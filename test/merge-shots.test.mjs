import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from '../server/store.mjs';
import { storyboardProblem } from '../public/storyboard.mjs';

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'storyboard-merge-test-'));
  const store = new StudioStore({ dataDir });
  const project = store.importMarkdown(readFileSync(new URL('../examples/奶油变心后_分镜提示词.md', import.meta.url), 'utf8'), 'merge.md');
  const shots = project.shots.slice(0, 2);
  const singles = shots.map(shot => store.createStoryboard(project.id, { shotIds: [shot.id] }));
  let board = store.createStoryboard(project.id, { shotIds: shots.map(shot => shot.id) });
  board = store.updateEntity(project.id, board.id, { baseVersion: board.currentVersion, data: { finalPrompt: 'ONE continuous merged shot.' } });
  const input = { baseVersion: board.currentVersion, baseVersions: Object.fromEntries([...shots, ...singles].map(entity => [entity.id, entity.currentVersion])), code: '01-02', name: '合并镜头', duration: 8 };
  return { store, project, shots, singles, board, input, close() { store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test('merge keeps one ordered shot, archives originals, preserves jobs/media and single-shot production board', () => {
  const f = fixture();
  try {
    const oldShot = f.shots[1];
    f.store.addMedia(f.project.id, oldShot.id, { id: 'old-media', kind: 'video', file: 'old.mp4', baseVersion: oldShot.currentVersion });
    f.store.createJob({ id: 'old-job', projectId: f.project.id, entityId: f.singles[1].id, kind: 'video', status: 'ready', snapshot: { prompt: 'old prompt' } });
    const result = f.store.mergeStoryboardShots(f.project.id, f.board.id, f.input);
    const p = f.store.getProject(f.project.id);
    assert.equal(p.shots.length, f.project.shots.length - 1);
    assert.deepEqual(p.shots.slice(0, 2).map(shot => shot.id), [f.shots[0].id, f.project.shots[2].id]);
    assert.equal(result.entity.code, '01-02');
    assert.equal(result.entity.data.duration, 8);
    assert.equal(result.entity.data.videoPrompt, 'ONE continuous merged shot.');
    assert.deepEqual(result.entity.data.sourceShotCodes, f.shots.map(shot => shot.code));
    assert.deepEqual(result.storyboard.data.shotIds, [result.entity.id]);
    assert.equal(storyboardProblem(p, result.storyboard.data.shotIds, result.storyboard.id), '');
    assert.equal(p.storyboards.length, 1);
    assert.equal(p.shotMergeArchives[0].shots.length, 2);
    assert.equal(p.shotMergeArchives[0].storyboards.length, 2);
    assert.equal(f.store.getEntity(p.id, oldShot.id).code, oldShot.code);
    assert.equal(f.store.getMedia('old-media').file, 'old.mp4');
    assert.equal(f.store.getJob('old-job').snapshot.prompt, 'old prompt');
    assert.equal(p.summaryDuration, f.project.summaryDuration - f.shots.reduce((sum, shot) => sum + shot.data.duration, 0) + 8);
    assert.throws(() => f.store.mergeStoryboardShots(p.id, f.board.id, f.input), /2至4/);
  } finally { f.close(); }
});

test('merge rejects stale versions, duplicate codes and active tasks without changing the originals', () => {
  const f = fixture();
  try {
    const before = f.store.getProject(f.project.id);
    assert.throws(() => f.store.mergeStoryboardShots(f.project.id, f.board.id, { ...f.input, baseVersion: 'stale' }), { code: 'VERSION_CONFLICT' });
    assert.throws(() => f.store.mergeStoryboardShots(f.project.id, f.board.id, { ...f.input, baseVersions: {} }), { code: 'VERSION_CONFLICT' });
    assert.throws(() => f.store.mergeStoryboardShots(f.project.id, f.board.id, { ...f.input, code: f.project.shots[2].code }), /编号重复/);
    f.store.createJob({ id: 'active-job', projectId: f.project.id, entityId: f.shots[1].id, kind: 'video', status: 'running' });
    assert.throws(() => f.store.mergeStoryboardShots(f.project.id, f.board.id, f.input), /未结束/);
    assert.deepEqual(f.store.getProject(f.project.id), before);
  } finally { f.close(); }
});

test('merge does not remove a storyboard that also contains an outside shot', () => {
  const f = fixture();
  try {
    f.store.change(() => f.store.project(f.project.id).storyboards.push({ ...structuredClone(f.board), id: 'legacy-overlap', data: { ...f.board.data, shotIds: f.project.shots.slice(0, 3).map(shot => shot.id) } }));
    assert.throws(() => f.store.mergeStoryboardShots(f.project.id, f.board.id, f.input), /范围外|属于其他/);
    assert.equal(f.store.getProject(f.project.id).shots.length, f.project.shots.length);
  } finally { f.close(); }
});
