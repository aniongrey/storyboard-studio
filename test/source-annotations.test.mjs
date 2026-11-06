import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioStore } from '../server/store.mjs';
import { createStudio } from '../server/main.mjs';
import { SOURCE_VIDEO_UPLOAD_MAX_BYTES } from '../public/media-limits.mjs';

const source = '# 打标作品\n### 第一场：开场\n#### 镜头 01-A｜保留镜头\n- **时长**：3s\n- **画面内容**：开门。';
const marks = [
  { time: '  00:08 → 00:02（暂定）  ', camera: '', content: '先记一点\n<不要改写>&' },
  { time: '', camera: '还没决定', content: '' },
  { time: '  00:08 → 00:02（暂定）  ', camera: '', content: '先记一点\n<不要改写>&' },
];

test('source annotations preserve incomplete and non-numeric text, order, history and episode/project isolation', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-source-notes-'));
  let store = new StudioStore({ dataDir });
  try {
    const project = store.importMarkdown(source, '打标.md');
    const other = store.importMarkdown(source.replace('打标作品', '另一作品'), '另一作品.md');
    store.addEpisode(project.id, 2);
    const before = store.getProject(project.id);
    assert.equal(store.getSourceAnnotations(project.id, 1), null);
    const first = store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, videoPath: '尚未有文件', marks });
    assert.deepEqual(first.marks, marks);
    assert.equal(first.videoPath, '尚未有文件');
    assert.equal(first.versions.length, 1);
    store.saveSourceAnnotations(project.id, { episodeNumber: 2, baseVersion: null, marks: [{ time: '', camera: '', content: '' }] });
    const second = store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: first.currentVersion, marks: [] });
    assert.deepEqual(second.marks, []);
    assert.deepEqual(second.versions[0].data.marks, marks);
    assert.equal(second.versions.length, 2);
    const after = store.getProject(project.id);
    for (const key of ['source','shots','assets','storyboards','versions']) assert.deepEqual(after[key], before[key]);
    assert.equal(store.getSourceAnnotations(other.id, 1), null);
    assert.equal(store.getSourceAnnotations(project.id, 2).marks.length, 1);
    assert.throws(() => store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: first.currentVersion, marks }), { status: 409, code: 'VERSION_CONFLICT' });
    assert.deepEqual(store.getSourceAnnotations(project.id, 1), second);
    for (const patch of [{ episodeNumber: 0 }, { episodeNumber: 3 }, { marks: null }, { marks: [null] }, { marks: [{ time: 1 }] }, { videoPath: 42 }]) {
      assert.throws(() => store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: second.currentVersion, ...patch }), { status: 400 });
    }
    store.close();
    store = new StudioStore({ dataDir });
    assert.deepEqual(store.getSourceAnnotations(project.id, 1), second);
    assert.deepEqual(store.state(project.id).jobs, []);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('HTTP saves without content approval; source playback uses only the saved local video path and supports ranges', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-source-notes-http-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const project = studio.store.importMarkdown(source, '打标.md');
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': studio.csrfToken };
    const endpoint = `${base}/api/projects/${project.id}/source-annotations`;
    const bytes = Buffer.from('source-video-range-fixture');
    const videoPath = path.join(dataDir, '原视频.mp4');
    await writeFile(videoPath, bytes);
    const payload = { episodeNumber: 1, baseVersion: null, videoPath, marks };
    assert.equal((await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'PUT', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify(payload) })).status, 403);
    const response = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(payload) });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = (await response.json()).annotations;
    assert.deepEqual((await (await fetch(`${endpoint}?episodeNumber=1`)).json()).annotations.marks, marks);
    assert.deepEqual((await (await fetch(`${base}/api/state?projectId=${project.id}`)).json()).project.sourceAnnotations[1].marks, marks);
    const playback = `${base}/api/projects/${project.id}/source-video?episodeNumber=1`;
    const range = await fetch(playback, { headers: { Range: 'bytes=2-7' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 2-7/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 8));
    assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(payload) })).status, 409);
    assert.equal((await fetch(`${endpoint}?episodeNumber=2`)).status, 400);
    let version = saved.currentVersion;
    for (const invalidPreview of ['尚未找到', path.join(dataDir, 'notes.txt'), '//server/share/video.mp4']) {
      const result = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ ...payload, videoPath: invalidPreview, baseVersion: version }) });
      assert.equal(result.status, 200, '路径不影响打标保存');
      version = (await result.json()).annotations.currentVersion;
      assert.equal((await fetch(playback)).status, 400, '播放端不提供任意非视频文件');
    }
    assert.equal(studio.store.getProject(project.id).shots.length, 1);
    assert.deepEqual(studio.store.state(project.id).jobs, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('original video uploads stream unchanged, retain old files and labels, and protect project, episode and version', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-source-upload-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const project = studio.store.importMarkdown(source, '打标.md');
    studio.store.addEpisode(project.id, 2);
    const before = studio.store.getProject(project.id);
    const initial = studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, marks });
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Studio-Token': studio.csrfToken };
    const bytes = Buffer.from('original-video-upload-without-decoding');
    const endpoint = `${base}/api/projects/${project.id}/source-video`;
    const url = (version = initial.currentVersion, filename = '原视频.mp4', episodeNumber = 1) => `${endpoint}?${new URLSearchParams({ episodeNumber, baseVersion: version, filename })}`;
    assert.equal((await fetch(url(), { method: 'POST', body: bytes })).status, 403);
    assert.equal((await fetch(url(), { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: bytes })).status, 403);
    assert.equal((await fetch(url(initial.currentVersion, 'notes.txt'), { method: 'POST', headers, body: bytes })).status, 400);
    assert.equal((await fetch(url(initial.currentVersion, 'video.mp4', 3), { method: 'POST', headers, body: bytes })).status, 400);
    assert.equal((await fetch(url(), { method: 'POST', headers, body: '' })).status, 400);
    const response = await fetch(url(), { method: 'POST', headers, body: bytes });
    assert.equal(response.status, 201, await response.clone().text());
    const first = (await response.json()).annotations;
    assert.deepEqual(first.marks, marks);
    assert.deepEqual(await readFile(first.videoPath), bytes);
    const range = await fetch(`${endpoint}?episodeNumber=1`, { headers: { Range: 'bytes=3-9' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(3, 10));
    assert.equal((await fetch(url(), { method: 'POST', headers, body: bytes })).status, 409);
    const secondBytes = Buffer.from('replacement-source');
    const secondResponse = await fetch(url(first.currentVersion, '另一个原视频.webm'), { method: 'POST', headers, body: secondBytes });
    const second = (await secondResponse.json()).annotations;
    assert.equal(secondResponse.status, 201);
    assert.notEqual(second.videoPath, first.videoPath);
    assert.deepEqual(await readFile(first.videoPath), bytes);
    assert.deepEqual(await readFile(second.videoPath), secondBytes);
    assert.equal(second.versions.at(-2).data.videoPath, first.videoPath);
    assert.deepEqual(second.marks, marks);
    const otherEpisode = await fetch(url('', '第二集.mp4', 2), { method: 'POST', headers, body: bytes });
    assert.equal(otherEpisode.status, 201);
    assert.deepEqual(studio.store.getSourceAnnotations(project.id, 2).marks, []);
    assert.deepEqual(studio.store.getSourceAnnotations(project.id, 1), second);
    const files = await readdir(path.dirname(first.videoPath));
    assert.equal(files.length, 3);
    assert.ok(files.every(file => !file.endsWith('.part')));
    for (const key of ['shots', 'assets', 'storyboards']) assert.deepEqual(studio.store.getProject(project.id)[key], before[key]);
    assert.deepEqual(studio.store.state(project.id).jobs, []);
    assert.equal(SOURCE_VIDEO_UPLOAD_MAX_BYTES, 1024 ** 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
