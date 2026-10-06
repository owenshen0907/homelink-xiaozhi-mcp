#!/usr/bin/env node
import { join } from 'node:path';
import { authorizeAlexa } from '../src/alexa-login.mjs';
import { privateJson } from '../src/private-json.mjs';
import { smartHome } from '../src/smart-home.mjs';
import { smartHomeMcp, validateMcpEndpoint } from '../src/smart-home-mcp.mjs';
import { packageName, packageVersion } from '../src/metadata.mjs';
import {
  CliError,
  parseArguments,
  validateDataDirectory,
  withRuntimeLock,
  readPrivateLine,
} from '../src/cli-support.mjs';

const help = `${packageName} ${packageVersion}
用法：node bin/cli.mjs [--data-dir 仓库外私有目录] <命令>

  login                    本人通过本机代理登录日本 Amazon
  devices                  刷新并显示设备编号与允许动作
  control <id> <action>    执行 turn_on / turn_off
  rename <id> <中文名称>    保存语音使用的名称
  configure                从不回显的输入保存小智 MCP 接入点
  start                    启动到小智的出站 MCP 连接
  --version / --help

请先停下 start，再运行其他使用同一数据目录的命令。
授权和接入点只存本机私有目录，不要提交到 Git。`;

async function main() {
  const { command, args, dataDir } = parseArguments(process.argv.slice(2));
  if (['help', '--help'].includes(command)) return console.log(help);
  if (command === '--version') return console.log(packageVersion);
  if (process.platform === 'win32')
    throw new CliError('当前版本需要 macOS 或 Linux 的私有文件权限');
  const directory = await validateDataDirectory(dataDir);
  await withRuntimeLock(directory, async () => {
    const shutdown = new AbortController(),
      stop = () => shutdown.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      if (command === 'login') {
        console.log('请本人登录已关联 HomeLink 的日本 Amazon 账号并完成验证。');
        await authorizeAlexa({
          directory: join(directory, 'smart-home'),
          onReady: (url) => console.log('浏览器打开：' + url),
        });
        return console.log('授权已保存到本机私有目录。下一步运行 devices。');
      }
      if (command === 'configure') {
        console.log('等待 MCP 接入点输入，内容不会回显。');
        const endpoint = validateMcpEndpoint(
          await readPrivateLine(process.stdin, process.stdout, shutdown.signal),
        );
        const store = await privateJson(join(directory, 'smart-home'));
        await store.write('voice.json', { endpoint });
        return console.log('MCP 接入点已私有保存。下一步运行 start。');
      }
      const home = await smartHome({ dataDir: directory });
      let bridge;
      try {
        if (!home.status().configured) throw new CliError('请先运行 login 完成 Alexa 授权');
        if (command === 'start') {
          bridge = await smartHomeMcp({
            dataDir: directory,
            home,
            onChange: () => console.log('MCP 状态：' + bridge.status().phase),
          });
          if (!bridge.status().configured) throw new CliError('请先运行 configure 保存 MCP 接入点');
        }
        await home.refresh();
        if (shutdown.signal.aborted) throw new CliError('操作已取消');
        if (command === 'devices')
          return console.log(JSON.stringify(home.status().devices, null, 2));
        if (command === 'control') {
          const result = await home.execute(
            { deviceId: args[0], action: args[1] },
            shutdown.signal,
          );
          console.log(JSON.stringify(result, null, 2));
          if (result.status === 'failed') process.exitCode = 1;
          if (result.status === 'unconfirmed') process.exitCode = 2;
          return;
        }
        if (command === 'rename') {
          await home.rename({ deviceId: args[0], name: args[1] });
          return console.log('名称已保存。');
        }
        await new Promise((resolve) => {
          shutdown.signal.addEventListener('abort', () => resolve(), { once: true });
          console.log('Alexa 已连接；按 Ctrl+C 停止。');
          bridge.start();
        });
      } finally {
        await bridge?.close();
        await home.close();
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  });
}

// Do not print arbitrary vendor errors, which can contain cookie data or URLs.
const publicErrors = new Set([
  '登录未完成，请重新运行',
  '登录超时，请重新运行',
  '登录已取消',
  '授权文件保存失败',
  '登录依赖版本不匹配',
  '请填写小智控制台生成的 MCP 接入点',
  '请使用小智官方的安全 MCP 接入点',
  'Alexa 连接失败，请重新授权或稍后重试',
  '请选择支持开关的设备和动作',
  '名称须为1–24个字',
]);
try {
  await main();
} catch (error) {
  console.error(
    error instanceof CliError || publicErrors.has(error.message)
      ? error.message
      : '连接或本地文件操作失败，请检查授权、文件权限和网络。',
  );
  process.exitCode = 1;
}
// The login dependency may retain timers after its proxy has closed.
process.exit(process.exitCode ?? 0);
