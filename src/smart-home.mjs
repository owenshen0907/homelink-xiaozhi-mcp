import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateJson } from './private-json.mjs';
import { alexaAdapter, validateAlexaSession } from './alexa-adapter.mjs';

const fail = (message, status = 400) => Object.assign(Error(message), { status });
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
export async function smartHome({ dataDir, adapter = alexaAdapter(), onChange = () => {} }) {
  const store = await privateJson(join(dataDir, 'smart-home'));
  let session = await store.read('session.json'),
    catalog = [],
    busy = false,
    stopped = false,
    phase = session ? 'waiting' : 'disconnected',
    error = '';
  const saved = (await store.read('settings.json')) ?? { names: {}, commands: [] };
  const names = saved.names ?? {},
    commands = new Map(
      (saved.commands ?? [])
        .slice(-100)
        .map((c) => [
          c.requestId,
          { ...c, status: ['executing'].includes(c.status) ? 'unconfirmed' : c.status },
        ]),
    );
  let task = null;
  const persist = () =>
    store.write('settings.json', { names, commands: [...commands.values()].slice(-100) });
  const sessionUpdated = async (value) => {
    validateAlexaSession(value);
    await store.write('session.json', value);
    session = value;
  };
  const view = (d) => ({
    id: d.id,
    name:
      names[d.id] ??
      (d.name.includes('⬆')
        ? '上方灯'
        : d.name.includes('⬇')
          ? '下方灯'
          : d.kind === 'THERMOSTAT'
            ? '空调'
            : d.name),
    originalName: d.name,
    kind: d.kind,
    actions: d.actions,
  });
  function status() {
    return {
      configured: !!session,
      phase,
      busy,
      error,
      devices: catalog.map(view),
      lastResult: [...commands.values()].at(-1) ?? null,
    };
  }
  async function exclusive(fn) {
    if (stopped) throw fail('家居服务已停止', 503);
    if (busy) throw fail('家居服务正忙，请稍后重试', 429);
    busy = true;
    onChange();
    task = (async () => fn())();
    try {
      return await task;
    } finally {
      busy = false;
      task = null;
      onChange();
    }
  }
  async function refreshNow(candidate = session, onSession = sessionUpdated) {
    if (!candidate) {
      phase = 'disconnected';
      catalog = [];
      return status();
    }
    phase = 'connecting';
    error = '';
    onChange();
    try {
      catalog = await adapter.list(candidate, { onSession });
      phase = 'ready';
      return catalog;
    } catch (e) {
      phase = 'error';
      error = 'Alexa 连接失败，请重新授权或稍后重试';
      throw fail(error, e.status === 401 ? 401 : 502);
    } finally {
      onChange();
    }
  }
  async function execute(
    { requestId = randomUUID(), deviceId, action, expiresAt = Date.now() + 30000 },
    signal,
  ) {
    if (
      !validId(requestId) ||
      !Number.isFinite(expiresAt) ||
      expiresAt > Date.now() + 60000 ||
      expiresAt <= Date.now()
    )
      throw fail('指令无效或已过期');
    const old = commands.get(requestId);
    if (old) {
      if (old.deviceId !== deviceId || old.action !== action)
        throw fail('重复指令的内容不一致', 409);
      return old;
    }
    return exclusive(async () => {
      const device = catalog.find((d) => d.id === deviceId);
      if (!session || phase !== 'ready') throw fail('请先连接 Alexa 并刷新设备', 503);
      if (!device || !['turn_on', 'turn_off'].includes(action) || !device.actions.includes(action))
        throw fail('请选择支持开关的设备和动作');
      if (signal?.aborted || expiresAt <= Date.now()) throw fail('操作已取消或过期', 409);
      const lifetime = AbortSignal.timeout(Math.max(1, Math.ceil(expiresAt - Date.now())));
      const actionSignal = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
      const result = {
        requestId,
        deviceId,
        name: view(device).name,
        action,
        status: 'executing',
        at: new Date().toISOString(),
      };
      commands.set(requestId, result);
      while (commands.size > 100) commands.delete(commands.keys().next().value);
      await persist();
      onChange();
      try {
        if (actionSignal.aborted) throw fail('操作已取消或过期', 409);
        Object.assign(
          result,
          await adapter.control(session, device, action, {
            signal: actionSignal,
            onSession: sessionUpdated,
          }),
        );
      } catch (e) {
        Object.assign(result, {
          status: 'failed',
          message:
            e.status === 401
              ? 'Alexa 授权已失效，请重新连接'
              : e.status === 409
                ? '操作已取消或过期'
                : '未能执行，请检查 Alexa 连接后重试',
        });
        if (e.status === 401) {
          phase = 'error';
          error = result.message;
        }
      }
      result.at = new Date().toISOString();
      await persist();
      return { ...result };
    });
  }
  const tools = () => [
    {
      name: 'home_list_devices',
      description:
        '列出已连接的家居设备、中文名称和允许操作。需要识别目标时先调用；不要猜设备编号。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'home_control_device',
      description:
        '根据用户明确要求打开或关闭一台家电。目标不明确时先问用户，不猜测。必须依据返回结果说明是否执行；空调红外状态未确认时如实说明。',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'home_list_devices 返回的 id' },
          action: { type: 'string', enum: ['turn_on', 'turn_off'] },
        },
        required: ['deviceId', 'action'],
        additionalProperties: false,
      },
    },
  ];
  async function callTool(name, args = {}, context = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('工具参数无效');
    if (name === 'home_list_devices') {
      if (Object.keys(args).length) throw fail('工具参数无效');
      return { devices: catalog.map(view), connected: phase === 'ready' };
    }
    if (
      name !== 'home_control_device' ||
      Object.keys(args).some((k) => !['deviceId', 'action'].includes(k))
    )
      throw fail('工具或参数不在允许范围');
    return execute({ ...args, requestId: context.requestId ?? randomUUID() }, context.signal);
  }
  return {
    status,
    execute,
    tools,
    callTool,
    refresh: () => exclusive(() => refreshNow()),
    importSession: (value) =>
      exclusive(async () => {
        validateAlexaSession(value);
        let replacement = value;
        await refreshNow(value, async (fresh) => {
          replacement = validateAlexaSession(fresh);
        });
        await sessionUpdated(replacement);
        error = '';
        return status();
      }),
    rename: ({ deviceId, name }) =>
      exclusive(async () => {
        if (
          !catalog.some((d) => d.id === deviceId) ||
          typeof name !== 'string' ||
          !name.trim() ||
          Array.from(name.trim()).length > 24 ||
          /[\x00-\x1f]/.test(name)
        )
          throw fail('名称须为1–24个字');
        names[deviceId] = name.trim();
        await persist();
        return status();
      }),
    disconnect: () =>
      exclusive(async () => {
        await store.remove('session.json');
        session = null;
        catalog = [];
        phase = 'disconnected';
        error = '';
        return status();
      }),
    async close() {
      stopped = true;
      await task?.catch(() => {});
    },
  };
}
