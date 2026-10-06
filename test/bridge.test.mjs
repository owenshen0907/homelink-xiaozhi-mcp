import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, stat, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { smartHome } from '../src/smart-home.mjs';
import { smartHomeMcp, validateMcpEndpoint } from '../src/smart-home-mcp.mjs';
import {
  alexaAdapter,
  allowedAlexaRequest,
  summariseAlexaDevices,
  validateAlexaSession,
} from '../src/alexa-adapter.mjs';
import { privateJson } from '../src/private-json.mjs';
import { authorizeAlexa, correctJapaneseOAuthPath, loginProxyFilter } from '../src/alexa-login.mjs';

const secret = 'synthetic-private-marker';
const session = () => ({
  amazonPage: 'amazon.co.jp',
  localCookie: 'csrf=synthetic; session=' + secret,
  refreshToken: secret,
  macDms: { adp_token: secret },
  tokenDate: Date.now(),
  dataVersion: 2,
});
const light = {
  id: 'lamp-one',
  endpointId: 'amzn1.alexa.endpoint.synthetic-light',
  name: '测试灯',
  kind: 'LIGHT',
  actions: ['turn_on', 'turn_off'],
};
const stub = () => ({
  calls: 0,
  async list() {
    return [light];
  },
  async control() {
    this.calls++;
    return {
      status: 'reported',
      power: 'ON',
      message: 'Alexa 已回报开启',
      physicalConfirmed: false,
    };
  },
});

test('Alexa 会话、设备能力与最终请求边界拒绝无关账号操作和任意控制', () => {
  assert.equal(validateAlexaSession(session()).amazonPage, 'amazon.co.jp');
  assert.throws(() => validateAlexaSession({ ...session(), amazonPage: 'amazon.com' }));
  const devices = summariseAlexaDevices([
    {
      endpointId: light.endpointId,
      friendlyName: '测试灯',
      displayCategories: { primary: { value: 'LIGHT' } },
      features: [{ name: 'power', operations: [{ name: 'turnOn' }, { name: 'unlock' }] }],
      cookie: secret,
    },
  ]);
  assert.deepEqual(devices[0].actions, ['turn_on']);
  assert.equal(JSON.stringify(devices).includes(secret), false);
  assert.deepEqual(
    summariseAlexaDevices([
      {
        endpointId: 'amzn1.alexa.endpoint.voice-device',
        friendlyName: '非家电账号设备',
        displayCategories: { primary: { value: 'ALEXA_VOICE_ENABLED' } },
      },
    ]),
    [],
  );
  const body = '{"query":"allowed"}';
  assert.equal(
    allowedAlexaRequest(
      '/nexus/v1/graphql',
      { method: 'POST', data: body },
      'fe-api-alexa.amazon.co.jp',
      [body],
    ),
    true,
  );
  for (const [path, flags, base] of [
    ['/api/notifications', {}, 'alexa.amazon.co.jp'],
    [
      '/nexus/v1/graphql',
      { method: 'POST', data: '{"query":"mutation arbitrary"}' },
      'alexa.amazon.co.jp',
    ],
    ['/api/endpoints', { host: 'example.org' }, 'alexa.amazon.co.jp'],
    ['/api/endpoints', { headers: { Cookie: secret } }, 'alexa.amazon.co.jp'],
    ['/api/endpoints', {}, 'example.org'],
  ])
    assert.equal(allowedAlexaRequest(path, flags, base, [body]), false);
});
test('真实驱动协议：只写一次，验证目标回执；红外空调保留未确认状态', async () => {
  const requests = [];
  class Remote extends EventEmitter {
    init(options, cb) {
      this.cookieData = options.cookie;
      this.baseUrl = 'fe-api-alexa.amazon.co.jp';
      cb();
    }
    httpsGetCall(path, cb, flags) {
      const body = JSON.parse(flags.data);
      requests.push(body);
      if (body.query.startsWith('mutation'))
        cb(null, {
          data: {
            setEndpointFeatures: {
              errors: [],
              featureControlResponses: [
                { endpointId: light.endpointId, featureOperationName: 'turnOn' },
              ],
            },
          },
        });
      else
        cb(null, {
          data: {
            endpoint: { features: [{ name: 'power', properties: [{ powerStateValue: 'ON' }] }] },
          },
        });
    }
    stop() {}
  }
  const driver = alexaAdapter({ Remote });
  const result = await driver.control(session(), light, 'turn_on');
  assert.equal(result.status, 'reported');
  assert.equal(result.physicalConfirmed, false);
  assert.equal(requests.filter((r) => r.query.startsWith('mutation')).length, 1);
  assert.deepEqual(requests[0].variables.featureControlRequests, [
    { endpointId: light.endpointId, featureName: 'power', featureOperationName: 'turnOn' },
  ]);
  assert.equal(
    (await driver.control(session(), { ...light, kind: 'THERMOSTAT' }, 'turn_on')).status,
    'unconfirmed',
  );
  const before = requests.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(driver.control(session(), light, 'turn_on', { signal: controller.signal }));
  assert.equal(requests.length, before);
});
test('后台授权私有持久化、重复指令、取消与重启不会再次操作设备', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-home-')),
    adapter = stub();
  let home = await smartHome({ dataDir: dir, adapter });
  try {
    await home.importSession(session());
    await home.rename({ deviceId: light.id, name: '书桌灯' });
    const command = { requestId: 'one-command', deviceId: light.id, action: 'turn_on' };
    assert.equal((await home.execute(command)).status, 'reported');
    assert.equal((await home.execute(command)).status, 'reported');
    assert.equal(adapter.calls, 1);
    await assert.rejects(home.execute({ ...command, action: 'turn_off' }), /内容不一致/);
    await assert.rejects(
      home.execute({ ...command, requestId: 'expired', expiresAt: Date.now() - 1 }),
      /过期/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(home.execute({ ...command, requestId: 'cancelled' }, controller.signal));
    assert.equal(adapter.calls, 1);
    for (const name of ['session.json', 'settings.json'])
      assert.equal((await stat(join(dir, 'smart-home', name))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(home.status()).includes(secret), false);
    assert.equal(home.status().devices[0].name, '书桌灯');
    await home.close();
    home = await smartHome({ dataDir: dir, adapter });
    await home.refresh();
    assert.equal((await home.execute(command)).status, 'reported');
    assert.equal(adapter.calls, 1);
    assert.equal(home.status().devices[0].name, '书桌灯');
    await home.disconnect();
    assert.equal(home.status().configured, false);
    assert.equal(home.status().devices.length, 0);
  } finally {
    await home.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('导入时刷新后的会话不被旧会话覆盖，错误连接不覆盖现有授权', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-home-import-'));
  let fail = false;
  const fresh = { ...session(), refreshToken: 'synthetic-refreshed-token' };
  const adapter = {
    async list(_s, { onSession }) {
      await onSession(fresh);
      if (fail) throw Error(secret);
      return [light];
    },
  };
  const home = await smartHome({ dataDir: dir, adapter });
  try {
    await home.importSession(session());
    assert.equal(
      JSON.parse(await readFile(join(dir, 'smart-home/session.json'))).refreshToken,
      fresh.refreshToken,
    );
    fail = true;
    await assert.rejects(home.importSession(session()), (e) => !e.message.includes(secret));
    assert.equal(
      JSON.parse(await readFile(join(dir, 'smart-home/session.json'))).refreshToken,
      fresh.refreshToken,
    );
  } finally {
    await home.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('指令有效期覆盖授权等待，过期后不再向家电发送', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-home-expiry-'));
  let writes = 0;
  const adapter = {
    async list() {
      return [light];
    },
    async control(_s, _d, _a, { signal }) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          writes++;
          resolve();
        }, 250);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(Object.assign(Error('expired'), { status: 409 }));
          },
          { once: true },
        );
      });
      return { status: 'reported' };
    },
  };
  const home = await smartHome({ dataDir: dir, adapter });
  try {
    await home.importSession(session());
    const result = await home.execute({
      requestId: 'expiring',
      deviceId: light.id,
      action: 'turn_on',
      expiresAt: Date.now() + 80,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.message, '操作已取消或过期');
    assert.equal(writes, 0);
  } finally {
    await home.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('登录超时关闭代理并移除监听，迟到的授权不再保存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-home-login-'));
  let callback,
    stops = 0;
  const Cookie = {
    generateAlexaCookie(options, cb) {
      writeFileSync(options.formerDataStorePath, JSON.stringify({ synthetic: true }));
      callback = cb;
    },
    stopProxyServer() {
      stops++;
    },
  };
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  try {
    await assert.rejects(authorizeAlexa({ directory: dir, Cookie, timeoutMs: 20 }), /登录超时/);
    assert.equal(stops, 1);
    assert.equal((await stat(join(dir, 'registration-cache.json'))).mode & 0o777, 0o600);
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
    await callback(null, session());
    await assert.rejects(readFile(join(dir, 'session.json')), (e) => e.code === 'ENOENT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('私有授权文件拒绝符号链接和过宽权限；日本登录参数仅修正协议标识', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-home-private-'));
  try {
    const store = await privateJson(join(dir, 'safe'));
    await store.write('session.json', session());
    await chmod(join(dir, 'safe/session.json'), 0o644);
    await assert.rejects(store.read('session.json'));
    await symlink(join(dir, 'safe'), join(dir, 'link'));
    await assert.rejects(privateJson(join(dir, 'link')));
    const original =
      '/ap/signin?openid.ns.oa2=' +
      encodeURIComponent('http://www.amazon.co.jp/ap/ext/oauth/2') +
      '&openid.oa2.code_challenge=synthetic&openid.return_to=https%3A%2F%2Fwww.amazon.co.jp%2Fap%2Fmaplanding';
    const corrected = correctJapaneseOAuthPath(original),
      url = new URL(corrected, 'https://www.amazon.co.jp');
    assert.equal(url.searchParams.get('openid.ns.oa2'), 'http://www.amazon.com/ap/ext/oauth/2');
    assert.equal(url.searchParams.get('openid.oa2.code_challenge'), 'synthetic');
    assert.equal(
      url.searchParams.get('openid.return_to'),
      'https://www.amazon.co.jp/ap/maplanding',
    );
    assert.equal(correctJapaneseOAuthPath(corrected), corrected);
    const filter = loginProxyFilter('!/cookie-success');
    assert.equal(filter('/cookie-success'), false);
    assert.equal(filter('/ap/signin'), true);
    assert.equal(filter('/' + '{'.repeat(20000)), true);
    assert.throws(() => loginProxyFilter('{'.repeat(20000)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('真实 MCP WebSocket：初始化、工具发现/调用、相同 RPC 去重与秘密不出现在状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-home-mcp-')),
    adapter = stub(),
    home = await smartHome({ dataDir: dir, adapter });
  await home.importSession(session());
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const url = 'ws://127.0.0.1:' + server.address().port,
    endpoint = 'wss://api.xiaozhi.me/mcp/?token=synthetic-private-token-123456789';
  class Socket extends WebSocket {
    constructor(actual, options) {
      assert.equal(actual, endpoint);
      super(url, options);
    }
  }
  const bridge = await smartHomeMcp({ dataDir: dir, home, Socket });
  try {
    const connection = new Promise((r) => server.once('connection', r));
    await bridge.configure(endpoint);
    const ws = await connection;
    const rpc = (id, method, params = {}) =>
      new Promise((resolve) => {
        const listener = (raw) => {
          const message = JSON.parse(raw);
          if (message.id !== id) return;
          ws.off('message', listener);
          resolve(message);
        };
        ws.on('message', listener);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    assert.equal((await rpc(1, 'initialize')).result.serverInfo.name, 'homelink-xiaozhi-mcp');
    const list = await rpc(2, 'tools/list');
    assert.ok(list.result.tools.some((t) => t.name === 'home_control_device'));
    assert.equal(bridge.status().phase, 'ready');
    const args = {
      name: 'home_control_device',
      arguments: { deviceId: light.id, action: 'turn_on' },
    };
    const result = await rpc(3, 'tools/call', args);
    assert.equal(JSON.parse(result.result.content[0].text).status, 'reported');
    await rpc(3, 'tools/call', args);
    assert.equal(adapter.calls, 1);
    assert.equal(
      (
        await rpc(3, 'tools/call', {
          ...args,
          arguments: { ...args.arguments, action: 'turn_off' },
        })
      ).error.code,
      -32600,
    );
    let entered;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    adapter.control = async (_s, _d, _a, { signal }) => {
      entered();
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(Error('cancelled'), { status: 409 })),
          { once: true },
        );
      });
      adapter.calls++;
      return { status: 'reported' };
    };
    const cancelled = rpc(4, 'tools/call', args);
    await waiting;
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 4 },
      }),
    );
    assert.equal((await cancelled).result.isError, true);
    assert.equal(adapter.calls, 1);
    await rpc(4, 'tools/call', args);
    assert.equal(adapter.calls, 1);
    assert.equal(JSON.stringify(bridge.status()).includes('synthetic-private-token'), false);
    assert.equal((await stat(join(dir, 'smart-home/voice.json'))).mode & 0o777, 0o600);
    for (const value of [
      'ws://api.xiaozhi.me/mcp/?token=synthetic',
      'wss://evil.example/mcp/?token=' + secret,
      'wss://api.xiaozhi.me/mcp/?token=' + secret + '&redirect=evil',
    ])
      assert.throws(() => validateMcpEndpoint(value));
    await bridge.disconnect();
    assert.equal(bridge.status().configured, false);
  } finally {
    await bridge.close();
    await home.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
