"""Cloud API dispatcher: /api/cloud/* for the studio and payment webhooks."""
import base64
import binascii
import ipaddress
import json
import re
import threading
import time
import traceback
import uuid
from collections import deque
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse

from .auth import Authenticator, Identity
from .billing import BillingService
from .errors import CloudError
from .store import LocalStore
from .supabase import SupabaseClient, SupabaseStore
from .validation import COMMUNITY_CATEGORIES, author_display_name

ROUTE_PROJECT = re.compile(r'^/api/cloud/projects/([A-Za-z0-9_-]{8,64})(/delete)?$')
ROUTE_ASSET = re.compile(r'^/api/cloud/assets/([A-Za-z0-9_-]{8,64})(/delete)?$')
ROUTE_PUBLIC_ASSET = re.compile(r'^/api/cloud/public/assets/([A-Za-z0-9_-]{8,64})$')
ROUTE_PUBLIC_THUMB = re.compile(r'^/api/cloud/public/thumbs/([A-Za-z0-9_-]{8,64})$')
ROUTE_PAYMENT = re.compile(r'^/api/cloud/payments/(WBS[A-Z0-9]{8})(/simulate)?$')


class RateLimiter:
    def __init__(self, limit=10, window=60.0):
        self.limit = limit
        self.window = window
        self._hits = {}
        self._lock = threading.Lock()

    def allow(self, key, now=None):
        now = time.monotonic() if now is None else now
        k = str(key)
        with self._lock:
            bucket = self._hits.setdefault(k, deque())
            while bucket and bucket[0] <= now - self.window:
                bucket.popleft()
            if len(bucket) >= self.limit:
                return False
            bucket.append(now)
            if len(self._hits) > 5000:
                cutoff = now - self.window
                expired = [old_k for old_k, q in self._hits.items() if not q or q[-1] <= cutoff]
                for old_k in expired:
                    self._hits.pop(old_k, None)
                while len(self._hits) > 5000:
                    oldest_k = next(iter(self._hits))
                    if oldest_k == k and len(self._hits) > 1:
                        break
                    self._hits.pop(oldest_k, None)
            return True


class CloudService:
    def __init__(self, config, store=None, supabase_client=None, billing=None,
                 clock=time.time, http_json=None):
        self.config = config
        self.clock = clock
        self.init_error = ''
        self.store = store
        self.supabase = supabase_client
        self.warnings = list(getattr(config, 'warnings', []) or [])
        self.login_limiter = RateLimiter(12, 60)
        self.checkout_limiter = RateLimiter(10, 60)

        if self.store is None and config.enabled:
            try:
                if config.provider == 'supabase':
                    self.supabase = SupabaseClient(config)
                    self.store = SupabaseStore(config, self.supabase)
                else:
                    self.store = LocalStore(config)
            except Exception as error:
                self.init_error = str(error)
                self.store = None
        if config.provider == 'supabase' and self.supabase is None and self.store is not None:
            self.supabase = getattr(self.store, 'client', None)

        self.auth = Authenticator(config, supabase=self.supabase, clock=clock) if self.store else None
        self.billing = billing or (
            BillingService(config, self.store, http_json=http_json) if self.store else None
        )

    # ----------------------------------------------------------------- status
    def status(self):
        status = self.config.public_status()
        status['enabled'] = bool(self.store and self.config.enabled)
        status['configured'] = status['enabled']
        if self.init_error:
            status['error'] = self.init_error
        status['warnings'] = list(dict.fromkeys(self.warnings + list(status.get('warnings') or [])))
        status['providers'] = {
            'sepay': self.config.sepay_ready(),
            'lemonsqueezy': self.config.lemonsqueezy_ready(),
        }
        status['billingEnabled'] = bool(status['providers']['sepay'] or status['providers']['lemonsqueezy'])
        status['freeMode'] = (
            self.config.costs.get('save_project', 0) == 0 and
            self.config.costs.get('upload_asset', 0) == 0 and
            self.config.costs.get('ai_chat', 0) == 0
        )
        status['categories'] = list(COMMUNITY_CATEGORIES)
        return status

    def max_body_bytes(self, path):
        return self.config.max_body_bytes(path)

    # --------------------------------------------------------------- dispatch
    def handle(self, method, path, query, headers, raw_body=b'', client_ip=''):
        try:
            headers = {str(key).lower(): value for key, value in (headers or {}).items()}
            method = str(method).upper()
            if method == 'GET' and path == '/api/cloud/status':
                return self._json(200, {'success': True, **self.status()})
            if method == 'POST' and path == '/api/cloud/webhook/sepay':
                return self._sepay_webhook(headers, raw_body)
            if method == 'POST' and path == '/api/cloud/webhook/lemonsqueezy':
                return self._lemonsqueezy_webhook(headers, raw_body)
            if not self.store or not self.auth or not self.config.enabled:
                raise CloudError(
                    'E_CLOUD_DISABLED', 'Cloud chưa được cấu hình.',
                    503, self.init_error or 'Tạo cloud_config.json từ cloud_config.example.json.')
            if method == 'POST' and path == '/api/cloud/dev-login':
                return self._dev_login(headers, raw_body, client_ip)
            if method == 'POST' and path == '/api/cloud/logout':
                return 200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Set-Cookie': self._clear_session_cookie(headers),
                }, json.dumps({'success': True}).encode('utf-8')
            if path == '/api/cloud/session':
                if method == 'DELETE':
                    return 200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Set-Cookie': self._clear_session_cookie(headers),
                    }, json.dumps({'success': True}).encode('utf-8')
                if method == 'POST':
                    return self._set_cookie_session(headers, raw_body)
                raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)
            if method == 'GET' and path == '/api/cloud/community':
                return self._community(query, headers)
            if method == 'GET' and path.startswith('/api/cloud/public/assets/'):
                return self._public_asset(path)
            if method == 'GET' and path.startswith('/api/cloud/public/thumbs/'):
                return self._public_thumb(path)

            identity = self._identity(headers, method=method)
            user = self.store.ensure_user(identity)

            if method == 'GET' and path == '/api/cloud/me':
                return self._me(user)
            if method == 'GET' and path == '/api/cloud/me/export':
                exported = self.store.export_user_data(user['id'])
                return 200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="web-blender-studio-data.json"',
                    'Cache-Control': 'no-store',
                }, json.dumps(exported, ensure_ascii=False, indent=2).encode('utf-8')
            if method == 'POST' and path == '/api/cloud/me/delete':
                return self._delete_account(user, raw_body, headers)
            if method == 'GET' and path == '/api/cloud/credits':
                return self._json(200, {
                    'success': True,
                    'credits': self.store.balance(user['id']),
                    'ledger': self.store.ledger(user['id'], 50),
                })
            if method == 'GET' and path == '/api/cloud/projects':
                return self._json(200, {'success': True, 'projects': self.store.list_projects(user['id'])})
            if path == '/api/cloud/projects':
                if method != 'POST':
                    raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)
                return self._save_project(user, raw_body)
            if method == 'GET' and path == '/api/cloud/assets':
                return self._json(200, {'success': True, 'assets': self.store.list_assets(user['id'])})
            if path == '/api/cloud/assets':
                if method != 'POST':
                    raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)
                return self._upload_asset(user, raw_body)
            if method == 'GET' and path == '/api/cloud/payments':
                return self._json(200, {'success': True, 'payments': self.store.list_payments(user['id'])})
            if method == 'POST' and path == '/api/cloud/checkout':
                return self._checkout(user, raw_body)
            if path == '/api/cloud/plans':
                return self._json(200, {
                    'success': True,
                    'plans': self.config.plans,
                    'costs': self.config.costs,
                    'providers': self.billing.providers(),
                })

            project_match = ROUTE_PROJECT.match(path)
            if project_match:
                project_id, delete = project_match.group(1), project_match.group(2)
                if delete:
                    if method != 'POST':
                        raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)
                    self.store.delete_project(user['id'], project_id)
                    return self._json(200, {'success': True})
                if method == 'GET':
                    return self._json(200, {
                        'success': True,
                        'project': self.store.get_project(user['id'], project_id),
                    })
                raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)

            asset_match = ROUTE_ASSET.match(path)
            if asset_match:
                asset_id, delete = asset_match.group(1), asset_match.group(2)
                if delete:
                    if method != 'POST':
                        raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)
                    self.store.delete_asset(user['id'], asset_id)
                    return self._json(200, {'success': True})
                if method == 'GET':
                    return self._json(200, {
                        'success': True,
                        'asset': self.store.get_asset(user['id'], asset_id),
                    })
                raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)

            payment_match = ROUTE_PAYMENT.match(path)
            if payment_match:
                code, simulate = payment_match.group(1), payment_match.group(2)
                if simulate:
                    if method != 'POST':
                        raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)
                    return self._simulate_payment(user, code)
                if method == 'GET':
                    return self._json(200, {
                        'success': True,
                        'payment': self.store.get_payment(user['id'], code),
                        'credits': self.store.balance(user['id']),
                    })
                raise CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405)

            raise CloudError('E_NOT_FOUND', 'Endpoint cloud không tồn tại.', 404)
        except CloudError as error:
            return self._json(error.status, error.to_dict())
        except Exception:
            traceback.print_exc()
            return self._json(500, {
                'success': False,
                'error': {'code': 'E_INTERNAL', 'message': 'Cloud request failed.', 'hint': ''},
            })

    # ------------------------------------------------------------------ auth
    @staticmethod
    def _cookie_value(headers, name):
        raw_cookie = str(headers.get('cookie') or '')
        if not raw_cookie:
            return ''
        jar = SimpleCookie()
        try:
            jar.load(raw_cookie)
        except Exception:
            return ''
        morsel = jar.get(name)
        return str(morsel.value).strip() if morsel else ''

    @staticmethod
    def _is_secure_request(headers):
        proto = str(headers.get('x-forwarded-proto') or '').strip().lower()
        origin = str(headers.get('origin') or '').strip().lower()
        return proto == 'https' or origin.startswith('https://')

    def _session_cookie(self, token, headers):
        max_age = int(getattr(self.config, 'session_ttl_seconds', 7 * 24 * 3600) or 3600)
        parts = [
            f'wbs_session={token}',
            f'Max-Age={max_age}',
            'Path=/api/cloud',
            'HttpOnly',
            'SameSite=Lax',
        ]
        if self._is_secure_request(headers):
            parts.append('Secure')
        return '; '.join(parts)

    def _clear_session_cookie(self, headers):
        parts = ['wbs_session=', 'Max-Age=0', 'Path=/api/cloud', 'HttpOnly', 'SameSite=Lax']
        if self._is_secure_request(headers):
            parts.append('Secure')
        return '; '.join(parts)

    def _set_cookie_session(self, headers, raw_body):
        body = self._json_body(raw_body)
        auth_header = str(headers.get('authorization') or '')
        if auth_header.lower().startswith('bearer '):
            token = auth_header.split(' ', 1)[1].strip()
        else:
            token = str(body.get('token') or '').strip()
        if not token:
            raise CloudError('E_AUTH_REQUIRED', 'Thiếu session token.', 401)
        identity = self.auth.verify(token)
        user = self.store.ensure_user(identity)
        return 200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': self._session_cookie(token, headers),
            'Cache-Control': 'no-store',
        }, json.dumps({'success': True, 'user': user}, ensure_ascii=False).encode('utf-8')

    @staticmethod
    def _same_origin_csrf_ok(headers):
        fetch_site = str(headers.get('sec-fetch-site') or '').strip().lower()
        if fetch_site in ('same-origin', 'none'):
            return True
        xrw = str(headers.get('x-requested-with') or '').strip().lower()
        if xrw:
            return True
        host = str(headers.get('host') or '').strip().lower()
        origin = str(headers.get('origin') or '').strip().lower()
        if host and origin:
            parsed = urlparse(origin)
            return bool(parsed.netloc and parsed.netloc.lower() == host)
        return False

    def _identity(self, headers, method='GET'):
        value = str(headers.get('authorization') or '')
        if value.lower().startswith('bearer '):
            token = value.split(' ', 1)[1].strip()
            return self.auth.verify(token)
        cookie_token = self._cookie_value(headers, 'wbs_session')
        if cookie_token:
            if str(method).upper() not in ('GET', 'HEAD') and not self._same_origin_csrf_ok(headers):
                raise CloudError('E_FORBIDDEN', 'CSRF verification failed for cookie session.', 403)
            return self.auth.verify(cookie_token)
        raise CloudError('E_AUTH_REQUIRED', 'Cần đăng nhập Cloud.', 401)

    def authenticate_request(self, headers, method='POST'):
        """Verify Cloud user from HTTP headers without dispatching a route."""
        if not self.store or not self.auth or not self.config.enabled:
            raise CloudError('E_CLOUD_DISABLED', 'Cloud chưa được cấu hình.', 503)
        norm = {str(key).lower(): val for key, val in (headers or {}).items()}
        identity = self._identity(norm, method=method)
        return self.store.ensure_user(identity)

    @staticmethod
    def _loopback_client(client_ip):
        try:
            address = ipaddress.ip_address(str(client_ip or ''))
        except ValueError:
            return False
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_loopback

    def _dev_login(self, headers, raw_body, client_ip):
        if not self._loopback_client(client_ip):
            raise CloudError(
                'E_FORBIDDEN', 'Dev login chỉ dành cho máy chủ local.', 403,
                'Dùng Supabase Auth khi triển khai cho mạng/LAN.')
        if not self.login_limiter.allow(client_ip or 'unknown'):
            raise CloudError('E_RATE_LIMIT', 'Thử đăng nhập quá nhanh, chờ một phút.', 429)
        body = self._json_body(raw_body)
        email = self.auth.dev_login(body.get('email'))
        user_id = uuid.uuid5(uuid.NAMESPACE_URL, f'web-blender-studio:{email}').hex
        identity = Identity(user_id, email, 'local')
        user = self.store.ensure_user(identity)
        token, expires = self.auth.issue_local_token(user_id, email)
        return self._json(200, {
            'success': True,
            'session': {'token': token, 'expiresAt': expires, 'provider': 'local'},
            'user': user,
        })

    # ----------------------------------------------------------------- users
    def _me(self, user):
        return self._json(200, {
            'success': True,
            'user': user,
            'provider': self.config.provider,
            'storage': self.config.storage,
            'limits': {
                'maxProjectBytes': self.config.max_project_bytes,
                'maxAssetBytes': self.config.max_asset_bytes,
                'maxProjects': self.config.max_projects,
                'maxAssets': self.config.max_assets,
                'maxTotalBytes': self.config.max_total_bytes,
            },
            'costs': dict(self.config.costs),
            'stats': self.store.stats(user['id']),
            'plans': self.config.plans,
        })

    def _delete_account(self, user, raw_body, headers):
        body = self._json_body(raw_body)
        confirm = str(body.get('confirm') or '').strip()
        email = str(body.get('email') or '').strip().lower()
        user_email = str(user.get('email') or '').strip().lower()
        if confirm != 'DELETE' and (not email or email != user_email):
            raise CloudError(
                'E_INVALID_ARG',
                'Cần xác nhận xoá tài khoản (confirm="DELETE" hoặc nhập đúng email).',
                400,
            )
        self.store.delete_user(user['id'])
        return 200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': self._clear_session_cookie(headers),
            'Cache-Control': 'no-store',
        }, json.dumps({'success': True, 'deleted': True}).encode('utf-8')

    # -------------------------------------------------------------- projects
    def _save_project(self, user, raw_body):
        body = self._json_body(raw_body)
        project = self.store.save_project(
            user['id'], body.get('id'), body.get('name'), body.get('data'))
        return self._json(200, {'success': True, 'project': project})

    def _upload_asset(self, user, raw_body):
        body = self._json_body(raw_body)
        encoded = body.get('dataBase64') or body.get('fileData')
        if not isinstance(encoded, str) or not encoded:
            raise CloudError('E_INVALID_ARG', 'Thiếu dataBase64.')
        if ',' in encoded:
            encoded = encoded.split(',', 1)[1]
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise CloudError('E_INVALID_ARG', 'dataBase64 không hợp lệ.') from None
        if len(payload) > self.config.max_asset_bytes:
            raise CloudError('E_TOO_LARGE', 'GLB vượt giới hạn dung lượng.', 413)

        thumb_payload = None
        thumb_b64 = body.get('thumbnailBase64')
        if isinstance(thumb_b64, str) and thumb_b64:
            if ',' in thumb_b64:
                thumb_b64 = thumb_b64.split(',', 1)[1]
            try:
                thumb_payload = base64.b64decode(thumb_b64, validate=True)
            except (ValueError, binascii.Error):
                raise CloudError('E_INVALID_ARG', 'thumbnailBase64 không hợp lệ.') from None

        asset = self.store.add_asset(
            user['id'],
            body.get('fileName') or 'model.glb',
            payload,
            public=body.get('public', True) is not False,
            content_type=body.get('contentType') or 'model/gltf-binary',
            title=body.get('title') or '',
            category=body.get('category') or 'props',
            tags=body.get('tags'),
            description=body.get('description') or '',
            author_name=body.get('authorName') or author_display_name(user.get('email')),
            thumbnail_data=thumb_payload,
        )
        return self._json(200, {'success': True, 'asset': asset})

    def _community(self, query, headers):
        qs = parse_qs(query or '', keep_blank_values=False)
        category = (qs.get('category') or ['all'])[0]
        search = (qs.get('q') or [''])[0]
        try:
            limit = int((qs.get('limit') or ['48'])[0])
        except ValueError:
            limit = 48
        try:
            offset = int((qs.get('offset') or ['0'])[0])
        except ValueError:
            offset = 0
        viewer_user_id = None
        auth_val = str((headers or {}).get('authorization') or '')
        if auth_val.lower().startswith('bearer '):
            try:
                viewer_user_id = self.auth.verify(auth_val.split(' ', 1)[1].strip()).id
            except CloudError:
                viewer_user_id = None
        items = self.store.list_public_assets(
            category=category, query=search, limit=limit, offset=offset,
            viewer_user_id=viewer_user_id,
        )
        return self._json(200, {'success': True, 'items': items})

    # -------------------------------------------------------------- payments
    def _checkout(self, user, raw_body):
        if not self.checkout_limiter.allow(user['id']):
            raise CloudError('E_RATE_LIMIT', 'Tạo giao dịch quá nhanh, thử lại sau.', 429)
        body = self._json_body(raw_body)
        result = self.billing.create_checkout(user, body.get('plan'), body.get('provider') or 'sepay')
        return self._json(200, {'success': True, **result, 'providers': self.billing.providers()})

    def _simulate_payment(self, user, code):
        if self.config.provider != 'local' or not self.config.dev_login:
            raise CloudError('E_FORBIDDEN', 'Chỉ có ở provider local.', 403)
        payment = self.store.get_payment(user['id'], code)
        result = self.store.mark_payment_paid(
            payment['code'], f'dev-{uuid.uuid4().hex[:12]}', payment['amountVnd'], provider=payment['provider'])
        return self._json(200, {
            'success': True,
            'payment': result['payment'],
            'credits': result['credits'],
            'applied': result['applied'],
        })

    # --------------------------------------------------------------- webhook
    def _sepay_webhook(self, headers, raw_body):
        if not self.billing:
            raise CloudError('E_CLOUD_DISABLED', 'Cloud chưa được cấu hình.', 503)
        self.billing.verify_sepay(headers, raw_body)
        event = self.billing.parse_sepay(raw_body)
        if event['transferType'] != 'in':
            return self._json(200, {'success': True, 'ignored': 'not_incoming'})
        expected_account = str(self.config.sepay_account or '').strip()
        got_account = str(event.get('accountNumber') or '').strip()
        if expected_account and got_account and got_account != expected_account:
            return self._json(200, {'success': True, 'applied': False, 'ignored': 'account_mismatch'})
        if not event['code']:
            return self._json(200, {'success': True, 'ignored': 'no_payment_code'})
        try:
            result = self.store.mark_payment_paid(
                event['code'], event['externalId'], event['amountVnd'], provider='sepay')
        except CloudError as error:
            if error.status == 404:
                return self._json(200, {'success': True, 'ignored': 'unknown_payment'})
            raise
        return self._json(200, {
            'success': True,
            'applied': result['applied'],
            'reason': result['reason'],
            'credits': result['credits'],
        })

    def _lemonsqueezy_webhook(self, headers, raw_body):
        if not self.billing:
            raise CloudError('E_CLOUD_DISABLED', 'Cloud chưa được cấu hình.', 503)
        self.billing.verify_lemonsqueezy(headers, raw_body)
        event = self.billing.parse_lemonsqueezy(raw_body)
        if event.get('testMode') and not self.config.allow_test_billing:
            raise CloudError('E_FORBIDDEN', 'Test mode webhook không được phép trên production.', 403)
        if event['event'] == 'order_refunded' or event['status'] == 'refunded' or event.get('refunded'):
            try:
                result = self.store.refund_payment(
                    event['code'], event['externalId'], provider='lemonsqueezy')
            except CloudError as error:
                if error.status == 404:
                    return self._json(200, {'success': True, 'ignored': 'unknown_payment'})
                raise
            return self._json(200, {
                'success': True,
                'applied': result['applied'],
                'reason': result['reason'],
                'credits': result['credits'],
            })
        if event['event'] != 'order_created':
            return self._json(200, {'success': True, 'ignored': event['event'] or 'event'})
        if event['status'] != 'paid':
            return self._json(200, {
                'success': True,
                'applied': False,
                'ignored': f"status_{event['status'] or 'unknown'}",
            })
        if not event['code']:
            return self._json(200, {'success': True, 'ignored': 'no_payment_code'})
        paid_amount_vnd = None
        if hasattr(self.store, 'find_payment_by_code'):
            existing = self.store.find_payment_by_code(event['code'])
            if not existing:
                return self._json(200, {'success': True, 'ignored': 'unknown_payment'})
            if existing.get('provider') and existing['provider'] != 'lemonsqueezy':
                raise CloudError('E_INVALID_ARG', 'Provider không khớp giao dịch.', 400)
            expected_variant = str(self.config.lemonsqueezy_variants.get(existing.get('planId')) or '').strip()
            if expected_variant and event.get('variantId') != expected_variant:
                return self._json(200, {
                    'success': True,
                    'applied': False,
                    'reason': 'variant_mismatch',
                    'credits': self.store.balance(existing['userId']) if existing.get('userId') else 0,
                })
            expected_vnd = int(existing.get('amountVnd') or 0)
            total = event.get('total')
            currency = event.get('currency') or ''
            if expected_vnd > 0 and total is not None:
                if total <= 0:
                    return self._json(200, {
                        'success': True,
                        'applied': False,
                        'reason': 'invalid_total',
                        'credits': self.store.balance(existing['userId']) if existing.get('userId') else 0,
                    })
                if currency == 'VND':
                    paid_amount_vnd = total
        try:
            result = self.store.mark_payment_paid(
                event['code'], event['externalId'], paid_amount_vnd, provider='lemonsqueezy')
        except CloudError as error:
            if error.status == 404:
                return self._json(200, {'success': True, 'ignored': 'unknown_payment'})
            raise
        return self._json(200, {
            'success': True,
            'applied': result['applied'],
            'reason': result['reason'],
            'credits': result['credits'],
        })

    # ---------------------------------------------------------- public asset
    def _public_asset(self, path):
        match = ROUTE_PUBLIC_ASSET.match(path)
        if not match:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        asset_id = match.group(1)
        if self.config.provider == 'supabase':
            url = self.store.public_asset_url(asset_id)
            return 302, {'Location': url, 'Cache-Control': 'public, max-age=60'}, b''
        payload, content_type, name = self.store.read_public_asset(asset_id)
        filename = re.sub(r'["\\\\\r\n]', '_', name or 'model.glb')
        filename = filename.encode('ascii', 'ignore').decode('ascii') or 'model.glb'
        return 200, {
            'Content-Type': content_type,
            'Content-Disposition': f'inline; filename="{filename}"',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Access-Control-Allow-Origin': '*',
        }, payload

    def _public_thumb(self, path):
        match = ROUTE_PUBLIC_THUMB.match(path)
        if not match:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy ảnh.', 404)
        asset_id = match.group(1)
        if self.config.provider == 'supabase':
            url = self.store.public_thumb_url(asset_id)
            return 302, {'Location': url, 'Cache-Control': 'public, max-age=300'}, b''
        payload = self.store.read_public_thumb(asset_id)
        return 200, {
            'Content-Type': 'image/png',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300',
        }, payload

    # --------------------------------------------------------------- helpers
    def _json_body(self, raw_body):
        if not raw_body:
            return {}
        try:
            data = json.loads(raw_body.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise CloudError('E_INVALID_ARG', 'Body không phải JSON hợp lệ.') from None
        if not isinstance(data, dict):
            raise CloudError('E_INVALID_ARG', 'Body phải là JSON object.')
        return data

    @staticmethod
    def _json(status, data):
        return status, {'Content-Type': 'application/json; charset=utf-8'}, json.dumps(
            data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
