"""Authentication: local HMAC sessions and Supabase access-token validation."""
import base64
import hashlib
import hmac
import json
import time

from .errors import CloudError, auth_required
from .validation import validate_email

TOKEN_VERSION = 'v1'
MAX_TOKEN_LENGTH = 4096


def _b64encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _b64decode(text):
    padded = text + '=' * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(padded.encode('ascii'))


class Identity:
    def __init__(self, user_id, email, provider):
        self.id = user_id
        self.email = email
        self.provider = provider

    def to_dict(self):
        return {'id': self.id, 'email': self.email, 'provider': self.provider}


class Authenticator:
    def __init__(self, config, supabase=None, clock=time.time):
        self.config = config
        self.supabase = supabase
        self.clock = clock

    def issue_local_token(self, user_id, email):
        now = int(self.clock())
        expires = now + int(self.config.session_ttl_seconds)
        payload = {
            'v': TOKEN_VERSION,
            'sub': user_id,
            'email': email,
            'p': 'local',
            'iat': now,
            'exp': expires,
        }
        body = _b64encode(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
        signature = hmac.new(
            self.config.session_secret.encode('utf-8'),
            f'{TOKEN_VERSION}.{body}'.encode('ascii'),
            hashlib.sha256,
        ).digest()
        return f'{TOKEN_VERSION}.{body}.{_b64encode(signature)}', expires

    def verify(self, token):
        if not token or not isinstance(token, str) or len(token) > MAX_TOKEN_LENGTH:
            raise auth_required()
        if self.config.provider == 'local':
            return self._verify_local(token)
        if self.config.provider == 'supabase':
            return self._verify_supabase(token)
        raise CloudError('E_CLOUD_DISABLED', 'Cloud chưa được cấu hình.', 503)

    def _verify_local(self, token):
        parts = token.split('.')
        if len(parts) != 3 or parts[0] != TOKEN_VERSION:
            raise auth_required()
        expected = hmac.new(
            self.config.session_secret.encode('utf-8'),
            f'{TOKEN_VERSION}.{parts[1]}'.encode('ascii'),
            hashlib.sha256,
        ).digest()
        try:
            provided = _b64decode(parts[2])
        except (ValueError, TypeError):
            raise auth_required() from None
        if not hmac.compare_digest(expected, provided):
            raise auth_required()
        try:
            payload = json.loads(_b64decode(parts[1]).decode('utf-8'))
        except (ValueError, UnicodeError):
            raise auth_required() from None
        if payload.get('v') != TOKEN_VERSION or payload.get('p') != 'local':
            raise auth_required()
        if int(payload.get('exp') or 0) <= int(self.clock()):
            raise CloudError('E_AUTH_EXPIRED', 'Phiên đăng nhập đã hết hạn.', 401)
        user_id = str(payload.get('sub') or '')
        email = validate_email(payload.get('email'))
        if not user_id or not email:
            raise auth_required()
        return Identity(user_id, email, 'local')

    def _verify_supabase(self, token):
        if not self.supabase:
            raise CloudError('E_CLOUD_DISABLED', 'Supabase chưa được cấu hình.', 503)
        user = self.supabase.validate_user(token)
        if not user or not user.get('id'):
            raise auth_required()
        email = validate_email(user.get('email')) or f'{user["id"]}@supabase.local'
        return Identity(str(user['id']), email, 'supabase')

    def dev_login(self, email):
        if self.config.provider != 'local' or not self.config.dev_login:
            raise CloudError('E_FORBIDDEN', 'Đăng nhập dev không được bật.', 403)
        normalized = validate_email(email)
        if not normalized:
            raise CloudError('E_INVALID_ARG', 'Email không hợp lệ.')
        return normalized
