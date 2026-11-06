import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/main.mjs';

test('video detachment is scoped, version checked, CSRF protected and preserves other content', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'studio-video-removal-'));
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const source = '# 删除测试\n### 场景A：家\n### 第一场：开门\n#### 镜头 01-A｜开门\n- **时长**：3s\n- **AI视频提示词**：开门。';
  const project = studio.store.importMarkdown(source, '删除测试.md');
  const other = studio.store.importMarkdown(source.replace('删除测试', '保留作品'), '保留作品.md');
  const board = studio.store.createStoryboard(project.id, { shotIds: [project.shots[0].id] });
  const targets = [project.assets[0], project.shots[0], board];
  for (const entity of [...targets, other.shots[0]]) {
    const projectId = entity.id === other.shots[0].id ? other.id : project.id;
    for (const kind of ['image', 'audio', 'video']) {
      const media = studio.store.addMedia(projectId, entity.id, { id: `${entity.id}-${kind}`, kind, file: `${entity.id}.${kind}`, baseVersion: entity.currentVersion });
      studio.store.adopt(projectId, entity.id, media.id);
    }
  }
  studio.store.adopt(project.id, targets[1].id, `${targets[1].id}-image`);
  const before = studio.store.getProject(project.id), otherBefore = studio.store.getProject(other.id);
  const ids = targets.map(entity => `${entity.id}-video`);
  const body = { mediaIds: ids, baseUpdatedAt: before.updatedAt };
  const job = studio.store.createJob({ projectId: project.id, entityId: board.id, kind: 'video', status: 'ready', snapshot: { referenceMediaIds: ids } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': studio.csrfToken };
  const post = (data, requestHeaders = headers) => fetch(`${base}/api/projects/${project.id}/detach-video-media`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(data) });
  try {
    assert.equal((await post(body, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post({ ...body, baseUpdatedAt: 'old-version' })).status, 409);
    assert.equal((await post({ ...body, mediaIds: [] })).status, 400);
    for (const invalid of ['missing', `${targets[0].id}-image`, `${targets[0].id}-audio`, `${other.shots[0].id}-video`]) {
      assert.equal((await post({ ...body, mediaIds: [...ids, invalid] })).status, 409);
      assert.deepEqual(studio.store.getProject(project.id), before);
    }
    const active = studio.store.createJob({ projectId: project.id, entityId: board.id, kind: 'video', status: 'running', snapshot: {} });
    assert.equal((await post(body)).status, 409);
    studio.store.updateJob(active.id, { status: 'cancelled' });
    const response = await post(body);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(new Set((await response.json()).removed.map(media => media.id)), new Set(ids));
    const after = studio.store.getProject(project.id);
    const expected = structuredClone(before);
    for (const entity of [...expected.assets, ...expected.shots, ...expected.storyboards]) {
      entity.media = entity.media.filter(media => !ids.includes(media.id));
      if (ids.includes(entity.adoptedMediaIds.video)) entity.adoptedMediaIds.video = null;
      if (ids.includes(entity.adoptedMediaId)) entity.adoptedMediaId = null;
    }
    expected.updatedAt = after.updatedAt;
    assert.deepEqual(after, expected);
    assert.deepEqual(studio.store.getProject(other.id), otherBefore);
    assert.deepEqual(studio.store.state(project.id).jobs.find(item => item.id === job.id), job);
    assert.equal((await post({ ...body, baseUpdatedAt: after.updatedAt })).status, 409);
    const reopened = await (await fetch(`${base}/api/state?projectId=${project.id}`)).json();
    assert.equal([...reopened.project.assets, ...reopened.project.shots, ...reopened.project.storyboards].flatMap(entity => entity.media).filter(media => media.kind === 'video').length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
