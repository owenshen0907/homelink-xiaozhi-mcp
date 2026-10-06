import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, symlink, access, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  parseArguments,
  validateDataDirectory,
  withRuntimeLock,
  readPrivateLine,
} from '../src/cli-support.mjs';
import { packageVersion } from '../src/metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const endpoint = 'wss://api.xiaozhi.me/mcp/?token=synthetic-private-token-123456789';
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: 'pipe' });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('CLI timed out'));
    }, 5000);
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
test('CLI 参数只接受既定动作，不回显未知秘密参数', async () => {
  assert.equal(parseArguments(['control', 'lamp', 'turn_on']).command, 'control');
  assert.throws(() => parseArguments(['control', 'lamp', 'unlock']));
  assert.throws(() => parseArguments(['--data-dir']));
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /configure/);
  assert.equal((await run(['--version'])).stdout.trim(), packageVersion);
  const invalid = await run(['--endpoint', endpoint]);
  assert.equal(invalid.code, 1);
  assert.equal((invalid.stdout + invalid.stderr).includes(endpoint), false);
});
test('CLI 拒绝仓库内数据目录以及符号链接绕入仓库', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homelink-path-'));
  try {
    await assert.rejects(validateDataDirectory(join(root, 'private-test-data')), /仓库之外/);
    await symlink(root, join(directory, 'checkout'));
    await assert.rejects(
      validateDataDirectory(join(directory, 'checkout', 'private-test-data')),
      /符号链接/,
    );
    await assert.rejects(access(join(root, 'private-test-data')));
    const data = await validateDataDirectory(join(directory, 'data'));
    assert.equal((await stat(data)).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('进程锁拒绝第二个写入者，失败后释放且不会移除替代文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homelink-lock-'));
  await validateDataDirectory(directory);
  try {
    await withRuntimeLock(directory, async () => {
      assert.equal((await stat(join(directory, 'runtime-lock.json'))).mode & 0o777, 0o600);
      await assert.rejects(
        withRuntimeLock(directory, () => assert.fail()),
        /已被使用/,
      );
    });
    await assert.rejects(access(join(directory, 'runtime-lock.json')));
    await assert.rejects(
      withRuntimeLock(directory, () => {
        throw Error('synthetic failure');
      }),
    );
    await assert.rejects(access(join(directory, 'runtime-lock.json')));
    await withRuntimeLock(directory, async () => {
      await rename(join(directory, 'runtime-lock.json'), join(directory, 'previous-lock.json'));
      await writeFile(join(directory, 'runtime-lock.json'), 'replacement', { mode: 0o600 });
    });
    assert.equal(await readFile(join(directory, 'runtime-lock.json'), 'utf8'), 'replacement');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('秘密输入只读一行，不回显并支持取消', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let text = '';
  output.on('data', (b) => {
    text += b;
  });
  const line = readPrivateLine(input, output);
  input.end(endpoint + '\n');
  assert.equal(await line, endpoint);
  assert.equal(text, '');
  const blocked = new PassThrough(),
    controller = new AbortController();
  const cancelled = readPrivateLine(blocked, output, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /已取消/);
  blocked.destroy();
});
test('独立 configure 不联网，权限受限且 stdout/stderr 不返回接入点', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homelink-configure-'));
  try {
    const result = await run(['--data-dir', directory, 'configure'], endpoint + '\n');
    assert.equal(result.code, 0, result.stderr);
    assert.equal((result.stdout + result.stderr).includes(endpoint), false);
    const file = join(directory, 'smart-home/voice.json');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).endpoint, endpoint);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(access(join(directory, 'runtime-lock.json')));
    const invalid = await run(
      ['--data-dir', directory, 'configure'],
      'wss://evil.example/?token=synthetic-secret\n',
    );
    assert.equal(invalid.code, 1);
    assert.equal((invalid.stdout + invalid.stderr).includes('synthetic-secret'), false);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).endpoint, endpoint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('无授权的 start 不操作设备，并释放进程锁', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homelink-start-'));
  try {
    const result = await run(['--data-dir', directory, 'start']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /先运行 login/);
    await assert.rejects(access(join(directory, 'runtime-lock.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configure 等待输入时 SIGTERM 会取消并释放进程锁', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homelink-stop-'));
  const child = spawn(process.execPath, [cli, '--data-dir', directory, 'configure'], {
    cwd: root,
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('startup timeout')), 5000);
      child.stdout.on('data', (b) => {
        if (b.toString().includes('等待 MCP')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    child.kill('SIGTERM');
    assert.equal(await closed, 1);
    assert.match(stderr, /输入已取消/);
    await assert.rejects(access(join(directory, 'runtime-lock.json')));
    await assert.rejects(access(join(directory, 'smart-home/voice.json')));
  } finally {
    child.kill('SIGKILL');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
