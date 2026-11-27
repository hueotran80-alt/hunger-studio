"""Supabase REST/Storage adapter. The service key never leaves the server."""
import hashlib
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode

from .errors import CloudError
from .validation import (
    safe_description,
    safe_name,
    utc_now,
    validate_category,
    validate_glb,
    validate_id,
    validate_png,
    validate_project_data,
    validate_tags,
)

ASSET_CONTENT_TYPE = 'model/gltf-binary'
CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
BASE_URL_RE = re.compile(r'^https://[A-Za-z0-9.-]+(?::\d+)?$|^http://(?:127\.0\.0\.1|localhost)(?::\d+)?$')


def _default_http(method, url, headers, payload, timeout=25):
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.getheaders()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers or {}), error.read()
    except (urllib.error.URLError, OSError) as error:
        raise CloudError('E_PROVIDER', f'Không kết nối được Supabase: {error}', 502) from None


class SupabaseClient:
    def __init__(self, config, http=None, clock=time.time):
        base = (config.supabase_url or '').rstrip('/')
        if not BASE_URL_RE.match(base):
            raise RuntimeError('Supabase URL must be https (http only for localhost).')
        self.base = base
        self.anon_key = config.supabase_anon_key
        self.service_key = config.supabase_service_key
        self.http = http or _default_http
        self.clock = clock
        self._cache = {}
        self._cache_lock = threading.Lock()

    def _request(self, method, path, token=None, body=None, raw=None, api_key=None,
                 extra_headers=None, timeout=25):
        url = f'{self.base}{path}'
        headers = {
            'apikey': api_key or self.service_key,
            'Authorization': f'Bearer {token or self.service_key}',
            'Accept': 'application/json',
        }
        payload = raw
        if body is not None:
            payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if extra_headers:
            headers.update(extra_headers)
        status, response_headers, data = self.http(method, url, headers, payload, timeout)
        if status < 200 or status >= 300:
            detail = ''
            try:
                parsed = json.loads(data.decode('utf-8'))
                detail = parsed.get('message') or parsed.get('error_description') or parsed.get('error') or ''
            except (ValueError, UnicodeError, AttributeError):
                detail = data[:200].decode('utf-8', errors='replace')
            code = 'E_PROVIDER'
            mapped = 502
            if status in (401, 403):
                code, mapped = 'E_AUTH_INVALID', 401
            elif status == 404:
                code, mapped = 'E_NOT_FOUND', 404
            if 'insufficient_credits' in str(detail):
                code, mapped = 'E_INSUFFICIENT_CREDITS', 402
                detail = 'Không đủ credit.'
            elif 'quota_max_assets' in str(detail):
                code, mapped = 'E_QUOTA', 413
                detail = 'Đã đạt số tệp tối đa.'
            elif 'quota_max_bytes' in str(detail):
                code, mapped = 'E_QUOTA', 413
                detail = 'Vượt hạn mức dung lượng Cloud.'
            raise CloudError(code, f'Supabase HTTP {status}: {str(detail)[:200]}', mapped)
        if not data:
            return None
        try:
            return json.loads(data.decode('utf-8'))
        except (ValueError, UnicodeError):
            return None

    def api(self, method, path, body=None, prefer=None):
        headers = {}
        if prefer:
            headers['Prefer'] = prefer
        return self._request(method, path, body=body, extra_headers=headers)

    def rpc(self, name, args):
        return self._request('POST', f'/rest/v1/rpc/{quote(name)}', body=args)

    def validate_user(self, access_token):
        if not access_token:
            return None
        cache_key = hashlib.sha256(access_token.encode('utf-8')).hexdigest()
        now = self.clock()
        with self._cache_lock:
            cached = self._cache.get(cache_key)
            if cached and cached[0] > now:
                return cached[1]
        try:
            user = self._request(
                'GET', '/auth/v1/user', token=access_token, api_key=self.anon_key)
        except CloudError as error:
            if error.status == 401:
                return None
            raise
        if not isinstance(user, dict) or not user.get('id'):
            return None
        result = {'id': str(user['id']), 'email': user.get('email') or ''}
        with self._cache_lock:
            if len(self._cache) > 1000:
                self._cache.clear()
            self._cache[cache_key] = (now + 60, result)
        return result

    def storage_upload(self, bucket, path, data, content_type=ASSET_CONTENT_TYPE):
        self._request(
            'POST', f'/storage/v1/object/{quote(bucket, safe="")}/{quote(path, safe="/")}',
            raw=data,
            extra_headers={'Content-Type': content_type, 'x-upsert': 'true'},
        )

    def storage_delete(self, bucket, path):
        try:
            self._request(
                'DELETE', f'/storage/v1/object/{quote(bucket, safe="")}/{quote(path, safe="/")}')
        except CloudError as error:
            if error.status != 404:
                raise

    def signed_url(self, bucket, path, expires_in=300):
        expires_in = max(60, min(int(expires_in), 3600))
        result = self._request(
            'POST',
            f'/storage/v1/object/sign/{quote(bucket, safe="")}/{quote(path, safe="/")}',
            body={'expiresIn': expires_in},
        )
        signed_path = result.get('signedURL') if isinstance(result, dict) else None
        if not isinstance(signed_path, str):
            raise CloudError('E_PROVIDER', 'Supabase trả signed URL không hợp lệ.', 502)
        if signed_path.startswith('/object/'):
            signed_path = f'/storage/v1{signed_path}'
        if not signed_path.startswith('/storage/v1/object/sign/'):
            raise CloudError('E_PROVIDER', 'Supabase trả signed URL ngoài phạm vi Storage.', 502)
        return f'{self.base}{signed_path}'


class SupabaseStore:
    provider = 'supabase'

    def __init__(self, config, client=None):
        self.config = config
        self.client = client or SupabaseClient(config)
        self.users_table = 'cloud_users'
        self.projects_table = 'cloud_projects'
        self.assets_table = 'cloud_assets'
        self.ledger_table = 'cloud_ledger'
        self.payments_table = 'cloud_payments'

    @staticmethod
    def _uid(user_id):
        uid = validate_id(user_id, required=True)
        if not uid:
            raise CloudError('E_AUTH_INVALID', 'User id không hợp lệ.', 401)
        return uid

    def _select(self, table, params, single=False):
        query = urlencode(params, safe=':,().*')
        rows = self.client.api('GET', f'/rest/v1/{table}?{query}')
        if single:
            if not isinstance(rows, list) or not rows:
                return None
            return rows[0]
        return rows if isinstance(rows, list) else []

    def _insert(self, table, row, prefer='return=representation', on_conflict=None):
        path = f'/rest/v1/{table}'
        if on_conflict:
            path += f'?on_conflict={quote(on_conflict)}'
        result = self.client.api('POST', path, body=row, prefer=prefer)
        return result

    def ensure_user(self, identity):
        now = utc_now()
        result = self._insert(
            self.users_table,
            {'id': identity.id, 'email': identity.email, 'created_at': now},
            prefer='resolution=merge-duplicates,return=representation',
            on_conflict='id',
        )
        row = (result or [{}])[0] if isinstance(result, list) else {}
        if row.get('email') != identity.email:
            self.client.api(
                'PATCH', f'/rest/v1/{self.users_table}?id=eq.{quote(identity.id, safe="")}',
                body={'email': identity.email}, prefer='return=minimal')
        if self.config.free_credits:
            self.client.rpc('cloud_grant_free', {
                'p_user_id': identity.id,
                'p_amount': int(self.config.free_credits),
            })
        return self.get_user(identity.id)

    def get_user(self, user_id):
        rows = self._select(
            self.users_table,
            {'id': f'eq.{self._uid(user_id)}', 'select': 'id,email,created_at', 'limit': '1'},
        )
        if not rows:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy người dùng.', 404)
        user = rows[0]
        return {
            'id': user['id'],
            'email': user.get('email', ''),
            'createdAt': user.get('created_at'),
            'credits': self.balance(user_id),
        }

    def balance(self, user_id):
        value = self.client.rpc('cloud_balance', {'p_user_id': user_id})
        if isinstance(value, list):
            value = value[0] if value else 0
        if isinstance(value, dict):
            value = value.get('cloud_balance', 0)
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    def ledger(self, user_id, limit=50):
        limit = max(1, min(int(limit or 50), 200))
        rows = self._select(self.ledger_table, {
            'user_id': f'eq.{self._uid(user_id)}',
            'select': 'delta,reason,ref,balance_after,created_at',
            'order': 'id.desc',
            'limit': str(limit),
        })
        return [{
            'delta': int(row.get('delta') or 0),
            'reason': row.get('reason', ''),
            'ref': row.get('ref', ''),
            'balanceAfter': int(row.get('balance_after') or 0),
            'createdAt': row.get('created_at'),
        } for row in rows]

    def charge(self, user_id, amount, reason, ref='', idempotency_key=None):
        amount = max(0, int(amount))
        if amount == 0:
            return self.balance(user_id)
        key = idempotency_key or f'{reason}:{ref}:{uuid.uuid4().hex}'
        value = self.client.rpc('cloud_charge', {
            'p_user_id': user_id,
            'p_amount': amount,
            'p_reason': reason,
            'p_ref': str(ref),
            'p_key': key,
        })
        if isinstance(value, list):
            value = value[0] if value else 0
        if isinstance(value, dict):
            value = value.get('cloud_charge', value.get('balance', 0))
        return int(value or 0)

    def credit(self, user_id, amount, reason, ref='', idempotency_key=None):
        key = idempotency_key or f'{reason}:{ref}:{uuid.uuid4().hex}'
        value = self.client.rpc('cloud_credit', {
            'p_user_id': user_id,
            'p_amount': int(amount),
            'p_reason': reason,
            'p_ref': str(ref),
            'p_key': key,
        })
        if isinstance(value, list):
            value = value[0] if value else 0
        if isinstance(value, dict):
            value = value.get('cloud_credit', value.get('balance', 0))
        return int(value or 0), True

    def stats(self, user_id):
        value = self.client.rpc('cloud_stats', {'p_user_id': user_id})
        if isinstance(value, list):
            value = value[0] if value else {}
        if not isinstance(value, dict):
            value = {}
        return {
            'projects': int(value.get('projects') or 0),
            'assets': int(value.get('assets') or 0),
            'usedBytes': int(value.get('used_bytes') or 0),
            'maxTotalBytes': self.config.max_total_bytes,
        }

    # --------------------------------------------------------------- projects
    def save_project(self, user_id, project_id, name, data_obj):
        try:
            payload, parsed, size = validate_project_data(data_obj, self.config.max_project_bytes)
        except ValueError as error:
            raise CloudError('E_INVALID_ARG', str(error)) from None
        project_id = validate_id(project_id) if project_id else str(uuid.uuid4())
        if not project_id:
            raise CloudError('E_INVALID_ARG', 'projectId không hợp lệ.')
        name = safe_name(name, 'Dự án không tên')
        cost = int(self.config.costs.get('save_project', 1))

        existing = self._select(self.projects_table, {
            'id': f'eq.{project_id}',
            'select': 'id,user_id,size_bytes,created_at',
            'limit': '1',
        })
        existing = existing[0] if existing else None
        if existing and existing.get('user_id') != user_id:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
        stats = self.stats(user_id)
        used = stats['usedBytes'] - (int(existing.get('size_bytes') or 0) if existing else 0)
        if not existing and stats['projects'] >= self.config.max_projects:
            raise CloudError('E_QUOTA', 'Đã đạt số dự án tối đa.', 413)
        if used + size > self.config.max_total_bytes:
            raise CloudError('E_QUOTA', 'Vượt hạn mức dung lượng Cloud.', 413)

        charge_key = f'save:{project_id}:{uuid.uuid4().hex}'
        balance = self.charge(user_id, cost, 'save_project', project_id, charge_key) if cost else self.balance(user_id)
        now = utc_now()
        row = {
            'id': project_id,
            'user_id': user_id,
            'name': name,
            'data': parsed,
            'size_bytes': size,
            'updated_at': now,
        }
        if not existing:
            row['created_at'] = now
        try:
            result = self._insert(
                self.projects_table, row,
                prefer='resolution=merge-duplicates,return=representation',
                on_conflict='id',
            )
            saved = (result or [{}])[0] if isinstance(result, list) else row
        except Exception:
            if cost:
                try:
                    self.credit(user_id, cost, 'refund_save_failed', project_id, f'refund:{charge_key}')
                except CloudError:
                    pass
            raise
        return {
            'id': project_id,
            'name': name,
            'sizeBytes': size,
            'createdAt': saved.get('created_at') or (existing or {}).get('created_at') or now,
            'updatedAt': now,
            'objectCount': len(parsed.get('objects') or []),
            'credits': balance,
        }

    def list_projects(self, user_id):
        rows = self._select(self.projects_table, {
            'user_id': f'eq.{self._uid(user_id)}',
            'select': 'id,name,size_bytes,created_at,updated_at',
            'order': 'updated_at.desc',
        })
        return [{
            'id': row['id'],
            'name': row.get('name', ''),
            'sizeBytes': int(row.get('size_bytes') or 0),
            'createdAt': row.get('created_at'),
            'updatedAt': row.get('updated_at'),
        } for row in rows]

    def get_project(self, user_id, project_id):
        project_id = validate_id(project_id, required=True)
        rows = self._select(self.projects_table, {
            'id': f'eq.{project_id}',
            'user_id': f'eq.{self._uid(user_id)}',
            'select': '*',
            'limit': '1',
        })
        if not rows:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
        row = rows[0]
        return {
            'id': row['id'],
            'name': row.get('name', ''),
            'sizeBytes': int(row.get('size_bytes') or 0),
            'createdAt': row.get('created_at'),
            'updatedAt': row.get('updated_at'),
            'data': row.get('data') or {},
        }

    def delete_project(self, user_id, project_id):
        project_id = validate_id(project_id, required=True)
        rows = self._select(self.projects_table, {
            'id': f'eq.{project_id}', 'user_id': f'eq.{self._uid(user_id)}', 'select': 'id', 'limit': '1',
        })
        if not rows:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
        self.client.api(
            'DELETE',
            f'/rest/v1/{self.projects_table}?id=eq.{project_id}&user_id=eq.{quote(str(user_id), safe="")}',
            prefer='return=minimal',
        )
        return True

    # ----------------------------------------------------------------- assets
    def add_asset(self, user_id, name, data, public=True, content_type=ASSET_CONTENT_TYPE,
                  title='', category='props', tags=None, description='',
                  author_name='', thumbnail_data=None):
        user_id = self._uid(user_id)
        try:
            payload = validate_glb(data)
        except ValueError as error:
            raise CloudError('E_UNSUPPORTED', str(error), 415) from None
        if len(payload) > self.config.max_asset_bytes:
            raise CloudError('E_TOO_LARGE', 'GLB vượt giới hạn dung lượng.', 413)
        if content_type != ASSET_CONTENT_TYPE:
            raise CloudError('E_UNSUPPORTED', 'Chỉ nhận GLB cho thư viện chia sẻ.', 415)

        thumb_payload = None
        if thumbnail_data:
            try:
                thumb_payload = validate_png(thumbnail_data)
            except ValueError as error:
                raise CloudError('E_INVALID_ARG', str(error)) from None

        safe = safe_name(name, 'model.glb')
        if not safe.lower().endswith('.glb'):
            safe = f'{safe}.glb'
        clean_title = safe_name(title, safe.rsplit('.', 1)[0])
        clean_category = validate_category(category)
        clean_tags = validate_tags(tags)
        clean_desc = safe_description(description)
        clean_author = safe_name(author_name, 'Creator')[:40]

        asset_id = str(uuid.uuid4())
        storage_path = f'{user_id}/{asset_id}.glb'
        thumb_path = f'{user_id}/{asset_id}.png' if thumb_payload else ''
        cost = int(self.config.costs.get('upload_asset', 5))
        charge_key = f'asset:{asset_id}:{uuid.uuid4().hex}'
        reserved = self.client.rpc('cloud_reserve_asset', {
            'p_user_id': user_id,
            'p_asset_id': asset_id,
            'p_name': safe,
            'p_title': clean_title,
            'p_category': clean_category,
            'p_tags': clean_tags,
            'p_description': clean_desc,
            'p_author_name': clean_author,
            'p_thumb_path': thumb_path,
            'p_content_type': content_type,
            'p_size_bytes': len(payload),
            'p_storage_path': storage_path,
            'p_public': bool(public),
            'p_max_assets': int(self.config.max_assets),
            'p_max_total_bytes': int(self.config.max_total_bytes),
            'p_cost': cost,
            'p_charge_key': charge_key,
        })
        if isinstance(reserved, list):
            reserved = reserved[0] if reserved else {}
        if not isinstance(reserved, dict):
            reserved = {}
        balance = int(reserved.get('credits') if reserved.get('credits') is not None else self.balance(user_id))
        now = str(reserved.get('created_at') or utc_now())
        try:
            self.client.storage_upload(self.config.asset_bucket, storage_path, payload, content_type=ASSET_CONTENT_TYPE)
            if thumb_payload and thumb_path:
                self.client.storage_upload(self.config.asset_bucket, thumb_path, thumb_payload, content_type='image/png')
        except Exception:
            try:
                self.client.api(
                    'DELETE',
                    f'/rest/v1/{self.assets_table}?id=eq.{asset_id}&user_id=eq.{quote(str(user_id), safe="")}',
                    prefer='return=minimal',
                )
            except CloudError:
                pass
            try:
                self.client.storage_delete(self.config.asset_bucket, storage_path)
                if thumb_path:
                    self.client.storage_delete(self.config.asset_bucket, thumb_path)
            except CloudError:
                pass
            if cost:
                try:
                    self.credit(user_id, cost, 'refund_upload_failed', asset_id, f'refund:{charge_key}')
                except CloudError:
                    pass
            raise
        row = {
            'id': asset_id,
            'user_id': user_id,
            'name': safe,
            'title': clean_title,
            'category': clean_category,
            'tags': clean_tags,
            'description': clean_desc,
            'author_name': clean_author,
            'thumb_path': thumb_path,
            'content_type': content_type,
            'size_bytes': len(payload),
            'storage_path': storage_path,
            'public': bool(public),
            'created_at': now,
        }
        return {**self._asset_row(row, viewer_user_id=user_id, include_private_url=True), 'credits': balance}

    def _asset_row(self, row, viewer_user_id=None, include_private_url=False):
        is_public = bool(row.get('public'))
        is_owner = bool(viewer_user_id and row.get('user_id') == viewer_user_id)
        thumb_path = row.get('thumb_path') or ''
        tags = row.get('tags') if isinstance(row.get('tags'), list) else []
        url = f'/api/cloud/public/assets/{row["id"]}' if is_public else None
        thumb_url = f'/api/cloud/public/thumbs/{row["id"]}' if (is_public and thumb_path) else None
        if not is_public and is_owner and include_private_url:
            url = self.client.signed_url(self.config.asset_bucket, row['storage_path'])
            if thumb_path:
                thumb_url = self.client.signed_url(self.config.asset_bucket, thumb_path)
        return {
            'id': row['id'],
            'name': row.get('name', ''),
            'title': row.get('title') or (row.get('name') or 'model').rsplit('.', 1)[0],
            'category': row.get('category') or 'props',
            'tags': tags,
            'description': row.get('description') or '',
            'authorName': row.get('author_name') or 'Creator',
            'contentType': row.get('content_type', ''),
            'sizeBytes': int(row.get('size_bytes') or 0),
            'public': is_public,
            'createdAt': row.get('created_at'),
            'url': url,
            'thumbUrl': thumb_url,
            'isOwner': is_owner,
        }

    def list_assets(self, user_id):
        rows = self._select(self.assets_table, {
            'user_id': f'eq.{self._uid(user_id)}',
            'select': 'id,user_id,name,title,category,tags,description,author_name,thumb_path,content_type,size_bytes,public,storage_path,created_at',
            'order': 'created_at.desc',
        })
        return [self._asset_row(row, viewer_user_id=user_id) for row in rows]

    def list_public_assets(self, category='all', query='', limit=48, offset=0, viewer_user_id=None):
        limit = max(1, min(int(limit or 48), 100))
        offset = max(0, int(offset or 0))
        cat = str(category or 'all').strip().lower()
        q = str(query or '').strip().lower()
        params = {
            'public': 'eq.true',
            'select': 'id,user_id,name,title,category,tags,description,author_name,thumb_path,content_type,size_bytes,public,storage_path,created_at',
            'order': 'created_at.desc',
            'limit': str(200 if q else limit),
            'offset': '0' if q else str(offset),
        }
        if cat and cat != 'all':
            params['category'] = f'eq.{validate_category(cat)}'
        rows = self._select(self.assets_table, params)
        mapped = [self._asset_row(row, viewer_user_id=viewer_user_id) for row in rows]
        if q:
            mapped = [
                item for item in mapped
                if q in ' '.join([
                    item['title'], item['name'], item['description'],
                    item['authorName'], ' '.join(item['tags']),
                ]).lower()
            ][offset:offset + limit]
        return mapped

    def get_asset(self, user_id, asset_id):
        asset_id = validate_id(asset_id, required=True)
        rows = self._select(self.assets_table, {
            'id': f'eq.{asset_id}', 'user_id': f'eq.{self._uid(user_id)}',
            'select': '*', 'limit': '1',
        })
        if not rows:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        return self._asset_row(rows[0], viewer_user_id=user_id, include_private_url=True)

    def public_asset_url(self, asset_id):
        asset_id = validate_id(asset_id, required=True)
        rows = self._select(self.assets_table, {
            'id': f'eq.{asset_id}', 'public': 'eq.true',
            'select': 'storage_path', 'limit': '1',
        })
        if not rows:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        return self.client.signed_url(self.config.asset_bucket, rows[0]['storage_path'], expires_in=120)

    def public_thumb_url(self, asset_id):
        asset_id = validate_id(asset_id, required=True)
        rows = self._select(self.assets_table, {
            'id': f'eq.{asset_id}', 'public': 'eq.true',
            'select': 'thumb_path', 'limit': '1',
        })
        if not rows or not rows[0].get('thumb_path'):
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy ảnh.', 404)
        return self.client.signed_url(self.config.asset_bucket, rows[0]['thumb_path'], expires_in=300)

    def delete_asset(self, user_id, asset_id):
        asset_id = validate_id(asset_id, required=True)
        rows = self._select(self.assets_table, {
            'id': f'eq.{asset_id}', 'user_id': f'eq.{self._uid(user_id)}',
            'select': 'id,storage_path,thumb_path', 'limit': '1',
        })
        if not rows:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        row = rows[0]
        self.client.api(
            'DELETE',
            f'/rest/v1/{self.assets_table}?id=eq.{asset_id}&user_id=eq.{quote(str(user_id), safe="")}',
            prefer='return=minimal',
        )
        try:
            self.client.storage_delete(self.config.asset_bucket, row['storage_path'])
            if row.get('thumb_path'):
                self.client.storage_delete(self.config.asset_bucket, row['thumb_path'])
        except CloudError:
            pass
        return True

    # --------------------------------------------------------------- payments
    def create_payment(self, user_id, provider, plan_id, amount_vnd, credits, meta=None):
        payment_id = str(uuid.uuid4())
        now = utc_now()
        ttl = int(getattr(self.config, 'payment_ttl_seconds', 1800) or 1800)
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=max(0, ttl))).isoformat(timespec='seconds')
        for _ in range(20):
            code = 'WBS' + ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))
            exists = self._select(self.payments_table, {
                'code': f'eq.{code}', 'select': 'id', 'limit': '1',
            })
            if not exists:
                break
        else:
            raise CloudError('E_CONFLICT', 'Không tạo được mã giao dịch.', 500)
        self._insert(self.payments_table, {
            'id': payment_id,
            'user_id': user_id,
            'provider': provider,
            'plan_id': plan_id,
            'code': code,
            'amount_vnd': int(amount_vnd),
            'credits': int(credits),
            'status': 'pending',
            'meta': meta or {},
            'created_at': now,
            'expires_at': expires_at,
        }, prefer='return=minimal')
        return {
            'id': payment_id,
            'code': code,
            'provider': provider,
            'planId': plan_id,
            'amountVnd': int(amount_vnd),
            'credits': int(credits),
            'status': 'pending',
            'createdAt': now,
            'expiresAt': expires_at,
            'paidAt': None,
        }

    @staticmethod
    def _payment_row(row):
        return {
            'id': row['id'],
            'code': row.get('code', ''),
            'provider': row.get('provider', ''),
            'planId': row.get('plan_id', ''),
            'amountVnd': int(row.get('amount_vnd') or 0),
            'credits': int(row.get('credits') or 0),
            'status': row.get('status', ''),
            'createdAt': row.get('created_at'),
            'expiresAt': row.get('expires_at'),
            'paidAt': row.get('paid_at'),
        }

    def get_payment(self, user_id, code):
        rows = self._select(self.payments_table, {
            'code': f'eq.{str(code or "").strip().upper()}',
            'user_id': f'eq.{self._uid(user_id)}',
            'select': '*', 'limit': '1',
        })
        if not rows:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy giao dịch.', 404)
        return self._payment_row(rows[0])

    def list_payments(self, user_id, limit=30):
        limit = max(1, min(int(limit or 30), 100))
        rows = self._select(self.payments_table, {
            'user_id': f'eq.{self._uid(user_id)}',
            'select': '*', 'order': 'created_at.desc', 'limit': str(limit),
        })
        return [self._payment_row(row) for row in rows]

    def find_payment_by_code(self, code):
        rows = self._select(self.payments_table, {
            'code': f'eq.{str(code or "").strip().upper()}',
            'select': '*', 'limit': '1',
        })
        if not rows:
            return None
        out = self._payment_row(rows[0])
        out['userId'] = rows[0].get('user_id', '')
        return out

    def mark_payment_paid(self, code, external_id='', paid_amount_vnd=None, provider=''):
        value = self.client.rpc('cloud_mark_payment_paid', {
            'p_code': str(code or '').strip().upper(),
            'p_external_id': str(external_id or ''),
            'p_paid_amount': None if paid_amount_vnd is None else int(paid_amount_vnd),
            'p_provider': str(provider or ''),
        })
        if isinstance(value, list):
            value = value[0] if value else {}
        if not isinstance(value, dict):
            raise CloudError('E_PROVIDER', 'Supabase trả kết quả thanh toán không hợp lệ.', 502)
        payment = value.get('payment') or {}
        return {
            'applied': bool(value.get('applied')),
            'reason': value.get('reason') or '',
            'payment': self._payment_row(payment) if payment else None,
            'credits': int(value.get('credits') or 0),
        }

    def refund_payment(self, code='', external_id='', provider=''):
        value = self.client.rpc('cloud_refund_payment', {
            'p_code': str(code or '').strip().upper(),
            'p_external_id': str(external_id or '').strip(),
            'p_provider': str(provider or '').strip(),
        })
        if isinstance(value, list):
            value = value[0] if value else {}
        if not isinstance(value, dict):
            raise CloudError('E_PROVIDER', 'Supabase trả kết quả hoàn tiền không hợp lệ.', 502)
        payment = value.get('payment') or {}
        return {
            'applied': bool(value.get('applied')),
            'reason': value.get('reason') or '',
            'payment': self._payment_row(payment) if payment else None,
            'credits': int(value.get('credits') or 0),
        }

    def export_user_data(self, user_id):
        uid = self._uid(user_id)
        user = self.get_user(user_id)
        projects_raw = self._select(self.projects_table, {
            'user_id': f'eq.{uid}', 'select': '*', 'order': 'updated_at.desc', 'limit': '500',
        })
        assets_raw = self._select(self.assets_table, {
            'user_id': f'eq.{uid}',
            'select': 'id,name,title,category,tags,description,author_name,content_type,size_bytes,public,created_at',
            'order': 'created_at.desc', 'limit': '500',
        })
        return {
            'exportedAt': utc_now(),
            'user': user,
            'stats': self.stats(user_id),
            'projects': [{
                'id': row['id'],
                'name': row.get('name', ''),
                'sizeBytes': int(row.get('size_bytes') or 0),
                'createdAt': row.get('created_at'),
                'updatedAt': row.get('updated_at'),
                'data': row.get('data'),
            } for row in projects_raw],
            'assets': [{
                'id': row['id'],
                'name': row.get('name', ''),
                'title': row.get('title', ''),
                'category': row.get('category', 'props'),
                'description': row.get('description', ''),
                'sizeBytes': int(row.get('size_bytes') or 0),
                'public': bool(row.get('public', True)),
                'createdAt': row.get('created_at'),
            } for row in assets_raw],
            'ledger': self.ledger(user_id, 200),
            'payments': self.list_payments(user_id, 100),
        }

    def delete_user(self, user_id):
        uid = self._uid(user_id)
        assets_raw = self._select(self.assets_table, {
            'user_id': f'eq.{uid}', 'select': 'storage_path,thumb_path', 'limit': '500',
        })
        for row in assets_raw:
            for field in ('storage_path', 'thumb_path'):
                path = row.get(field)
                if path:
                    try:
                        self.client.storage_delete(self.config.asset_bucket, path)
                    except CloudError:
                        pass
        self.client.api('DELETE', f'/rest/v1/{self.users_table}?id=eq.{uid}', prefer='return=minimal')
        try:
            self.client.api('DELETE', f'/auth/v1/admin/users/{uid}')
        except CloudError:
            pass
        return True
