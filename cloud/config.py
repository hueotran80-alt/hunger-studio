"""Cloud configuration: JSON file + environment overrides, secrets stay server-side."""
import json
import os
import re
import secrets
import stat

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG_PATH = os.path.join(SCRIPT_DIR, 'cloud_config.json')

DEFAULT_PLANS = (
    {'id': 'starter', 'label': 'Starter', 'credits': 300, 'priceVnd': 69000, 'badge': ''},
    {'id': 'pro', 'label': 'Pro', 'credits': 1200, 'priceVnd': 199000, 'badge': 'Phổ biến'},
    {'id': 'studio', 'label': 'Studio', 'credits': 5000, 'priceVnd': 799000, 'badge': 'Tiết kiệm'},
)
DEFAULT_COSTS = {'save_project': 1, 'upload_asset': 5, 'ai_chat': 1}

PROVIDERS = ('disabled', 'local', 'supabase')


def _as_bool(value, fallback=False):
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def _as_int(value, fallback, minimum=0, maximum=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number


def _as_str(value, fallback=''):
    if value is None:
        return fallback
    return str(value).strip()


def _nested(data, key):
    value = data.get(key)
    return value if isinstance(value, dict) else {}


class CloudConfig:
    """Resolved cloud configuration. Never serialize this object to clients."""

    def __init__(self, data=None, environ=None, path=None):
        data = data if isinstance(data, dict) else {}
        environ = os.environ if environ is None else environ

        self.path = path
        self.config_error = ''
        self.warnings = []

        provider = _as_str(environ.get('CLOUD_PROVIDER') or data.get('provider'), 'disabled').lower()
        if provider not in PROVIDERS:
            self.config_error = f'Unknown cloud provider: {provider}'
            provider = 'disabled'
        self.provider = provider

        self.data_dir = _as_str(
            environ.get('CLOUD_DATA_DIR') or data.get('data_dir'), os.path.join(SCRIPT_DIR, 'cloud_data'))
        if not os.path.isabs(self.data_dir):
            self.data_dir = os.path.abspath(os.path.join(SCRIPT_DIR, self.data_dir))

        self.session_secret = _as_str(
            environ.get('CLOUD_SESSION_SECRET') or data.get('session_secret'))
        self.session_ttl_seconds = _as_int(data.get('session_ttl_seconds'), 7 * 24 * 3600, 300, 90 * 24 * 3600)
        self.dev_login = _as_bool(
            environ.get('CLOUD_ALLOW_DEV_LOGIN') if 'CLOUD_ALLOW_DEV_LOGIN' in environ else data.get('allow_dev_login'),
            False)
        self.allow_test_billing = _as_bool(
            environ.get('CLOUD_ALLOW_TEST_BILLING') if 'CLOUD_ALLOW_TEST_BILLING' in environ else data.get('allow_test_billing'),
            False)
        self.payment_ttl_seconds = _as_int(
            environ.get('CLOUD_PAYMENT_TTL_SECONDS') or data.get('payment_ttl_seconds'),
            1800, 60, 86400)

        self.free_credits = _as_int(
            environ.get('CLOUD_FREE_CREDITS') or data.get('free_credits'), 100, 0, 1_000_000)
        self.max_project_bytes = _as_int(
            environ.get('CLOUD_MAX_PROJECT_BYTES') or data.get('max_project_bytes'), 8 * 1024 * 1024, 1024, 64 * 1024 * 1024)
        self.max_asset_bytes = _as_int(
            environ.get('CLOUD_MAX_ASSET_BYTES') or data.get('max_asset_bytes'), 25 * 1024 * 1024, 1024, 200 * 1024 * 1024)
        self.max_projects = _as_int(data.get('max_projects'), 50, 1, 10_000)
        self.max_assets = _as_int(data.get('max_assets'), 200, 1, 100_000)
        self.max_total_bytes = _as_int(data.get('max_total_bytes'), 300 * 1024 * 1024, 1024, 100 * 1024 * 1024 * 1024)

        costs = data.get('costs') if isinstance(data.get('costs'), dict) else {}
        save_cost = _as_int(costs.get('save_project'), DEFAULT_COSTS['save_project'], 0, 1000)
        upload_cost = _as_int(costs.get('upload_asset'), DEFAULT_COSTS['upload_asset'], 0, 1000)
        ai_default = 0 if (save_cost == 0 and upload_cost == 0) else DEFAULT_COSTS['ai_chat']
        self.costs = {
            'save_project': save_cost,
            'upload_asset': upload_cost,
            'ai_chat': _as_int(costs.get('ai_chat'), ai_default, 0, 1000),
        }

        plans_raw = data.get('plans')
        self.plans = self._parse_plans(plans_raw)

        supabase = _nested(data, 'supabase')
        self.supabase_url = _as_str(environ.get('SUPABASE_URL') or supabase.get('url')).rstrip('/')
        self.supabase_anon_key = _as_str(environ.get('SUPABASE_ANON_KEY') or supabase.get('anon_key'))
        self.supabase_service_key = _as_str(environ.get('SUPABASE_SERVICE_KEY') or supabase.get('service_key'))
        self.project_bucket = _as_str(supabase.get('project_bucket'), 'studio-projects')
        self.asset_bucket = _as_str(supabase.get('asset_bucket'), 'shared-models')

        billing = _nested(data, 'billing')
        sepay = billing.get('sepay') if isinstance(billing.get('sepay'), dict) else _nested(data, 'sepay')
        self.sepay_webhook_secret = _as_str(environ.get('SEPAY_WEBHOOK_SECRET') or sepay.get('webhook_secret'))
        self.sepay_api_key = _as_str(environ.get('SEPAY_API_KEY') or sepay.get('api_key'))
        self.sepay_bank = _as_str(environ.get('SEPAY_BANK') or sepay.get('bank'))
        self.sepay_account = _as_str(environ.get('SEPAY_ACCOUNT') or sepay.get('account'))
        self.sepay_holder = _as_str(environ.get('SEPAY_HOLDER') or sepay.get('holder'))
        self.sepay_qr_template = _as_str(sepay.get('qr_template'), 'compact2')

        lemonseven = (
            billing.get('lemonsqueezy') if isinstance(billing.get('lemonsqueezy'), dict)
            else _nested(data, 'lemonsqueezy'))
        self.lemonsqueezy_api_key = _as_str(
            environ.get('LEMONSQUEEZY_API_KEY') or lemonseven.get('api_key'))
        self.lemonsqueezy_store_id = _as_str(
            environ.get('LEMONSQUEEZY_STORE_ID') or lemonseven.get('store_id'))
        self.lemonsqueezy_signing_secret = _as_str(
            environ.get('LEMONSQUEEZY_SIGNING_SECRET') or lemonseven.get('signing_secret'))
        variants = lemonseven.get('variants') if isinstance(lemonseven.get('variants'), dict) else {}
        self.lemonsqueezy_variants = {
            str(key): _as_str(value) for key, value in variants.items() if _as_str(value)
        }

        self.public_base_url = _as_str(data.get('public_base_url')).rstrip('/')

        if self.provider == 'local' and not self.session_secret:
            self.session_secret = secrets.token_urlsafe(48)
            self.warnings.append(
                'CLOUD_SESSION_SECRET chưa đặt: token dev sẽ hết hiệu lực khi khởi động lại server.')
        if self.provider == 'supabase':
            missing = [name for name, value in (
                ('url', self.supabase_url),
                ('anon_key', self.supabase_anon_key),
                ('service_key', self.supabase_service_key),
            ) if not value]
            if missing:
                self.config_error = 'Thiếu cấu hình Supabase: ' + ', '.join(missing)
        if self.provider == 'local' and not self.dev_login:
            self.config_error = 'Provider local cần allow_dev_login=true để có đường đăng nhập.'
        if self.path:
            self._check_permissions()

    def _parse_plans(self, raw):
        if not isinstance(raw, list) or not raw:
            return [dict(plan) for plan in DEFAULT_PLANS]
        plans = []
        seen = set()
        for item in raw:
            if not isinstance(item, dict):
                continue
            plan_id = _as_str(item.get('id')).lower()
            if not plan_id or plan_id in seen or len(plan_id) > 32:
                continue
            seen.add(plan_id)
            plans.append({
                'id': plan_id,
                'label': _as_str(item.get('label'), plan_id.title())[:60],
                'credits': _as_int(item.get('credits'), 0, 1, 10_000_000),
                'priceVnd': _as_int(item.get('priceVnd'), 0, 0, 1_000_000_000),
                'badge': _as_str(item.get('badge'))[:20],
            })
        return plans or [dict(plan) for plan in DEFAULT_PLANS]

    def _check_permissions(self):
        try:
            mode = stat.S_IMODE(os.stat(self.path).st_mode)
        except OSError:
            return
        if mode & 0o077:
            self.warnings.append(
                f'{os.path.basename(self.path)} đang cho nhóm/người khác đọc (mode {mode:o}); nên chmod 600.')

    @property
    def enabled(self):
        return self.provider != 'disabled' and not self.config_error

    @property
    def storage(self):
        return 'supabase' if self.provider == 'supabase' else 'local'

    def plan(self, plan_id):
        wanted = _as_str(plan_id).lower()
        for plan in self.plans:
            if plan['id'] == wanted:
                return plan
        return None

    def sepay_ready(self):
        return bool(
            (self.sepay_webhook_secret or self.sepay_api_key) and
            re.match(r'^[A-Za-z0-9_-]{1,40}$', self.sepay_bank or '') and
            re.match(r'^[A-Za-z0-9]{4,40}$', self.sepay_account or ''))

    def lemonsqueezy_ready(self):
        return bool(
            self.lemonsqueezy_api_key and self.lemonsqueezy_store_id and
            any(plan['id'] in self.lemonsqueezy_variants for plan in self.plans))

    def public_status(self):
        supabase = None
        if self.provider == 'supabase' and self.enabled:
            supabase = {'url': self.supabase_url, 'anonKey': self.supabase_anon_key}
        return {
            'enabled': self.enabled,
            'configured': self.enabled,
            'provider': self.provider,
            'error': self.config_error or None,
            'warnings': list(self.warnings),
            'devLogin': self.provider == 'local' and self.dev_login,
            'storage': self.storage,
            'supabase': supabase,
            'plans': [dict(plan) for plan in self.plans],
            'costs': dict(self.costs),
            'limits': {
                'freeCredits': self.free_credits,
                'maxProjectBytes': self.max_project_bytes,
                'maxAssetBytes': self.max_asset_bytes,
                'maxProjects': self.max_projects,
                'maxAssets': self.max_assets,
                'maxTotalBytes': self.max_total_bytes,
            },
            'billing': {
                'sepay': self.sepay_ready(),
                'lemonsqueezy': self.lemonsqueezy_ready(),
                'currency': 'VND',
            },
        }

    def max_body_bytes(self, path):
        base = 2 * 1024 * 1024
        if path in ('/api/cloud/projects', '/api/cloud/projects/'):
            base = self.max_project_bytes + 256 * 1024
        elif path in ('/api/cloud/assets', '/api/cloud/assets/'):
            base = 4 * ((self.max_asset_bytes + 2) // 3) + 1024 * 1024
        if path.startswith('/api/cloud/webhook/'):
            base = 1024 * 1024
        return base


def load_cloud_config(path=None, environ=None):
    """Loads cloud_config.json (if present) with environment overrides."""
    environ = os.environ if environ is None else environ
    config_path = path or environ.get('CLOUD_CONFIG') or DEFAULT_CONFIG_PATH
    data = {}
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                data = loaded
            else:
                raise ValueError('root must be a JSON object')
        except (OSError, ValueError) as error:
            cfg = CloudConfig({}, environ=environ, path=None)
            cfg.config_error = f'Không đọc được cloud_config.json: {error}'
            return cfg
    elif not environ.get('CLOUD_PROVIDER'):
        data = {'provider': 'disabled'}
    return CloudConfig(data, environ=environ, path=config_path if os.path.exists(config_path) else None)
