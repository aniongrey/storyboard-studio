import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('startup reports an occupied port without running the success callback', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-startup-'));
  const occupied = createServer();
  try {
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const port = occupied.address().port;
    const result = spawnSync(process.execPath, ['server/main.mjs'], {
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: temp, TMP: temp,
        STUDIO_DATA_DIR: path.join(temp, 'data'), PORT: String(port) },
      encoding: 'utf8', timeout: 10000, windowsHide: true
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`端口 ${port} 已占用`));
    assert.doesNotMatch(result.stderr, /TypeError|reading 'port'/);
    assert.doesNotMatch(result.stdout, /http:\/\/127\.0\.0\.1/);
  } finally {
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
