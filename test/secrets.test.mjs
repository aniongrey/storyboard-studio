import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveRunningHubKey, getRunningHubKey } from '../server/secrets.mjs';

test('Windows DPAPI roundtrip persists encrypted credentials and rejects invalid input', { skip: process.platform !== 'win32' }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-key-'));
  const previous = process.env.STUDIO_SECRET_FILE;
  process.env.STUDIO_SECRET_FILE = path.join(temp, 'test.dpapi');
  const sample = 'test-only-credential-0123456789';
  try {
    assert.throws(() => saveRunningHubKey('bad'), /格式无效/);
    // A blocked leftover at the old fixed path must not prevent saving.
    await mkdir(`${process.env.STUDIO_SECRET_FILE}.tmp`);
    assert.deepEqual(saveRunningHubKey(sample), { configured: true });
    assert.equal(getRunningHubKey(), sample);
    const saved = await readFile(process.env.STUDIO_SECRET_FILE, 'utf8');
    assert.ok(saved.length > sample.length);
    assert.ok(!saved.includes(sample));
    assert.deepEqual(saveRunningHubKey(sample), { configured: true });
    const beforeFailure = await readFile(process.env.STUDIO_SECRET_FILE, 'utf8');
    const rename = mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('test rename blocked'), { code: 'EPERM' }); });
    try {
      assert.throws(() => saveRunningHubKey('test-only-replacement-0123456789'), /test rename blocked/);
    } finally {
      rename.mock.restore();
    }
    assert.equal(await readFile(process.env.STUDIO_SECRET_FILE, 'utf8'), beforeFailure);
    assert.equal(getRunningHubKey(), sample);
    assert.deepEqual((await readdir(temp)).sort(), ['test.dpapi', 'test.dpapi.tmp']);
    const moduleUrl = pathToFileURL(path.resolve('server/secrets.mjs')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import {getRunningHubKey} from ${JSON.stringify(moduleUrl)}; assert.equal(getRunningHubKey(),process.env.STUDIO_TEST_KEY);`], {
      env: { ...process.env, RUNNINGHUB_API_KEY: '', STUDIO_TEST_KEY: sample }, windowsHide: true, stdio: 'pipe'
    });
  } finally {
    if (previous === undefined) delete process.env.STUDIO_SECRET_FILE;
    else process.env.STUDIO_SECRET_FILE = previous;
    await rm(temp, { recursive: true, force: true });
  }
});
