"""Shared validation for cloud payloads and identifiers."""
import json
import re
from datetime import datetime, timezone

PROJECT_FORMAT = 'web-blender-studio-project'
COMMUNITY_CATEGORIES = (
    'materials', 'environments', 'vegetation',
    'architecture', 'characters', 'props', 'scenes',
)
EMAIL_RE = re.compile(r'^[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$')
ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,64}$')


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def normalize_email(value):
    return str(value or '').strip().lower()


def validate_email(value):
    email = normalize_email(value)
    if len(email) < 5 or len(email) > 254 or '\n' in email or '\r' in email:
        return None
    return email if EMAIL_RE.match(email) else None


def validate_id(value, required=False):
    text = str(value or '').strip()
    if not text and not required:
        return ''
    return text if ID_RE.match(text) else None


def safe_name(value, fallback='Untitled'):
    text = str(value or '').replace('\\', '/').split('/')[-1]
    text = ''.join(ch for ch in text if ch >= ' ' and ch != '\x7f').strip()
    text = text[:120].strip()
    return text or fallback


def compact_json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def validate_project_data(data, max_bytes):
    """Returns (json_bytes, parsed, size) or raises ValueError."""
    if not isinstance(data, dict):
        raise ValueError('data phải là object JSON của dự án.')
    meta = data.get('meta')
    if not isinstance(meta, dict) or meta.get('format') != PROJECT_FORMAT:
        raise ValueError('Dự án không đúng định dạng web-blender-studio-project.')
    try:
        payload = compact_json_bytes(data)
    except (TypeError, ValueError):
        raise ValueError('Dữ liệu dự án không serialize được.') from None
    if len(payload) > max_bytes:
        raise ValueError('Dự án vượt giới hạn dung lượng.')
    return payload, data, len(payload)


def validate_glb(data):
    if not isinstance(data, (bytes, bytearray)):
        raise ValueError('Thiếu dữ liệu GLB.')
    payload = bytes(data)
    if len(payload) < 12 or payload[:4] != b'glTF':
        raise ValueError('Tệp tải lên không phải GLB hợp lệ.')
    return payload


def validate_png(data, max_bytes=524288):
    if not isinstance(data, (bytes, bytearray)):
        raise ValueError('Thiếu dữ liệu ảnh preview PNG.')
    payload = bytes(data)
    if len(payload) < 8 or payload[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Ảnh preview phải đúng định dạng PNG.')
    if len(payload) > max_bytes:
        raise ValueError('Ảnh preview vượt giới hạn 512 KB.')
    return payload


def validate_category(value, default='props'):
    raw = str(value or '').strip().lower()
    aliases = {
        'material': 'materials', 'pbr': 'materials',
        'environment': 'environments', 'landscape': 'environments', 'hdri': 'environments', 'sky': 'environments',
        'plant': 'vegetation', 'plants': 'vegetation', 'tree': 'vegetation', 'trees': 'vegetation', 'nature': 'vegetation',
        'arch': 'architecture', 'building': 'architecture', 'buildings': 'architecture',
        'character': 'characters', 'avatar': 'characters',
        'prop': 'props', 'scene': 'scenes',
    }
    raw = aliases.get(raw, raw)
    return raw if raw in COMMUNITY_CATEGORIES else default


def validate_tags(raw, max_items=12):
    if isinstance(raw, str):
        items = [part.strip() for part in raw.split(',')]
    elif isinstance(raw, list):
        items = [str(item or '').strip() for item in raw]
    else:
        return []
    out = []
    seen = set()
    for item in items:
        clean = ''.join(ch for ch in item if ch >= ' ' and ch != '\x7f').strip()[:32].lower()
        if clean and clean not in seen:
            seen.add(clean)
            out.append(clean)
            if len(out) >= max_items:
                break
    return out


def safe_description(value, max_len=400):
    text = str(value or '')
    text = ''.join(ch for ch in text if ch >= ' ' and ch != '\x7f').strip()
    return text[:max_len]


def author_display_name(email_or_name, fallback='Creator'):
    text = str(email_or_name or '').strip()
    if not text:
        return fallback
    if '@' in text:
        text = text.split('@', 1)[0]
    return safe_name(text, fallback)[:40]
