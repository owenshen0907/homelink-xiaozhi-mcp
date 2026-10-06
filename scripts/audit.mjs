import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loginProxyFilter } from '../src/alexa-login.mjs';

// No blanket severity suppression: only the documented, unpatched braces
// advisory may remain. All new advisories or an unavailable audit fail CI.
const known = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  throw Error('无法取得依赖安全检查结果');
}
if (audit.error || report.error || !report.metadata?.vulnerabilities)
  throw Error('依赖安全检查不可用');
const unexpected = [];
let documented = false;
for (const [name, item] of Object.entries(report.vulnerabilities ?? {})) {
  for (const advisory of item.via ?? []) {
    if (typeof advisory === 'string') continue;
    if (advisory.url !== known) unexpected.push(name + ': ' + advisory.url);
    else documented = true;
  }
}
if (unexpected.length) throw Error('发现未处理的依赖安全问题：' + unexpected.join(', '));
const require = createRequire(import.meta.url),
  fromCookie = createRequire(require.resolve('alexa-cookie2/package.json'));
if (fromCookie('./package.json').version !== '5.0.6') throw Error('需要重新核验登录代理的输入路径');
const source = readFileSync(fromCookie.resolve('./lib/proxy.js'), 'utf8');
if (
  !source.includes("proxy('!/cookie-success', optionsAlexa)") ||
  typeof loginProxyFilter('!/cookie-success') !== 'function'
)
  throw Error('登录代理过滤器已变化，需重新审查');
console.log(
  documented
    ? '仅保留已记录的未修复 braces 告警；登录过滤器绕过 glob 解析，详见 SECURITY.md。'
    : '依赖安全检查没有已知告警。',
);
