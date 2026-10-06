import { createRequire } from 'node:module';
import { privateJson } from './private-json.mjs';

const require = createRequire(import.meta.url);
// alexa-cookie2 5.0.6 uses this fixed negative glob. Replace it with a
// predicate so no login request is routed through the vulnerable glob parser.
export function loginProxyFilter(context) {
  if (context !== '!/cookie-success') throw Error('登录依赖版本不匹配');
  return (pathname) => pathname !== '/cookie-success';
}
export function correctJapaneseOAuthPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/ap/signin?')) return path;
  return path.replace(/([?&]openid\.ns\.oa2=)([^&]*)/, (whole, prefix, value) => {
    try {
      return decodeURIComponent(value) === 'http://www.amazon.co.jp/ap/ext/oauth/2'
        ? prefix + encodeURIComponent('http://www.amazon.com/ap/ext/oauth/2')
        : whole;
    } catch {
      return whole;
    }
  });
}
function loadCookieLibrary() {
  const fromRemote = createRequire(require.resolve('alexa-remote2/package.json'));
  const fromCookie = createRequire(fromRemote.resolve('alexa-cookie2/package.json'));
  if (fromCookie('./package.json').version !== '5.0.6') throw Error('登录依赖版本不匹配');
  const proxy = fromCookie('http-proxy-middleware'),
    original = proxy.createProxyMiddleware;
  proxy.createProxyMiddleware = function (context, options) {
    const rewrite = options.pathRewrite;
    return original.call(this, loginProxyFilter(context), {
      ...options,
      pathRewrite: function (...args) {
        return correctJapaneseOAuthPath(rewrite.apply(this, args));
      },
    });
  };
  try {
    return fromRemote('alexa-cookie2');
  } finally {
    proxy.createProxyMiddleware = original;
  }
}
export async function authorizeAlexa({
  directory,
  port = 18232,
  onReady = () => {},
  Cookie,
  timeoutMs = 10 * 60 * 1000,
}) {
  const store = await privateJson(directory),
    cookie = Cookie ?? loadCookieLibrary();
  const formerRegistrationData = await store.read('session.json');
  // The upstream proxy overwrites this file without specifying a mode.
  // Create it privately first so its later writes retain 0600 permissions.
  if ((await store.read('registration-cache.json')) === null)
    await store.write('registration-cache.json', {});
  let cleanup = () => {};
  try {
    await new Promise((resolve, reject) => {
      let ready = false,
        finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(Error('登录已取消'));
      const timer = setTimeout(() => finish(Error('登录超时，请重新运行')), timeoutMs);
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      cleanup = () => {
        clearTimeout(timer);
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      };
      cookie.generateAlexaCookie(
        {
          amazonPage: 'amazon.co.jp',
          baseAmazonPage: 'amazon.co.jp',
          acceptLanguage: 'ja-JP',
          amazonPageProxyLanguage: 'ja_JP',
          logger: () => {},
          proxyLogLevel: 'silent',
          deviceAppName: 'HomeLink XiaoZhi MCP',
          formerRegistrationData,
          formerDataStorePath: directory + '/registration-cache.json',
          proxyOnly: true,
          setupProxy: true,
          proxyOwnIp: '127.0.0.1',
          proxyListenBind: '127.0.0.1',
          proxyPort: port,
          proxyCloseWindowHTML: '<p>授权已取得，可以关闭此页并返回终端。</p>',
        },
        async (error, result) => {
          if (finished) return;
          if (
            error &&
            !ready &&
            error.message.startsWith(`Please open http://127.0.0.1:${port}/`)
          ) {
            ready = true;
            onReady(`http://127.0.0.1:${port}/`);
            return;
          }
          if (
            error ||
            !result?.localCookie ||
            !result.refreshToken ||
            !result.macDms ||
            result.amazonPage !== 'amazon.co.jp'
          )
            return finish(Error('登录未完成，请重新运行'));
          try {
            await store.write('session.json', result);
            finish();
          } catch {
            finish(Error('授权文件保存失败'));
          }
        },
      );
    });
  } finally {
    cleanup();
    cookie.stopProxyServer();
  }
}
