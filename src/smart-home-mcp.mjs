import { packageName, packageVersion } from './metadata.mjs';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateJson } from './private-json.mjs';

const fail = (message, status = 400) => Object.assign(Error(message), { status });
export function validateMcpEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('请填写小智控制台生成的 MCP 接入点');
  }
  if (
    url.protocol !== 'wss:' ||
    url.hostname !== 'api.xiaozhi.me' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/mcp/' ||
    url.hash ||
    url.searchParams.size !== 1 ||
    !url.searchParams.has('token') ||
    !/^[A-Za-z0-9_.-]{20,8192}$/.test(url.searchParams.get('token') ?? '')
  )
    throw fail('请使用小智官方的安全 MCP 接入点');
  return url.href;
}

// Outbound authenticated socket: no public tool port and no credentials in state.
export async function smartHomeMcp({
  dataDir,
  home,
  onChange = () => {},
  Socket = WebSocket,
  retryMs = 3000,
}) {
  const store = await privateJson(join(dataDir, 'smart-home'));
  let endpoint = (await store.read('voice.json'))?.endpoint ?? null,
    socket = null,
    phase = 'disconnected',
    closed = false,
    timer = null,
    heartbeat = null,
    backoff = retryMs;
  const pending = new Map();
  let current = null,
    connection = '';
  const status = () => ({ configured: !!endpoint, phase });
  function setPhase(value) {
    phase = value;
    onChange();
  }
  function stopSocket() {
    clearTimeout(timer);
    clearInterval(heartbeat);
    timer = heartbeat = null;
    current?.abort();
    socket?.terminate();
    socket = null;
    pending.clear();
  }
  function connect() {
    if (closed || !endpoint) return;
    connection = randomUUID();
    setPhase('connecting');
    let active;
    try {
      active = new Socket(validateMcpEndpoint(endpoint), {
        maxPayload: 32768,
        perMessageDeflate: false,
        handshakeTimeout: 12000,
        followRedirects: false,
      });
    } catch {
      setPhase('error');
      return;
    }
    socket = active;
    let initialized = false,
      lastPong = Date.now();
    const send = (value) => {
      if (
        socket === active &&
        active.readyState === WebSocket.OPEN &&
        active.bufferedAmount < 128 * 1024
      )
        active.send(JSON.stringify(value));
    };
    const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
    active.on('open', () => {
      backoff = retryMs;
      setPhase('connected');
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 45000) return active.terminate();
        if (active.readyState === WebSocket.OPEN) active.ping();
      }, 15000);
      heartbeat.unref();
    });
    active.on('pong', () => {
      lastPong = Date.now();
    });
    active.on('error', () => {}); // ws errors may contain the secret URL; never log them.
    active.on('close', () => {
      if (socket !== active) return;
      clearInterval(heartbeat);
      heartbeat = null;
      current?.abort();
      socket = null;
      pending.clear();
      setPhase('reconnecting');
      if (!closed && endpoint) {
        timer = setTimeout(connect, backoff);
        timer.unref();
        backoff = Math.min(backoff * 2, 60000);
      }
    });
    active.on('message', async (bytes, binary) => {
      if (binary || socket !== active) return;
      let message;
      try {
        message = JSON.parse(bytes.toString());
      } catch {
        return rpcError(null, -32700, '请求格式无效');
      }
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
      const id = message.id,
        hasId = Object.hasOwn(message, 'id');
      if (hasId && !((typeof id === 'string' && id.length <= 100) || Number.isSafeInteger(id)))
        return rpcError(null, -32600, '请求编号无效');
      const params = message.params ?? {};
      if (message.method === 'initialize' && hasId) {
        initialized = true;
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: packageName, version: packageVersion },
            instructions:
              '家电工具只支持已登记设备。目标不明确时先询问，执行结果未确认时不要宣称已成功。',
          },
        });
      }
      if (message.method === 'notifications/initialized') {
        if (initialized) setPhase('ready');
        return;
      }
      if (message.method === 'notifications/cancelled') {
        pending.get(String(params.requestId))?.controller.abort();
        return;
      }
      if (message.method === 'ping' && hasId) return send({ jsonrpc: '2.0', id, result: {} });
      if (!hasId) return;
      if (!initialized) return rpcError(id, -32000, '请先初始化');
      if (message.method === 'tools/list') {
        setPhase('ready');
        return send({ jsonrpc: '2.0', id, result: { tools: home.tools() } });
      }
      if (message.method !== 'tools/call') return rpcError(id, -32601, '方法不存在');
      const key = String(id),
        fingerprint = JSON.stringify(params);
      if (pending.has(key)) {
        const old = pending.get(key);
        if (old.fingerprint !== fingerprint) return rpcError(id, -32600, '重复请求内容不一致');
        const result = await old.promise;
        return send({ jsonrpc: '2.0', id, result });
      }
      if (current) return rpcError(id, -32000, '家居服务正忙，请稍后重试');
      if (pending.size >= 100) pending.delete(pending.keys().next().value);
      const controller = new AbortController();
      current = controller;
      const requestId = 'mcp-' + randomUUID(),
        session = connection;
      const promise = (async () => {
        try {
          const result = await home.callTool(params.name, params.arguments ?? {}, {
            requestId,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: result?.status === 'failed',
          };
        } catch {
          return {
            content: [{ type: 'text', text: '本次家居操作未确认，请检查后台连接或目标设备。' }],
            isError: true,
          };
        } finally {
          if (current === controller) current = null;
        }
      })();
      pending.set(key, { fingerprint, promise, controller });
      const result = await promise;
      if (connection === session) send({ jsonrpc: '2.0', id, result });
    });
  }
  return {
    status,
    start() {
      if (endpoint) connect();
    },
    async configure(value) {
      const next = validateMcpEndpoint(value);
      await store.write('voice.json', { endpoint: next });
      stopSocket();
      endpoint = next;
      connect();
      return status();
    },
    async disconnect() {
      await store.remove('voice.json');
      endpoint = null;
      stopSocket();
      setPhase('disconnected');
      return status();
    },
    async close() {
      closed = true;
      stopSocket();
    },
  };
}
