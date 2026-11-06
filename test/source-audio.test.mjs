import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/main.mjs';
import { planAudioCut, parseTimePoint, markTimePoints, snapToFrames, sourceAudioExtension } from '../server/source-audio.mjs';

const source = `# 打标作品
### 第一场：开场
#### 镜头 01-A｜保留镜头
- **时长**：3s
- **画面内容**：开门。
#### 镜头 02-A｜第二镜
- **时长**：2s
- **画面内容**：回头。`;

const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', ...args], { windowsHide: true, timeout: 60000 });

test('time labels reuse the page parser and stay unchanged in wording', () => {
  for (const [value, seconds] of [['00:01.800', 1.8], ['4.267秒', 4.267], ['01:02:03.125', 3723.125], ['00：09.125', 9.125], ['00:01.800–00:04.267', 1.8], ['00:02 至 00:07', 2]]) {
    assert.equal(parseTimePoint(value), seconds, value);
  }
  for (const value of ['', '暂定', '1:60', '1:02:99']) assert.equal(parseTimePoint(value), null, value);
  assert.deepEqual(markTimePoints({ time: '00:01.800，00:02.600,00:04.267' }), [1.8, 2.6, 4.267]);
  assert.deepEqual(markTimePoints({ time: '暂定' }), []);
  assert.equal(sourceAudioExtension('a.WAV'), '.wav');
  assert.equal(sourceAudioExtension('a.txt'), '');
});

test('cut range prefers shot codes, then shot order, then every mark, always padding and rounding outward', () => {
  const episodeShots = [{ code: '01-A' }, { code: '02-A' }, { code: '03-A' }];
  const boundMarks = [{ time: '00:05', shotCode: '01-A' }, { time: '00:09.500', shotCode: '02-A' }, { time: '00:12', shotCode: '03-A' }];
  const bound = planAudioCut({ groupCodes: ['02-A'], episodeShots, episodeMarks: boundMarks, duration: 30 });
  assert.equal(bound.source, 'shot-code');
  assert.deepEqual(bound.points, [9.5]);
  assert.equal(bound.start, 7.5);
  assert.equal(bound.end, 12.5);

  const ordered = planAudioCut({ groupCodes: ['01-A', '02-A'], episodeShots: episodeShots.slice(0, 2), episodeMarks: [{ time: '00:03' }, { time: '00:08' }], before: 1, after: 1, duration: 30 });
  assert.equal(ordered.source, 'order');
  assert.equal(ordered.start, 2);
  assert.equal(ordered.end, 9);

  const all = planAudioCut({ groupCodes: ['02-A'], episodeShots: episodeShots.slice(0, 2), episodeMarks: boundMarks.map(({ time }) => ({ time })), duration: 30 });
  assert.equal(all.source, 'all');
  assert.equal(all.start, 3);
  assert.equal(all.end, 15);

  const explicit = planAudioCut({ groupCodes: ['02-A'], episodeShots, episodeMarks: boundMarks, range: '00:08-00:15', before: 2, after: 3, duration: 30 });
  assert.equal(explicit.source, 'range');
  assert.equal(explicit.start, 6);
  assert.equal(explicit.end, 18);

  const clamped = planAudioCut({ groupCodes: ['03-A'], episodeShots, episodeMarks: boundMarks, duration: 13 });
  assert.equal(clamped.end, 13);
  assert.equal(planAudioCut({ groupCodes: ['01-A'], episodeShots, episodeMarks: boundMarks, duration: 3 }).start, 1, '时间点超出音轨时夹到结尾，仍切出最短的一段');
  assert.throws(() => planAudioCut({ groupCodes: ['01-A'], episodeShots, episodeMarks: [{ time: '暂定' }] }), { status: 400, code: 'AUDIO_CUT_NO_POINTS' });
  assert.deepEqual(snapToFrames({ start: 3.02, end: 12.01 }, 24), { start: 72 / 24, end: 289 / 24 });
  assert.deepEqual(snapToFrames({ start: 3.02, end: 12.01 }, 0), { start: 3.02, end: 12.01 });
});

test('one source audio per episode: replacing keeps a single file, playback supports ranges, marks keep their shot codes', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-source-audio-http-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const project = studio.store.importMarkdown(source, '打标.md');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-ac', '2', path.join(dataDir, 'a.wav')]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '4', '-ac', '2', path.join(dataDir, 'b.wav')]);
    const marks = [{ time: '00:01.800，00:02.600', shotCode: '01-A', camera: '推进', content: '开门' }];
    const saved = studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, videoPath: 'E:/原视频.mp4', marks });
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Studio-Token': studio.csrfToken };
    const endpoint = `${base}/api/projects/${project.id}/source-audio`;
    const url = (version = saved.currentVersion, filename = 'a.wav', episodeNumber = 1) => `${endpoint}?${new URLSearchParams({ episodeNumber, baseVersion: version, filename })}`;
    assert.equal((await fetch(url(), { method: 'POST', body: Buffer.from('x') })).status, 403);
    assert.equal((await fetch(url(saved.currentVersion, 'a.txt'), { method: 'POST', headers, body: Buffer.from('x') })).status, 400);
    assert.equal((await fetch(url(saved.currentVersion, 'a.wav', 2), { method: 'POST', headers, body: Buffer.from('x') })).status, 400);
    const uploaded = await fetch(url(), { method: 'POST', headers, body: await readFileBuffer(path.join(dataDir, 'a.wav')) });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const withAudio = (await uploaded.json()).annotations;
    assert.match(withAudio.audioPath, /source-audio[\\/][a-f0-9-]+\.wav$/);
    assert.equal(withAudio.audioName, 'a.wav');
    assert.ok(withAudio.audioDuration > 5.5 && withAudio.audioDuration < 6.5);
    assert.deepEqual(withAudio.marks, marks.map(mark => ({ ...mark })));
    const playback = await fetch(`${endpoint}?episodeNumber=1`, { headers: { Range: 'bytes=0-15' } });
    assert.equal(playback.status, 206);
    assert.equal(playback.headers.get('content-type'), 'audio/wav');
    const replaced = await fetch(url(withAudio.currentVersion, 'b.wav'), { method: 'POST', headers, body: await readFileBuffer(path.join(dataDir, 'b.wav')) });
    const second = (await replaced.json()).annotations;
    assert.equal(replaced.status, 201);
    assert.notEqual(second.audioPath, withAudio.audioPath);
    assert.equal(second.audioName, 'b.wav');
    assert.equal(second.videoPath, 'E:/原视频.mp4');
    assert.deepEqual(second.marks, withAudio.marks);
    const files = await readdir(path.dirname(second.audioPath));
    assert.equal(files.filter(file => file.endsWith('.wav')).length, 1, '只保留当前这一条音频');
    const kept = studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: second.currentVersion, videoPath: 'E:/原视频.mp4', marks: second.marks });
    assert.equal(kept.audioPath, second.audioPath, '保存打标不会清掉已导入音频');
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

const readFileBuffer = file => readFile(file);

test('without an imported audio the cut uses the original video track instead', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-source-video-cut-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const project = studio.store.importMarkdown(source, '打标.md');
    const shots = studio.store.getProject(project.id).shots.sort((a, b) => a.order - b.order);
    const board = studio.store.createStoryboard(project.id, { shotIds: shots.map(shot => shot.id) });
    const video = path.join(dataDir, '原视频.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-ac', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
    studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, videoPath: video, marks: [{ time: '00:03', shotCode: shots[0].code, camera: '', content: '' }] });
    const response = await fetch(`${base}/api/projects/${project.id}/storyboards/${board.id}/cut-audio`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': studio.csrfToken }, body: JSON.stringify({ before: 1, after: 1 }) });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.media.metadata.audioCut.source, '原视频音轨');
    // 10fps 原视频：起点 2 秒、终点 4 秒都落在整帧上。
    assert.equal(payload.plan.start, 2);
    assert.equal(payload.plan.end, 4);
    assert.ok(payload.media.metadata.duration > 1.8 && payload.media.metadata.duration < 2.2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('storyboards get one cut audio file, adopted as their only audio reference', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-source-cut-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const project = studio.store.importMarkdown(source, '打标.md');
    const shots = studio.store.getProject(project.id).shots.sort((a, b) => a.order - b.order);
    const board = studio.store.createStoryboard(project.id, { shotIds: shots.map(shot => shot.id) });
    const marks = [
      { time: '00:05', shotCode: shots[0].code, camera: '', content: '' },
      { time: '00:09', shotCode: shots[1].code, camera: '', content: '' },
    ];
    const saved = studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, marks });
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': studio.csrfToken };
    const cut = `${base}/api/projects/${project.id}/storyboards/${board.id}/cut-audio`;
    assert.equal((await fetch(cut, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(cut, { method: 'POST', headers, body: '{}' })).status, 400, '没有音频也没有原视频音轨');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-ac', '2', path.join(dataDir, 'episode.wav')]);
    const uploaded = await fetch(`${base}/api/projects/${project.id}/source-audio?${new URLSearchParams({ episodeNumber: 1, baseVersion: saved.currentVersion, filename: 'episode.wav' })}`,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: await readFileBuffer(path.join(dataDir, 'episode.wav')) });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const response = await fetch(cut, { method: 'POST', headers, body: JSON.stringify({ before: 2, after: 3 }) });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.plan.source, 'shot-code');
    assert.equal(payload.plan.start, 3);
    assert.equal(payload.plan.end, 12);
    assert.equal(payload.media.kind, 'audio');
    assert.match(payload.media.file, /storyboards/);
    assert.ok(payload.media.metadata.duration > 8.5 && payload.media.metadata.duration < 9.5);
    assert.equal(payload.entity.adoptedMediaIds.audio, payload.media.id);
    assert.equal(payload.media.metadata.audioCut.source, '本集导入音频');
    assert.deepEqual(payload.media.metadata.audioCut.points, [5, 9]);
    const media = await fetch(`${base}/api/media/${payload.media.id}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'audio/wav');
    // 本组音频就是唯一音频槽：准备预览时只带这一条，不会被要求补角色音色。
    const preview = await fetch(`${base}/api/previews`, { method: 'POST', headers, body: JSON.stringify({
      projectId: project.id, entityId: board.id, kind: 'video', referenceMediaIds: [payload.media.id],
      videoConfig: { duration: '5', aspectRatio: '16:9 (Widescreen)', referenceBindings: [{ nodeId: '144', fieldName: 'audio', mediaId: payload.media.id }] },
    }) });
    const prepared = await preview.json();
    assert.equal(preview.status, 200, JSON.stringify(prepared));
    const blockers = (prepared.preview.blockers || []).join(' | ');
    assert.doesNotMatch(blockers, /音频|音色/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
