import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/main.mjs';

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-empty-cleanup-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const baseText = '# 保留作品\n### 场景A：家\n### 第一场：保留\n#### 镜头 01-A｜一\n- **时长**：3s\n- **AI视频提示词**：开门。\n#### 镜头 02-A｜二\n- **时长**：3s\n- **AI视频提示词**：关门。';
  const incoming = '# 第三集\n### 场景A：家\n### 第一场：遗留\n#### 镜头 301-A｜旧一\n- **时长**：3s\n- **AI视频提示词**：开门。\n#### 镜头 302-A｜旧二\n- **时长**：3s\n- **AI视频提示词**：关门。\n### 第二场：新版\n#### 镜头 401-A｜保留新版\n- **时长**：4s\n- **AI视频提示词**：看窗外。';
  const project = studio.store.importMarkdown(baseText, '保留.md');
  const other = studio.store.importMarkdown(baseText.replace('保留作品', '其他作品'), '其他.md');
  studio.store.addEpisode(project.id, 3);
  const appended = studio.store.appendMarkdown(project.id, incoming, '第三集.md', { episodeNumber: 3 });
  const oldShots = appended.shots.filter(shot => /^30/.test(shot.code));
  const currentShot = appended.shots.find(shot => shot.code === '401-A');
  const oldBoard = studio.store.createStoryboard(project.id, { shotIds: oldShots.map(shot => shot.id) });
  const currentBoard = studio.store.createStoryboard(project.id, { shotIds: [currentShot.id] });
  const media = studio.store.addMedia(project.id, currentBoard.id, { id: 'retained-native-video', file: 'retained.mp4', kind: 'video', sha256: 'original-native-hash', baseVersion: currentBoard.currentVersion });
  studio.store.adopt(project.id, currentBoard.id, media.id);
  const selected = [...oldShots, oldBoard];
  const body = { episodeNumber: 3, entityIds: selected.map(item => item.id), baseVersions: Object.fromEntries(selected.map(item => [item.id, item.currentVersion])) };
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
  return { studio, project, other, oldShots, oldBoard, currentBoard, body, headers, base,
    async close() { await new Promise(resolve => server.close(resolve)); studio.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('empty-entry cleanup is CSRF protected, atomic, scoped, version checked and restorable', async () => {
  const f = await fixture();
  try {
    const before = f.studio.store.getProject(f.project.id), otherBefore = f.studio.store.getProject(f.other.id);
    const url = `${f.base}/api/projects/${f.project.id}/cleanup-empty`;
    const post = (body, headers = f.headers) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post(f.body, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post({ ...f.body, episodeNumber: 1 })).status, 409);
    assert.equal((await post({ ...f.body, entityIds: [f.oldShots[0].id] })).status, 409);
    assert.equal((await post({ ...f.body, baseVersions: {} })).status, 409);
    assert.equal((await post({ ...f.body, entityIds: [before.assets[0].id], baseVersions: { [before.assets[0].id]: before.assets[0].currentVersion } })).status, 400);
    assert.equal((await post({ ...f.body, entityIds: [...f.body.entityIds, f.currentBoard.id], baseVersions: { ...f.body.baseVersions, [f.currentBoard.id]: f.currentBoard.currentVersion } })).status, 409);
    assert.deepEqual(f.studio.store.getProject(f.project.id), before);
    const response = await post(f.body);
    assert.equal(response.status, 200, await response.clone().text());
    const { project, archive } = await response.json();
    assert.equal(archive.shots.length, 2);
    assert.equal(archive.storyboards.length, 1);
    assert.equal(archive.storyScenes.length, 1);
    assert.deepEqual(project.shots, before.shots.filter(shot => !f.body.entityIds.includes(shot.id)));
    assert.deepEqual(project.storyboards, [before.storyboards[1]]);
    assert.equal(project.summaryDuration, 10);
    assert.deepEqual(project.assets, before.assets);
    assert.deepEqual(project.source, before.source);
    assert.deepEqual(project.appendedSources, before.appendedSources);
    assert.deepEqual(f.studio.store.getProject(f.other.id), otherBefore);
    const newBoard = f.studio.store.createStoryboard(project.id, { shotIds: [project.shots[0].id] });
    assert.equal(newBoard.code, 'SB-3');
    assert.equal(newBoard.order, 2);
    f.studio.store.createStoryboards(project.id, { startShotId: project.shots[1].id, limit: 1, episodeNumber: 1 });
    assert.equal(f.studio.store.getProject(project.id).storyboards.at(-1).code, 'SB-4');
    const restoredResponse = await fetch(`${url}/${archive.id}/restore`, { method: 'POST', headers: f.headers, body: '{}' });
    assert.equal(restoredResponse.status, 200, await restoredResponse.clone().text());
    const restored = (await restoredResponse.json()).project;
    assert.deepEqual(restored.shots, before.shots);
    assert.deepEqual(restored.storyboards.filter(board => before.storyboards.some(old => old.id === board.id)), before.storyboards);
    assert.deepEqual(restored.storyScenes, before.storyScenes);
    assert.equal(restored.storyboards.find(board => board.id === f.currentBoard.id).media[0].sha256, 'original-native-hash');
    assert.equal((await fetch(`${url}/${archive.id}/restore`, { method: 'POST', headers: f.headers, body: '{}' })).status, 409);
  } finally { await f.close(); }
});

test('empty-entry cleanup refuses entries with a generation job and preserves the entire project', async () => {
  const f = await fixture();
  try {
    f.studio.store.createJob({ projectId: f.project.id, entityId: f.oldBoard.id, kind: 'image', status: 'awaiting_delivery', snapshot: {} });
    const before = f.studio.store.getProject(f.project.id);
    const response = await fetch(`${f.base}/api/projects/${f.project.id}/cleanup-empty`, { method: 'POST', headers: f.headers, body: JSON.stringify(f.body) });
    assert.equal(response.status, 409);
    assert.deepEqual(f.studio.store.getProject(f.project.id), before);
  } finally { await f.close(); }
});
