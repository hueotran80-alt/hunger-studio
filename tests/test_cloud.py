"""Cloud layer tests: auth, projects, assets, credits, SePay/LemonSqueezy, Supabase adapter."""
import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import helpers  # noqa: E402
from cloud.auth import Authenticator, Identity  # noqa: E402
from cloud.config import CloudConfig  # noqa: E402
from cloud.errors import CloudError  # noqa: E402
from cloud.service import CloudService  # noqa: E402
from cloud.store import LocalStore  # noqa: E402
from cloud.supabase import SupabaseClient, SupabaseStore  # noqa: E402

SERVER = helpers.load_server()
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests' / 'fixtures' / 'embed-cube.glb'
SEPAY_SECRET = 'whsec_test_sepay'
LEMON_SECRET = 'ls_test_secret'


def project_doc(name='Cube'):
    return {
        'meta': {'format': 'web-blender-studio-project', 'schemaVersion': 2},
        'objects': [{'name': name, 'type': 'Mesh'}],
        'lights': [],
    }


def sepay_signature(raw):
    return 'sha256=' + hmac.new(SEPAY_SECRET.encode(), raw, hashlib.sha256).hexdigest()


def lemon_signature(raw):
    return hmac.new(LEMON_SECRET.encode(), raw, hashlib.sha256).hexdigest()


class FakeLemonHTTP:
    def __init__(self, status=201, url='https://checkout.lemonsqueezy.com/test'):
        self.calls = []
        self.status = status
        self.url = url

    def __call__(self, method, url, headers, payload, timeout=20):
        self.calls.append({'method': method, 'url': url, 'headers': headers, 'payload': payload})
        body = json.dumps({'data': {'attributes': {'url': self.url}}}).encode()
        return self.status, {}, body


class CloudHttpBase(unittest.TestCase):
    def make_config(self, **overrides):
        data = {
            'provider': 'local',
            'allow_dev_login': True,
            'session_secret': 's' * 64,
            'data_dir': self.tmp.name,
            'free_credits': 100,
            'max_projects': 50,
            'max_assets': 50,
            'max_project_bytes': 1024 * 1024,
            'max_asset_bytes': 1024 * 1024,
            'billing': {
                'sepay': {
                    'webhook_secret': SEPAY_SECRET,
                    'bank': 'VCB',
                    'account': '0123456789',
                    'holder': 'TEST USER',
                },
                'lemonsqueezy': {
                    'api_key': 'ls-key',
                    'store_id': '42',
                    'signing_secret': LEMON_SECRET,
                    'variants': {'starter': '111', 'pro': '777', 'studio': '999'},
                },
            },
        }
        data.update(overrides)
        return CloudConfig(data)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_cloud = SERVER.CLOUD
        self.saved_token = SERVER.STUDIO_TOKEN
        SERVER.STUDIO_TOKEN = ''
        self.lemon_http = FakeLemonHTTP()
        self.service = CloudService(self.make_config(), http_json=self.lemon_http)
        self.assertFalse(self.service.init_error)
        SERVER.CLOUD = self.service
        self.httpd, self.thread, self.host = helpers.make_server(SERVER, directory=self.tmp.name)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()
        SERVER.CLOUD = self.saved_cloud
        SERVER.STUDIO_TOKEN = self.saved_token

    def call(self, method, path, body=None, headers=None, raw_body=None):
        return helpers.request(self.host, method, path, body=body, headers=headers, raw_body=raw_body)

    def login(self, email='user@example.com'):
        status, _, data = self.call('POST', '/api/cloud/dev-login', {'email': email})
        self.assertEqual(status, 200, data)
        token = data['session']['token']
        return {'Authorization': f'Bearer {token}'}

    def save(self, headers, name='Scene', data=None, project_id=None):
        body = {'name': name, 'data': data or project_doc()}
        if project_id:
            body['id'] = project_id
        return self.call('POST', '/api/cloud/projects', body, headers)

    def checkout(self, headers, plan='starter', provider='sepay'):
        return self.call('POST', '/api/cloud/checkout', {'plan': plan, 'provider': provider}, headers)


class CloudApiTests(CloudHttpBase):
    def test_status_has_no_secrets(self):
        SERVER.STUDIO_TOKEN = ''
        status, _, data = self.call('GET', '/api/cloud/status')
        self.assertEqual(status, 200)
        self.assertTrue(data['enabled'])
        self.assertEqual(data['provider'], 'local')
        text = json.dumps(data)
        self.assertNotIn('s' * 64, text)
        self.assertNotIn('ls-key', text)
        self.assertNotIn(SEPAY_SECRET, text)
        self.assertTrue(data['billing']['sepay'])
        self.assertTrue(data['billing']['lemonsqueezy'])

    def test_login_creates_free_credits_and_me(self):
        headers = self.login()
        status, _, data = self.call('GET', '/api/cloud/me', headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(data['user']['email'], 'user@example.com')
        self.assertEqual(data['user']['credits'], 100)
        self.assertEqual(data['stats']['projects'], 0)
        self.assertEqual(data['costs']['save_project'], 1)

    def test_invalid_email_rejected(self):
        status, _, data = self.call('POST', '/api/cloud/dev-login', {'email': 'not-an-email'})
        self.assertEqual(status, 400)
        self.assertEqual(data['error']['code'], 'E_INVALID_ARG')

    def test_projects_require_bearer(self):
        status, _, data = self.call('GET', '/api/cloud/projects')
        self.assertEqual(status, 401)
        self.assertEqual(data['error']['code'], 'E_AUTH_REQUIRED')

    def test_project_roundtrip_and_charge(self):
        headers = self.login()
        status, _, saved = self.save(headers, 'My Scene')
        self.assertEqual(status, 200, saved)
        project = saved['project']
        self.assertEqual(project['credits'], 99)
        status, _, listing = self.call('GET', '/api/cloud/projects', headers=headers)
        self.assertEqual(len(listing['projects']), 1)
        status, _, loaded = self.call('GET', f"/api/cloud/projects/{project['id']}", headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(loaded['project']['data']['objects'][0]['name'], 'Cube')
        status, _, _ = self.call('POST', f"/api/cloud/projects/{project['id']}/delete", {}, headers)
        self.assertEqual(status, 200)
        _, _, listing = self.call('GET', '/api/cloud/projects', headers=headers)
        self.assertEqual(listing['projects'], [])

    def test_project_upsert_charges_each_save(self):
        headers = self.login()
        _, _, saved = self.save(headers)
        project_id = saved['project']['id']
        status, _, updated = self.save(headers, 'Renamed', project_id=project_id)
        self.assertEqual(status, 200)
        self.assertEqual(updated['project']['credits'], 98)
        _, _, listing = self.call('GET', '/api/cloud/projects', headers=headers)
        self.assertEqual(len(listing['projects']), 1)
        self.assertEqual(listing['projects'][0]['name'], 'Renamed')

    def test_project_rejects_bad_format_and_bad_id(self):
        headers = self.login()
        status, _, data = self.save(headers, data={'objects': []})
        self.assertEqual(status, 400)
        self.assertEqual(data['error']['code'], 'E_INVALID_ARG')
        status, _, data = self.save(headers, project_id='../../etc/passwd')
        self.assertEqual(status, 400)

    def test_project_ownership_isolation(self):
        alice = self.login('alice@example.com')
        bob = self.login('bob@example.com')
        _, _, saved = self.save(alice)
        pid = saved['project']['id']
        status, _, data = self.call('GET', f'/api/cloud/projects/{pid}', headers=bob)
        self.assertEqual(status, 404)
        status, _, _ = self.call('POST', f'/api/cloud/projects/{pid}/delete', {}, bob)
        self.assertEqual(status, 404)
        _, _, listing = self.call('GET', '/api/cloud/projects', headers=bob)
        self.assertEqual(listing['projects'], [])

    def test_asset_upload_public_download_and_delete(self):
        headers = self.login()
        payload = FIXTURE.read_bytes()
        status, _, data = self.call('POST', '/api/cloud/assets', {
            'fileName': 'Cube GLB.glb',
            'dataBase64': base64.b64encode(payload).decode(),
        }, headers)
        self.assertEqual(status, 200, data)
        asset = data['asset']
        self.assertEqual(asset['credits'], 95)
        self.assertTrue(asset['url'].startswith('/api/cloud/public/assets/'))
        status, response_headers, raw = self.call('GET', asset['url'])
        self.assertEqual(status, 200)
        self.assertEqual(raw, payload)
        self.assertEqual(response_headers.get('Content-Type'), 'model/gltf-binary')
        self.assertEqual(response_headers.get('Access-Control-Allow-Origin'), '*')
        self.assertIn('sandbox', response_headers.get('Content-Security-Policy', ''))
        status, _, _ = self.call('POST', f"/api/cloud/assets/{asset['id']}/delete", {}, headers)
        self.assertEqual(status, 200)
        status, _, _ = self.call('GET', asset['url'])
        self.assertEqual(status, 404)

    def test_dev_login_rejects_non_loopback_clients(self):
        status, _, payload = self.service.handle(
            'POST', '/api/cloud/dev-login', '', {}, json.dumps({'email': 'lan@example.com'}).encode(),
            client_ip='192.168.1.50')
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(payload)['error']['code'], 'E_FORBIDDEN')

    def test_asset_rejects_non_glb(self):
        headers = self.login()
        status, _, data = self.call('POST', '/api/cloud/assets', {
            'fileName': 'evil.glb',
            'dataBase64': base64.b64encode(b'<html>no</html>').decode(),
        }, headers)
        self.assertEqual(status, 415)
        self.assertEqual(data['error']['code'], 'E_UNSUPPORTED')

    def test_asset_rejects_spoofed_content_type(self):
        headers = self.login()
        status, _, data = self.call('POST', '/api/cloud/assets', {
            'fileName': 'evil.glb',
            'contentType': 'text/html',
            'dataBase64': base64.b64encode(FIXTURE.read_bytes()).decode(),
        }, headers)
        self.assertEqual(status, 415)
        self.assertEqual(data['error']['code'], 'E_UNSUPPORTED')

    def test_public_asset_survives_lan_studio_token(self):
        headers = self.login()
        payload = FIXTURE.read_bytes()
        _, _, data = self.call('POST', '/api/cloud/assets', {
            'fileName': 'cube.glb',
            'dataBase64': base64.b64encode(payload).decode(),
        }, headers)
        SERVER.STUDIO_TOKEN = 'lan-secret'
        try:
            status, _, raw = self.call('GET', data['asset']['url'])
            self.assertEqual(status, 200)
            self.assertEqual(raw, payload)
            status, _, _ = self.call('GET', '/api/cloud/me', headers=headers)
            self.assertEqual(status, 200)
        finally:
            SERVER.STUDIO_TOKEN = ''

    def test_sepay_checkout_and_simulated_payment_is_idempotent(self):
        headers = self.login()
        status, _, data = self.checkout(headers, 'starter', 'sepay')
        self.assertEqual(status, 200, data)
        checkout = data['checkout']
        self.assertTrue(checkout['qrUrl'].startswith('https://img.vietqr.io/'))
        self.assertEqual(checkout['amountVnd'], 69000)
        self.assertEqual(checkout['transferContent'], data['payment']['code'])
        code = data['payment']['code']
        status, _, paid = self.call('POST', f'/api/cloud/payments/{code}/simulate', {}, headers)
        self.assertEqual(status, 200)
        self.assertEqual(paid['credits'], 400)
        status, _, again = self.call('POST', f'/api/cloud/payments/{code}/simulate', {}, headers)
        self.assertEqual(status, 200)
        self.assertEqual(again['credits'], 400)

    def test_sepay_webhook_signature_and_idempotency(self):
        headers = self.login()
        _, _, data = self.checkout(headers, 'pro', 'sepay')
        code = data['payment']['code']
        body = json.dumps({
            'id': 1001, 'transferType': 'in', 'transferAmount': 199000,
            'code': code, 'content': f'CK {code}',
        }).encode()
        status, _, _ = self.call('POST', '/api/cloud/webhook/sepay', raw_body=body,
                                 headers={'X-SePay-Signature': 'sha256=deadbeef'})
        self.assertEqual(status, 401)
        status, _, result = self.call('POST', '/api/cloud/webhook/sepay', raw_body=body,
                                      headers={'X-SePay-Signature': sepay_signature(body)})
        self.assertEqual(status, 200)
        self.assertTrue(result['applied'])
        self.assertEqual(result['credits'], 1300)
        status, _, repeat = self.call('POST', '/api/cloud/webhook/sepay', raw_body=body,
                                      headers={'X-SePay-Signature': sepay_signature(body)})
        self.assertEqual(status, 200)
        self.assertFalse(repeat['applied'])
        self.assertEqual(repeat['reason'], 'already_paid')
        self.assertEqual(repeat['credits'], 1300)

    def test_sepay_underpaid_and_ignored_transfers(self):
        headers = self.login()
        _, _, data = self.checkout(headers, 'starter', 'sepay')
        code = data['payment']['code']
        body = json.dumps({
            'id': 1002, 'transferType': 'in', 'transferAmount': 1000,
            'code': code,
        }).encode()
        status, _, result = self.call('POST', '/api/cloud/webhook/sepay', raw_body=body,
                                      headers={'X-SePay-Signature': sepay_signature(body)})
        self.assertEqual(status, 200)
        self.assertFalse(result['applied'])
        self.assertEqual(result['reason'], 'underpaid')
        self.assertEqual(result['credits'], 100)
        out = json.dumps({'id': 1003, 'transferType': 'out', 'transferAmount': 69000, 'code': code}).encode()
        status, _, result = self.call('POST', '/api/cloud/webhook/sepay', raw_body=out,
                                      headers={'X-SePay-Signature': sepay_signature(out)})
        self.assertEqual(status, 200)
        self.assertEqual(result['ignored'], 'not_incoming')

    def test_lemonsqueezy_checkout_and_webhook(self):
        headers = self.login()
        status, _, data = self.checkout(headers, 'pro', 'lemonsqueezy')
        self.assertEqual(status, 200, data)
        self.assertEqual(data['checkout']['checkoutUrl'], 'https://checkout.lemonsqueezy.com/test')
        self.assertEqual(self.lemon_http.calls[0]['url'], 'https://api.lemonsqueezy.com/v1/checkouts')
        code = data['payment']['code']
        body = json.dumps({
            'meta': {'event_name': 'order_created', 'custom_data': {'payment_code': code}},
            'data': {
                'id': 'order_1',
                'attributes': {'status': 'paid', 'first_order_item': {'variant_id': 777}},
            },
        }).encode()
        status, _, _ = self.call('POST', '/api/cloud/webhook/lemonsqueezy', raw_body=body,
                                 headers={'X-Signature': 'bad'})
        self.assertEqual(status, 401)
        status, _, result = self.call('POST', '/api/cloud/webhook/lemonsqueezy', raw_body=body,
                                      headers={'X-Signature': lemon_signature(body)})
        self.assertEqual(status, 200)
        self.assertTrue(result['applied'])
        self.assertEqual(result['credits'], 1300)

    def test_lemonsqueezy_rejects_unpaid_and_variant_tampering(self):
        headers = self.login()
        status, _, data = self.checkout(headers, 'studio', 'lemonsqueezy')
        self.assertEqual(status, 200, data)
        code = data['payment']['code']

        # 1. Pending / unpaid order must not credit
        pending_body = json.dumps({
            'meta': {'event_name': 'order_created', 'custom_data': {'payment_code': code}},
            'data': {
                'id': 'order_pending',
                'attributes': {'status': 'pending', 'first_order_item': {'variant_id': 999}},
            },
        }).encode()
        status, _, res1 = self.call('POST', '/api/cloud/webhook/lemonsqueezy', raw_body=pending_body,
                                    headers={'X-Signature': lemon_signature(pending_body)})
        self.assertEqual(status, 200)
        self.assertFalse(res1.get('applied'))
        self.assertEqual(res1.get('ignored'), 'status_pending')

        # 2. Price tampering: paying cheaper 'starter' variant (111) with 'studio' payment_code
        tampered_body = json.dumps({
            'meta': {'event_name': 'order_created', 'custom_data': {'payment_code': code}},
            'data': {
                'id': 'order_tamper',
                'attributes': {'status': 'paid', 'first_order_item': {'variant_id': 111}},
            },
        }).encode()
        status, _, res2 = self.call('POST', '/api/cloud/webhook/lemonsqueezy', raw_body=tampered_body,
                                    headers={'X-Signature': lemon_signature(tampered_body)})
        self.assertEqual(status, 200)
        self.assertFalse(res2['applied'])
        self.assertEqual(res2['reason'], 'variant_mismatch')
        self.assertEqual(res2['credits'], 100)

        # 3. Missing variant_id when plan variant is configured must also be rejected
        missing_var_body = json.dumps({
            'meta': {'event_name': 'order_created', 'custom_data': {'payment_code': code}},
            'data': {'id': 'order_novar', 'attributes': {'status': 'paid'}},
        }).encode()
        status, _, res3 = self.call('POST', '/api/cloud/webhook/lemonsqueezy', raw_body=missing_var_body,
                                    headers={'X-Signature': lemon_signature(missing_var_body)})
        self.assertEqual(status, 200)
        self.assertFalse(res3['applied'])
        self.assertEqual(res3['reason'], 'variant_mismatch')
        self.assertEqual(res3['credits'], 100)

    def test_checkout_rejects_unknown_plan_and_provider(self):
        headers = self.login()
        status, _, data = self.checkout(headers, 'nope', 'sepay')
        self.assertEqual(status, 400)
        status, _, data = self.checkout(headers, 'starter', 'stripe')
        self.assertEqual(status, 400)

    def test_dev_login_rate_limit(self):
        statuses = []
        for _ in range(13):
            status, _, _ = self.call('POST', '/api/cloud/dev-login', {'email': 'rate@example.com'})
            statuses.append(status)
        self.assertEqual(statuses[:12], [200] * 12)
        self.assertEqual(statuses[12], 429)

    def test_large_body_is_rejected(self):
        headers = self.login()
        huge = 'A' * (self.service.max_body_bytes('/api/cloud/projects') + 1024)
        status, _, _ = self.call('POST', '/api/cloud/projects', raw_body=huge.encode(),
                                 headers={**headers, 'Content-Type': 'application/json'})
        self.assertEqual(status, 413)

    def test_community_publish_thumbnail_filter_and_privacy(self):
        headers = self.login('creator-secret@example.com')
        png_bytes = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
        payload = FIXTURE.read_bytes()
        status, _, data = self.call('POST', '/api/cloud/assets', {
            'fileName': 'pine_scene.glb',
            'dataBase64': base64.b64encode(payload).decode(),
            'title': 'Pine Forest',
            'category': 'vegetation',
            'tags': ['tree', 'pine', 'nature'],
            'description': 'Handcrafted studio pine grove',
            'thumbnailBase64': 'data:image/png;base64,' + base64.b64encode(png_bytes).decode(),
            'public': True,
        }, headers)
        self.assertEqual(status, 200, data)
        asset = data['asset']
        self.assertEqual(asset['category'], 'vegetation')
        self.assertEqual(asset['authorName'], 'creator-secret')
        self.assertTrue(asset['thumbUrl'].startswith('/api/cloud/public/thumbs/'))

        # Private upload must never appear in community listing
        self.call('POST', '/api/cloud/assets', {
            'fileName': 'private_draft.glb',
            'dataBase64': base64.b64encode(payload).decode(),
            'category': 'scenes',
            'public': False,
        }, headers)

        # Anonymous caller sees public entry, filtered by category, with zero email leak
        status, _, comm = self.call('GET', '/api/cloud/community?category=vegetation&q=pine')
        self.assertEqual(status, 200, comm)
        self.assertEqual(len(comm['items']), 1)
        item = comm['items'][0]
        self.assertEqual(item['title'], 'Pine Forest')
        self.assertFalse(item['isOwner'])
        self.assertNotIn('@example.com', json.dumps(comm))

        # Owner sees isOwner=True
        status, _, owner_comm = self.call('GET', '/api/cloud/community?category=vegetation', headers=headers)
        self.assertEqual(status, 200)
        self.assertTrue(owner_comm['items'][0]['isOwner'])

        # Thumbnail endpoint serves safe PNG
        status, resp_headers, raw_png = self.call('GET', asset['thumbUrl'])
        self.assertEqual(status, 200)
        self.assertEqual(raw_png, png_bytes)
        self.assertEqual(resp_headers.get('Content-Type'), 'image/png')

        # Deleting revokes thumbnail too
        status, _, _ = self.call('POST', f"/api/cloud/assets/{asset['id']}/delete", {}, headers)
        self.assertEqual(status, 200)
        status, _, _ = self.call('GET', asset['thumbUrl'])
        self.assertEqual(status, 404)

    def test_free_mode_saves_and_publishes_without_charging_credits(self):
        cfg = self.make_config(costs={'save_project': 0, 'upload_asset': 0}, free_credits=0)
        SERVER.CLOUD = CloudService(cfg)
        _, _, st = self.call('GET', '/api/cloud/status')
        self.assertTrue(st['freeMode'])
        headers = self.login('freeuser@example.com')
        status, _, saved = self.save(headers, 'Free Project')
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved['project']['credits'], 0)
        status, _, pub = self.call('POST', '/api/cloud/assets', {
            'fileName': 'rock.glb',
            'dataBase64': base64.b64encode(FIXTURE.read_bytes()).decode(),
            'category': 'environments',
        }, headers)
        self.assertEqual(status, 200, pub)
        self.assertEqual(pub['asset']['credits'], 0)


class LocalStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = CloudConfig({
            'provider': 'local', 'allow_dev_login': True, 'session_secret': 'x' * 64,
            'data_dir': self.tmp.name, 'free_credits': 10,
            'costs': {'save_project': 1, 'upload_asset': 5},
        })
        self.store = LocalStore(self.config)
        self.identity = Identity('u' * 16, 'store@example.com', 'local')
        self.user = self.store.ensure_user(self.identity)

    def tearDown(self):
        self.tmp.cleanup()

    def test_free_credits_are_idempotent(self):
        again = self.store.ensure_user(self.identity)
        self.assertEqual(again['credits'], 10)
        self.assertEqual(self.store.balance(self.user['id']), 10)

    def test_insufficient_credits_is_atomic(self):
        self.store.charge(self.user['id'], 8, 'test')
        with self.assertRaises(CloudError) as ctx:
            self.store.charge(self.user['id'], 5, 'test')
        self.assertEqual(ctx.exception.status, 402)
        self.assertEqual(self.store.balance(self.user['id']), 2)

    def test_idempotent_credit(self):
        first, applied = self.store.credit(self.user['id'], 50, 'topup', 'r1', 'key-1')
        self.assertTrue(applied)
        second, applied_again = self.store.credit(self.user['id'], 50, 'topup', 'r1', 'key-1')
        self.assertFalse(applied_again)
        self.assertEqual(first, 60)
        self.assertEqual(second, 60)

    def test_quota_limits(self):
        self.config.max_projects = 1
        self.store.save_project(self.user['id'], None, 'One', project_doc())
        with self.assertRaises(CloudError) as ctx:
            self.store.save_project(self.user['id'], None, 'Two', project_doc())
        self.assertEqual(ctx.exception.code, 'E_QUOTA')

    def test_public_asset_requires_public_flag(self):
        asset = self.store.add_asset(self.user['id'], 'x.glb', FIXTURE.read_bytes(), public=False)
        with self.assertRaises(CloudError) as ctx:
            self.store.read_public_asset(asset['id'])
        self.assertEqual(ctx.exception.status, 404)


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.config = CloudConfig({
            'provider': 'local', 'allow_dev_login': True, 'session_secret': 'a' * 64,
            'data_dir': tempfile.mkdtemp(),
        })
        self.now = 1000.0
        self.auth = Authenticator(self.config, clock=lambda: self.now)

    def test_token_roundtrip(self):
        token, expires = self.auth.issue_local_token('u' * 16, 'a@example.com')
        identity = self.auth.verify(token)
        self.assertEqual(identity.email, 'a@example.com')
        self.assertEqual(expires, 1000 + self.config.session_ttl_seconds)

    def test_tampered_token_rejected(self):
        token, _ = self.auth.issue_local_token('u' * 16, 'a@example.com')
        head, body, sig = token.split('.')
        flipped = ('f' if sig[0] != 'f' else 'e') + sig[1:]
        with self.assertRaises(CloudError):
            self.auth.verify(f'{head}.{body}.{flipped}')

    def test_expired_token_rejected(self):
        token, _ = self.auth.issue_local_token('u' * 16, 'a@example.com')
        self.now += self.config.session_ttl_seconds + 1
        with self.assertRaises(CloudError) as ctx:
            self.auth.verify(token)
        self.assertEqual(ctx.exception.code, 'E_AUTH_EXPIRED')

    def test_secret_is_not_generated_silently_when_configured(self):
        self.assertEqual(self.config.session_secret, 'a' * 64)


class ConfigTests(unittest.TestCase):
    def test_public_status_redacts_secrets(self):
        config = CloudConfig({
            'provider': 'local', 'allow_dev_login': True, 'session_secret': 'topsecret',
            'data_dir': tempfile.mkdtemp(),
            'supabase': {'url': 'https://demo.supabase.co', 'anon_key': 'anon', 'service_key': 'service'},
            'billing': {'sepay': {'webhook_secret': 'whsec', 'bank': 'VCB', 'account': '0123456789'}},
        })
        text = json.dumps(config.public_status())
        self.assertNotIn('topsecret', text)
        self.assertNotIn('"service"', text)
        self.assertNotIn('whsec', text)
        self.assertIsNone(config.public_status()['supabase'])

    def test_supabase_missing_keys_disables_cloud(self):
        config = CloudConfig({'provider': 'supabase', 'data_dir': tempfile.mkdtemp()})
        self.assertFalse(config.enabled)
        self.assertIn('Supabase', config.config_error)

    def test_environment_overrides_file(self):
        config = CloudConfig(
            {'provider': 'local', 'allow_dev_login': True, 'session_secret': 'file', 'data_dir': '/tmp/x'},
            environ={
                'CLOUD_PROVIDER': 'disabled',
                'CLOUD_ALLOW_DEV_LOGIN': '0',
                'CLOUD_SESSION_SECRET': 'env-secret',
                'CLOUD_FREE_CREDITS': '7',
            },
        )
        self.assertEqual(config.provider, 'disabled')
        self.assertFalse(config.enabled)
        self.assertEqual(config.session_secret, 'env-secret')
        self.assertEqual(config.free_credits, 7)

    def test_invalid_bank_config_is_not_ready(self):
        config = CloudConfig({
            'provider': 'local', 'allow_dev_login': True, 'session_secret': 'x' * 64,
            'data_dir': tempfile.mkdtemp(),
            'billing': {'sepay': {'webhook_secret': 'x', 'bank': 'bad bank', 'account': '1234'}},
        })
        self.assertFalse(config.sepay_ready())


class FakeSupabase:
    def __init__(self, fail_insert=False, fail_storage=False):
        self.calls = []
        self.fail_insert = fail_insert
        self.fail_storage = fail_storage
        self.ledger = 100
        self.asset_rows = []

    def api(self, method, path, body=None, prefer=None):
        self.calls.append((method, path, body, prefer))
        if path.startswith('/rest/v1/cloud_users'):
            return [body] if method in ('POST', 'PATCH') and body else []
        if path.startswith('/rest/v1/cloud_projects'):
            if method == 'GET':
                return []
            if method == 'POST':
                if self.fail_insert:
                    raise CloudError('E_PROVIDER', 'insert failed', 502)
                return [body]
            return []
        if path.startswith('/rest/v1/cloud_assets'):
            if method == 'POST':
                self.asset_rows.append(body)
                return [body]
            if method == 'DELETE':
                self.asset_rows = [row for row in self.asset_rows if f"id=eq.{row['id']}" not in path]
                return []
            if 'public=eq.true' in path:
                return [row for row in self.asset_rows if row.get('public')]
            return self.asset_rows
        if path.startswith('/rest/v1/cloud_payments'):
            return []
        return []

    def rpc(self, name, args):
        self.calls.append(('rpc', name, args))
        if name == 'cloud_balance':
            return self.ledger
        if name == 'cloud_stats':
            return {'projects': 0, 'assets': len(self.asset_rows), 'used_bytes': sum(r.get('size_bytes', 0) for r in self.asset_rows)}
        if name == 'cloud_charge':
            self.ledger -= args['p_amount']
            return self.ledger
        if name == 'cloud_credit':
            self.ledger += args['p_amount']
            return self.ledger
        if name == 'cloud_reserve_asset':
            used_assets = sum(1 for r in self.asset_rows if r.get('user_id') == args['p_user_id'])
            used_bytes = sum(int(r.get('size_bytes') or 0) for r in self.asset_rows if r.get('user_id') == args['p_user_id'])
            if used_assets >= int(args['p_max_assets']):
                raise CloudError('E_QUOTA', 'Đã đạt số tệp tối đa.', 413)
            if used_bytes + int(args['p_size_bytes']) > int(args['p_max_total_bytes']):
                raise CloudError('E_QUOTA', 'Vượt hạn mức dung lượng Cloud.', 413)
            cost = int(args.get('p_cost') or 0)
            if self.ledger < cost:
                raise CloudError('E_INSUFFICIENT_CREDITS', 'Không đủ credit.', 402)
            self.ledger -= cost
            row = {
                'id': args['p_asset_id'],
                'user_id': args['p_user_id'],
                'name': args['p_name'],
                'title': args['p_title'],
                'category': args['p_category'],
                'tags': args['p_tags'],
                'description': args['p_description'],
                'author_name': args['p_author_name'],
                'thumb_path': args['p_thumb_path'],
                'content_type': args['p_content_type'],
                'size_bytes': args['p_size_bytes'],
                'storage_path': args['p_storage_path'],
                'public': args['p_public'],
                'created_at': '2026-11-26T00:00:00+00:00',
            }
            self.asset_rows.append(row)
            return {'credits': self.ledger, 'created_at': row['created_at']}
        return 0

    def storage_upload(self, bucket, path, data, content_type='model/gltf-binary'):
        self.calls.append(('storage_upload', bucket, path, len(data)))
        if self.fail_storage:
            raise CloudError('E_PROVIDER', 'storage upload failed', 502)

    def storage_delete(self, bucket, path):
        self.calls.append(('storage_delete', bucket, path))

    def signed_url(self, bucket, path, expires_in=300):
        self.calls.append(('signed_url', bucket, path, expires_in))
        return f'https://demo.supabase.co/storage/v1/object/sign/{bucket}/{path}?token=test'


class SupabaseStoreTests(unittest.TestCase):
    def make_config(self):
        return CloudConfig({
            'provider': 'supabase',
            'data_dir': tempfile.mkdtemp(),
            'supabase': {
                'url': 'https://demo.supabase.co',
                'anon_key': 'anon',
                'service_key': 'service',
            },
        })

    def test_save_project_refunds_when_upsert_fails(self):
        fake = FakeSupabase(fail_insert=True)
        store = SupabaseStore(self.make_config(), client=fake)
        with self.assertRaises(CloudError):
            store.save_project('u' * 16, None, 'Scene', project_doc())
        refunds = [call for call in fake.calls if call[0] == 'rpc' and call[1] == 'cloud_credit']
        self.assertTrue(refunds)
        self.assertIn('refund:', refunds[0][2]['p_key'])

    def test_asset_upload_path_and_public_url(self):
        fake = FakeSupabase()
        store = SupabaseStore(self.make_config(), client=fake)
        asset = store.add_asset('u' * 16, 'Cube.glb', FIXTURE.read_bytes())
        uploads = [call for call in fake.calls if call[0] == 'storage_upload']
        self.assertEqual(uploads[0][1], 'shared-models')
        self.assertTrue(uploads[0][2].startswith('u' * 16 + '/'))
        self.assertTrue(uploads[0][2].endswith('.glb'))
        self.assertTrue(asset['url'].startswith('/api/cloud/public/assets/'))
        signed = store.public_asset_url(asset['id'])
        self.assertTrue(signed.startswith('https://demo.supabase.co/storage/v1/object/sign/'))
        self.assertNotIn('/object/public/', signed)

    def test_private_asset_uses_short_lived_owner_urls(self):
        fake = FakeSupabase()
        store = SupabaseStore(self.make_config(), client=fake)
        png_bytes = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16
        user_id = 'u' * 16
        asset = store.add_asset(
            user_id, 'Private.glb', FIXTURE.read_bytes(), public=False, thumbnail_data=png_bytes)
        uploads = [call for call in fake.calls if call[0] == 'storage_upload']
        self.assertEqual([call[1] for call in uploads], ['shared-models', 'shared-models'])
        signed = [call for call in fake.calls if call[0] == 'signed_url']
        self.assertEqual(len(signed), 2)
        self.assertTrue(all(call[3] == 300 for call in signed))
        self.assertIn('/object/sign/', asset['url'])
        self.assertIn('/object/sign/', asset['thumbUrl'])
        self.assertFalse(asset['public'])
        self.assertTrue(asset['isOwner'])
        self.assertEqual(store.list_assets(user_id)[0]['url'], None)
        self.assertEqual(store.list_public_assets(), [])
        row = fake.asset_rows[0]
        self.assertIsNone(store._asset_row(row, viewer_user_id='v' * 16, include_private_url=True)['url'])

    def test_add_asset_atomic_reserve_rolls_back_on_storage_failure(self):
        fake = FakeSupabase(fail_storage=True)
        store = SupabaseStore(self.make_config(), client=fake)
        with self.assertRaises(CloudError):
            store.add_asset('u' * 16, 'Rollback.glb', FIXTURE.read_bytes())
        self.assertEqual(fake.asset_rows, [])
        self.assertEqual(fake.ledger, 100)
        refunds = [call for call in fake.calls if call[0] == 'rpc' and call[1] == 'cloud_credit']
        self.assertTrue(refunds)

    def test_supabase_schema_has_rls_and_functions(self):
        sql = (ROOT / 'cloud' / 'supabase_schema.sql').read_text(encoding='utf-8')
        self.assertIn("values ('shared-models', 'shared-models', false", sql)
        self.assertIn('set public = false', sql)
        self.assertIn('revoke all on table storage.objects from anon, authenticated', sql)
        self.assertIn('from public, anon, authenticated', sql)
        self.assertIn('cloud_reserve_asset', sql)
        paid_sql = sql.split('create or replace function public.cloud_mark_payment_paid(', 1)[1].split('$$;', 1)[0]
        refund_sql = sql.split('create or replace function public.cloud_refund_payment(', 1)[1].split('$$;', 1)[0]
        self.assertIn("if v_payment.status = 'refunded' then", paid_sql)
        self.assertNotIn("if v_payment.status <> 'paid' then", refund_sql)
        self.assertIn("case when v_payment.status = 'paid'", refund_sql)
        self.assertIn("set status = 'refunded'", refund_sql)
        self.assertIn('enable row level security', sql)
        for name in ('cloud_balance', 'cloud_charge', 'cloud_credit', 'cloud_mark_payment_paid', 'cloud_refund_payment', 'cloud_reserve_asset'):
            self.assertIn(f'function public.{name}', sql)
        self.assertIn("revoke all on function public.cloud_charge", sql)

    def test_supabase_community_list_and_thumbnail_upload(self):
        fake = FakeSupabase()
        store = SupabaseStore(self.make_config(), client=fake)
        png_bytes = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16
        asset = store.add_asset(
            'u' * 16, 'Grass.glb', FIXTURE.read_bytes(),
            title='Green Grass', category='vegetation', tags=['grass', 'nature'],
            author_name='studio_dev', thumbnail_data=png_bytes,
        )
        uploads = [call for call in fake.calls if call[0] == 'storage_upload']
        self.assertEqual(len(uploads), 2)
        self.assertTrue(uploads[0][2].endswith('.glb'))
        self.assertTrue(uploads[1][2].endswith('.png'))
        self.assertEqual(asset['category'], 'vegetation')
        self.assertTrue(asset['thumbUrl'].startswith('/api/cloud/public/thumbs/'))
        items = store.list_public_assets(category='vegetation', viewer_user_id='u' * 16)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['id'], asset['id'])
        self.assertTrue(items[0]['url'].startswith('/api/cloud/public/assets/'))


class SupabaseClientTests(unittest.TestCase):
    def make_config(self, url='https://demo.supabase.co'):
        return CloudConfig({
            'provider': 'supabase',
            'data_dir': tempfile.mkdtemp(),
            'supabase': {'url': url, 'anon_key': 'anon', 'service_key': 'service'},
        })

    def test_validate_user_caches_and_maps_401(self):
        calls = []

        def http(method, url, headers, payload, timeout=25):
            calls.append({'method': method, 'url': url, 'headers': headers})
            if 'bad-token' in headers.get('Authorization', ''):
                return 401, {}, b'{"message":"bad"}'
            return 200, {}, json.dumps({'id': 'u' * 16, 'email': 'a@example.com'}).encode()

        now = [0.0]
        client = SupabaseClient(self.make_config(), http=http, clock=lambda: now[0])
        first = client.validate_user('good-token')
        second = client.validate_user('good-token')
        self.assertEqual(first, second)
        self.assertEqual(len(calls), 1, 'valid token should be cached')
        self.assertIsNone(client.validate_user('bad-token'))
        self.assertEqual(calls[1]['url'], 'https://demo.supabase.co/auth/v1/user')
        self.assertEqual(calls[1]['headers']['apikey'], 'anon')
        now[0] = 61
        client.validate_user('good-token')
        self.assertEqual(len(calls), 3, 'cache should expire')

    def test_remote_plain_http_supabase_url_is_rejected(self):
        with self.assertRaises(RuntimeError):
            SupabaseClient(self.make_config('http://evil.example.com'))

    def test_signed_url_is_scoped_to_storage_and_clamps_expiry(self):
        calls = []

        def http(method, url, headers, payload, timeout=25):
            calls.append((method, url, json.loads(payload)))
            return 200, {}, b'{"signedURL":"/object/sign/shared-models/user/model.glb?token=abc"}'

        client = SupabaseClient(self.make_config(), http=http)
        url = client.signed_url('shared-models', 'user/model.glb', expires_in=99999)
        self.assertEqual(
            url,
            'https://demo.supabase.co/storage/v1/object/sign/shared-models/user/model.glb?token=abc',
        )
        self.assertEqual(calls[0][2], {'expiresIn': 3600})

        client.http = lambda *args: (200, {}, b'{"signedURL":"https://evil.example/file"}')
        with self.assertRaises(CloudError) as ctx:
            client.signed_url('shared-models', 'user/model.glb')
        self.assertEqual(ctx.exception.code, 'E_PROVIDER')


class Wave4HardeningTests(CloudHttpBase):
    def test_lemonsqueezy_blocks_test_mode_in_production_and_verifies_refund_and_total(self):
        headers = self.login()
        status, _, co = self.checkout(headers, 'starter', 'lemonsqueezy')
        self.assertEqual(status, 200, co)
        code = co['payment']['code']

        # 1) test_mode: true blocked with 403 when allow_test_billing is False
        test_payload = json.dumps({
            'meta': {'event_name': 'order_created', 'test_mode': True, 'custom_data': {'payment_code': code}},
            'data': {'id': 'ord-1', 'attributes': {'status': 'paid', 'variant_id': '111', 'total': 69000, 'currency': 'VND'}},
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/lemonsqueezy', headers={'X-Signature': lemon_signature(test_payload)}, raw_body=test_payload)
        self.assertEqual(st, 403, res)

        # 2) total == 0 rejected safely
        zero_payload = json.dumps({
            'meta': {'event_name': 'order_created', 'custom_data': {'payment_code': code}},
            'data': {'id': 'ord-2', 'attributes': {'status': 'paid', 'variant_id': '111', 'total': 0, 'currency': 'VND'}},
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/lemonsqueezy', headers={'X-Signature': lemon_signature(zero_payload)}, raw_body=zero_payload)
        self.assertEqual(st, 200, res)
        self.assertFalse(res['applied'])
        self.assertEqual(res['reason'], 'invalid_total')

        # 3) real paid webhook succeeds (+300 credits -> 400)
        paid_payload = json.dumps({
            'meta': {'event_name': 'order_created', 'custom_data': {'payment_code': code}},
            'data': {'id': 'ord-3', 'attributes': {'status': 'paid', 'variant_id': '111', 'total': 69000, 'currency': 'VND'}},
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/lemonsqueezy', headers={'X-Signature': lemon_signature(paid_payload)}, raw_body=paid_payload)
        self.assertEqual(st, 200, res)
        self.assertTrue(res['applied'])
        self.assertEqual(res['credits'], 400)

        # 4) refund webhook claws back 300 credits cleanly and is idempotent
        refund_payload = json.dumps({
            'meta': {'event_name': 'order_refunded', 'custom_data': {'payment_code': code}},
            'data': {'id': 'ord-3', 'attributes': {'status': 'refunded', 'refunded': True}},
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/lemonsqueezy', headers={'X-Signature': lemon_signature(refund_payload)}, raw_body=refund_payload)
        self.assertEqual(st, 200, res)
        self.assertTrue(res['applied'])
        self.assertEqual(res['reason'], 'refunded')
        self.assertEqual(res['credits'], 100)

        st2, _, res2 = self.call('POST', '/api/cloud/webhook/lemonsqueezy', headers={'X-Signature': lemon_signature(refund_payload)}, raw_body=refund_payload)
        self.assertEqual(st2, 200)
        self.assertFalse(res2['applied'])
        self.assertEqual(res2['reason'], 'already_refunded')
        self.assertEqual(res2['credits'], 100)

    def test_refund_before_paid_persists_and_blocks_late_credit(self):
        headers = self.login()
        status, _, co = self.checkout(headers, 'starter', 'lemonsqueezy')
        self.assertEqual(status, 200, co)
        code = co['payment']['code']
        refund_payload = json.dumps({
            'meta': {'event_name': 'order_refunded', 'custom_data': {'payment_code': code}},
            'data': {'id': 'ord-early-refund', 'attributes': {'status': 'refunded', 'refunded': True}},
        }).encode()
        status, _, refunded = self.call(
            'POST', '/api/cloud/webhook/lemonsqueezy',
            headers={'X-Signature': lemon_signature(refund_payload)}, raw_body=refund_payload)
        self.assertEqual(status, 200, refunded)
        self.assertTrue(refunded['applied'])
        self.assertEqual(refunded['reason'], 'refunded')
        self.assertEqual(refunded['credits'], 100)

        paid_payload = json.dumps({
            'meta': {'event_name': 'order_created', 'custom_data': {'payment_code': code}},
            'data': {
                'id': 'ord-late-paid',
                'attributes': {'status': 'paid', 'variant_id': '111', 'total': 69000, 'currency': 'VND'},
            },
        }).encode()
        status, _, late_paid = self.call(
            'POST', '/api/cloud/webhook/lemonsqueezy',
            headers={'X-Signature': lemon_signature(paid_payload)}, raw_body=paid_payload)
        self.assertEqual(status, 200, late_paid)
        self.assertFalse(late_paid['applied'])
        self.assertEqual(late_paid['reason'], 'already_refunded')
        self.assertEqual(late_paid['credits'], 100)
        status, _, payment = self.call('GET', f'/api/cloud/payments/{code}', headers=headers)
        self.assertEqual(payment['payment']['status'], 'refunded')

    def test_sepay_checks_account_float_amount_expiry_and_duplicate_external_id(self):
        headers = self.login()
        _, _, co1 = self.checkout(headers, 'starter', 'sepay')
        code1 = co1['payment']['code']
        _, _, co2 = self.checkout(headers, 'starter', 'sepay')
        code2 = co2['payment']['code']

        # Wrong receiving account number is ignored
        wrong_acct = json.dumps({
            'id': 'tx-wrong', 'transferType': 'in', 'transferAmount': '69000.0',
            'accountNumber': '9999999999', 'content': f'CK {code1}',
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/sepay', headers={'X-SePay-Signature': sepay_signature(wrong_acct)}, raw_body=wrong_acct)
        self.assertEqual(st, 200)
        self.assertEqual(res.get('ignored'), 'account_mismatch')

        # Valid account + float amount pays cleanly
        ok_payload = json.dumps({
            'id': 'tx-100', 'transferType': 'in', 'transferAmount': '69000.0',
            'accountNumber': '0123456789', 'content': f'CK {code1}',
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/sepay', headers={'X-SePay-Signature': sepay_signature(ok_payload)}, raw_body=ok_payload)
        self.assertEqual(st, 200, res)
        self.assertTrue(res['applied'])
        self.assertEqual(res['credits'], 400)

        # Replaying external_id tx-100 on code2 is blocked
        dup_ext = json.dumps({
            'id': 'tx-100', 'transferType': 'in', 'transferAmount': 69000,
            'accountNumber': '0123456789', 'content': f'CK {code2}',
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/sepay', headers={'X-SePay-Signature': sepay_signature(dup_ext)}, raw_body=dup_ext)
        self.assertEqual(st, 200)
        self.assertFalse(res['applied'])
        self.assertEqual(res['reason'], 'duplicate_external_id')

        # Expired pending payment cannot be paid
        with self.service.store._tx() as conn:
            conn.execute("UPDATE cloud_payments SET expires_at = '2020-01-01T00:00:00+00:00' WHERE code = ?", (code2,))
        exp_payload = json.dumps({
            'id': 'tx-exp', 'transferType': 'in', 'transferAmount': 69000,
            'accountNumber': '0123456789', 'content': f'CK {code2}',
        }).encode()
        st, _, res = self.call('POST', '/api/cloud/webhook/sepay', headers={'X-SePay-Signature': sepay_signature(exp_payload)}, raw_body=exp_payload)
        self.assertEqual(st, 200)
        self.assertFalse(res['applied'])
        self.assertEqual(res['reason'], 'expired')

    def test_cookie_session_and_gdpr_export_delete(self):
        headers = self.login('gdpr@example.com')
        st, resp_headers, _ = self.call('POST', '/api/cloud/session', {}, headers=headers)
        self.assertEqual(st, 200)
        set_cookie = resp_headers.get('Set-Cookie', '')
        self.assertIn('HttpOnly', set_cookie)
        self.assertIn('wbs_session=', set_cookie)
        cookie_val = set_cookie.split(';', 1)[0]

        # Cookie allows GET /api/cloud/me
        st, _, me = self.call('GET', '/api/cloud/me', headers={'Cookie': cookie_val})
        self.assertEqual(st, 200, me)
        self.assertEqual(me['user']['email'], 'gdpr@example.com')

        # Cookie POST without same-origin/XRW CSRF marker is rejected
        st, _, _ = self.call('POST', '/api/cloud/projects', {'name': 'X', 'data': project_doc()}, headers={'Cookie': cookie_val})
        self.assertEqual(st, 403)

        # Cookie POST with X-Requested-With works
        st, _, _ = self.call('POST', '/api/cloud/projects', {'name': 'MyExport', 'data': project_doc()}, headers={'Cookie': cookie_val, 'X-Requested-With': 'XMLHttpRequest'})
        self.assertEqual(st, 200)

        # GDPR export includes user and projects
        st, _, exported = self.call('GET', '/api/cloud/me/export', headers=headers)
        self.assertEqual(st, 200, exported)
        self.assertEqual(exported['user']['email'], 'gdpr@example.com')
        self.assertEqual(len(exported['projects']), 1)

        # GDPR delete removes account and clears projects
        st, _, bad_del = self.call('POST', '/api/cloud/me/delete', {'confirm': 'NO'}, headers=headers)
        self.assertEqual(st, 400, bad_del)
        st, del_hdrs, deleted = self.call('POST', '/api/cloud/me/delete', {'confirm': 'DELETE'}, headers=headers)
        self.assertEqual(st, 200, deleted)
        self.assertTrue(deleted['deleted'])
        self.assertIn('Max-Age=0', del_hdrs.get('Set-Cookie', ''))
        self.assertEqual(self.service.store.stats(exported['user']['id'])['projects'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
