"""Local cloud store: SQLite metadata + filesystem assets (dev/self-host)."""
import json
import os
import sqlite3
import secrets
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from .errors import CloudError
from .validation import (
    compact_json_bytes,
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

CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
ASSET_CONTENT_TYPE = 'model/gltf-binary'


def _utc_after(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=max(0, int(seconds or 0)))).isoformat(timespec='seconds')


def _is_expired(expires_at):
    if not expires_at:
        return False
    try:
        raw = str(expires_at).strip()
        if raw.endswith('Z'):
            raw = raw[:-1] + '+00:00'
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > dt
    except ValueError:
        return False


class LocalStore:
    provider = 'local'

    def __init__(self, config):
        self.config = config
        self.data_dir = os.path.abspath(config.data_dir)
        self.assets_dir = os.path.join(self.data_dir, 'assets')
        self.db_path = os.path.join(self.data_dir, 'cloud.sqlite3')
        self._prepare_dirs()
        self._init_schema()

    def _prepare_dirs(self):
        if os.path.islink(self.data_dir):
            raise RuntimeError('cloud data_dir must not be a symlink')
        os.makedirs(self.data_dir, mode=0o700, exist_ok=True)
        if os.path.islink(self.assets_dir):
            raise RuntimeError('cloud assets directory must not be a symlink')
        os.makedirs(self.assets_dir, mode=0o700, exist_ok=True)
        try:
            os.chmod(self.data_dir, 0o700)
            os.chmod(self.assets_dir, 0o700)
        except OSError:
            pass

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        conn.execute('PRAGMA journal_mode = WAL')
        return conn

    def _init_schema(self):
        conn = self._connect()
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS cloud_users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cloud_projects (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    data BLOB NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cloud_assets (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT 'props',
                    tags TEXT NOT NULL DEFAULT '[]',
                    description TEXT NOT NULL DEFAULT '',
                    author_name TEXT NOT NULL DEFAULT '',
                    thumb_path TEXT NOT NULL DEFAULT '',
                    content_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    storage_path TEXT NOT NULL,
                    public INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cloud_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
                    delta INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    ref TEXT NOT NULL DEFAULT '',
                    idempotency_key TEXT NOT NULL,
                    balance_after INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(user_id, idempotency_key)
                );
                CREATE TABLE IF NOT EXISTS cloud_payments (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    plan_id TEXT NOT NULL,
                    code TEXT NOT NULL UNIQUE,
                    amount_vnd INTEGER NOT NULL,
                    credits INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    external_id TEXT NOT NULL DEFAULT '',
                    meta TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL DEFAULT '',
                    paid_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_projects_user ON cloud_projects(user_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_assets_user ON cloud_assets(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ledger_user ON cloud_ledger(user_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_payments_user ON cloud_payments(user_id, created_at DESC);
            """)
            existing_cols = {
                row['name'] for row in conn.execute('PRAGMA table_info(cloud_assets)').fetchall()
            }
            for col_name, col_def in (
                ('title', "TEXT NOT NULL DEFAULT ''"),
                ('category', "TEXT NOT NULL DEFAULT 'props'"),
                ('tags', "TEXT NOT NULL DEFAULT '[]'"),
                ('description', "TEXT NOT NULL DEFAULT ''"),
                ('author_name', "TEXT NOT NULL DEFAULT ''"),
                ('thumb_path', "TEXT NOT NULL DEFAULT ''"),
            ):
                if col_name not in existing_cols:
                    conn.execute(f'ALTER TABLE cloud_assets ADD COLUMN {col_name} {col_def}')
            pay_cols = {
                row['name'] for row in conn.execute('PRAGMA table_info(cloud_payments)').fetchall()
            }
            if 'expires_at' not in pay_cols:
                conn.execute("ALTER TABLE cloud_payments ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''")
            conn.execute('CREATE INDEX IF NOT EXISTS idx_assets_public ON cloud_assets(public, category, created_at DESC)')
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_ext "
                "ON cloud_payments(provider, external_id) WHERE external_id <> ''"
            )
        finally:
            conn.close()
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass

    @contextmanager
    def _tx(self):
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.execute('COMMIT')
        except Exception:
            try:
                conn.execute('ROLLBACK')
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    @contextmanager
    def _read(self):
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    # ------------------------------------------------------------------ users
    def ensure_user(self, identity):
        now = utc_now()
        with self._tx() as conn:
            row = conn.execute('SELECT * FROM cloud_users WHERE id = ?', (identity.id,)).fetchone()
            if not row:
                conn.execute(
                    'INSERT INTO cloud_users (id, email, created_at) VALUES (?, ?, ?)',
                    (identity.id, identity.email, now),
                )
                grant = max(0, int(self.config.free_credits))
                if grant:
                    self._insert_ledger(conn, identity.id, grant, 'signup_bonus', '', 'free:signup')
                row = conn.execute('SELECT * FROM cloud_users WHERE id = ?', (identity.id,)).fetchone()
            balance = self._balance(conn, identity.id)
            return {
                'id': row['id'],
                'email': row['email'],
                'createdAt': row['created_at'],
                'credits': balance,
            }

    def get_user(self, user_id):
        with self._read() as conn:
            row = conn.execute('SELECT * FROM cloud_users WHERE id = ?', (user_id,)).fetchone()
            if not row:
                raise CloudError('E_NOT_FOUND', 'Không tìm thấy người dùng.', 404)
            return {
                'id': row['id'],
                'email': row['email'],
                'createdAt': row['created_at'],
                'credits': self._balance(conn, user_id),
            }

    def _balance(self, conn, user_id):
        row = conn.execute(
            'SELECT COALESCE(SUM(delta), 0) AS balance FROM cloud_ledger WHERE user_id = ?',
            (user_id,),
        ).fetchone()
        return int(row['balance'] or 0)

    def balance(self, user_id):
        with self._read() as conn:
            return self._balance(conn, user_id)

    def ledger(self, user_id, limit=50):
        limit = max(1, min(int(limit or 50), 200))
        with self._read() as conn:
            rows = conn.execute(
                'SELECT delta, reason, ref, balance_after, created_at '
                'FROM cloud_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?',
                (user_id, limit),
            ).fetchall()
            return [{
                'delta': int(row['delta']),
                'reason': row['reason'],
                'ref': row['ref'],
                'balanceAfter': int(row['balance_after']),
                'createdAt': row['created_at'],
            } for row in rows]

    def _insert_ledger(self, conn, user_id, delta, reason, ref, idempotency_key):
        current = self._balance(conn, user_id)
        next_balance = current + int(delta)
        cursor = conn.execute(
            'INSERT OR IGNORE INTO cloud_ledger '
            '(user_id, delta, reason, ref, idempotency_key, balance_after, created_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (user_id, int(delta), reason, ref, idempotency_key, next_balance, utc_now()),
        )
        if cursor.rowcount == 0:
            row = conn.execute(
                'SELECT balance_after FROM cloud_ledger WHERE user_id = ? AND idempotency_key = ?',
                (user_id, idempotency_key),
            ).fetchone()
            return int(row['balance_after']), False
        return next_balance, True

    def charge(self, user_id, amount, reason, ref='', idempotency_key=None):
        amount = max(0, int(amount))
        if amount == 0:
            return self.balance(user_id)
        key = idempotency_key or f'{reason}:{ref}:{secrets.token_hex(8)}'
        with self._tx() as conn:
            balance = self._balance(conn, user_id)
            if balance < amount:
                raise CloudError(
                    'E_INSUFFICIENT_CREDITS',
                    f'Không đủ credit (cần {amount}, còn {balance}).',
                    402,
                    'Nạp thêm credit trong bảng Cloud / Credit.',
                )
            next_balance, _ = self._insert_ledger(conn, user_id, -amount, reason, ref, key)
            return next_balance

    def credit(self, user_id, amount, reason, ref='', idempotency_key=None):
        amount = int(amount)
        if amount == 0:
            return self.balance(user_id), False
        key = idempotency_key or f'{reason}:{ref}:{secrets.token_hex(8)}'
        with self._tx() as conn:
            return self._insert_ledger(conn, user_id, amount, reason, ref, key)

    # --------------------------------------------------------------- projects
    def _used_bytes(self, conn, user_id):
        projects = conn.execute(
            'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM cloud_projects WHERE user_id = ?',
            (user_id,),
        ).fetchone()['n']
        assets = conn.execute(
            'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM cloud_assets WHERE user_id = ?',
            (user_id,),
        ).fetchone()['n']
        return int(projects or 0) + int(assets or 0)

    def save_project(self, user_id, project_id, name, data_obj):
        try:
            payload, parsed, size = validate_project_data(data_obj, self.config.max_project_bytes)
        except ValueError as error:
            raise CloudError('E_INVALID_ARG', str(error)) from None
        project_id = validate_id(project_id) if project_id else uuid.uuid4().hex
        if not project_id:
            raise CloudError('E_INVALID_ARG', 'projectId không hợp lệ.')
        name = safe_name(name, 'Dự án không tên')
        cost = int(self.config.costs.get('save_project', 1))
        now = utc_now()

        with self._tx() as conn:
            existing = conn.execute(
                'SELECT * FROM cloud_projects WHERE id = ?', (project_id,)
            ).fetchone()
            if existing and existing['user_id'] != user_id:
                raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
            used = self._used_bytes(conn, user_id)
            if existing:
                used -= int(existing['size_bytes'])
                if used + size > self.config.max_total_bytes:
                    raise CloudError('E_QUOTA', 'Vượt hạn mức dung lượng Cloud.', 413)
                conn.execute(
                    'UPDATE cloud_projects SET name = ?, data = ?, size_bytes = ?, updated_at = ? '
                    'WHERE id = ? AND user_id = ?',
                    (name, payload, size, now, project_id, user_id),
                )
                created_at = existing['created_at']
            else:
                count = conn.execute(
                    'SELECT COUNT(*) AS n FROM cloud_projects WHERE user_id = ?', (user_id,)
                ).fetchone()['n']
                if int(count) >= self.config.max_projects:
                    raise CloudError('E_QUOTA', 'Đã đạt số dự án tối đa.', 413)
                if used + size > self.config.max_total_bytes:
                    raise CloudError('E_QUOTA', 'Vượt hạn mức dung lượng Cloud.', 413)
                conn.execute(
                    'INSERT INTO cloud_projects '
                    '(id, user_id, name, data, size_bytes, created_at, updated_at) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?)',
                    (project_id, user_id, name, payload, size, now, now),
                )
                created_at = now

            if cost:
                balance = self._balance(conn, user_id)
                if balance < cost:
                    raise CloudError(
                        'E_INSUFFICIENT_CREDITS',
                        f'Không đủ credit để lưu dự án (cần {cost}, còn {balance}).',
                        402,
                    )
                self._insert_ledger(
                    conn, user_id, -cost, 'save_project', project_id,
                    f'save:{project_id}:{secrets.token_hex(6)}',
                )
            else:
                self._balance(conn, user_id)
            balance = self._balance(conn, user_id)

        return {
            'id': project_id,
            'name': name,
            'sizeBytes': size,
            'createdAt': created_at,
            'updatedAt': now,
            'objectCount': len(parsed.get('objects') or []),
            'credits': balance,
        }

    def list_projects(self, user_id):
        with self._read() as conn:
            rows = conn.execute(
                'SELECT id, name, size_bytes, created_at, updated_at '
                'FROM cloud_projects WHERE user_id = ? ORDER BY updated_at DESC',
                (user_id,),
            ).fetchall()
            return [{
                'id': row['id'],
                'name': row['name'],
                'sizeBytes': row['size_bytes'],
                'createdAt': row['created_at'],
                'updatedAt': row['updated_at'],
            } for row in rows]

    def get_project(self, user_id, project_id):
        project_id = validate_id(project_id, required=True)
        if not project_id:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
        with self._read() as conn:
            row = conn.execute(
                'SELECT * FROM cloud_projects WHERE id = ? AND user_id = ?',
                (project_id, user_id),
            ).fetchone()
        if not row:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
        try:
            data = json.loads(bytes(row['data']).decode('utf-8'))
        except (ValueError, UnicodeError):
            raise CloudError('E_CORRUPT', 'Dữ liệu dự án bị hỏng.', 500) from None
        return {
            'id': row['id'],
            'name': row['name'],
            'sizeBytes': row['size_bytes'],
            'createdAt': row['created_at'],
            'updatedAt': row['updated_at'],
            'data': data,
        }

    def delete_project(self, user_id, project_id):
        project_id = validate_id(project_id, required=True)
        if not project_id:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
        with self._tx() as conn:
            cursor = conn.execute(
                'DELETE FROM cloud_projects WHERE id = ? AND user_id = ?',
                (project_id, user_id),
            )
            if cursor.rowcount == 0:
                raise CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404)
        return True

    # ----------------------------------------------------------------- assets
    def add_asset(self, user_id, name, data, public=True, content_type=ASSET_CONTENT_TYPE,
                  title='', category='props', tags=None, description='',
                  author_name='', thumbnail_data=None):
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

        asset_id = uuid.uuid4().hex
        safe = safe_name(name, 'model.glb')
        if not safe.lower().endswith('.glb'):
            safe = f'{safe}.glb'
        clean_title = safe_name(title, safe.rsplit('.', 1)[0])
        clean_category = validate_category(category)
        clean_tags = validate_tags(tags)
        clean_desc = safe_description(description)
        clean_author = safe_name(author_name, 'Creator')[:40]
        storage_path = os.path.join(self.assets_dir, f'{asset_id}.glb')
        thumb_path = os.path.join(self.assets_dir, f'{asset_id}.png') if thumb_payload else ''
        cost = int(self.config.costs.get('upload_asset', 5))
        created_at = utc_now()

        temp_path = f'{storage_path}.tmp'
        thumb_temp = f'{thumb_path}.tmp' if thumb_path else ''
        try:
            with open(temp_path, 'wb') as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, storage_path)
            if thumb_payload and thumb_path:
                with open(thumb_temp, 'wb') as handle:
                    handle.write(thumb_payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(thumb_temp, 0o600)
                os.replace(thumb_temp, thumb_path)
            with self._tx() as conn:
                count = conn.execute(
                    'SELECT COUNT(*) AS n FROM cloud_assets WHERE user_id = ?', (user_id,)
                ).fetchone()['n']
                if int(count) >= self.config.max_assets:
                    raise CloudError('E_QUOTA', 'Đã đạt số tệp tối đa.', 413)
                used = self._used_bytes(conn, user_id)
                if used + len(payload) > self.config.max_total_bytes:
                    raise CloudError('E_QUOTA', 'Vượt hạn mức dung lượng Cloud.', 413)
                balance = self._balance(conn, user_id)
                if balance < cost:
                    raise CloudError(
                        'E_INSUFFICIENT_CREDITS',
                        f'Không đủ credit để tải lên (cần {cost}, còn {balance}).',
                        402,
                    )
                conn.execute(
                    'INSERT INTO cloud_assets '
                    '(id, user_id, name, title, category, tags, description, author_name, thumb_path, '
                    'content_type, size_bytes, storage_path, public, created_at) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (
                        asset_id, user_id, safe, clean_title, clean_category,
                        json.dumps(clean_tags, ensure_ascii=False), clean_desc, clean_author, thumb_path,
                        content_type, len(payload), storage_path, 1 if public else 0, created_at,
                    ),
                )
                if cost:
                    self._insert_ledger(
                        conn, user_id, -cost, 'upload_asset', asset_id,
                        f'asset:{asset_id}:{secrets.token_hex(6)}',
                    )
                balance = self._balance(conn, user_id)
        except Exception:
            for path in (temp_path, storage_path, thumb_temp, thumb_path):
                if path:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
            raise

        return {
            'id': asset_id,
            'name': safe,
            'title': clean_title,
            'category': clean_category,
            'tags': clean_tags,
            'description': clean_desc,
            'authorName': clean_author,
            'contentType': content_type,
            'sizeBytes': len(payload),
            'public': bool(public),
            'createdAt': created_at,
            'url': f'/api/cloud/public/assets/{asset_id}' if public else None,
            'thumbUrl': f'/api/cloud/public/thumbs/{asset_id}' if (public and thumb_path) else None,
            'credits': balance,
        }

    def list_assets(self, user_id):
        with self._read() as conn:
            rows = conn.execute(
                'SELECT id, user_id, name, title, category, tags, description, author_name, thumb_path, '
                'content_type, size_bytes, public, created_at '
                'FROM cloud_assets WHERE user_id = ? ORDER BY created_at DESC',
                (user_id,),
            ).fetchall()
            return [self._asset_row(row, viewer_user_id=user_id) for row in rows]

    def list_public_assets(self, category='all', query='', limit=48, offset=0, viewer_user_id=None):
        limit = max(1, min(int(limit or 48), 100))
        offset = max(0, int(offset or 0))
        cat = str(category or 'all').strip().lower()
        q = str(query or '').strip().lower()
        sql = (
            'SELECT id, user_id, name, title, category, tags, description, author_name, thumb_path, '
            'content_type, size_bytes, public, created_at '
            'FROM cloud_assets WHERE public = 1'
        )
        params = []
        if cat and cat != 'all':
            sql += ' AND category = ?'
            params.append(validate_category(cat))
        if q:
            like = f'%{q}%'
            sql += (
                ' AND (lower(title) LIKE ? OR lower(name) LIKE ? OR lower(description) LIKE ? '
                'OR lower(tags) LIKE ? OR lower(author_name) LIKE ?)'
            )
            params.extend([like, like, like, like, like])
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
        params.extend([limit, offset])
        with self._read() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
            return [self._asset_row(row, viewer_user_id=viewer_user_id) for row in rows]

    def get_asset(self, user_id, asset_id):
        asset_id = validate_id(asset_id, required=True)
        if not asset_id:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        with self._read() as conn:
            row = conn.execute(
                'SELECT * FROM cloud_assets WHERE id = ? AND user_id = ?',
                (asset_id, user_id),
            ).fetchone()
        if not row:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        return self._asset_row(row, viewer_user_id=user_id)

    @staticmethod
    def _asset_row(row, viewer_user_id=None):
        keys = row.keys()
        raw_tags = row['tags'] if 'tags' in keys else '[]'
        try:
            tags = json.loads(raw_tags) if isinstance(raw_tags, str) else list(raw_tags or [])
        except (ValueError, TypeError):
            tags = []
        is_public = bool(row['public'])
        thumb_path = row['thumb_path'] if 'thumb_path' in keys else ''
        row_id = row['id']
        return {
            'id': row_id,
            'name': row['name'],
            'title': (row['title'] if 'title' in keys and row['title'] else row['name'].rsplit('.', 1)[0]),
            'category': (row['category'] if 'category' in keys and row['category'] else 'props'),
            'tags': tags if isinstance(tags, list) else [],
            'description': row['description'] if 'description' in keys else '',
            'authorName': row['author_name'] if 'author_name' in keys and row['author_name'] else 'Creator',
            'contentType': row['content_type'],
            'sizeBytes': row['size_bytes'],
            'public': is_public,
            'createdAt': row['created_at'],
            'url': f'/api/cloud/public/assets/{row_id}' if is_public else None,
            'thumbUrl': f'/api/cloud/public/thumbs/{row_id}' if (is_public and thumb_path) else None,
            'isOwner': bool(viewer_user_id and 'user_id' in keys and row['user_id'] == viewer_user_id),
        }

    def read_public_thumb(self, asset_id):
        asset_id = validate_id(asset_id, required=True)
        if not asset_id:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy ảnh.', 404)
        with self._read() as conn:
            row = conn.execute(
                'SELECT thumb_path FROM cloud_assets WHERE id = ? AND public = 1', (asset_id,)
            ).fetchone()
        if not row or not row['thumb_path']:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy ảnh.', 404)
        path = row['thumb_path']
        if not os.path.isfile(path):
            raise CloudError('E_NOT_FOUND', 'Ảnh không còn trên máy chủ.', 404)
        with open(path, 'rb') as handle:
            return handle.read()

    def read_public_asset(self, asset_id):
        asset_id = validate_id(asset_id, required=True)
        if not asset_id:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        with self._read() as conn:
            row = conn.execute(
                'SELECT * FROM cloud_assets WHERE id = ? AND public = 1', (asset_id,)
            ).fetchone()
        if not row:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        path = row['storage_path']
        if not os.path.isfile(path):
            raise CloudError('E_NOT_FOUND', 'Tệp không còn trên máy chủ.', 404)
        with open(path, 'rb') as handle:
            payload = handle.read()
        return payload, row['content_type'], row['name']

    def delete_asset(self, user_id, asset_id):
        asset_id = validate_id(asset_id, required=True)
        if not asset_id:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
        with self._tx() as conn:
            row = conn.execute(
                'SELECT storage_path, thumb_path FROM cloud_assets WHERE id = ? AND user_id = ?',
                (asset_id, user_id),
            ).fetchone()
            if not row:
                raise CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404)
            conn.execute('DELETE FROM cloud_assets WHERE id = ? AND user_id = ?', (asset_id, user_id))
        for path in (row['storage_path'], row['thumb_path']):
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass
        return True

    # --------------------------------------------------------------- payments
    @staticmethod
    def _new_code():
        return 'WBS' + ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))

    def create_payment(self, user_id, provider, plan_id, amount_vnd, credits, meta=None):
        payment_id = uuid.uuid4().hex
        now = utc_now()
        ttl = int(getattr(self.config, 'payment_ttl_seconds', 1800) or 1800)
        expires_at = _utc_after(ttl)
        with self._tx() as conn:
            for _ in range(20):
                code = self._new_code()
                exists = conn.execute(
                    'SELECT 1 FROM cloud_payments WHERE code = ?', (code,)
                ).fetchone()
                if not exists:
                    break
            else:
                raise CloudError('E_CONFLICT', 'Không tạo được mã giao dịch.', 500)
            conn.execute(
                'INSERT INTO cloud_payments '
                '(id, user_id, provider, plan_id, code, amount_vnd, credits, status, meta, created_at, expires_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (payment_id, user_id, provider, plan_id, code, int(amount_vnd), int(credits),
                 'pending', json.dumps(meta or {}, ensure_ascii=False), now, expires_at),
            )
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

    def _payment_row(self, row):
        keys = row.keys()
        exp = row['expires_at'] if 'expires_at' in keys and row['expires_at'] else None
        return {
            'id': row['id'],
            'code': row['code'],
            'provider': row['provider'],
            'planId': row['plan_id'],
            'amountVnd': int(row['amount_vnd']),
            'credits': int(row['credits']),
            'status': row['status'],
            'createdAt': row['created_at'],
            'expiresAt': exp,
            'paidAt': row['paid_at'],
        }

    def get_payment(self, user_id, code):
        with self._read() as conn:
            row = conn.execute(
                'SELECT * FROM cloud_payments WHERE code = ? AND user_id = ?',
                (str(code or '').strip().upper(), user_id),
            ).fetchone()
        if not row:
            raise CloudError('E_NOT_FOUND', 'Không tìm thấy giao dịch.', 404)
        return self._payment_row(row)

    def get_payment_by_code(self, code):
        with self._read() as conn:
            row = conn.execute(
                'SELECT * FROM cloud_payments WHERE code = ?',
                (str(code or '').strip().upper(),),
            ).fetchone()
        return self._payment_row(row) if row else None

    def list_payments(self, user_id, limit=30):
        limit = max(1, min(int(limit or 30), 100))
        with self._read() as conn:
            rows = conn.execute(
                'SELECT * FROM cloud_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
                (user_id, limit),
            ).fetchall()
        return [self._payment_row(row) for row in rows]

    def find_payment_by_code(self, code):
        code = str(code or '').strip().upper()
        with self._tx() as conn:
            row = conn.execute('SELECT * FROM cloud_payments WHERE code = ?', (code,)).fetchone()
        if not row:
            return None
        out = self._payment_row(row)
        out['userId'] = row['user_id']
        return out

    def mark_payment_paid(self, code, external_id='', paid_amount_vnd=None, provider=''):
        code = str(code or '').strip().upper()
        ext = str(external_id or '').strip()
        with self._tx() as conn:
            row = conn.execute('SELECT * FROM cloud_payments WHERE code = ?', (code,)).fetchone()
            if not row:
                raise CloudError('E_NOT_FOUND', 'Không tìm thấy giao dịch.', 404)
            if provider and row['provider'] != provider:
                raise CloudError('E_INVALID_ARG', 'Provider không khớp giao dịch.', 400)
            if row['status'] == 'paid':
                return {
                    'applied': False,
                    'reason': 'already_paid',
                    'payment': self._payment_row(row),
                    'credits': self._balance(conn, row['user_id']),
                }
            if row['status'] == 'refunded':
                return {
                    'applied': False,
                    'reason': 'already_refunded',
                    'payment': self._payment_row(row),
                    'credits': self._balance(conn, row['user_id']),
                }
            exp = row['expires_at'] if 'expires_at' in row.keys() else ''
            if row['status'] == 'expired' or _is_expired(exp):
                if row['status'] != 'expired':
                    conn.execute("UPDATE cloud_payments SET status = 'expired' WHERE code = ?", (code,))
                updated = conn.execute('SELECT * FROM cloud_payments WHERE code = ?', (code,)).fetchone()
                return {
                    'applied': False,
                    'reason': 'expired',
                    'payment': self._payment_row(updated),
                    'credits': self._balance(conn, row['user_id']),
                }
            if ext:
                dup = conn.execute(
                    'SELECT code FROM cloud_payments WHERE provider = ? AND external_id = ? AND code <> ?',
                    (row['provider'], ext, code),
                ).fetchone()
                if dup:
                    return {
                        'applied': False,
                        'reason': 'duplicate_external_id',
                        'payment': self._payment_row(row),
                        'credits': self._balance(conn, row['user_id']),
                    }
            if paid_amount_vnd is not None and int(paid_amount_vnd) < int(row['amount_vnd']):
                try:
                    conn.execute(
                        "UPDATE cloud_payments SET status = 'underpaid', external_id = ? WHERE code = ?",
                        (ext, code),
                    )
                except sqlite3.IntegrityError:
                    return {
                        'applied': False,
                        'reason': 'duplicate_external_id',
                        'payment': self._payment_row(row),
                        'credits': self._balance(conn, row['user_id']),
                    }
                updated = conn.execute('SELECT * FROM cloud_payments WHERE code = ?', (code,)).fetchone()
                return {
                    'applied': False,
                    'reason': 'underpaid',
                    'payment': self._payment_row(updated),
                    'credits': self._balance(conn, row['user_id']),
                }
            paid_at = utc_now()
            try:
                conn.execute(
                    "UPDATE cloud_payments SET status = 'paid', external_id = ?, paid_at = ? WHERE code = ?",
                    (ext, paid_at, code),
                )
            except sqlite3.IntegrityError:
                return {
                    'applied': False,
                    'reason': 'duplicate_external_id',
                    'payment': self._payment_row(row),
                    'credits': self._balance(conn, row['user_id']),
                }
            self._insert_ledger(
                conn, row['user_id'], int(row['credits']), 'topup', code,
                f'payment:{code}',
            )
            updated = conn.execute('SELECT * FROM cloud_payments WHERE code = ?', (code,)).fetchone()
            return {
                'applied': True,
                'reason': 'credited',
                'payment': self._payment_row(updated),
                'credits': self._balance(conn, row['user_id']),
            }

    def refund_payment(self, code='', external_id='', provider=''):
        code = str(code or '').strip().upper()
        ext = str(external_id or '').strip()
        with self._tx() as conn:
            row = None
            if code:
                row = conn.execute('SELECT * FROM cloud_payments WHERE code = ?', (code,)).fetchone()
            if not row and ext and provider:
                row = conn.execute(
                    'SELECT * FROM cloud_payments WHERE provider = ? AND external_id = ?',
                    (provider, ext),
                ).fetchone()
            if not row:
                raise CloudError('E_NOT_FOUND', 'Không tìm thấy giao dịch.', 404)
            if provider and row['provider'] != provider:
                raise CloudError('E_INVALID_ARG', 'Provider không khớp giao dịch.', 400)
            if row['status'] == 'refunded':
                return {
                    'applied': False,
                    'reason': 'already_refunded',
                    'payment': self._payment_row(row),
                    'credits': self._balance(conn, row['user_id']),
                }
            balance = self._balance(conn, row['user_id'])
            clawback = min(max(0, balance), max(0, int(row['credits']))) if row['status'] == 'paid' else 0
            if clawback > 0:
                self._insert_ledger(
                    conn, row['user_id'], -clawback, 'refund', row['code'],
                    f"refund:{row['code']}",
                )
            # Persist early refunds so a later paid webhook cannot credit the order.
            conn.execute("UPDATE cloud_payments SET status = 'refunded' WHERE code = ?", (row['code'],))
            updated = conn.execute('SELECT * FROM cloud_payments WHERE code = ?', (row['code'],)).fetchone()
            return {
                'applied': True,
                'reason': 'refunded',
                'payment': self._payment_row(updated),
                'credits': self._balance(conn, row['user_id']),
            }

    # ------------------------------------------------------------------- GDPR
    def export_user_data(self, user_id):
        user = self.get_user(user_id)
        with self._read() as conn:
            proj_rows = conn.execute(
                'SELECT id, name, data, size_bytes, created_at, updated_at '
                'FROM cloud_projects WHERE user_id = ? ORDER BY updated_at DESC',
                (user_id,),
            ).fetchall()
            asset_rows = conn.execute(
                'SELECT id, name, title, category, tags, description, author_name, '
                'content_type, size_bytes, public, created_at '
                'FROM cloud_assets WHERE user_id = ? ORDER BY created_at DESC',
                (user_id,),
            ).fetchall()
        projects = []
        for row in proj_rows:
            try:
                parsed = json.loads(bytes(row['data']).decode('utf-8'))
            except (ValueError, UnicodeError):
                parsed = None
            projects.append({
                'id': row['id'],
                'name': row['name'],
                'sizeBytes': int(row['size_bytes']),
                'createdAt': row['created_at'],
                'updatedAt': row['updated_at'],
                'data': parsed,
            })
        assets = [{
            'id': row['id'],
            'name': row['name'],
            'title': row['title'],
            'category': row['category'],
            'description': row['description'],
            'sizeBytes': int(row['size_bytes']),
            'public': bool(row['public']),
            'createdAt': row['created_at'],
        } for row in asset_rows]
        return {
            'exportedAt': utc_now(),
            'user': user,
            'stats': self.stats(user_id),
            'projects': projects,
            'assets': assets,
            'ledger': self.ledger(user_id, 200),
            'payments': self.list_payments(user_id, 100),
        }

    def delete_user(self, user_id):
        with self._tx() as conn:
            user_row = conn.execute('SELECT id FROM cloud_users WHERE id = ?', (user_id,)).fetchone()
            if not user_row:
                raise CloudError('E_NOT_FOUND', 'Không tìm thấy người dùng.', 404)
            asset_rows = conn.execute(
                'SELECT storage_path, thumb_path FROM cloud_assets WHERE user_id = ?',
                (user_id,),
            ).fetchall()
            conn.execute('DELETE FROM cloud_users WHERE id = ?', (user_id,))
        for row in asset_rows:
            for file_path in (row['storage_path'], row['thumb_path']):
                if file_path:
                    try:
                        os.remove(file_path)
                    except OSError:
                        pass
        return True

    # ------------------------------------------------------------------ stats
    def stats(self, user_id):
        with self._read() as conn:
            projects = conn.execute(
                'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b '
                'FROM cloud_projects WHERE user_id = ?', (user_id,)
            ).fetchone()
            assets = conn.execute(
                'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b '
                'FROM cloud_assets WHERE user_id = ?', (user_id,)
            ).fetchone()
            return {
                'projects': int(projects['n']),
                'assets': int(assets['n']),
                'usedBytes': int(projects['b']) + int(assets['b']),
                'maxTotalBytes': self.config.max_total_bytes,
            }
