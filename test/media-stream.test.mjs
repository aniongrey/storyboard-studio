import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { createStudio } from '../server/main.mjs';

test('media playback cancels quietly, closes file reads and still reports disk errors', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-media-stream-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const errors = [], reads = [];
  studio.app.use((error, req, res, next) => { errors.push(error); res.destroy(); });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const file = path.join(dataDir, 'fixture.mp4');
    await writeFile(file, bytes);
    const project = studio.store.importMarkdown('# 播放测试\n### 第一场：开场\n#### 镜头 01-A｜开门\n- **时长**：3s', '播放.md');
    studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, videoPath: file });
    const media = studio.store.addMedia(project.id, project.shots[0].id, { file: 'fixture.mp4', kind: 'video', mime: 'video/mp4',
      sha256: 'fixture', baseVersion: project.shots[0].currentVersion });
    const endpoints = [`${base}/api/projects/${project.id}/source-video?episodeNumber=1`, `${base}/api/media/${media.id}`];
    for (const url of endpoints) {
      const response = await fetch(url, { headers: { Range: 'bytes=2-7' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes 2-7/${bytes.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2, 8));
    }

    const createReadStream = fs.createReadStream;
    let readError;
    t.mock.method(fs, 'createReadStream', (file, options) => {
      const stream = createReadStream(file, { ...options, highWaterMark: 1024 });
      reads.push({ stream, closed: new Promise(resolve => stream.once('close', resolve)) });
      if (readError) queueMicrotask(() => stream.destroy(readError));
      return stream;
    });
    for (const url of endpoints) for (const range of [undefined, 'bytes=0-']) {
      await t.test(`${new URL(url).pathname}, ${range || 'full download'}`, async () => {
        const index = reads.length;
        await new Promise((resolve, reject) => {
          get(url, { agent: false, headers: range ? { Range: range } : {} }, response => {
            assert.equal(response.statusCode, range ? 206 : 200);
            response.once('error', () => {});
            response.once('data', () => { response.destroy(); resolve(); });
          }).once('error', reject);
        });
        const read = reads[index];
        assert.ok(read, 'playback opened a file stream');
        await Promise.race([read.closed, delay(2000, null, { ref: false })]);
        assert.equal(read.stream.closed, true, 'cancelled playback must close the file');
        assert.equal(read.stream.readableEnded, false, 'cancelled playback must stop reading before EOF');
        await tick();
        assert.deepEqual(errors, [], 'normal player cancellation must not reach the error logger');
      });
    }

    readError = Object.assign(new Error('fixture disk read failed'), { code: 'EIO' });
    await assert.rejects(fetch(endpoints[1]));
    await tick();
    assert.equal(errors.at(-1), readError, 'real read failures must still reach error handling');
  } finally {
    for (const { stream } of reads) stream.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
