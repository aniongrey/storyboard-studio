import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StudioStore, MAX_VIDEO_CONCURRENCY } from '../server/store.mjs';
import { GenerationService } from '../server/generation.mjs';
import { AutoQueue, storyboardVideoReferences, storyboardVideoConfig } from '../server/autoqueue.mjs';
import { createStudio } from '../server/main.mjs';
import { planStoryboardGroups, storyboardSource, storyboardDuration, storyboardProblem } from '../public/storyboard.mjs';
import { referenceGroups, automaticReferences, automaticBindings, videoPromptBlocks, assembleVideoPrompt } from '../public/video-editor.mjs';

const text = await readFile(new URL('../examples/奶油变心后_分镜提示词.md', import.meta.url), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const videoBytes = Buffer.from('mock mp4 payload for the auto queue');
const waitFor = async (check, message = '等待超时') => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 15)); }
  throw new Error(message);
};
async function tempStore() {
  const dataDir = await mkdtemp(join(tmpdir(), 'storyboard-queue-store-'));
  const store = new StudioStore({ dataDir });
  return { dataDir, store, project: store.importMarkdown(text, 'sample.md'), async cleanup() { store.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
// 假生成服务：上传返回文件名，提交返回 taskId，查询成功并附一段视频，下载走假字节；不做真实收费调用。
async function fixture({ runResponse = () => ({ taskId: '77000001', status: 'QUEUED' }), getRunningHubKey = () => 'mock-auto-queue-key', queryStatus = () => 'SUCCESS', videoSize = () => ({ width: 1088, height: 1920 }) } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'storyboard-autoqueue-'));
  const store = new StudioStore({ dataDir });
  const project = store.importMarkdown(text, 'sample.md');
  const calls = [];
  const service = new GenerationService({ store, dataDir, appRoot: resolve('.'), getRunningHubKey, pollIntervalMs: 20,
    inspectCodexImpl: async () => ({ available: true, loggedIn: false }),
    resizeVideoImpl: async () => { throw new Error('原生任务不应调用本机缩放'); },
    validateMedia: async (file, kind) => ({ sha256: digest(await readFile(file)), mime: `${kind}/${kind === 'image' ? 'png' : 'mp4'}`, extension: kind === 'image' ? '.png' : '.mp4', ...(kind === 'video' ? videoSize() : { width: 640, height: 360 }), duration: kind === 'video' ? 12 : undefined }),
    fetchImpl: async (url, options = {}) => {
      const address = String(url);
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      if (address.includes('/run/ai-app/')) {
        const index = calls.filter(call => call.address.includes('/run/ai-app/')).length;
        calls.push({ address, body, readyAtSubmit: store.state().jobs.filter(job => job.status === 'ready').length });
        const response = runResponse(index + 1);
        if (response.rejectConcurrency) return Response.json({ code: 421, message: '并发超限，请稍后重试' });
        if (response.failed) return Response.json({ taskId: response.taskId, status: 'FAILED', errorMessage: '远端生成失败' });
        return Response.json(response);
      }
      calls.push({ address, body });
      if (address.endsWith('/media/upload/binary')) return Response.json({ code: 0, data: { fileName: 'openapi/auto-queue.png' } });
      if (address.endsWith('/query')) {
        const status = queryStatus();
        return Response.json({ taskId: body.taskId, status, results: status === 'SUCCESS' ? [{ url: 'https://www.runninghub.ai/results/auto-queue.mp4', outputType: 'mp4' }] : [] });
      }
      if (address.startsWith('https://www.runninghub.ai/results/')) return new Response(videoBytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) } });
      throw new Error(`Unexpected mock URL: ${address}`);
    } });
  const queue = new AutoQueue({ store, generation: service, pollIntervalMs: 20, backoffMs: 400, logger: { error() {} } });
  const submissions = () => calls.filter(call => call.address.includes('/run/ai-app/'));
  return { dataDir, store, project, service, queue, calls, submissions, async cleanup() { queue.close(); service.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
async function boardImage(f, boardId) {
  const project = f.store.getProject(f.project.id), board = f.store.getEntity(project.id, boardId);
  const file = `projects/${project.id}/${board.code}-grid.png`;
  const bytes = Buffer.from(`mock grid for ${board.code}`);
  await mkdir(join(f.dataDir, 'projects', project.id), { recursive: true });
  await writeFile(join(f.dataDir, file), bytes);
  const media = f.store.addMedia(project.id, board.id, { file, sha256: digest(bytes), kind: 'image', mime: 'image/png',
    baseVersion: board.currentVersion, metadata: { storyboardSource: storyboardSource(project, board) } });
  f.store.adopt(project.id, board.id, media.id);
  return media;
}
// 只给前 count 个组补四宫格，其余的保持“还没有采用图”的阻塞状态。
async function boardsWithImages(f, total, withImage = total) {
  const created = f.store.createStoryboards(f.project.id, { limit: total }).boards;
  for (const board of created.slice(0, withImage)) await boardImage(f, board.id);
  return created;
}
async function adoptTestMedia(f, entityId, kind) {
  const entity = f.store.getEntity(f.project.id, entityId);
  const extension = { image: 'png', audio: 'mp3', video: 'mp4' }[kind];
  const file = `projects/${f.project.id}/${entity.id}-${kind}.${extension}`;
  const bytes = Buffer.from(`mock ${kind} for ${entity.id}`);
  await mkdir(join(f.dataDir, 'projects', f.project.id), { recursive: true });
  await writeFile(join(f.dataDir, file), bytes);
  const media = f.store.addMedia(f.project.id, entity.id, { file, sha256: digest(bytes), kind, mime: `${kind}/${extension}`, baseVersion: entity.currentVersion });
  f.store.adopt(f.project.id, entity.id, media.id);
  return media;
}

test('planning groups preserves existing groups and leaves unused tail cells blank without repeating shots', async () => {
  const f = await tempStore();
  try {
    const shots = [...f.project.shots].sort((a, b) => a.order - b.order);
    assert.equal(shots.length, 45);
    const whole = planStoryboardGroups(f.project, {});
    assert.equal(whole.groups.length, 12);
    assert.equal(whole.remaining, 0);
    assert.deepEqual(whole.groups.at(-1), [shots.at(-1).id]);
    assert.equal(new Set(whole.groups.flat()).size, shots.length);
    // 0–3 已被占用：跳过，片尾单镜单独成组。
    f.store.createStoryboard(f.project.id, { shotIds: shots.slice(0, 4).map(shot => shot.id) });
    const after = planStoryboardGroups(f.store.getProject(f.project.id), { startShotId: shots[0].id });
    assert.equal(after.groups.length, 11);
    assert.equal(after.remaining, 0);
    assert.equal(after.skipped, 4);
    assert.deepEqual(after.groups.flat().filter(id => shots.slice(0, 4).some(shot => shot.id === id)), []);
    // limit 只建前 N 组，剩下的镜头仍留在未分组里。
    const limited = planStoryboardGroups(f.store.getProject(f.project.id), { limit: 2 });
    assert.equal(limited.groups.length, 2);
    assert.equal(limited.remaining, 33);
  } finally { await f.cleanup(); }
});

test('store creates the whole batch in one transaction and rejects bad requests', async () => {
  const f = await tempStore();
  try {
    const created = f.store.createStoryboards(f.project.id, { namePrefix: '第1场', limit: 2 });
    assert.equal(created.created, 2);
    assert.deepEqual(created.boards.map(board => board.name), ['第1场 1', '第1场 2']);
    assert.deepEqual(created.boards.map(board => board.code), ['SB-1', 'SB-2']);
    assert.equal(f.store.getProject(f.project.id).storyboards.length, 2);
    assert.throws(() => f.store.createStoryboards(f.project.id, { startShotId: 'missing-shot' }), { status: 404 });
    assert.throws(() => f.store.createStoryboards(f.project.id, { limit: 0 }), { status: 400 });
    // 0–7 已占：从第 9 镜往后建一组，正好是 9–12。
    const shots = [...f.store.getProject(f.project.id).shots].sort((a, b) => a.order - b.order);
    const more = f.store.createStoryboards(f.project.id, { startShotId: shots[9].id, limit: 1 });
    assert.equal(more.created, 1);
    assert.deepEqual(more.boards[0].data.shotIds, shots.slice(9, 13).map(shot => shot.id));
    assert.equal(more.boards[0].name, shots.slice(9, 13).map(shot => shot.name).join(' → '));
  } finally { await f.cleanup(); }
});

test('voice-aware grouping counts distinct speakers before voice import, preserves order and leaves partial grids', () => {
  const assets = ['甲','乙','丙','丁'].map((name,i) => ({ id:String(i),name,type:'character',data:{},media:[] }));
  const sequence = [0,1,2,3,0,3,1,2];
  const shots = sequence.map((speaker,i) => ({ id:`s${i}`,code:String(i),order:i,data:{characterIds:assets.map(a=>a.id),dialogue:`${assets[speaker].name}：发言。`,duration:3} }));
  const project = { assets, shots, storyboards:[] };
  const plan = planStoryboardGroups(project);
  assert.deepEqual(plan.groups, [['s0','s1','s2'],['s3','s4','s5','s6'],['s7']]);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.groups.flat(), shots.map(s=>s.id));
  assert.equal(plan.remaining, 0);
  assert.match(storyboardProblem(project, shots.slice(0,4).map(s=>s.id)), /最多3个/);
  // Silent visible characters and screen copy consume no voice slots; repeated speech uses one.
  shots.forEach(s => s.data.dialogue='甲：发言。\n丁（配文）：文字。');
  assert.deepEqual(planStoryboardGroups(project).groups, [['s0','s1','s2','s3'],['s4','s5','s6','s7']]);
});

test('a single shot with four speakers blocks batch creation atomically instead of dropping voices', async () => {
  const f = await tempStore();
  try {
    const characters = f.project.assets.filter(a=>a.type==='character').slice(0,4);
    const shot = f.project.shots[0];
    f.store.updateEntity(f.project.id,shot.id,{baseVersion:shot.currentVersion,data:{characterIds:characters.map(a=>a.id),dialogue:characters.map(a=>`${a.name}：发言。`).join('\n')}});
    const project = f.store.getProject(f.project.id);
    assert.match(planStoryboardGroups(project).blockers[0], /单镜超过3个/);
    assert.throws(()=>f.store.createStoryboards(project.id), /单镜超过3个/);
    assert.equal(f.store.getProject(project.id).storyboards.length,0);
  } finally { await f.cleanup(); }
});

test('overlapping tail stays valid after panel reordering and cannot be created twice', async () => {
  const f = await tempStore();
  try {
    f.store.createStoryboards(f.project.id);
    const p = f.store.getProject(f.project.id), tail = p.storyboards.at(-1);
    f.store.updateEntity(p.id, tail.id, { baseVersion: tail.currentVersion, data: { shotIds: [...tail.data.shotIds].reverse() } });
    const updated = f.store.getProject(p.id);
    for (const board of updated.storyboards) assert.equal(storyboardProblem(updated, board.data.shotIds, board.id), '');
    assert.throws(() => f.store.createStoryboard(p.id, { shotIds: tail.data.shotIds }), { status: 400 });
  } finally { await f.cleanup(); }
});

test('concurrency setting gates how many paid video jobs may run at once', async () => {
  const f = await tempStore();
  try {
    const input = index => ({ projectId: f.project.id, entityId: f.project.shots[index].id, kind: 'video', singleVideo: true, status: 'running', operationId: `limit-${index}`, snapshot: { id: `preview-${index}`, hash: `hash-${index}` } });
    assert.equal(f.store.videoConcurrency(), 1);
    assert.equal(f.store.setVideoConcurrency(3).videoConcurrency, 3);
    const jobs = [0, 1, 2].map(index => f.store.createJob(input(index)));
    assert.equal(f.store.state().jobs.length, 3);
    assert.throws(() => f.store.createJob(input(3)), { status: 409, code: 'ACTIVE_VIDEO_TASK' });
    f.store.updateJob(jobs[0].id, { status: 'ready' });
    assert.equal(f.store.createJob(input(3)).kind, 'video');
    assert.throws(() => f.store.setVideoConcurrency(0), { status: 400 });
    assert.throws(() => f.store.setVideoConcurrency(MAX_VIDEO_CONCURRENCY + 1), { status: 400 });
  } finally { await f.cleanup(); }
});

test('storyboard video references bind the adopted grid to slot 1 and characters to audio slots', async () => {
  const f = await tempStore();
  try {
    const board = f.store.createStoryboards(f.project.id, { limit: 1 }).boards[0];
    const empty = storyboardVideoConfig(f.store.getProject(f.project.id), board, {});
    assert.equal(empty.references.image, null);
    assert.deepEqual(empty.references.bindings, []);
    assert.equal(empty.config.mode, 'reference');
    // 没有采用四宫格时只把时长留给 prepare 报阻塞，不在这里静默改数。
    assert.equal(empty.config.duration, String(storyboardDuration(f.store.getProject(f.project.id), board)));
    await boardImage(f, board.id);
    const project = f.store.getProject(f.project.id), current = f.store.getEntity(f.project.id, board.id);
    const withImage = storyboardVideoConfig(project, current, { duration: '12' });
    assert.deepEqual(withImage.references.bindings, [{ nodeId: '141', fieldName: 'image', mediaId: withImage.references.image.id }]);
    assert.equal(withImage.config.duration, '12');
    assert.equal(withImage.config.outputResolution, '720p');
    assert.equal(withImage.config.pixels, '0.9');
    assert.equal(withImage.config.referenceBindings[0].nodeId, '141');
    assert.equal(storyboardVideoConfig(project, current, { outputResolution: 'native', pixels: '0.98' }).config.pixels, '0.98');
    const references = storyboardVideoReferences(project, current);
    assert.equal(references.referenceMediaIds.length, 1);
  } finally { await f.cleanup(); }
});

test('shot-list queue uses the page prompt, its own adopted image, voice references and native 720p without creating groups', async () => {
  const f = await fixture();
  try {
    const shots = f.project.shots.slice(0, 3), character = f.project.assets.find(asset => asset.type === 'character');
    f.store.updateEntity(f.project.id, shots[0].id, { baseVersion: shots[0].currentVersion, data: { duration: 4, characterIds: [character.id], locationIds: [], propIds: [], dialogue: `${character.name}：你好。`, videoPrompt: '缓慢走入画面。' } });
    f.store.updateEntity(f.project.id, shots[1].id, { baseVersion: shots[1].currentVersion, data: { duration: 6 } });
    f.store.updateEntity(f.project.id, shots[2].id, { baseVersion: shots[2].currentVersion, data: { characterIds: [], locationIds: [], propIds: [] } });
    const image = await adoptTestMedia(f, shots[0].id, 'image');
    await adoptTestMedia(f, shots[1].id, 'image');
    const voice = await adoptTestMedia(f, character.id, 'audio');
    await adoptTestMedia(f, character.id, 'image');
    const excluded = await adoptTestMedia(f, character.id, 'video');
    for (const id of ['subject_definitions', 'detailed_description', 'timing']) f.store.setPromptPreference(id, true);
    const project = f.store.getProject(f.project.id), shot = f.store.getEntity(project.id, shots[0].id);
    const { config, references } = storyboardVideoConfig(project, shot);
    const selected = new Set(automaticReferences(project, shot));
    const pageMedia = referenceGroups(project, shot).flatMap(group => group.media).filter(media => media.kind !== 'video' && selected.has(media.id));
    const pageBindings = automaticBindings(pageMedia);
    const slots = ['141', '142', '143', '161', '175', '176', '144', '160', '189'];
    const bindingOrder = media => slots.indexOf(pageBindings.find(binding => binding.mediaId === media.id).nodeId);
    pageMedia.sort((a, b) => bindingOrder(a) - bindingOrder(b));
    const prompt = assembleVideoPrompt(videoPromptBlocks(project, shot, pageMedia, { ...config, referenceBindings: pageBindings }), f.store.state(project.id).promptPreferences);
    const preview = await f.service.prepare({ projectId: project.id, entityId: shot.id, kind: 'video', prompt, referenceMediaIds: pageMedia.map(media => media.id), videoConfig: config });
    assert.deepEqual(preview.blockers, []);
    assert.equal(config.duration, '4');
    assert.equal(config.outputResolution, '720p');
    assert.equal(references.bindings.find(binding => binding.nodeId === '141').mediaId, image.id);
    assert.ok(references.referenceMediaIds.includes(voice.id));
    assert.ok(!references.referenceMediaIds.includes(excluded.id));
    const run = await f.queue.create({ projectId: project.id, entityIds: [shots[0].id, shots[0].id, shots[1].id, shots[2].id] });
    assert.equal(run.items.length, 2);
    assert.equal(run.skipped.length, 1);
    assert.match(run.skipped[0].reason, /参考图片/);
    await waitFor(() => f.store.getAutoRun(run.id).status === 'completed');
    const finished = f.store.getAutoRun(run.id);
    assert.deepEqual(finished.items.map(item => item.status), ['ready', 'ready']);
    const jobs = f.store.state().jobs;
    assert.equal(jobs[0].snapshot.prompt, preview.prompt);
    assert.equal(f.submissions()[0].body.nodeInfoList.find(node => node.nodeId === '150').fieldValue, preview.prompt);
    assert.equal(jobs[0].snapshot.references.find(reference => reference.mediaId === voice.id).note, '音色参考；节点作用与克隆效果未验证。');
    assert.doesNotMatch(preview.prompt, /Audio reuse:\s*full(?:y)?_copy/);
    assert.equal(f.store.getProject(project.id).storyboards.length, 0);
    assert.equal(f.store.getEntity(project.id, shot.id).adoptedMediaIds.image, image.id);
    assert.equal(f.store.getEntity(project.id, shot.id).adoptedMediaIds.video, null);
    assert.deepEqual(f.submissions().map(call => call.body.nodeInfoList.find(node => node.nodeId === '186').fieldValue), ['4', '6']);
    await assert.rejects(() => f.queue.create({ projectId: project.id, entityIds: [shots[2].id] }), { status: 400 });
    await assert.rejects(() => f.queue.create({ projectId: project.id, entityIds: [character.id] }), { status: 404 });
  } finally { await f.cleanup(); }
});

test('shot-list queue accepts adopted linked images without a shot image and blocks if every reference image disappears', async () => {
  const f = await fixture();
  try {
    const shot = f.project.shots[0], character = f.project.assets.find(asset => asset.type === 'character'), location = f.project.assets.find(asset => asset.type === 'location');
    f.store.updateEntity(f.project.id, shot.id, { baseVersion: shot.currentVersion, data: { characterIds: [character.id], locationIds: [location.id], propIds: [], duration: 4 } });
    const characterImage = await adoptTestMedia(f, character.id, 'image');
    const locationImage = await adoptTestMedia(f, location.id, 'image');
    f.store.setPromptPreference('detailed_description', true);
    const project = f.store.getProject(f.project.id), current = f.store.getEntity(project.id, shot.id);
    const references = storyboardVideoReferences(project, current);
    assert.equal(current.adoptedMediaIds.image, null);
    assert.equal(references.image.id, characterImage.id);
    assert.deepEqual(references.referenceMediaIds, [characterImage.id, locationImage.id]);
    const run = await f.queue.create({ projectId: project.id, entityIds: [shot.id] });
    await waitFor(() => f.store.getAutoRun(run.id).status === 'completed');
    assert.equal(f.store.getAutoRun(run.id).items[0].status, 'ready');
    assert.equal(f.store.getEntity(project.id, shot.id).adoptedMediaIds.image, null);
    assert.equal(f.submissions().length, 1);
    assert.deepEqual(f.store.state().jobs[0].snapshot.references.map(reference => reference.mediaId), references.referenceMediaIds);
    f.queue.kick = () => {};
    const missing = await f.queue.create({ projectId: project.id, entityIds: [shot.id] });
    const originalGetProject = f.store.getProject.bind(f.store);
    f.store.getProject = id => ({ ...originalGetProject(id), assets: [] });
    await f.queue.tick();
    const blocked = f.store.getAutoRun(missing.id).items[0];
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.blockers[0], /没有采用的参考图片/);
    assert.equal(f.submissions().length, 1);
  } finally { await f.cleanup(); }
});

test('shot-list queue blocks empty prompt selections and retains overflow voices for preview validation', async () => {
  const f = await fixture();
  try {
    const shot = f.project.shots[0], characters = f.project.assets.filter(asset => asset.type === 'character').slice(0, 4);
    await adoptTestMedia(f, shot.id, 'image');
    const empty = await f.queue.create({ projectId: f.project.id, entityIds: [shot.id] });
    await waitFor(() => f.store.getAutoRun(empty.id).status === 'completed');
    assert.equal(f.store.getAutoRun(empty.id).items[0].status, 'blocked');
    assert.match(f.store.getAutoRun(empty.id).items[0].blockers[0], /提示词区域/);
    f.store.updateEntity(f.project.id, shot.id, { baseVersion: f.store.getEntity(f.project.id, shot.id).currentVersion, data: { characterIds: characters.map(character => character.id), locationIds: [], propIds: [] } });
    for (const character of characters) await adoptTestMedia(f, character.id, 'audio');
    f.store.setPromptPreference('detailed_description', true);
    const references = storyboardVideoReferences(f.store.getProject(f.project.id), f.store.getEntity(f.project.id, shot.id));
    assert.equal(references.referenceMediaIds.length, 5);
    assert.equal(references.bindings.filter(binding => binding.fieldName === 'audio').length, 3);
    const overflow = await f.queue.create({ projectId: f.project.id, entityIds: [shot.id] });
    await waitFor(() => f.store.getAutoRun(overflow.id).status === 'completed');
    const item = f.store.getAutoRun(overflow.id).items[0];
    assert.equal(item.status, 'blocked');
    assert.ok(item.blockers.some(blocker => /未在 referenceBindings 中绑定槽位/.test(blocker)));
    assert.equal(f.submissions().length, 0);
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('shot-list queue skips existing adopted videos unless regeneration is requested', async () => {
  const f = await fixture();
  try {
    const shot = f.project.shots[0];
    await adoptTestMedia(f, shot.id, 'image');
    const video = await adoptTestMedia(f, shot.id, 'video');
    await assert.rejects(() => f.queue.create({ projectId: f.project.id, entityIds: [shot.id] }), { status: 400 });
    assert.equal(f.store.autoRuns().length, 0);
    f.queue.kick = () => {};
    const run = await f.queue.create({ projectId: f.project.id, entityIds: [shot.id], includeGenerated: true });
    assert.equal(run.items[0].entityId, shot.id);
    assert.equal(f.store.getEntity(f.project.id, shot.id).adoptedMediaIds.video, video.id);
    assert.equal(f.submissions().length, 0);
  } finally { await f.cleanup(); }
});

test('a low-resolution original fails once and the queue continues without resizing or resubmitting it', async () => {
  let checked = 0;
  const f = await fixture({ videoSize: () => ++checked === 1 ? { width: 480, height: 864 } : { width: 1088, height: 1920 } });
  try {
    const boards = await boardsWithImages(f, 2);
    const run = await f.queue.create({ projectId: f.project.id, entityIds: boards.map(board => board.id), template: { duration: '10' } });
    await waitFor(() => f.store.getAutoRun(run.id).status === 'completed');
    const items = f.store.getAutoRun(run.id).items;
    assert.deepEqual(items.map(item => item.status), ['failed', 'ready']);
    const failed = f.store.getJob(items[0].jobId);
    assert.equal(failed.errorCode, 'NATIVE_RESOLUTION_MISMATCH');
    assert.equal(failed.outputs.length, 0);
    assert.equal(failed.sourceFiles.length, 1);
    assert.equal(await readFile(join(f.dataDir, failed.sourceFiles[0].file), 'utf8'), videoBytes.toString());
    assert.equal(f.submissions().length, 2);
    assert.equal(items[0].attempts, 1);
    for (const call of f.submissions()) assert.equal(call.body.nodeInfoList.find(node => node.nodeId === '147').fieldValue, '0.9');
  } finally { await f.cleanup(); }
});

test('the queue accepts adopted grids from older plots and orders and advances after each download', async () => {
  const f = await fixture();
  try {
    const boards = await boardsWithImages(f, 2);
    const first=f.store.getEntity(f.project.id,boards[0].data.shotIds[0]);
    f.store.updateEntity(f.project.id,first.id,{baseVersion:first.currentVersion,data:{action:'新剧情沿用原已采用四宫格'}});
    f.store.updateEntity(f.project.id,boards[1].id,{baseVersion:boards[1].currentVersion,data:{shotIds:[...boards[1].data.shotIds].reverse()}});
    const run = await f.queue.create({ projectId: f.project.id, entityIds: boards.map(board => board.id) });
    assert.equal(run.status, 'running');
    assert.equal(run.items.length, 2);
    await waitFor(() => f.store.getAutoRun(run.id).status === 'completed', '队列没有在预期时间内结束');
    const finished = f.store.getAutoRun(run.id);
    assert.deepEqual(finished.items.map(item => item.status), ['ready', 'ready']);
    assert.match(finished.note, /完成 2/);
    const submissions = f.submissions();
    assert.equal(submissions.length, 2);
    // 顺序证据：第二次提交发生时，第一个任务已经下载并登记完成（正好 1 个 ready）。
    assert.equal(submissions[0].readyAtSubmit, 0);
    assert.equal(submissions[1].readyAtSubmit, 1);
    assert.equal(f.store.state().jobs.length, 2);
    for (const job of f.store.state().jobs) assert.equal(job.status, 'ready');
    // 结果只成为候选，不自动采用。
    for (const board of f.store.getProject(f.project.id).storyboards) {
      assert.equal(board.media.filter(item => item.kind === 'video').length, 1);
      assert.equal(board.adoptedMediaIds.video, null);
    }
  } finally { await f.cleanup(); }
});

test('a failed item does not stop the queue, and groups without an adopted grid never enter it', async () => {
  const f = await fixture({ runResponse: index => index === 1 ? { failed: true, taskId: '88000001' } : { taskId: '88000002', status: 'QUEUED' } });
  try {
    const boards = await boardsWithImages(f, 3, 2);
    // 三个组里只有两个采用了四宫格：第三个不进队列，而不是进队列后失败。
    const run = await f.queue.create({ projectId: f.project.id, entityIds: boards.map(board => board.id) });
    assert.equal(run.items.length, 2);
    assert.deepEqual(run.skipped.map(item => item.code), [boards[2].code]);
    assert.match(run.skipped[0].reason, /四宫格/);
    await waitFor(() => f.store.getAutoRun(run.id).status === 'completed', '失败任务没有让队列继续');
    const finished = f.store.getAutoRun(run.id);
    assert.deepEqual(finished.items.map(item => item.status), ['failed', 'ready']);
    assert.match(finished.items[0].error, /远端生成失败/);
    // 一个都没有四宫格时直接拒绝排队，不创建任何队列。
    const before = f.submissions().length;
    await assert.rejects(() => f.queue.create({ projectId: f.project.id, entityIds: [boards[2].id] }), { status: 400 });
    assert.equal(f.submissions().length, before);
    assert.equal(f.store.autoRuns().length, 1);
  } finally { await f.cleanup(); }
});

test('a higher concurrency limit fills the pipe without waiting for the previous job to finish', async () => {
  // 远端先一直停在 RUNNING：任何一个任务都不会“提前跑完”，
  // 于是第二个提交还能发生就只可能是一个原因——队列没有在等第一个任务结束。
  let released = false;
  const f = await fixture({ queryStatus: () => (released ? 'SUCCESS' : 'RUNNING') });
  try {
    f.store.setVideoConcurrency(2);
    const boards = await boardsWithImages(f, 4);
    const run = await f.queue.create({ projectId: f.project.id, entityIds: boards.map(board => board.id) });
    assert.equal(run.concurrency, 2);
    await waitFor(() => f.submissions().length >= 2, '并发上限内没有同时提交两个任务');
    // 前两次提交都发生在任何任务完成之前（此时 ready 数恒为 0）。
    assert.deepEqual(f.submissions().map(call => call.readyAtSubmit), [0, 0]);
    assert.equal(f.store.getAutoRun(run.id).items.filter(item => item.status === 'pending').length, 2);
    released = true;
    await waitFor(() => f.store.getAutoRun(run.id).status === 'completed', '队列没有跑完');
    const finished = f.store.getAutoRun(run.id);
    assert.deepEqual(finished.items.map(item => item.status), ['ready', 'ready', 'ready', 'ready']);
    assert.equal(f.submissions().length, 4);
  } finally { await f.cleanup(); }
});

test('provider concurrency rejection keeps the item pending and backs off instead of failing', async () => {
  const f = await fixture({ runResponse: () => ({ rejectConcurrency: true }) });
  try {
    const boards = await boardsWithImages(f, 1);
    const run = await f.queue.create({ projectId: f.project.id, entityIds: [boards[0].id] });
    await waitFor(() => f.store.getAutoRun(run.id).waitUntil, '没有进入退避等待');
    const waiting = f.store.getAutoRun(run.id);
    assert.equal(waiting.status, 'running');
    assert.equal(waiting.items[0].status, 'pending');
    assert.match(waiting.items[0].note, /并发/);
    // 被并发拒绝时远端没有创建任务：本地只留一条明确的失败记录，不冒充「提交结果不明」。
    for (const job of f.store.state().jobs) {
      assert.equal(job.taskId, undefined);
      assert.equal(job.status, 'failed');
      assert.equal(job.manualResolution, 'provider_concurrency_rejected');
    }
  } finally { await f.cleanup(); }
});

test('queue actions pause, resume and cancel without touching paid submissions', async () => {
  const f = await fixture();
  try {
    const boards = await boardsWithImages(f, 2);
    const run = await f.queue.create({ projectId: f.project.id, entityIds: boards.map(board => board.id) });
    const paused = await f.queue.pause(run.id, '测试暂停');
    assert.equal(paused.status, 'paused');
    assert.equal((await f.queue.resume(run.id)).status, 'running');
    await f.queue.pause(run.id, '再次暂停');
    const cancelled = await f.queue.cancel(run.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.items.every(item => item.status === 'skipped'));
    await assert.rejects(f.queue.resume(run.id), { status: 400 });
    assert.equal(f.submissions().length, 0);
  } finally { await f.cleanup(); }
});

test('a missing or unreadable RunningHub key rejects the whole queue before any paid submission', async () => {
  // 未配置：整条队列直接拒绝，而不是逐组撞上同一个错误刷出一堆失败任务。
  const empty = await fixture({ getRunningHubKey: () => '' });
  try {
    const boards = await boardsWithImages(empty, 3);
    await assert.rejects(() => empty.queue.create({ projectId: empty.project.id, entityIds: boards.map(board => board.id) }), { status: 409 });
    assert.equal(empty.submissions().length, 0);
    assert.equal(empty.store.autoRuns().length, 0);
  } finally { await empty.cleanup(); }
  // 读不出来（例如本机 DPAPI 不可用）：同样不建队列，错误里点明去重新保存 Key。
  const broken = await fixture({ getRunningHubKey: () => { throw new Error('DPAPI unavailable'); } });
  try {
    const boards = await boardsWithImages(broken, 2);
    await assert.rejects(() => broken.queue.create({ projectId: broken.project.id, entityIds: [boards[0].id] }),
      reason => reason.status === 409 && /接口与工作流设置/.test(reason.message));
    assert.equal(broken.store.autoRuns().length, 0);
  } finally { await broken.cleanup(); }
});

test('HTTP: auto grouping, concurrency settings, account detection and queue lifecycle', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'studio-autoqueue-http-'));
  const calls = [];
  const studio = createStudio({ dataDir: join(temp, 'data'), generationOptions: {
    codexPath: join(temp, 'missing-codex.exe'), getRunningHubKey: () => 'mock-studio-key', pollIntervalMs: 1000000,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'POST' });
      if (String(url).endsWith('/queue/status')) return Response.json({ code: 0, msg: 'success', data: { apiKeyType: 'EXCLUSIVE', concurrentLimit: 6, runningCount: '2', queuedCount: '0', totalCurrentTasks: '2' } });
      throw new Error(`Unexpected request: ${url}`);
    } } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.settings.videoConcurrency, 1);
    assert.deepEqual(state.autoRuns, []);
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
    const projectId = state.project.id, shots = [...state.project.shots].sort((a, b) => a.order - b.order);
    let response = await fetch(`${base}/api/storyboards/auto`, { method: 'POST', headers, body: JSON.stringify({ projectId, startShotId: shots[0].id, namePrefix: '第1场', limit: 3 }) });
    assert.equal(response.status, 201, await response.clone().text());
    const grouped = await response.json();
    assert.equal(grouped.created, 3);
    assert.deepEqual(grouped.boards.map(board => board.name), ['第1场 1', '第1场 2', '第1场 3']);
    response = await fetch(`${base}/api/storyboards/auto`, { method: 'POST', headers, body: JSON.stringify({ projectId, startShotId: shots[0].id }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).created, 9);
    response = await fetch(`${base}/api/settings/video-concurrency`, { method: 'PATCH', headers, body: JSON.stringify({ value: 4 }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).settings.videoConcurrency, 4);
    assert.equal((await fetch(`${base}/api/settings/video-concurrency`, { method: 'PATCH', headers, body: JSON.stringify({ value: 0 }) })).status, 400);
    response = await fetch(`${base}/api/settings/video-concurrency/detect`, { method: 'POST', headers, body: JSON.stringify({}) });
    assert.equal(response.status, 200, await response.clone().text());
    const detected = await response.json();
    assert.equal(detected.account.concurrentLimit, 6);
    assert.equal(detected.account.apiKeyType, 'EXCLUSIVE');
    assert.equal(detected.settings.accountConcurrency.concurrentLimit, 6);
    assert.ok(calls.some(call => call.url.endsWith('/queue/status') && call.method === 'GET'));
    // 队列只收录已经采用四宫格的组：没有四宫格的组被跳过，一个都没有时直接拒绝排队。
    const boards = studio.store.getProject(projectId).storyboards.slice(0, 2);
    const gridFile = `projects/${projectId}/grid.png`;
    const gridBytes = Buffer.from('mock grid for the http queue');
    await mkdir(join(temp, 'data', 'projects', projectId), { recursive: true });
    await writeFile(join(temp, 'data', gridFile), gridBytes);
    const grid = studio.store.addMedia(projectId, boards[0].id, { file: gridFile, sha256: digest(gridBytes), kind: 'image', mime: 'image/png',
      baseVersion: studio.store.getEntity(projectId, boards[0].id).currentVersion,
      metadata: { storyboardSource: storyboardSource(studio.store.getProject(projectId), studio.store.getEntity(projectId, boards[0].id)) } });
    studio.store.adopt(projectId, boards[0].id, grid.id);
    response = await fetch(`${base}/api/auto-runs`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityIds: [boards[0].id, boards[1].id], concurrency: 2, template: { aspectRatio: '9:16 (Portrait Widescreen)' } }) });
    assert.equal(response.status, 201, await response.clone().text());
    const { run } = await response.json();
    assert.equal(run.items.length, 1);
    assert.deepEqual(run.skipped.map(item => item.code), [boards[1].code]);
    assert.equal(run.concurrency, 2);
    assert.equal(studio.store.videoConcurrency(), 2);
    assert.equal((await fetch(`${base}/api/auto-runs`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityIds: [boards[1].id] }) })).status, 400);
    response = await fetch(`${base}/api/auto-runs/${run.id}/pause`, { method: 'POST', headers, body: JSON.stringify({}) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).run.status, 'paused');
    response = await fetch(`${base}/api/auto-runs/${run.id}/resume`, { method: 'POST', headers, body: JSON.stringify({}) });
    assert.equal((await response.json()).run.status, 'running');
    response = await fetch(`${base}/api/auto-runs/${run.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({}) });
    assert.equal((await response.json()).run.status, 'cancelled');
    assert.equal((await (await fetch(`${base}/api/state?projectId=${projectId}`)).json()).autoRuns.length, 1);
    assert.equal((await fetch(`${base}/api/auto-runs/run_missing/pause`, { method: 'POST', headers, body: JSON.stringify({}) })).status, 404);
    assert.equal((await fetch(`${base}/api/auto-runs`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityIds: ['board_missing'] }) })).status, 404);
  } finally {
    await new Promise(done => server.close(done)); studio.close();
    await rm(temp, { recursive: true, force: true });
  }
});
