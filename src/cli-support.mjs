import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { open, lstat, unlink, realpath, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { privateJson } from './private-json.mjs';

export class CliError extends Error {}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseArguments(argv) {
  const args = [...argv];
  let dataDir = join(homedir(), '.local', 'share', 'homelink-xiaozhi-mcp');
  const flag = args.indexOf('--data-dir');
  if (flag !== -1) {
    if (!args[flag + 1] || args[flag + 1].startsWith('-'))
      throw new CliError('--data-dir 后需要一个仓库外目录');
    dataDir = resolve(args[flag + 1]);
    args.splice(flag, 2);
  }
  const command = args.shift() ?? 'help';
  const counts = {
    login: 0,
    configure: 0,
    start: 0,
    devices: 0,
    control: 2,
    rename: 2,
    help: 0,
    '--help': 0,
    '--version': 0,
  };
  if (!(command in counts) || args.length !== counts[command])
    throw new CliError('参数无效，请运行 node bin/cli.mjs --help');
  if (command === 'control' && !['turn_on', 'turn_off'].includes(args[1]))
    throw new CliError('仅支持 turn_on / turn_off');
  return { command, args, dataDir };
}

export async function validateDataDirectory(value) {
  const directory = resolve(value);
  if (directory === repo || directory.startsWith(repo + '/'))
    throw new CliError('私有数据目录必须位于仓库之外');
  // Check the nearest existing ancestor before creating a directory through it.
  let ancestor = directory;
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      ancestor = dirname(ancestor);
    }
  }
  const target = await realpath(ancestor);
  if (target === repo || target.startsWith(repo + '/'))
    throw new CliError('私有数据目录不能通过符号链接指向仓库');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const actual = await realpath(directory);
  if (actual === repo || actual.startsWith(repo + '/'))
    throw new CliError('私有数据目录不能指向仓库');
  await privateJson(directory);
  return directory;
}

// One writer per private directory. A second CLI must not race the MCP service.
export async function withRuntimeLock(directory, operation) {
  const path = join(directory, 'runtime-lock.json');
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (e) {
    if (e.code === 'EEXIST')
      throw new CliError(
        '这份数据目录已被使用。先停止其他实例；异常退出遗留的 runtime-lock.json 需确认进程停止后再移除。',
      );
    throw e;
  }
  const identity = await handle.stat();
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    const current = await lstat(path).catch(() => null);
    if (current?.ino === identity.ino && current?.dev === identity.dev) await unlink(path);
  }
}

export async function readPrivateLine(input = process.stdin, output = process.stdout, signal) {
  if (input.isTTY) output.write('粘贴小智 MCP 接入点并回车（输入不回显）：');
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const lines = createInterface({ input, output: muted, terminal: !!input.isTTY });
  let cleanup = () => {};
  try {
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lines.close();
        reject(new CliError('输入超时，请重新运行 configure'));
      }, 60000);
      const abort = () => {
        reject(new CliError('输入已取消'));
        lines.close();
      };
      cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      lines.once('line', (line) => {
        cleanup();
        resolve(line);
      });
      lines.once('close', () => {
        cleanup();
        reject(new CliError('未收到 MCP 接入点'));
      });
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (value.length > 16384) throw new CliError('MCP 接入点过长');
    return value.trim();
  } finally {
    cleanup();
    lines.close();
    if (input.isTTY) output.write('\n');
  }
}
