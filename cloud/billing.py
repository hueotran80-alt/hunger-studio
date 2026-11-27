"""Credit plans, SePay VietQR and LemonSqueezy checkout/webhook handling."""
import hashlib
import hmac
import json
import math
import re
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode

from .errors import CloudError

SEPAY_CODE_RE = re.compile(r'(WBS[A-Z0-9]{8})', re.IGNORECASE)
SAFE_BANK_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
SAFE_ACCOUNT_RE = re.compile(r'^[A-Za-z0-9]{4,40}$')


def _header(headers, name):
    return str((headers or {}).get(name.lower(), '') or '')


def _signature_hex(secret, raw):
    return hmac.new(secret.encode('utf-8'), raw, hashlib.sha256).hexdigest()


def _parse_int_amount(value, default=None):
    if value is None or isinstance(value, bool):
        return default
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(num) or num < 0:
        return default
    return int(num)


class BillingService:
    def __init__(self, config, store, http_json=None):
        self.config = config
        self.store = store
        self.http_json = http_json or self._default_http_json

    @staticmethod
    def _default_http_json(method, url, headers, payload, timeout=20):
        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, dict(response.getheaders()), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers or {}), error.read()
        except (urllib.error.URLError, OSError) as error:
            raise CloudError('E_PROVIDER', f'Không gọi được cổng thanh toán: {error}', 502) from None

    def providers(self):
        return {
            'sepay': self.config.sepay_ready(),
            'lemonsqueezy': self.config.lemonsqueezy_ready(),
        }

    def create_checkout(self, user, plan_id, provider):
        plan = self.config.plan(plan_id)
        if not plan:
            raise CloudError('E_INVALID_ARG', 'Gói credit không hợp lệ.')
        provider = str(provider or 'sepay').strip().lower()
        if provider not in ('sepay', 'lemonsqueezy'):
            raise CloudError('E_INVALID_ARG', 'Cổng thanh toán không hợp lệ.')
        if provider == 'sepay' and not self.config.sepay_ready():
            raise CloudError('E_PROVIDER', 'SePay/VietQR chưa được cấu hình.', 503)
        if provider == 'lemonsqueezy' and not self.config.lemonsqueezy_ready():
            raise CloudError('E_PROVIDER', 'LemonSqueezy chưa được cấu hình.', 503)

        payment = self.store.create_payment(
            user['id'], provider, plan['id'], plan['priceVnd'], plan['credits'],
            {'email': user['email'], 'label': plan['label']},
        )
        if provider == 'sepay':
            checkout = self._sepay_checkout(payment)
        else:
            checkout = self._lemonsqueezy_checkout(payment, user)
        return {'payment': payment, 'checkout': checkout}

    def _sepay_checkout(self, payment):
        bank = self.config.sepay_bank
        account = self.config.sepay_account
        if not (SAFE_BANK_RE.match(bank) and SAFE_ACCOUNT_RE.match(account)):
            raise CloudError('E_PROVIDER', 'Cấu hình ngân hàng SePay không hợp lệ.', 503)
        template = self.config.sepay_qr_template or 'compact2'
        if template not in ('compact', 'compact2', 'qr_only', 'print'):
            template = 'compact2'
        query = urlencode({
            'amount': payment['amountVnd'],
            'addInfo': payment['code'],
            'accountName': self.config.sepay_holder,
        })
        qr_url = (
            f'https://img.vietqr.io/image/{quote(bank, safe="")}-{quote(account, safe="")}-{template}.png'
            f'?{query}'
        )
        return {
            'type': 'vietqr',
            'provider': 'sepay',
            'code': payment['code'],
            'amountVnd': payment['amountVnd'],
            'credits': payment['credits'],
            'bank': bank,
            'account': account,
            'holder': self.config.sepay_holder,
            'transferContent': payment['code'],
            'qrUrl': qr_url,
            'expiresInSeconds': self.config.payment_ttl_seconds,
            'expiresAt': payment.get('expiresAt'),
        }

    def _lemonsqueezy_checkout(self, payment, user):
        variant = self.config.lemonsqueezy_variants.get(payment['planId'])
        if not variant:
            raise CloudError('E_PROVIDER', 'Chưa cấu hình variant LemonSqueezy cho gói này.', 503)
        redirect_url = ''
        if self.config.public_base_url:
            redirect_url = f'{self.config.public_base_url}/?cloud=paid&code={quote(payment["code"])}'
        attributes = {
            'checkout_data': {
                'email': user['email'],
                'name': '',
                'custom': {
                    'payment_code': payment['code'],
                    'user_id': user['id'],
                },
            },
            'product_options': {
                'name': f'Web Blender Studio — {payment["credits"]} credits',
                'redirect_url': redirect_url,
            },
            'checkout_options': {'button_text': 'Thanh toán'},
            'expires_at': None,
        }
        payload = json.dumps({
            'data': {
                'type': 'checkouts',
                'attributes': attributes,
                'relationships': {
                    'store': {'data': {'type': 'stores', 'id': str(self.config.lemonsqueezy_store_id)}},
                    'variant': {'data': {'type': 'variants', 'id': str(variant)}},
                },
            }
        }, ensure_ascii=False).encode('utf-8')
        status, _, body = self.http_json(
            'POST',
            'https://api.lemonsqueezy.com/v1/checkouts',
            {
                'Accept': 'application/vnd.api+json',
                'Content-Type': 'application/vnd.api+json',
                'Authorization': f'Bearer {self.config.lemonsqueezy_api_key}',
                'User-Agent': 'WebBlenderStudio/2.0',
            },
            payload,
        )
        if status < 200 or status >= 300:
            raise CloudError('E_PROVIDER', f'LemonSqueezy trả HTTP {status}.', 502)
        try:
            data = json.loads(body.decode('utf-8'))
            checkout_url = data['data']['attributes']['url']
        except (ValueError, KeyError, TypeError):
            raise CloudError('E_PROVIDER', 'LemonSqueezy trả dữ liệu không hợp lệ.', 502) from None
        if not str(checkout_url).startswith('https://'):
            raise CloudError('E_PROVIDER', 'LemonSqueezy trả checkout URL không an toàn.', 502)
        return {
            'type': 'checkout_url',
            'provider': 'lemonsqueezy',
            'code': payment['code'],
            'amountVnd': payment['amountVnd'],
            'credits': payment['credits'],
            'checkoutUrl': checkout_url,
        }

    # --------------------------------------------------------------- webhooks
    def verify_sepay(self, headers, raw):
        secret = self.config.sepay_webhook_secret
        if secret:
            signature = _header(headers, 'x-sepay-signature') or _header(headers, 'x-sepay-signature-256')
            if not signature:
                raise CloudError('E_SIGNATURE', 'Thiếu chữ ký SePay.', 401)
            signature = signature.strip()
            if signature.lower().startswith('sha256='):
                signature = signature[7:]
            expected = _signature_hex(secret, raw)
            if not hmac.compare_digest(expected, signature.lower()):
                raise CloudError('E_SIGNATURE', 'Chữ ký SePay không hợp lệ.', 401)
            return
        api_key = self.config.sepay_api_key
        if api_key:
            provided = _header(headers, 'authorization')
            if not hmac.compare_digest(provided, f'Apikey {api_key}'):
                raise CloudError('E_SIGNATURE', 'API key SePay không hợp lệ.', 401)
            return
        raise CloudError('E_PROVIDER', 'SePay webhook chưa được cấu hình.', 503)

    @staticmethod
    def parse_sepay(raw):
        try:
            data = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise CloudError('E_INVALID_ARG', 'SePay webhook không phải JSON.', 400) from None
        if not isinstance(data, dict):
            raise CloudError('E_INVALID_ARG', 'SePay webhook không hợp lệ.', 400)
        transfer_type = str(data.get('transferType') or '').strip().lower()
        parsed_amount = _parse_int_amount(data.get('transferAmount'), default=0)
        amount = parsed_amount if parsed_amount is not None else 0
        account_number = str(data.get('accountNumber') or data.get('subAccount') or '').strip()
        text = ' '.join(str(data.get(key) or '') for key in ('code', 'content', 'description'))
        match = SEPAY_CODE_RE.search(text)
        code = match.group(1).upper() if match else ''
        external = str(
            data.get('id') or data.get('referenceCode') or
            f"{data.get('transactionDate', '')}:{account_number}:{amount}"
        )
        return {
            'code': code,
            'amountVnd': amount,
            'transferType': transfer_type,
            'accountNumber': account_number,
            'externalId': external,
        }

    def verify_lemonsqueezy(self, headers, raw):
        secret = self.config.lemonsqueezy_signing_secret
        if not secret:
            raise CloudError('E_PROVIDER', 'LemonSqueezy webhook chưa được cấu hình.', 503)
        signature = _header(headers, 'x-signature').strip().lower()
        if not signature:
            raise CloudError('E_SIGNATURE', 'Thiếu chữ ký LemonSqueezy.', 401)
        expected = _signature_hex(secret, raw)
        if not hmac.compare_digest(expected, signature):
            raise CloudError('E_SIGNATURE', 'Chữ ký LemonSqueezy không hợp lệ.', 401)

    @staticmethod
    def parse_lemonsqueezy(raw):
        try:
            data = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise CloudError('E_INVALID_ARG', 'LemonSqueezy webhook không phải JSON.', 400) from None
        if not isinstance(data, dict):
            raise CloudError('E_INVALID_ARG', 'LemonSqueezy webhook không hợp lệ.', 400)
        meta = data.get('meta') or {}
        if not isinstance(meta, dict):
            meta = {}
        event = str(meta.get('event_name') or '').strip()
        custom = meta.get('custom_data') or {}
        code = str((custom or {}).get('payment_code') or '').strip().upper()
        resource = data.get('data') or {}
        attrs = (resource.get('attributes') or {}) if isinstance(resource, dict) else {}
        status = str(attrs.get('status') or '').strip().lower()
        first_item = attrs.get('first_order_item') or {}
        variant_raw = (
            first_item.get('variant_id') if isinstance(first_item, dict) else None
        )
        if variant_raw is None or variant_raw == '':
            variant_raw = attrs.get('variant_id') or ''
        return {
            'event': event,
            'code': code,
            'externalId': str(resource.get('id') or '') if isinstance(resource, dict) else '',
            'status': status,
            'variantId': str(variant_raw).strip(),
            'testMode': bool(meta.get('test_mode')),
            'total': _parse_int_amount(attrs.get('total'), default=None),
            'currency': str(attrs.get('currency') or '').strip().upper(),
            'refunded': bool(attrs.get('refunded')),
        }
