import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioStore } from '../server/store.mjs';
import { createStudio } from '../server/main.mjs';
import { sourceVideoFile, sourceFrameSeconds } from '../server/source-frame.mjs';

const source = '# 比对作品\n### 第一场：开场\n#### 镜头 01｜原有镜头\n- **时长**：3s\n- **画面内容**：开门。';
const image = (store, project, owner, kind = 'image') => store.addMedia(project.id, owner.id, { file: `projects/${project.id}/${owner.id}-${kind}.png`, kind, mime: `${kind}/png`, baseVersion: owner.currentVersion });

test('comparison titles and multiple timestamp pairs preserve source text, unmatched pairs, history and old media', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-comparison-'));
  const store = new StudioStore({ dataDir });
  try {
    const project = store.importMarkdown(source, 'compare.md'), shot = project.shots[0];
    const board = store.createStoryboard(project.id, { shotIds: [shot.id] });
    const original = image(store, project, shot), generated = image(store, project, board);
    store.adopt(project.id, shot.id, original.id);
    const before = store.getProject(project.id);
    const legacy = { time: ' 00:01.800，00:02.500 ', camera: '推进\n保留原文', content: '<待补>', shotCode: shot.code };
    const first = store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, marks: [legacy] });
    assert.deepEqual(first.marks, [legacy]);
    const mark = { ...legacy, title: '开门后回头', comparisons: [
      { time: '1.8', sourceMediaId: original.id, generatedMediaId: generated.id, status: 'needs_review', note: '朝向有偏差\n请保留', sourceVideoPath: 'E:/original.mp4' },
      { time: '2.5', status: 'unreviewed' },
      { time: '9', generatedMediaId: generated.id, note: '时间点改动后仍保留旧配对' },
    ] };
    const second = store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: first.currentVersion, marks: [mark] });
    assert.deepEqual(second.marks, [mark]);
    assert.deepEqual(second.versions[0].data.marks, [legacy]);
    assert.equal(second.versions.length, 2);
    const after = store.getProject(project.id);
    for (const key of ['shots', 'assets', 'storyboards', 'source']) assert.deepEqual(after[key], before[key]);
    assert.throws(() => store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: first.currentVersion, marks: [] }), { status: 409, code: 'VERSION_CONFLICT' });
    assert.deepEqual(store.getSourceAnnotations(project.id, 1), second);
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('comparison saving validates fields and rejects foreign, other-episode and non-image media', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-comparison-validation-'));
  const store = new StudioStore({ dataDir });
  try {
    const project = store.importMarkdown(source, 'compare.md');
    const other = store.importMarkdown(source.replace('比对作品', '其他作品'), 'other.md');
    store.addEpisode(project.id, 2);
    const appended = store.appendMarkdown(project.id, source.replace('原有镜头', '第二集镜头'), 'episode2.md', { episodeNumber: 2 });
    const secondShot = appended.shots.find(shot => shot.data.episodeNumber === 2);
    const secondBoard = store.createStoryboard(project.id, { shotIds: [secondShot.id] });
    const foreign = image(store, other, other.shots[0]), wrongEpisode = image(store, project, secondShot), wrongBoard = image(store, project, secondBoard);
    const audio = image(store, project, project.shots[0], 'audio');
    const saved = store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, marks: [{ time: '', camera: '', content: '', title: '' }] });
    assert.deepEqual(saved.marks, [{ time: '', camera: '', content: '' }]);
    for (const id of [foreign.id, wrongEpisode.id, wrongBoard.id, audio.id, 'missing-image']) {
      for (const key of ['generatedMediaId', 'sourceMediaId']) assert.throws(() => store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: saved.currentVersion, marks: [{ comparisons: [{ time: '0', [key]: id }] }] }), { status: 400 });
    }
    for (const mark of [
      { title: 5 }, { title: 'x'.repeat(301) }, { comparisons: null }, { comparisons: Array(501).fill({ time: '0' }) },
      ...[null, [], { time: '' }, { time: 0 }, { time: '-1' }, { time: 'Infinity' }, { time: '0x10' }, { time: '1', status: 'approved' }, { time: '1', note: 'x'.repeat(20001) }, { time: '1', sourceVideoPath: 'x'.repeat(4001) }].map(item => ({ comparisons: [item] })),
    ]) assert.throws(() => store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: saved.currentVersion, marks: [mark] }), { status: 400 });
    assert.deepEqual(store.getSourceAnnotations(project.id, 1), saved);
    assert.equal(store.getSourceAnnotations(project.id, 2), null);
    assert.equal(store.getSourceAnnotations(other.id, 1), null);
    assert.equal(store.getEntity(project.id, secondShot.id).media[0].id, wrongEpisode.id);
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('saved pairs survive a shot moving episodes while new cross-episode references remain rejected', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-comparison-moved-'));
  const store = new StudioStore({ dataDir });
  try {
    const project = store.importMarkdown(source, 'compare.md'), shot = project.shots[0];
    const other = store.importMarkdown(source.replace('比对作品', '其他作品'), 'other.md');
    store.addEpisode(project.id, 2);
    const original = image(store, project, shot), generated = image(store, project, shot), unused = image(store, project, shot);
    const foreign = image(store, other, other.shots[0]);
    const mark = { time: '1.8', camera: '推进', content: '', comparisons: [{ time: '9', sourceMediaId: original.id, generatedMediaId: generated.id, status: 'pass' }] };
    const first = store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, marks: [mark] });
    store.updateEntity(project.id, shot.id, { baseVersion: shot.currentVersion, data: { episodeNumber: 2 } });
    const revised = { ...mark, title: '其他修改仍可保存' };
    const second = store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: first.currentVersion, marks: [revised] });
    assert.deepEqual(second.marks, [revised]);
    assert.deepEqual(second.versions[0].data.marks, [mark]);
    for (const comparison of [
      { ...mark.comparisons[0], generatedMediaId: unused.id },
      { ...mark.comparisons[0], generatedMediaId: foreign.id },
      { ...mark.comparisons[0], time: '10' },
      { time: '9', sourceMediaId: generated.id },
    ]) assert.throws(() => store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: second.currentVersion, marks: [{ ...revised, comparisons: [comparison] }] }), { status: 400 });
    assert.deepEqual(store.getSourceAnnotations(project.id, 1), second);
    assert.deepEqual(store.getEntity(project.id, shot.id).media.map(item => item.id), [original.id, generated.id, unused.id]);
    assert.equal(store.getSourceAnnotations(project.id, 2), null);
  } finally { store.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('source frame endpoint reads only the saved version and local video, validates time and never modifies media', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-source-frame-'));
  const calls = [], png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let empty = false;
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false, generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' }, extractSourceFrameImpl: async input => { calls.push(input); return empty ? Buffer.alloc(0) : png; } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const project = studio.store.importMarkdown(source, 'compare.md');
    studio.store.addEpisode(project.id, 2);
    const videoPath = path.join(dataDir, 'original.mp4'), original = Buffer.from('unchanged original');
    await writeFile(videoPath, original);
    let saved = studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: null, videoPath, marks: [{ time: '1.8,2.5', camera: '推进', content: '' }] });
    const endpoint = `${base}/api/projects/${project.id}/source-frame`;
    const url = values => `${endpoint}?${new URLSearchParams({ episodeNumber: 1, time: '1.8', version: saved.currentVersion, ...values })}`;
    const response = await fetch(url({ file: 'E:/ignored.mp4' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.deepEqual(calls, [{ inputFile: videoPath, seconds: 1.8 }]);
    assert.equal((await fetch(url({ version: 'outdated' }))).status, 409);
    assert.equal((await fetch(url({ episodeNumber: 2 }))).status, 409);
    assert.equal((await fetch(url({ episodeNumber: 3 }))).status, 400);
    for (const time of ['', '-1', 'NaN', 'Infinity', '86400.1', '0x10']) assert.equal((await fetch(url({ time }))).status, 400);
    assert.equal(calls.length, 1);
    empty = true;
    assert.equal((await fetch(url())).status, 400);
    assert.equal(calls.length, 2);
    assert.deepEqual(studio.store.getSourceAnnotations(project.id, 1), saved);
    assert.deepEqual(await readFile(videoPath), original);
    assert.deepEqual(studio.store.getProject(project.id).shots[0].media, []);
    assert.deepEqual(studio.store.state(project.id).jobs, []);
    for (const invalid of ['relative.mp4', '//server/share/source.mp4', path.join(dataDir, 'notes.txt')]) {
      saved = studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: saved.currentVersion, videoPath: invalid, marks: saved.marks });
      assert.equal((await fetch(url())).status, 400);
    }
    saved = studio.store.saveSourceAnnotations(project.id, { episodeNumber: 1, baseVersion: saved.currentVersion, videoPath: path.join(dataDir, 'missing.mp4'), marks: saved.marks });
    assert.equal((await fetch(url())).status, 404);
    assert.equal(calls.length, 2);
    assert.deepEqual(await readFile(videoPath), original);
  } finally { await new Promise(resolve => server.close(resolve)); studio.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('frame time and source path guards accept valid numeric points and reject unsafe inputs', () => {
  for (const [raw, seconds] of [['0', 0], ['1.8', 1.8], ['1e-7', 1e-7], ['86400', 86400]]) assert.equal(sourceFrameSeconds(raw), seconds);
  for (const value of [undefined, [], ['1'], '', ' ', '-1', 'Infinity', '86401']) assert.throws(() => sourceFrameSeconds(value), { status: 400 });
  for (const file of ['', 'relative.mp4', '//server/source.mp4', 'https://example.com/video.mp4', path.resolve('notes.txt')]) assert.throws(() => sourceVideoFile(file), { status: 400 });
  assert.equal(sourceVideoFile(path.resolve('source.mp4')), path.resolve('source.mp4'));
});
