import { mkdir, lstat, chmod, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Account sessions live outside the checkout, never in snapshots or logs.
export async function privateJson(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
    throw Error('授权目录不可用');
  await chmod(directory, 0o700);
  const file = (name) => {
    if (!/^[a-z-]+\.json$/.test(name)) throw Error('文件名无效');
    return join(directory, name);
  };
  return {
    async read(name) {
      let handle;
      try {
        handle = await open(file(name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const s = await handle.stat();
        if (!s.isFile() || s.uid !== process.getuid() || s.mode & 0o077 || s.size > 256 * 1024)
          throw Error('授权文件不可用');
        return JSON.parse(await handle.readFile('utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw Error('授权文件不可用');
      } finally {
        await handle?.close();
      }
    },
    async write(name, value) {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 256 * 1024) throw Error('授权文件过大');
      const target = file(name),
        temp = join(directory, randomUUID() + '.tmp');
      let handle;
      try {
        handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temp, target);
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
    },
    async remove(name) {
      await unlink(file(name)).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    },
  };
}
