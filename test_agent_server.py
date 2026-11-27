"""Focused agent backend tests; no running studio, external network or real assets needed."""
import asyncio
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


with patch.dict(sys.modules, {'websockets': types.ModuleType('websockets'),
                             'mocap_engine': types.ModuleType('mocap_engine')}):
    server = load_module('agent_test_server', 'server.py')


def answer(ip='93.184.216.34', port=443):
    family = socket.AF_INET6 if ':' in ip else socket.AF_INET
    address = (ip, port, 0, 0) if family == socket.AF_INET6 else (ip, port)
    return family, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', address


class QuietHandler(server.BlenderStudioHTTPRequestHandler):
    def log_message(self, *args):
        pass


class AgentHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.storage = patch.object(server, 'AGENT_ASSET_DIR', self.temp.name)
        self.storage.start()
        server._agent_rate_windows.clear()
        self.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.host = f'127.0.0.1:{self.httpd.server_port}'

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.storage.stop()
        self.temp.cleanup()

    def request(self, endpoint, body=None, method=None, headers=None):
        headers = dict(headers or {})
        if body is not None:
            headers.setdefault('Content-Type', 'application/json')
            body = json.dumps(body).encode() if not isinstance(body, bytes) else body
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=3)
        try:
            connection.request(method or ('POST' if body is not None else 'GET'), endpoint,
                               body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def request_bytes(self, endpoint, body=None, method=None, headers=None):
        headers = dict(headers or {})
        if body is not None:
            headers.setdefault('Content-Type', 'application/json')
            body = json.dumps(body).encode() if not isinstance(body, bytes) else body
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=3)
        try:
            connection.request(method or ('POST' if body is not None else 'GET'), endpoint,
                               body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def assert_error(self, result, code, status=None):
        if status is not None:
            self.assertEqual(result[0], status)
        self.assertFalse(result[2]['ok'])
        self.assertEqual(result[2]['error']['code'], code)
        self.assertEqual(set(result[2]['error']), {'code', 'message', 'hint', 'toolId'})

    def test_allowlist_and_assets_have_no_credentials_or_wildcard_cors(self):
        status, headers, result = self.request('/api/agent/allowlist')
        self.assertEqual(status, 200)
        self.assertEqual(result, {'ok': True, 'data': list(server.AGENT_ALLOWLIST)})
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(self.request('/api/agent/assets')[2], {'ok': True, 'data': []})

    def test_local_client_host_and_origin_guards(self):
        with patch.object(QuietHandler, '_agent_local_host', return_value=False):
            self.assert_error(self.request('/api/agent/allowlist'), 'E_PERMISSION', 403)
        self.assert_error(self.request('/api/agent/assets', headers={'Host': 'evil.example'}), 'E_PERMISSION', 403)
        for endpoint, body in [('/api/agent/proxy?url=https://cdn.jsdelivr.net/model.glb', None),
                               ('/api/agent/proxy', {'url': 'https://cdn.jsdelivr.net/model.glb'}),
                               ('/api/agent/call', {'method': 'scene.tree'}),
                               ('/api/agent/upload', {'fileName': 'x.glb', 'fileData': ''})]:
            self.assert_error(self.request(endpoint, body, headers={'Origin': 'https://evil.example'}), 'E_CORS', 403)
        self.assert_error(self.request('/api/agent/call', {'method': 'scene.tree'},
                                       headers={'Origin': 'null'}), 'E_CORS', 403)
        result = self.request('/api/agent/upload', {'fileName': 'x.glb', 'fileData': ''},
                              headers={'Origin': f'http://{self.host}'})
        self.assertTrue(result[2]['ok'])
        self.assert_error(self.request('/api/agent/upload', method='OPTIONS',
                                       headers={'Origin': 'http://evil.example'}), 'E_CORS', 403)

    def test_upload_unique_safe_and_list_only_assets(self):
        payload = {'fileName': '../../secret\\model.glb', 'fileData': base64.b64encode(b'glTF').decode()}
        first = self.request('/api/agent/upload', payload)[2]['data']
        second = self.request('/api/agent/upload', payload)[2]['data']
        self.assertNotEqual(first['fileName'], second['fileName'])
        self.assertRegex(first['fileName'], r'^model_[0-9a-f]{32}\.glb$')
        self.assertEqual((Path(self.temp.name) / first['fileName']).read_bytes(), b'glTF')
        (Path(self.temp.name) / 'ai_config.json').write_text('{"secret":"key"}')
        os.symlink(ROOT / 'server.py', Path(self.temp.name) / ('link_' + 'a' * 32 + '.json'))
        assets = self.request('/api/agent/assets')[2]['data']
        self.assertEqual(len(assets), 2)
        self.assertEqual(set(assets[0]), {'fileName', 'url', 'size'})
        self.assertNotIn(self.temp.name, json.dumps(assets))
        self.assertNotIn('ai_config', json.dumps(assets))
        with patch.object(server.uuid, 'uuid4', return_value=types.SimpleNamespace(hex=first['fileName'].split('_')[1][:-4])):
            collision = self.request('/api/agent/upload', payload)
        self.assertFalse(collision[2]['ok'])
        self.assertEqual((Path(self.temp.name) / first['fileName']).read_bytes(), b'glTF')

    def test_strict_base64_types_and_size_bounds(self):
        for encoded in ['!!!!', 'YQ==\n', 'YQ', 'YR==', 'data:text/plain,abc', 'YQ===']:
            self.assert_error(self.request('/api/agent/upload', {'fileName': 'a.glb', 'fileData': encoded}),
                              'E_INVALID_ARG', 400)
        self.assert_error(self.request('/api/agent/upload', {'fileName': 'a.html', 'fileData': 'YQ=='}),
                          'E_UNSUPPORTED', 415)
        self.assertTrue(self.request('/api/agent/upload', {'fileName': 'a.glb',
                        'fileData': 'data:model/gltf-binary;base64,YQ=='})[2]['ok'])
        with patch.object(server, 'AGENT_MAX_BYTES', 2):
            self.assert_error(self.request('/api/agent/upload', {'fileName': 'a.glb', 'fileData': 'YWJj'}),
                              'E_TOO_LARGE', 413)
        self.assert_error(self.request('/api/agent/call', b'{'), 'E_INVALID_ARG', 400)
        self.assert_error(self.request('/api/agent/call', b'[]'), 'E_INVALID_ARG', 400)
        self.assert_error(self.request('/api/agent/call', b'{"method":"tree","args":[NaN]}'), 'E_INVALID_ARG', 400)
        self.assert_error(self.request('/api/agent/call', {}, headers={'Content-Length': str(server.AGENT_MAX_BYTES + 1)}),
                          'E_TOO_LARGE', 413)

    def test_proxy_get_post_and_shared_rate_limit(self):
        with patch.object(server, '_agent_proxy', return_value={'body': b'a', 'size': 1, 'contentType': 'image/png'}) as proxy:
            status, headers, raw = self.request_bytes('/api/agent/proxy?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fa.png')
            self.assertEqual((status, raw), (200, b'a'))
            self.assertEqual(headers.get('Content-Type'), 'image/png')
            status, _, raw = self.request_bytes('/api/agent/proxy', {'url': 'https://cdn.jsdelivr.net/a.png'})
            self.assertEqual((status, raw), (200, b'a'))
            self.assertEqual(proxy.call_args.args[0], 'https://cdn.jsdelivr.net/a.png')
        self.assert_error(self.request('/api/agent/proxy?url=a&url=b'), 'E_INVALID_ARG', 400)
        server._agent_rate_windows['127.0.0.1'] = server.deque([time.monotonic()] * 60)
        self.assert_error(self.request('/api/agent/proxy?url=a'), 'E_PERMISSION', 429)
        self.assert_error(self.request('/api/agent/upload', {'fileName': 'a.glb', 'fileData': ''}), 'E_PERMISSION', 429)
        self.assertTrue(self.request('/api/agent/allowlist')[2]['ok'])
        server._agent_take_rate('127.0.0.2')

    def test_call_contract_and_public_path_validation(self):
        responses = [{'ok': True, 'data': {'count': 1}, 'id': 'internal'},
                     {'ok': False, 'error': {'code': 'E_NEEDS_CONFIRM', 'message': 'Confirm', 'hint': 'Try UI', 'toolId': 'scene.clear'}}]
        for response in responses:
            with patch.object(server.bridge_hub, 'send_and_wait', return_value=response) as dispatch:
                result = self.request('/api/agent/call', {'method': 'agent.scene.tree', 'args': [1]})[2]
                self.assertEqual(result, {k: v for k, v in response.items() if k != 'id'})
                self.assertEqual(dispatch.call_args.args[0]['action'], 'agent')
                self.assertEqual(dispatch.call_args.args[0]['method'], 'scene.tree')
                self.assertLessEqual(dispatch.call_args.kwargs['timeout'], 20)
        for method in ['__proto__.x', 'scene.constructor', 'scene._secret', 'session.token', 'exec.call', 'scene["tree"]']:
            # exec.call is syntactically public but is rejected by descriptor traversal in JS.
            if method == 'exec.call':
                continue
            self.assert_error(self.request('/api/agent/call', {'method': method}), 'E_PERMISSION', 403)
        self.assert_error(self.request('/api/agent/call', {'method': 'scene.tree', 'args': {}}), 'E_INVALID_ARG', 400)
        with patch.object(server.bridge_hub, 'send_and_wait', return_value={'success': False, 'error': 'secret key'}):
            result = self.request('/api/agent/call', {'method': 'scene.tree'})
            self.assert_error(result, 'E_DISABLED', 503)
            self.assertNotIn('secret key', json.dumps(result))

    def test_body_deadline_and_unknown_routes(self):
        with patch.object(server, 'AGENT_TIMEOUT', 0.03):
            self.assert_error(self.request('/api/agent/call', b'{}', headers={'Content-Length': '100'}), 'E_TIMEOUT', 504)
        self.assert_error(self.request('/api/agent/missing'), 'E_NOT_FOUND', 404)
        self.assert_error(self.request('/api/agent/upload'), 'E_UNSUPPORTED', 405)


class ProxySecurityTests(unittest.TestCase):
    def target(self, url, ips=('93.184.216.34',)):
        with patch.object(server.socket, 'getaddrinfo', return_value=[answer(ip) for ip in ips]):
            return server._agent_target(url, time.monotonic() + 2)

    def test_domains_schemes_credentials_and_all_dns_answers(self):
        self.target('https://cdn.jsdelivr.net/model.glb')
        for url in ['file:///etc/passwd', 'ftp://cdn.jsdelivr.net/a', 'https://cdn.jsdelivr.net.evil.com/a',
                    'https://user:password@cdn.jsdelivr.net/a', 'https://127.0.0.1/a',
                    'https://cdn.jsdelivr.net:8080/a', 'https://cdn.jsdelivr.net/a\r\nX: y']:
            with self.assertRaises(server.AgentRequestError):
                self.target(url)
        for ip in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '224.0.0.1',
                   '240.0.0.1', '0.0.0.0', '100.64.0.1', '::1', 'fc00::1', 'fe80::1',
                   'ff02::1', '::ffff:127.0.0.1', '2001:db8::1']:
            with self.subTest(ip=ip), self.assertRaises(server.AgentRequestError) as error:
                self.target('https://cdn.jsdelivr.net/a', ('93.184.216.34', ip))
            self.assertEqual(error.exception.code, 'E_PERMISSION')

    def test_dns_deadline(self):
        release = threading.Event()
        def blocked(*args, **kwargs):
            release.wait(1)
            return [answer()]
        try:
            with patch.object(server.socket, 'getaddrinfo', side_effect=blocked), self.assertRaises(server.AgentRequestError) as error:
                server._agent_target('https://cdn.jsdelivr.net/a', time.monotonic() + 0.02)
            self.assertEqual(error.exception.code, 'E_TIMEOUT')
        finally:
            release.set()

    def test_pinned_socket_and_tls_original_hostname(self):
        for secure in (False, True):
            raw, tls = Mock(), Mock()
            context = Mock()
            context.wrap_socket.return_value = tls
            with patch.object(server.socket, 'socket', return_value=raw), \
                    patch.object(server.socket, 'getaddrinfo') as dns, \
                    patch.object(server.ssl, 'create_default_context', return_value=context):
                connection = server._AgentPinnedConnection('cdn.jsdelivr.net', 443 if secure else 80,
                                                          answer(), secure, time.monotonic() + 2)
                connection.connect()
                raw.connect.assert_called_once_with(('93.184.216.34', 443))
                dns.assert_not_called()
                if secure:
                    context.wrap_socket.assert_called_once_with(raw, server_hostname='cdn.jsdelivr.net',
                                                               do_handshake_on_connect=False)
                    tls.do_handshake.assert_called_once()
                connection.abort()

    def proxy(self, responses, limit=None):
        connections = []
        for status, headers, chunks in responses:
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.status = status
            response.getheader.side_effect = lambda key, default=None, h=headers: h.get(key, default)
            response.read1.side_effect = chunks
            connection = Mock()
            connection.getresponse.return_value = response
            connections.append(connection)
        dns = patch.object(server.socket, 'getaddrinfo', return_value=[answer()])
        factory = patch.object(server, '_AgentPinnedConnection', side_effect=connections)
        size = patch.object(server, 'AGENT_MAX_BYTES', limit if limit is not None else server.AGENT_MAX_BYTES)
        with dns as lookup, factory as create, size:
            result = server._agent_proxy('https://cdn.jsdelivr.net/model.glb', time.monotonic() + 2)
        return result, lookup, create, connections

    def test_redirect_revalidation_and_no_forwarded_credentials(self):
        result, lookup, create, connections = self.proxy([
            (302, {'Location': 'https://raw.githubusercontent.com/a/model.glb'}, []),
            (200, {'Content-Type': 'model/gltf-binary', 'Content-Length': '1'}, [b'a', b'']),
        ])
        self.assertEqual(result, {'body': b'a', 'contentType': 'model/gltf-binary', 'size': 1})
        self.assertEqual(lookup.call_count, 2)
        self.assertEqual(create.call_args_list[1].args[0], 'raw.githubusercontent.com')
        self.assertEqual(set(connections[0].request.call_args.kwargs['headers']),
                         {'User-Agent', 'Accept-Encoding', 'Connection'})
        for location in ['https://evil.example/a', 'http://127.0.0.1/a', 'https://user:secret@cdn.jsdelivr.net/a']:
            with self.assertRaises(server.AgentRequestError):
                self.proxy([(302, {'Location': location}, [])])
        with self.assertRaises(server.AgentRequestError):
            self.proxy([(302, {'Location': '/model.glb'}, [])] * 6)

    def test_real_pinned_http_and_absolute_socket_deadline(self):
        release, stalled = threading.Event(), threading.Event()
        seen = []
        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers['Host'])
                if self.path == '/stall.glb':
                    self.wfile.write(b'HTTP/1.1 200 OK\r\n')
                    self.wfile.flush()
                    stalled.set()
                    release.wait(2)  # Deadline must abort even while headers are incomplete.
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'model/gltf-binary')
                self.send_header('Content-Length', '4')
                self.end_headers()
                self.wfile.write(b'glTF')
            def log_message(self, *args):
                pass
        upstream = server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        worker = threading.Thread(target=upstream.serve_forever, daemon=True)
        worker.start()
        def validated(url, deadline):
            return server.urlsplit(url), 'cdn.jsdelivr.net', upstream.server_port, answer('127.0.0.1', upstream.server_port)
        try:
            with patch.object(server, '_agent_target', side_effect=validated), \
                    patch.object(server.socket, 'getaddrinfo') as dns:
                result = server._agent_proxy('http://cdn.jsdelivr.net/model.glb', time.monotonic() + 2)
                self.assertEqual(result['body'], b'glTF')
                self.assertEqual(seen[0], f'cdn.jsdelivr.net:{upstream.server_port}')
                dns.assert_not_called()
                with self.assertRaises(server.AgentRequestError) as error:
                    server._agent_proxy('http://cdn.jsdelivr.net/stall.glb', time.monotonic() + 0.05)
                self.assertTrue(stalled.is_set())
                self.assertEqual(error.exception.code, 'E_TIMEOUT')
        finally:
            release.set()
            upstream.shutdown()
            upstream.server_close()
            worker.join()

    def test_content_types_bounded_read_and_truncation(self):
        for mime in ['text/html', 'application/javascript', 'image/svg+xml', 'text/plain', '']:
            with self.assertRaises(server.AgentRequestError) as error:
                self.proxy([(200, {'Content-Type': mime}, [b'a', b''])])
            self.assertEqual(error.exception.code, 'E_UNSUPPORTED')
        for headers, chunks, code in [
            ({'Content-Type': 'image/png', 'Content-Length': '4'}, [], 'E_TOO_LARGE'),
            ({'Content-Type': 'image/png'}, [b'abcd'], 'E_TOO_LARGE'),
            ({'Content-Type': 'image/png', 'Content-Length': '3'}, [b'a', b''], 'E_NOT_FOUND'),
            ({'Content-Type': 'image/png', 'Content-Encoding': 'gzip'}, [], 'E_UNSUPPORTED'),
        ]:
            with self.assertRaises(server.AgentRequestError) as error:
                self.proxy([(200, headers, chunks)], limit=3)
            self.assertEqual(error.exception.code, code)
        self.assertEqual(server._agent_content_type('text/plain; charset=utf-8', '/model.obj'), 'text/plain')


class BridgeAndMCPTests(unittest.TestCase):
    def test_bridge_deadline_cleans_pending_futures(self):
        class Browser:
            async def send(self, payload):
                pass
        async def check():
            hub = object.__new__(server.StudioBridgeHub)
            hub.connected_clients = {Browser()}
            hub.pending_futures = {}
            result = await hub._dispatch_to_browser({'action': 'agent'}, timeout=0.01)
            self.assertFalse(result['success'])
            self.assertEqual(hub.pending_futures, {})
            task = asyncio.create_task(hub._dispatch_to_browser({'action': 'agent'}, timeout=20))
            await asyncio.sleep(0)  # Yield once so registration occurs; no wall-clock sleep.
            self.assertEqual(len(hub.pending_futures), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(hub.pending_futures, {})
        asyncio.run(check())

    @unittest.skipUnless(shutil.which('node'), 'Node is required for browser bridge tests')
    def test_javascript_public_dispatch_contract_and_exec(self):
        script = r"""
import fs from 'node:fs';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const source = fs.readFileSync(process.argv[1], 'utf8');
const { StudioBridge } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const bridge = Object.create(StudioBridge.prototype);
let getterHits = 0;
const scene = Object.create({ inherited() { throw Error('must not execute'); } });
scene.count = 7;
scene.tree = function(...args) { return { ok: true, data: [this.count, ...args] }; };
scene.fail = () => ({ ok: false, error: { code: 'E_NEEDS_CONFIRM', message: 'Confirm', hint: 'UI', toolId: 'scene.fail' } });
scene.thrown = () => { throw Object.assign(Error('Bad argument'), { code: 'E_INVALID_ARG', hint: 'Fix it', toolId: 'inner.tool' }); };
scene.circular = () => { const x = {}; x.self = x; return x; };
scene.slow = () => new Promise(() => {});
Object.defineProperty(scene, 'getter', { get() { getterHits++; return () => {}; } });
window.agent = { scene, session: { token() { throw Error('secret'); } }, exec: () => ({ ok: true, data: 'isolated-worker' }) };
const call = (method, args = []) => bridge.handleRequest({ action: 'agent', method, args });
assert.deepEqual(await call('agent.scene.tree', [1]), { ok: true, data: [7, 1] });
assert.deepEqual(await call('scene.fail'), scene.fail());
assert.equal((await call('scene.thrown')).error.toolId, 'inner.tool');
for (const method of ['__proto__.toString', 'scene.constructor', 'scene._secret', 'session.token', 'scene.inherited',
                      'scene.getter', 'scene.tree.call', 'exec.call', 'scene["tree"]', 'scene.count']) {
  assert.equal((await call(method)).ok, false, method);
}
assert.equal(getterHits, 0);
assert.deepEqual(await call('exec'), { ok: true, data: 'isolated-worker' });
assert.equal((await call('scene.tree', {})).error.code, 'E_INVALID_ARG');
assert.equal((await call('scene.circular')).ok, false);
assert.equal((await bridge.handleRequest({ action: 'agent', method: 'scene.slow', timeoutMs: 5 })).error.code, 'E_TIMEOUT');
delete window.agent;
assert.equal((await call('scene.tree')).error.code, 'E_DISABLED');
"""
        result = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script,
                                 str(ROOT / 'js/core/studio-bridge.js')], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_mcp_tool_request_and_contract(self):
        fake = types.ModuleType('mcp.server.mcpserver')
        fake.MCPServer = lambda name: types.SimpleNamespace(tool=lambda: lambda fn: fn)
        with patch.dict(sys.modules, {'mcp': types.ModuleType('mcp'), 'mcp.server': types.ModuleType('mcp.server'),
                                     'mcp.server.mcpserver': fake}):
            mcp = load_module('agent_test_mcp', 'studio_mcp.py')
        result = {'ok': True, 'data': {'objects': 2}}
        with patch.object(mcp, '_request', return_value=result) as request:
            self.assertEqual(json.loads(mcp.studio_agent_call('scene.tree')), result)
            request.assert_called_once_with('/api/agent/call', {'method': 'scene.tree', 'args': []})
        with patch.object(mcp, '_request', return_value={'success': False, 'error': 'secret'}):
            result = json.loads(mcp.studio_agent_call('scene.tree', [1]))
            self.assertEqual(result['error']['code'], 'E_DISABLED')
            self.assertNotIn('secret', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
