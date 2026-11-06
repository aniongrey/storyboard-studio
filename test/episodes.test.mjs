import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StudioStore } from '../server/store.mjs';
import { createStudio } from '../server/main.mjs';
import { planStoryboardGroups, storyboardProblem } from '../public/storyboard.mjs';

const source = `# 分集测试
### 角色1：小明
\`\`\`json
{"name":"小明"}
\`\`\`
### 场景A：家
### 第一场：第2集也可能只是旧标题
#### 镜头 01-A｜开门
- **时长**：3s
- **画面内容**：小明开门。
- **AI视频提示词**：小明开门。
#### 镜头 02-A｜进屋
- **时长**：4s
- **画面内容**：小明进屋。
- **AI视频提示词**：小明进屋。`;
const incoming = source.replace('分集测试', '分集测试续集').replaceAll('开门', '敲门');
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-episodes-'));
  const store = new StudioStore({ dataDir });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, project: store.importMarkdown(source, '第一集.md') };
}

test('legacy projects default to episode 1 without changing edits, versions, media or source', t => {
  const { store, project, dataDir } = fixture(t);
  const shot = project.shots[0];
  store.updateEntity(project.id, shot.id, { baseVersion: shot.currentVersion, data: { action: '保留手工编辑' } });
  const current = store.getEntity(project.id, shot.id);
  const media = store.addMedia(project.id, shot.id, { kind: 'image', file: 'fixture.png', sha256: 'fixture', baseVersion: current.currentVersion });
  store.adopt(project.id, shot.id, media.id);
  const document = JSON.parse(store.db.prepare('SELECT value FROM studio_state WHERE id=1').get().value);
  delete document.projects[0].episodes;
  for (const item of document.projects[0].shots) delete item.data.episodeNumber;
  store.db.prepare('UPDATE studio_state SET value=? WHERE id=1').run(JSON.stringify(document));
  const reader = new StudioStore({ dataDir });
  try {
    const migrated = reader.getProject(project.id);
    assert.deepEqual(migrated.episodes, [1]);
    assert.ok(migrated.shots.every(item => item.data.episodeNumber === 1));
    const expected = structuredClone(document.projects[0]);
    expected.episodes = [1];
    expected.shots.forEach(item => { item.data.episodeNumber = 1; });
    assert.deepEqual(migrated, expected);
    assert.equal(readFileSync(join(dataDir, project.source.file), 'utf8'), source);
  } finally { reader.close(); }
});

test('episodes persist, imports reuse shared assets and duplicate codes are scoped to the episode', t => {
  const { store, project, dataDir } = fixture(t);
  assert.deepEqual(store.addEpisode(project.id, 2).episodes, [1, 2]);
  for (const number of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => store.addEpisode(project.id, number), { status: 400 });
  assert.throws(() => store.addEpisode(project.id, 2), { status: 409 });
  assert.throws(() => store.appendMarkdown(project.id, incoming, '第二集.md', { episodeNumber: 3 }), { status: 400 });
  const after = store.appendMarkdown(project.id, incoming, '第二集.md', { episodeNumber: 2 });
  assert.equal(after.shots.length, 4);
  assert.deepEqual(after.shots.map(shot => shot.data.episodeNumber), [1, 1, 2, 2]);
  assert.deepEqual(after.shots.slice(0, 2), project.shots);
  assert.deepEqual(after.assets, project.assets);
  assert.deepEqual(after.shots[2].data.characterIds, project.shots[0].data.characterIds);
  assert.deepEqual(after.shots[2].data.locationIds, project.shots[0].data.locationIds);
  assert.equal(after.appendedSources[0].episodeNumber, 2);
  assert.deepEqual(store.appendMarkdown(project.id, incoming, '重试.md', { episodeNumber: 2 }), after);
  assert.throws(() => store.appendMarkdown(project.id, incoming, '重复.md'), /已导入第2集/);
  assert.throws(() => store.appendMarkdown(project.id, `${incoming}\n改动`, '第二集.md', { episodeNumber: 2 }), /镜头编号重复/);
  const reader = new StudioStore({ dataDir });
  try { assert.deepEqual(reader.getProject(project.id), after); } finally { reader.close(); }
  const cli = spawnSync(process.execPath, ['scripts/import-md.mjs', join(dataDir, after.appendedSources[0].file), '--data-dir', dataDir, '--append-to', project.id, '--episode', '2'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).shots, 4);
});

test('grouping, membership edits and reordering stay within an episode', t => {
  const { store, project } = fixture(t);
  store.addEpisode(project.id, 2);
  const after = store.appendMarkdown(project.id, incoming, '第二集.md', { episodeNumber: 2 });
  const ids = after.shots.map(shot => shot.id);
  assert.deepEqual(planStoryboardGroups(after).groups, [ids.slice(0, 2), ids.slice(2)]);
  assert.deepEqual(planStoryboardGroups(after, { episodeNumber: 2 }).groups, [ids.slice(2)]);
  assert.match(storyboardProblem(after, [ids[1], ids[2]]), /不能跨集/);
  assert.throws(() => store.createStoryboard(project.id, { shotIds: [ids[1], ids[2]] }), /不能跨集/);
  const result = store.createStoryboards(project.id, { episodeNumber: 2 });
  assert.equal(result.created, 1);
  assert.deepEqual(result.boards[0].data.shotIds, ids.slice(2));
  assert.throws(() => store.createStoryboards(project.id, { episodeNumber: 2, startShotId: ids[0] }), /不属于所选集数/);
  const shot = store.getEntity(project.id, ids[2]);
  assert.throws(() => store.updateEntity(project.id, shot.id, { baseVersion: shot.currentVersion, data: { episodeNumber: 1 }, code: '03-A' }), /不能跨集/);
  const first = store.getEntity(project.id, ids[0]);
  assert.throws(() => store.updateEntity(project.id, first.id, { baseVersion: first.currentVersion, data: { episodeNumber: 8 } }), /已有的集数/);
  assert.throws(() => store.updateEntity(project.id, first.id, { baseVersion: first.currentVersion, data: { episodeNumber: 2 } }), /编号重复/);
  const last = store.getEntity(project.id, ids[1]);
  assert.deepEqual(store.reorderShot(project.id, last.id, 'down', last.currentVersion), store.getProject(project.id));
});

test('episode deletion archives its entries and preserves the other episode, shared assets and files', t => {
  const { store, project, dataDir } = fixture(t);
  const other = store.importMarkdown(source.replace('分集测试', '其他作品'), '其他作品.md');
  store.addEpisode(project.id, 2, '第1集打标版');
  store.appendMarkdown(project.id, incoming, '打标版.md', { episodeNumber: 2 });
  const boards = [1, 2].map(episodeNumber => store.createStoryboards(project.id, { episodeNumber }).boards[0]);
  const media = boards.map((board, index) => {
    const file = `episode-${index + 1}.mp4`;
    writeFileSync(join(dataDir, file), `original-${index + 1}`);
    const item = store.addMedia(project.id, board.id, { kind: 'video', file, sha256: `hash-${index}`, baseVersion: board.currentVersion });
    store.adopt(project.id, board.id, item.id);
    store.saveSourceAnnotations(project.id, { episodeNumber: index + 1, baseVersion: null, videoPath: 'shared-original.mp4', marks: [{ time: '暂定', camera: '', content: '原样保留' }] });
    return item;
  });
  const oldJob = store.createJob({ projectId: project.id, entityId: boards[0].id, kind: 'video', status: 'running', snapshot: {} });
  const newJob = store.createJob({ projectId: project.id, entityId: boards[1].id, kind: 'video', status: 'running', snapshot: {} });
  const before = store.getProject(project.id);
  const deletion = () => store.deleteEpisode(project.id, 1, { baseUpdatedAt: before.updatedAt });
  for (const number of [0, -1, 1.5, '1', null]) assert.throws(() => store.deleteEpisode(project.id, number), { status: 400 });
  assert.throws(() => store.deleteEpisode(project.id, 8), { status: 404 });
  assert.throws(() => store.deleteEpisode(project.id, 1), { code: 'VERSION_CONFLICT' });
  assert.throws(deletion, /未结束或状态不明/);
  assert.deepEqual(store.getProject(project.id), before);
  store.updateJob(oldJob.id, { status: 'ready' });
  const run = store.createAutoRun({ id: 'run-deletion-test', projectId: project.id, status: 'paused', items: boards.map(board => ({ entityId: board.id, status: 'ready' })) });
  assert.throws(deletion, /未结束的自动队列/);
  store.updateAutoRun(run.id, { status: 'completed' });
  const { project: after, archive } = deletion();
  assert.deepEqual(after.episodes, [2]);
  assert.deepEqual(after.episodeNames, { 2: '第1集打标版' });
  assert.deepEqual(after.shots, before.shots.filter(shot => shot.data.episodeNumber === 2));
  assert.deepEqual(after.storyboards, [before.storyboards[1]]);
  assert.deepEqual(after.storyScenes, before.storyScenes.slice(1));
  assert.deepEqual(after.assets, before.assets);
  assert.deepEqual(after.source, before.source);
  assert.deepEqual(after.appendedSources, before.appendedSources);
  assert.deepEqual(after.sourceAnnotations, { 2: before.sourceAnnotations[2] });
  assert.equal(after.summaryDuration, 7);
  assert.deepEqual(archive.shots, before.shots.filter(shot => shot.data.episodeNumber === 1));
  assert.deepEqual(archive.storyboards, [before.storyboards[0]]);
  assert.deepEqual(archive.sourceAnnotations, before.sourceAnnotations[1]);
  assert.equal(archive.jobs[0].id, oldJob.id);
  assert.equal(archive.autoRuns[0].items.length, 2);
  assert.equal(store.state(project.id).jobs[0].id, newJob.id);
  assert.deepEqual(store.autoRuns(project.id)[0].items, [{ entityId: boards[1].id, status: 'ready' }]);
  assert.equal(readFileSync(join(dataDir, media[0].file), 'utf8'), 'original-1');
  assert.deepEqual(store.getProject(other.id), other);
  assert.throws(() => store.deleteEpisode(project.id, 2, { baseUpdatedAt: after.updatedAt }), /至少保留一集/);
  const reopened = new StudioStore({ dataDir });
  try { assert.deepEqual(reopened.getProject(project.id), after); } finally { reopened.close(); }
});

test('HTTP episode creation and append enforce validation, CSRF and export episode metadata', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-episodes-http-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); studio.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = studio.store.importMarkdown(source, '第一集.md');
  const state = await (await fetch(`${base}/api/state`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
  const url = `${base}/api/projects/${project.id}/episodes`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"number":2}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{"number":"2"}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ number: 2, name: 123 }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ number: 2, name: '长'.repeat(81) }) })).status, 400);
  const created = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ number: 2, name: ' 第1集自分镜版 ' }) });
  assert.equal(created.status, 201);
  const named = (await created.json()).project;
  assert.deepEqual(named.episodes, [1, 2]);
  assert.deepEqual(named.episodeNames, { 2: '第1集自分镜版' });
  const reopened = new StudioStore({ dataDir });
  try { assert.deepEqual(reopened.getProject(project.id).episodeNames, named.episodeNames); }
  finally { reopened.close(); }
  const append = await fetch(`${base}/api/projects/${project.id}/append-import`, { method: 'POST', headers, body: JSON.stringify({ filename: '第二集.md', text: incoming, episodeNumber: 2 }) });
  assert.equal(append.status, 200, await append.clone().text());
  const batch = await fetch(`${base}/api/storyboards/auto`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, episodeNumber: 2 }) });
  assert.equal(batch.status, 201);
  assert.equal((await batch.json()).created, 1);
  const manifest = await (await fetch(`${base}/api/export/${project.id}`)).json();
  assert.deepEqual(manifest.episodes, [1, 2]);
  assert.deepEqual(manifest.episodeNames, { 2: '第1集自分镜版' });
  assert.deepEqual(manifest.shots.map(shot => shot.data.episodeNumber), [1, 1, 2, 2]);
  const deleteUrl = `${url}/1`;
  assert.equal((await fetch(deleteUrl, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(deleteUrl, { method: 'DELETE', headers, body: '{}' })).status, 409);
  const current = studio.store.getProject(project.id);
  const deleted = await fetch(deleteUrl, { method: 'DELETE', headers, body: JSON.stringify({ baseUpdatedAt: current.updatedAt }) });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual((await deleted.json()).project.episodes, [2]);
  assert.deepEqual(studio.store.getProject(project.id).shots, current.shots.slice(2));
});
