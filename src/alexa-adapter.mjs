import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const AlexaRemote = createRequire(import.meta.url)('alexa-remote2');
const hosts = new Set([
  'alexa.amazon.co.jp',
  'fe-api-alexa.amazon.co.jp',
  'pitangui.amazon.co.jp',
  'pitangui.amazon.com',
]);
const directoryQuery =
  'query Endpoints { endpoints { items { endpointId friendlyName displayCategories { primary { value } } manufacturer { value { text } } features { name operations { name } } } } }';
const powerQuery =
  'query HomeHubPower($endpointId: String!) { endpoint(id: $endpointId) { features { name properties { name ... on Power { powerStateValue } } } } }';
const powerMutation =
  'mutation HomeHubPowerControl($featureControlRequests: [FeatureControlRequest!]!) { setEndpointFeatures(setEndpointFeaturesInput: { featureControlRequests: $featureControlRequests }) { featureControlResponses { endpointId featureOperationName } errors { endpointId code } } }';
const fail = (message, status = 502) => Object.assign(Error(message), { status });

export function validateAlexaSession(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 256 * 1024 ||
    value.amazonPage !== 'amazon.co.jp' ||
    typeof value.localCookie !== 'string' ||
    !value.localCookie ||
    value.localCookie.length > 128 * 1024 ||
    typeof value.refreshToken !== 'string' ||
    !value.refreshToken ||
    value.refreshToken.length > 16384 ||
    !value.macDms ||
    typeof value.macDms !== 'object' ||
    !Number.isFinite(value.tokenDate) ||
    value.dataVersion !== 2
  )
    throw fail('请选择本机连接工具生成的日本 Amazon 授权文件', 400);
  return value;
}
export const endpointKey = (id) => createHash('sha256').update(id).digest('hex').slice(0, 20);
export function summariseAlexaDevices(items) {
  if (!Array.isArray(items) || items.length > 1000) throw fail('Alexa 设备目录格式无效');
  const devices = [];
  for (const d of items) {
    if (
      !/^amzn1\.alexa\.endpoint\.[a-zA-Z0-9-]{1,128}$/.test(d?.endpointId ?? '') ||
      typeof d.friendlyName !== 'string'
    )
      continue;
    const kind = d.displayCategories?.primary?.value,
      operations = d.features?.find((f) => f.name === 'power')?.operations;
    if (!['LIGHT', 'THERMOSTAT', 'SWITCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR'].includes(kind))
      continue;
    const actions =
      Array.isArray(operations) && ['LIGHT', 'THERMOSTAT', 'SWITCH'].includes(kind)
        ? [
            ['turnOn', 'turn_on'],
            ['turnOff', 'turn_off'],
          ]
            .filter(([op]) => operations.some((o) => o.name === op))
            .map(([, action]) => action)
        : [];
    devices.push({
      id: endpointKey(d.endpointId),
      endpointId: d.endpointId,
      name: d.friendlyName.slice(0, 80),
      kind,
      actions,
    });
  }
  if (new Set(devices.map((d) => d.id)).size !== devices.length) throw fail('Alexa 设备标识重复');
  return devices;
}
export function allowedAlexaRequest(requestPath, flags = {}, baseUrl, bodies = []) {
  let url;
  try {
    url = new URL(requestPath, `https://${baseUrl}`);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    flags.host ||
    flags.headers
  )
    return false;
  const method = flags.method ?? (flags.data ? 'POST' : 'GET');
  if (method === 'GET')
    return ['/api/customer-status', '/api/endpoints'].includes(url.pathname) && !flags.data;
  return method === 'POST' && url.pathname === '/nexus/v1/graphql' && bodies.includes(flags.data);
}
function accepted(body, id, operation) {
  const result = body?.data?.setEndpointFeatures;
  return (
    (!body.errors || (Array.isArray(body.errors) && !body.errors.length)) &&
    result &&
    (!result.errors || (Array.isArray(result.errors) && !result.errors.length)) &&
    Array.isArray(result.featureControlResponses) &&
    result.featureControlResponses.length === 1 &&
    result.featureControlResponses[0].endpointId === id &&
    result.featureControlResponses[0].featureOperationName === operation
  );
}
function reportedPower(body) {
  if (body?.errors?.length) return null;
  const values = body?.data?.endpoint?.features
    ?.filter((f) => f.name === 'power')
    .flatMap((f) => f.properties ?? [])
    .map((p) => p.powerStateValue);
  return values?.find((v) => ['ON', 'OFF'].includes(v)) ?? null;
}

export function alexaAdapter({ Remote = AlexaRemote } = {}) {
  async function withRemote(session, bodies, signal, onSession, operation) {
    validateAlexaSession(session);
    const remote = new Remote();
    let refreshed = session;
    remote.prepare = (cb) => cb();
    remote.generateCookie = (_email, _password, cb) =>
      cb(fail('Alexa 授权已失效，请重新连接', 401));
    const actual = remote.httpsGetCall.bind(remote);
    let writes = 0;
    remote.httpsGetCall = (url, cb, flags = {}) => {
      if (signal?.aborted) return cb(fail('操作已取消', 409));
      if (!allowedAlexaRequest(url, flags, remote.baseUrl, bodies))
        return cb(fail('Alexa 接口不在允许范围'));
      if (flags.data && JSON.parse(flags.data).query.startsWith('mutation') && ++writes > 1)
        return cb(fail('已阻止重复家电操作'));
      return actual(url, cb, { ...flags, timeout: 12000, isRetry: true });
    };
    remote.on('cookie', () => {
      if (remote.cookieData) refreshed = remote.cookieData;
    });
    const wait = (fn) =>
      new Promise((resolve, reject) => {
        let finished = false;
        const end = (error, result) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve(result);
        };
        const abort = () => end(fail('操作已取消，已发出的指令请检查设备', 409));
        const timer = setTimeout(() => end(fail('Alexa 响应超时，请检查设备')), 15000);
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          fn(end);
        } catch {
          end(fail('Alexa 暂时无法连接'));
        }
      });
    try {
      await wait((cb) =>
        remote.init(
          {
            amazonPage: 'amazon.co.jp',
            baseAmazonPage: 'amazon.co.jp',
            acceptLanguage: 'ja-JP',
            logger: () => {},
            cookie: session,
            cookieRefreshInterval: 0,
            setupProxy: false,
            usePushConnection: false,
            useWsMqtt: false,
            bluetooth: false,
            notifications: false,
          },
          cb,
        ),
      );
      const request = (body) =>
        wait((cb) => remote.httpsGetCall('/nexus/v1/graphql', cb, { method: 'POST', data: body }));
      return await operation(request);
    } catch (e) {
      if (e.status) throw e;
      throw fail('Alexa 连接失败，请检查授权或稍后重试');
    } finally {
      remote.stop();
      if (refreshed !== session) await onSession?.(validateAlexaSession(refreshed));
    }
  }
  return {
    async list(session, { signal, onSession } = {}) {
      const body = JSON.stringify({ query: directoryQuery });
      return withRemote(session, [body], signal, onSession, async (request) => {
        const result = await request(body);
        if (result?.errors?.length) throw fail('Alexa 设备读取失败');
        return summariseAlexaDevices(result?.data?.endpoints?.items);
      });
    },
    async control(session, device, action, { signal, onSession } = {}) {
      if (!['turn_on', 'turn_off'].includes(action) || !device.actions.includes(action))
        throw fail('设备不支持这个动作', 400);
      const operation = action === 'turn_on' ? 'turnOn' : 'turnOff',
        desired = action === 'turn_on' ? 'ON' : 'OFF';
      const write = JSON.stringify({
        query: powerMutation,
        variables: {
          featureControlRequests: [
            {
              endpointId: device.endpointId,
              featureName: 'power',
              featureOperationName: operation,
            },
          ],
        },
      });
      const read = JSON.stringify({
        query: powerQuery,
        variables: { endpointId: device.endpointId },
      });
      let sent = false;
      try {
        return await withRemote(session, [write, read], signal, onSession, async (request) => {
          if (signal?.aborted) throw fail('操作已取消', 409);
          sent = true;
          const result = await request(write);
          if (!accepted(result, device.endpointId, operation))
            return { status: 'failed', power: null, message: 'Alexa 未确认执行成功，请检查设备' };
          const power = reportedPower(await request(read).catch(() => null));
          return {
            status: device.kind !== 'THERMOSTAT' && power === desired ? 'reported' : 'unconfirmed',
            power,
            source: 'alexa',
            physicalConfirmed: false,
            message:
              device.kind === 'THERMOSTAT'
                ? `已发送空调${action === 'turn_on' ? '开机' : '关机'}指令，请确认空调响应`
                : power === desired
                  ? `Alexa 已回报${action === 'turn_on' ? '开启' : '关闭'}`
                  : '指令已发送，设备状态尚未确认',
          };
        });
      } catch (e) {
        if (sent)
          return {
            status: 'unconfirmed',
            power: null,
            message: '指令可能已发送，结果未确认，请检查设备',
          };
        throw e;
      }
    },
  };
}
