import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StudioStore } from '../server/store.mjs';
import { GenerationService, DEFAULT_VIDEO_CONFIG, FRAME_VIDEO_CONFIG, composePrompt, isValidationRejection } from '../server/generation.mjs';
import { childEnvironment, CodexAppServer, runPromptTask } from '../server/codex.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const text = await readFile(new URL('../examples/奶油变心后_分镜提示词.md', import.meta.url), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'storyboard-generation-'));
  const store = new StudioStore({ dataDir });
  const project = store.importMarkdown(text, 'sample.md');
  const service = new GenerationService({ store, dataDir, appRoot: resolve(dataDir),
    getRunningHubKey: () => '', fetchImpl: () => { throw new Error('unexpected network request'); },
    inspectCodexImpl: async () => ({ available: true, loggedIn: false, message: 'CLI 未登录' }),
    validateMedia: async (path, kind) => ({ sha256: digest(await readFile(path)), mime: `${kind}/${kind === 'image' ? 'png' : 'mp4'}`, extension: kind === 'image' ? '.png' : '.mp4', width: 100, height: 100 }),
    ...extra });
  return { dataDir, store, project, service, async cleanup() { service.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
function configuredVideo(mediaId) {
  const config = structuredClone(DEFAULT_VIDEO_CONFIG);
  config.outputResolution = 'native';
  if (mediaId) config.referenceBindings = ['141', '142', '143'].map(nodeId => ({ nodeId, fieldName: 'image', mediaId }));
  else for (const n of config.nodeInfoList) if (['141', '142', '143'].includes(n.nodeId)) n.fieldValue = `openapi/user-${n.nodeId}.png`;
  return config;
}
async function reference(f) {
  const entity = f.project.assets[0], file = `projects/${f.project.id}/reference.png`, bytes = Buffer.from('a mock image for validator injection');
  await mkdir(join(f.dataDir, 'projects', f.project.id), { recursive: true }); await writeFile(join(f.dataDir, file), bytes);
  return f.store.addMedia(f.project.id, entity.id, { file, sha256: digest(bytes), kind: 'image', mime: 'image/png', baseVersion: entity.currentVersion });
}
async function audioReference(f, index = 0) {
  const entity = f.project.assets.filter(item => item.type === 'character')[index];
  const bytes = Buffer.alloc(60);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(16, 40); bytes.writeInt16LE(index + 1, 44);
  const file = `projects/${f.project.id}/voices/voice-${index + 1}.wav`;
  await mkdir(join(f.dataDir, 'projects', f.project.id, 'voices'), { recursive: true });
  await writeFile(join(f.dataDir, file), bytes);
  return f.store.addMedia(f.project.id, entity.id, { file, sha256: digest(bytes), kind: 'audio', mime: 'audio/wav', baseVersion: entity.currentVersion });
}

test('desktop images work without CLI login, preserve exact prompt, and accept old-version candidates once', async () => {
  const f = await fixture();
  try {
    const entity = f.project.assets[0];
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'image', prompt: '完整提示词\n不隐藏改写' });
    const job = await f.service.submit({ previewId: preview.id, operationId: 'desktop-operation-1', mode: 'desktop' });
    assert.equal(job.status, 'awaiting_delivery'); assert.match(job.instruction, /result.json/);
    assert.equal(job.id, preview.jobId); assert.equal(job.deliveryDirectory, preview.deliveryDirectory);
    assert.equal(job.instruction, preview.agentInstructions);
    const request = JSON.parse(await readFile(join(job.deliveryDirectory, 'request.json'), 'utf8'));
    assert.equal(request.prompt, preview.prompt); assert.equal(request.jobId, job.id);
    f.store.updateEntity(f.project.id, entity.id, { baseVersion: entity.currentVersion, data: { notes: '生成中编辑' } });
    await writeFile(join(job.deliveryDirectory, 'image.png'), 'mock image bytes');
    await writeFile(join(job.deliveryDirectory, 'result.json'), JSON.stringify({ schemaVersion: 1, jobId: job.id, projectId: f.project.id,
      entityId: entity.id, baseVersion: preview.baseVersion, prompt: preview.prompt, files: [{ path: 'image.png', kind: 'image' }] }));
    const refreshed = await f.service.refresh(f.project.id);
    assert.equal(refreshed.errors.length, 0); assert.equal(refreshed.imported.length, 1);
    assert.equal(f.store.getJob(job.id).status, 'ready');
    assert.equal(f.store.getEntity(f.project.id, entity.id).adoptedMediaId, null);
    assert.equal(f.store.getEntity(f.project.id, entity.id).media[0].baseVersion, preview.baseVersion);
    assert.equal((await f.service.refresh(f.project.id)).imported.length, 0);
    assert.equal((await f.service.submit({ previewId: preview.id, operationId: 'desktop-operation-1' })).id, job.id);
  } finally { await f.cleanup(); }
});

test('initial editable prompt includes global style, asset consistency, shot action and verbatim dialogue', async () => {
  const f = await fixture();
  try {
    const asset = f.project.assets[0];
    const assetPrompt = composePrompt(f.project, asset, 'image');
    for (const value of [f.project.style, asset.data.description, asset.data.visualPrompt, asset.data.seedPrompt, f.project.aspectRatio]) assert.ok(assetPrompt.includes(value));
    const shot = f.project.shots[1];
    const imagePrompt = composePrompt(f.project, shot, 'image');
    for (const value of [shot.data.action, shot.data.camera, shot.data.composition, shot.data.dialogue]) assert.ok(imagePrompt.includes(value));
    for (const id of [...shot.data.characterIds, ...shot.data.locationIds]) assert.ok(imagePrompt.includes(f.project.assets.find(a => a.id === id).data.visualPrompt));
    assert.match(imagePrompt, /still storyboard reference frame/);
    const videoPrompt = composePrompt(f.project, shot, 'video');
    assert.ok(videoPrompt.includes(shot.data.transition)); assert.match(videoPrompt, /Storyboard target duration/);
  } finally { await f.cleanup(); }
});

test('preview invalidates on entity, project, dependency and reference file changes', async () => {
  const f = await fixture();
  try {
    const entity = f.project.assets[0];
    let preview = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'image' });
    f.store.updateEntity(f.project.id, entity.id, { baseVersion: entity.currentVersion, data: { notes: 'new' } });
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'stale-entity-123' }), { code: 'PREVIEW_STALE' });
    preview = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'image' });
    f.store.updateProject(f.project.id, { style: 'new global style' });
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'stale-project-123' }), { code: 'PREVIEW_STALE' });
    const shot = f.project.shots[0];
    preview = await f.service.prepare({ projectId: f.project.id, entityId: shot.id, kind: 'image' });
    const dependency = f.store.getEntity(f.project.id, shot.data.characterIds[0]);
    f.store.updateEntity(f.project.id, dependency.id, { baseVersion: dependency.currentVersion, data: { notes: 'dependency update' } });
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'stale-dependency-123' }), { code: 'PREVIEW_STALE' });
    const media = await reference(f);
    preview = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'image', referenceMediaIds: [media.id] });
    await writeFile(join(f.dataDir, media.file), 'changed file');
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'stale-file-123' }), { code: 'PREVIEW_STALE' });
  } finally { await f.cleanup(); }
});

test('default video configuration blocks submission and never imports sample references or LoRA', async () => {
  const f = await fixture();
  try {
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video' });
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '141').fieldValue, 'None');
    assert.ok(preview.blockers.some(item => item.includes('API Key')));
    assert.deepEqual([preview.output.mode, preview.output.resolution, preview.output.width, preview.output.height], ['native_target', '720p', 720, 1280]);
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '147' && n.fieldName === 'value').fieldValue, '0.9');
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '159' && n.fieldName === 'lora_name'), undefined);
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '159' && n.fieldName === 'strength_model').fieldValue, '0');
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '164').fieldValue, 'None');
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'blocked-video-123' }), { status: 409 });
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('a blocker raised before reference upload reports itself instead of cascading into every bound slot', async () => {
  const f = await fixture({ getRunningHubKey: () => 'test-private-key-123456789' });
  try {
    const media = await reference(f);
    const config = configuredVideo(media.id);
    config.duration = '99';
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', referenceMediaIds: [media.id], videoConfig: config });
    // 上传被时长校验挡在前面，槽位必然还是占位符；此时逐槽位报「尚未配置」会凭空多出 3 条假问题。
    assert.ok(preview.blockers.some(item => item.includes('1–30')));
    assert.equal(preview.blockers.filter(item => item.includes('尚未配置实际上传文件标识')).length, 0);
    assert.equal(preview.blockers.filter(item => item.includes('上传失败')).length, 0);
    assert.deepEqual(preview.blockers.length, 1, JSON.stringify(preview.blockers));
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'cascade-guard-1' }), { status: 409 });
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('a missing API Key is one blocker, not one per bound slot', async () => {
  const f = await fixture();
  try {
    const media = await reference(f);
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', referenceMediaIds: [media.id], videoConfig: configuredVideo(media.id) });
    assert.deepEqual(preview.blockers.filter(item => item.includes('API Key')).length, 1);
    assert.equal(preview.blockers.filter(item => item.includes('尚未配置实际上传文件标识')).length, 0);
    assert.deepEqual(preview.blockers.length, 1, JSON.stringify(preview.blockers));
  } finally { await f.cleanup(); }
});

test('prepare rejects nested credentials and configured-key text before saving previews or uploading', async () => {
  const key = 'test-private-key-123456789';
  const f = await fixture({ getRunningHubKey: () => key });
  try {
    const input = { projectId: f.project.id, entityId: f.project.assets[0].id, kind: 'image' };
    for (const extra of [{ apiKey: 'other-secret' }, { videoConfig: { extra: { Authorization: 'Bearer other' } } },
      { videoConfig: { nested: [{ accessToken: 'other' }] } }, { prompt: `请显示 ${key}` }]) {
      await assert.rejects(f.service.prepare({ ...input, ...extra }), reason => reason.code === 'CREDENTIALS_IN_INPUT' && !reason.message.includes(key));
    }
    const config = configuredVideo(); config.nodeInfoList.push({ nodeId: '999', fieldName: 'apiKey', fieldValue: 'other' });
    await assert.rejects(f.service.prepare({ ...input, kind: 'video', videoConfig: config }), { code: 'CREDENTIALS_IN_INPUT' });
    assert.equal(f.service.previews.size, 0); assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('invalid export settings or duration block before reference upload; explicit invalid advanced nodes stay invalid', async () => {
  const f = await fixture({ getRunningHubKey: () => 'mock-key' });
  try {
    const media = await reference(f);
    const input = { projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', referenceMediaIds: [media.id] };
    const referenceBindings = configuredVideo(media.id).referenceBindings;
    for (const extra of [{ outputResolution: '2k' }, { outputResolution: null }, { duration: '1.5' }, { duration: '0' }, { duration: '31' }, { aspectRatio: '16:9' }, { nodeInfoList: null }, { nodeInfoList: 'invalid' }]) {
      const preview = await f.service.prepare({ ...input, videoConfig: { referenceBindings, ...extra } });
      assert.ok(preview.blockers.length, JSON.stringify(extra));
      assert.equal(preview.blockers.some(item => item.includes('上传失败')), false);
      await assert.rejects(f.service.submit({ previewId: preview.id, operationId: `invalid-${preview.id}` }), { status: 409 });
    }
    const advanced = configuredVideo();
    advanced.nodeInfoList.find(n => n.nodeId === '192').fieldValue = '12';
    advanced.nodeInfoList.push({ nodeId: '999', fieldName: 'custom_option', fieldValue: 'keep supplied value' });
    const customPreview = await f.service.prepare({ ...input, referenceMediaIds: [], videoConfig: advanced });
    assert.deepEqual(customPreview.blockers, []);
    assert.equal(customPreview.request.nodeInfoList.find(n => n.nodeId === '192').fieldValue, '12');
    assert.equal(customPreview.request.nodeInfoList.find(n => n.nodeId === '999').fieldValue, 'keep supplied value');
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('legacy frozen resize snapshots still reuse the saved original after restart', async () => {
  let uploads = 0, submissions = 0, downloads = 0, exports = 0;
  const requests = [];
  const f = await fixture({ getRunningHubKey: () => 'mock-key',
    resizeVideoImpl: async ({ sourceFile, outputFile, output }) => {
      exports++;
      assert.equal(await readFile(sourceFile, 'utf8'), 'cloud original');
      assert.deepEqual([output.width, output.height], [1280, 720]);
      await writeFile(outputFile, 'partial export');
      if (exports === 1) throw new Error('mock ffmpeg interrupted');
      await writeFile(outputFile, 'local resized mp4');
    },
    validateMedia: async path => {
      const bytes = await readFile(path), exported = bytes.toString() === 'local resized mp4';
      return { sha256: digest(bytes), mime: 'video/mp4', extension: '.mp4', width: exported ? 1280 : 480, height: exported ? 720 : 864 };
    },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/media/upload/binary')) { uploads++; return Response.json({ data: { fileName: 'openapi/one-reference.png' } }); }
      if (String(url).includes('/run/ai-app/')) {
        submissions++; requests.push(JSON.parse(options.body));
        return Response.json({ taskId: 'resize-task', status: 'SUCCESS', results: [{ outputType: 'mp4', url: 'https://files.runninghub.ai/original.mp4' }] });
      }
      if (String(url).endsWith('/query')) throw new Error('successful task must not be queried again for local export');
      downloads++; return new Response('cloud original');
    } });
  try {
    const media = await reference(f);
    const config = { duration: '5', aspectRatio: '16:9 (Widescreen)', outputResolution: '720p',
      referenceBindings: configuredVideo(media.id).referenceBindings };
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video',
      prompt: '完整且保持原样的最终提示词', referenceMediaIds: [media.id], videoConfig: config });
    assert.deepEqual(preview.blockers, []); assert.equal(uploads, 1);
    assert.equal(preview.request.nodeInfoList.length, DEFAULT_VIDEO_CONFIG.nodeInfoList.length);
    assert.deepEqual([preview.output.mode, preview.output.resolution, preview.output.width, preview.output.height], ['native_target', '720p', 1280, 720]);
    const hashInput = { ...preview }; delete hashInput.hash;
    assert.equal(preview.hash, digest(JSON.stringify(hashInput)));
    // 模拟升级前已经冻结的导出计划；新 prepare 不再创建 resize 任务。
    const originalPlan = { mode: 'resize', resolution: '720p', width: 1280, height: 720, note: '旧版本机导出计划' };
    f.service.previews.get(preview.id).output = structuredClone(originalPlan);
    config.duration = '30'; config.outputResolution = '480p'; preview.output.width = 2;
    const job = await f.service.submit({ previewId: preview.id, operationId: 'resize-partial-controls' });
    assert.equal(job.status, 'query_failed'); assert.match(job.error, /ffmpeg interrupted/);
    assert.deepEqual(job.snapshot.output, originalPlan);
    assert.equal(job.sourceFiles.length, 1); assert.equal(job.outputs.length, 0);
    assert.equal(await readFile(join(f.dataDir, job.sourceFiles[0].file), 'utf8'), 'cloud original');
    const actual = requests[0].nodeInfoList;
    assert.equal(actual.find(n => n.nodeId === '150').fieldValue, job.snapshot.prompt);
    assert.equal(actual.find(n => n.nodeId === '115').fieldValue, '16:9 (Widescreen)');
    assert.equal(actual.find(n => n.nodeId === '186').fieldValue, '5');
    assert.equal(actual.find(n => n.nodeId === '192').fieldValue, '8');
    assert.equal(JSON.stringify(requests[0]).includes('outputResolution'), false);
    const next = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[1].id, kind: 'video', videoConfig: configuredVideo() });
    await assert.rejects(f.service.submit({ previewId: next.id, operationId: 'resize-lock-next-task' }), { code: 'ACTIVE_VIDEO_TASK' });
    f.service.close();
    f.service = new GenerationService({ store: f.store, dataDir: f.dataDir, appRoot: f.dataDir,
      getRunningHubKey: () => { throw new Error('local export retry must not need provider key'); },
      fetchImpl: () => { throw new Error('local export retry must not access provider'); },
      validateMedia: async path => ({ sha256: digest(await readFile(path)), mime: 'video/mp4', extension: '.mp4', width: 1280, height: 720 }),
      resizeVideoImpl: async ({ sourceFile, outputFile, output }) => {
        exports++; assert.deepEqual(output, originalPlan);
        assert.equal(await readFile(sourceFile, 'utf8'), 'cloud original');
        await writeFile(outputFile, 'local resized mp4');
      } });
    f.service.pollIntervalMs = 5;
    f.store.updateJob(job.id, { status: 'downloading' });
    f.service.recover();
    assert.equal(f.service.polling.size, 1);
    for (let count = 0; count < 100 && !['ready', 'query_failed'].includes(f.store.getJob(job.id).status); count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.store.getJob(job.id).status, 'ready', 'restart should continue the saved local export without querying');
    const finished = await f.service.retry(job.id);
    assert.equal(finished.status, 'ready'); assert.equal(finished.outputs.length, 1);
    assert.equal(finished.outputs[0].metadata.sourceFile, job.sourceFiles[0].file);
    assert.notEqual(finished.outputs[0].file, finished.outputs[0].metadata.sourceFile);
    assert.deepEqual([finished.outputs[0].metadata.sourceWidth, finished.outputs[0].metadata.sourceHeight], [480, 864]);
    assert.deepEqual([finished.outputs[0].metadata.exportWidth, finished.outputs[0].metadata.exportHeight], [1280, 720]);
    assert.equal(await readFile(join(f.dataDir, finished.outputs[0].file), 'utf8'), 'local resized mp4');
    assert.equal(await readFile(join(f.dataDir, job.sourceFiles[0].file), 'utf8'), 'cloud original');
    assert.deepEqual([uploads, submissions, downloads, exports], [1, 1, 1, 2]);
  } finally { await f.cleanup(); }
});

test('1080p prepares and submits the cloud pixel node, then keeps a qualifying original without resizing', async () => {
  const requests = []; let downloads = 0, resizes = 0;
  const bytes = Buffer.from('native 1088x1920 cloud original');
  const f = await fixture({ getRunningHubKey: () => 'mock-native-key',
    resizeVideoImpl: async () => { resizes++; throw new Error('native output must not be resized'); },
    validateMedia: async path => ({ sha256: digest(await readFile(path)), mime: 'video/mp4', extension: '.mp4', width: 1088, height: 1920 }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/run/ai-app/')) {
        requests.push(JSON.parse(options.body));
        return Response.json({ taskId: 'native-1080-success', status: 'SUCCESS', results: [{ outputType: 'mp4', url: 'https://files.runninghub.ai/native.mp4' }] });
      }
      downloads++; return new Response(bytes);
    } });
  try {
    const config = { ...configuredVideo(), outputResolution: '1080p' };
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: config });
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual([preview.config.pixels, preview.output.mode, preview.output.expectedWidth, preview.output.expectedHeight], ['2', 'native_target', 1088, 1920]);
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '147' && n.fieldName === 'value').fieldValue, '2');
    config.outputResolution = '480p';
    const job = await f.service.submit({ previewId: preview.id, operationId: 'native-1080-success-operation' });
    assert.deepEqual(requests, [preview.request]);
    assert.equal(job.status, 'ready'); assert.equal(job.outputs.length, 1);
    const media = job.outputs[0];
    assert.equal(media.file, job.sourceFiles[0].file);
    assert.deepEqual([media.metadata.width, media.metadata.height, media.metadata.sourceWidth, media.metadata.sourceHeight], [1088, 1920, 1088, 1920]);
    assert.equal(media.sha256, digest(bytes));
    assert.deepEqual(await readFile(join(f.dataDir, media.file)), bytes);
    assert.deepEqual([requests.length, downloads, resizes], [1, 1, 0]);
  } finally { await f.cleanup(); }
});

for (const resultMode of ['immediate', 'query']) test(`a low-resolution original is terminally rejected after ${resultMode} success and retry never submits again`, async () => {
  let submissions = 0, queries = 0, downloads = 0, resizes = 0;
  const bytes = Buffer.from('undersized 480x864 cloud original');
  const success = { taskId: `low-native-${resultMode}`, status: 'SUCCESS', results: [{ outputType: 'mp4', url: 'https://files.runninghub.ai/low-native.mp4' }] };
  const f = await fixture({ getRunningHubKey: () => 'mock-native-key',
    resizeVideoImpl: async () => { resizes++; throw new Error('undersized native output must not be enlarged'); },
    validateMedia: async path => ({ sha256: digest(await readFile(path)), mime: 'video/mp4', extension: '.mp4', width: 480, height: 864 }),
    fetchImpl: async url => {
      if (String(url).includes('/run/ai-app/')) { submissions++; return Response.json(resultMode === 'immediate' ? success : { taskId: success.taskId, status: 'RUNNING' }); }
      if (String(url).endsWith('/query')) { queries++; return Response.json(success); }
      downloads++; return new Response(bytes);
    } });
  try {
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: { ...configuredVideo(), outputResolution: '1080p' } });
    assert.deepEqual(preview.blockers, []);
    let job = await f.service.submit({ previewId: preview.id, operationId: `low-native-operation-${resultMode}` });
    if (resultMode === 'query') { assert.equal(job.status, 'running'); job = await f.service.retry(job.id); }
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, 'NATIVE_RESOLUTION_MISMATCH');
    assert.equal(job.taskId, success.taskId);
    assert.equal(job.sourceFiles.length, 1); assert.deepEqual(job.outputs, []);
    assert.equal(job.sourceFiles[0].sha256, digest(bytes));
    assert.deepEqual(await readFile(join(f.dataDir, job.sourceFiles[0].file)), bytes);
    assert.equal(f.store.getEntity(f.project.id, f.project.shots[0].id).media.filter(media => media.kind === 'video').length, 0);
    const retried = await f.service.retry(job.id);
    assert.equal(retried.status, 'failed'); assert.equal(retried.errorCode, 'NATIVE_RESOLUTION_MISMATCH');
    f.service.recover(); assert.equal(f.service.polling.size, 0);
    assert.deepEqual([submissions, queries, downloads, resizes], [1, resultMode === 'query' ? 1 : 0, 1, 0]);
  } finally { await f.cleanup(); }
});

test('conflicting custom native pixel fields are blocked without rewriting the advanced node or uploading', async () => {
  const f = await fixture({ getRunningHubKey: () => 'mock-key' });
  try {
    const config = configuredVideo();
    config.pixels = '2';
    config.nodeInfoList.find(node => node.nodeId === '147' && node.fieldName === 'value').fieldValue = '0.7';
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: config });
    assert.ok(preview.blockers.some(message => message.includes('配置冲突')));
    assert.equal(preview.config.pixels, '2');
    assert.equal(preview.config.nodeInfoList.find(node => node.nodeId === '147').fieldValue, '0.7');
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'conflicting-native-budget' }), { status: 409 });
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('custom native pixels preserve the advanced node and reject invalid budgets before paid submission', async () => {
  const f = await fixture({ getRunningHubKey: () => 'mock-native-key' });
  try {
    const input = { projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video' };
    const config = configuredVideo(); delete config.pixels;
    config.nodeInfoList.find(node => node.nodeId === '147' && node.fieldName === 'value').fieldValue = '0.7';
    const custom = await f.service.prepare({ ...input, videoConfig: config });
    assert.deepEqual(custom.blockers, []);
    assert.deepEqual([custom.output.mode, custom.config.pixels, custom.output.pixels], ['native', '0.7', '0.7']);
    assert.equal(custom.request.nodeInfoList.find(node => node.nodeId === '147' && node.fieldName === 'value').fieldValue, '0.7');
    for (const pixels of ['0.1', '2.1', 'NaN', '', null]) {
      const invalid = await f.service.prepare({ ...input, videoConfig: { ...config, pixels } });
      assert.ok(invalid.blockers.length, `invalid native pixels ${JSON.stringify(pixels)} must be rejected`);
      await assert.rejects(f.service.submit({ previewId: invalid.id, operationId: `invalid-native-${invalid.id}` }), { status: 409 });
    }
    const tooWide = await f.service.prepare({ ...input, videoConfig: { ...config, outputResolution: '1080p', aspectRatio: '21:9 (Ultrawide)' } });
    assert.ok(tooWide.blockers.length);
    await assert.rejects(f.service.submit({ previewId: tooWide.id, operationId: 'unsupported-native-wide-1080' }), { status: 409 });
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('reference upload prepares exact provider file names; submit is direct and download retry never regenerates', async () => {
  const calls = []; let downloads = 0;
  const f = await fixture({ getRunningHubKey: () => 'test-key-not-real', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), body: typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body });
    if (String(url).endsWith('media/upload/binary')) return Response.json({ code: 0, data: { fileName: 'openapi/uploaded.png' } });
    if (String(url).includes('/run/ai-app/')) return Response.json({ taskId: 'task-test-1', status: 'RUNNING', promptTips: '{"result":true,"node_errors":{}}' });
    if (String(url).endsWith('/query')) return Response.json({ taskId: 'task-test-1', status: 'SUCCESS', usage: { consumeCoins: 32 }, results: [{ outputType: 'mp4', url: 'https://files.runninghub.ai/result.mp4' }] });
    if (++downloads === 1) return new Response('expired transient', { status: 503 });
    return new Response('mock mp4 bytes');
  } });
  try {
    const media = await reference(f);
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video',
      prompt: '发送前可见的完整中文台词', referenceMediaIds: [media.id], videoConfig: configuredVideo(media.id) });
    assert.deepEqual(preview.blockers, []);
    assert.equal(calls.length, 1);
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '141').fieldValue, 'openapi/uploaded.png');
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '150').fieldValue, preview.prompt);
    const jobs = await Promise.all([1, 2].map(() => f.service.submit({ previewId: preview.id, operationId: 'paid-operation-one' })));
    assert.equal(jobs[0].id, jobs[1].id);
    assert.equal(calls.filter(call => call.url.includes('/run/ai-app/')).length, 1);
    assert.deepEqual(calls.find(call => call.url.includes('/run/ai-app/')).body, preview.request);
    const another = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[1].id, kind: 'video', videoConfig: configuredVideo() });
    await assert.rejects(f.service.submit({ previewId: another.id, operationId: 'paid-operation-two' }), { code: 'ACTIVE_VIDEO_TASK' });
    assert.equal((await f.service.retry(jobs[0].id)).status, 'query_failed');
    await assert.rejects(f.service.submit({ previewId: another.id, operationId: 'paid-operation-two' }), { code: 'ACTIVE_VIDEO_TASK' });
    const completed = await f.service.retry(jobs[0].id);
    assert.equal(completed.status, 'ready'); assert.equal(completed.outputs.length, 1);
    assert.equal(completed.usage.consumeCoins, 32);
    assert.equal(calls.filter(call => call.url.includes('/run/ai-app/')).length, 1);
    assert.equal(f.store.getEntity(f.project.id, f.project.shots[0].id).adoptedMediaId, null);
    assert.equal(JSON.stringify(completed).includes('test-key-not-real'), false);
    assert.deepEqual(completed.outputs[0].metadata.dependencyVersions, preview.dependencyVersions);
  } finally { await f.cleanup(); }
});

test('six distinct image references freeze all six workflow slots and an unbound seventh blocks before upload', async () => {
  const uploads = [], requests = [];
  const f = await fixture({ getRunningHubKey: () => 'mock-key-for-six-images', fetchImpl: async (url, options) => {
    if (String(url).endsWith('/media/upload/binary')) {
      const file = options.body.get('file'); uploads.push(file.name);
      return Response.json({ data: { fileName: `openapi/uploaded-${file.name}` } });
    }
    assert.ok(String(url).includes('/run/ai-app/')); requests.push(JSON.parse(options.body));
    return Response.json({ taskId: 'six-image-task', status: 'RUNNING' });
  } });
  try {
    const images = [];
    for (let index = 0; index < 7; index++) images.push(await dimensionedImage(f, 864 + index));
    const nodeIds = ['141', '142', '143', '161', '175', '176'];
    const config = configuredVideo();
    config.referenceBindings = nodeIds.map((nodeId, index) => ({ nodeId, fieldName: 'image', mediaId: images[index].id }));
    const input = { projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: config };
    const extra = await f.service.prepare({ ...input, referenceMediaIds: images.map(image => image.id) });
    assert.ok(extra.blockers.some(item => item.includes('未在 referenceBindings')));
    assert.equal(uploads.length, 0);
    await assert.rejects(f.service.submit({ previewId: extra.id, operationId: 'seventh-image-blocked' }), { status: 409 });
    assert.equal(requests.length, 0);

    const preview = await f.service.prepare({ ...input, referenceMediaIds: images.slice(0, 6).map(image => image.id) });
    assert.deepEqual(preview.blockers, []); assert.equal(uploads.length, 6);
    assert.equal(requests.length, 0);
    assert.deepEqual(nodeIds.map(nodeId => preview.request.nodeInfoList.find(node => node.nodeId === nodeId && node.fieldName === 'image').fieldValue),
      uploads.map(filename => `openapi/uploaded-${filename}`));
    config.referenceBindings = [];
    const job = await f.service.submit({ previewId: preview.id, operationId: 'six-image-submit' });
    assert.equal(job.status, 'running'); assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], preview.request);
    assert.deepEqual(job.snapshot.references, preview.references);
  } finally { await f.cleanup(); }
});

test('two WAV voice references upload once each and freeze all three audio slots before direct video submission', async () => {
  const uploads = [], requests = [];
  const f = await fixture({ getRunningHubKey: () => 'mock-key-for-audio', fetchImpl: async (url, options) => {
    if (String(url).endsWith('/media/upload/binary')) {
      const file = options.body.get('file'); assert.equal(file.type, 'audio/wav');
      const bytes = Buffer.from(await file.arrayBuffer()); assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
      uploads.push(file.name);
      return Response.json({ code: 0, data: { fileName: `openapi/uploaded-${file.name}` } });
    }
    assert.ok(String(url).includes('/run/ai-app/')); requests.push(JSON.parse(options.body));
    return Response.json({ taskId: 'audio-reference-task', status: 'RUNNING' });
  } });
  try {
    const first = await audioReference(f, 0), second = await audioReference(f, 1);
    const config = configuredVideo();
    config.referenceBindings = [
      { nodeId: '144', fieldName: 'audio', mediaId: first.id },
      { nodeId: '160', fieldName: 'audio', mediaId: first.id },
      { nodeId: '189', fieldName: 'audio', mediaId: second.id },
    ];
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video',
      referenceMediaIds: [first.id, second.id], videoConfig: config });
    assert.deepEqual(preview.blockers, []); assert.deepEqual(uploads, ['voice-1.wav', 'voice-2.wav']);
    assert.equal(requests.length, 0);
    assert.equal(preview.references.length, 2);
    assert.ok(preview.references.every(ref => ref.kind === 'audio' && ref.mime === 'audio/wav' && ref.note.includes('未验证')));
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '144').fieldValue, 'openapi/uploaded-voice-1.wav');
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '160').fieldValue, 'openapi/uploaded-voice-1.wav');
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '189').fieldValue, 'openapi/uploaded-voice-2.wav');
    const job = await f.service.submit({ previewId: preview.id, operationId: 'audio-reference-submit' });
    assert.equal(job.status, 'running'); assert.equal(requests.length, 1); assert.deepEqual(requests[0], preview.request);
    assert.deepEqual(job.snapshot.references, preview.references);
    for (const ref of preview.references) assert.equal(preview.dependencyVersions[ref.entityId], f.store.getEntity(f.project.id, ref.entityId).currentVersion);
  } finally { await f.cleanup(); }
});

test('audio references require explicit audio slots, cannot enter image tasks, and changed WAV files invalidate previews', async () => {
  let submissions = 0;
  const f = await fixture({ getRunningHubKey: () => 'audio-test-key', fetchImpl: async (url, options) => {
    if (String(url).endsWith('/media/upload/binary')) return Response.json({ code: 0, data: { fileName: 'openapi/voice.wav' } });
    submissions++; throw new Error('paid endpoint must not be called');
  } });
  try {
    const audio = await audioReference(f);
    const input = { projectId: f.project.id, entityId: f.project.shots[0].id, referenceMediaIds: [audio.id] };
    await assert.rejects(f.service.prepare({ ...input, kind: 'image' }), { code: 'IMAGE_REFERENCE_TYPE' });
    assert.equal(f.service.previews.size, 0);
    const unbound = await f.service.prepare({ ...input, kind: 'video', videoConfig: configuredVideo() });
    assert.ok(unbound.blockers.some(item => item.includes('未在 referenceBindings')));
    const wrong = configuredVideo(); wrong.referenceBindings = [{ nodeId: '141', fieldName: 'image', mediaId: audio.id }];
    const wrongPreview = await f.service.prepare({ ...input, kind: 'video', videoConfig: wrong });
    assert.ok(wrongPreview.blockers.some(item => item.includes('类型与 141.image 不符')));
    const unknown = configuredVideo(); unknown.nodeInfoList.push({ nodeId: '999', fieldName: 'audio', fieldValue: 'None' });
    unknown.referenceBindings = [{ nodeId: '999', fieldName: 'audio', mediaId: audio.id }];
    assert.ok((await f.service.prepare({ ...input, kind: 'video', videoConfig: unknown })).blockers.some(item => item.includes('音频参考仅支持')));
    const config = configuredVideo(); config.referenceBindings = [{ nodeId: '144', fieldName: 'audio', mediaId: audio.id }];
    const preview = await f.service.prepare({ ...input, kind: 'video', videoConfig: config }); assert.deepEqual(preview.blockers, []);
    await writeFile(join(f.dataDir, audio.file), 'voice bytes changed after preparation');
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'audio-changed-submit' }), { code: 'PREVIEW_STALE' });
    assert.equal(submissions, 0); assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('ambiguous submit is persisted and never retried as a paid request after restart', async () => {
  let count = 0;
  const f = await fixture({ getRunningHubKey: () => 'dummy-key', fetchImpl: async () => { count++; throw new Error('network timeout dummy-key'); } });
  try {
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: configuredVideo() });
    const job = await f.service.submit({ previewId: preview.id, operationId: 'ambiguous-operation' });
    assert.equal(job.status, 'submission_unknown'); assert.equal(job.error.includes('dummy-key'), false);
    await assert.rejects(f.service.retry(job.id), { status: 409 });
    f.service.recover();
    assert.equal((await f.service.submit({ previewId: preview.id, operationId: 'ambiguous-operation' })).id, job.id);
    const another = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[1].id, kind: 'video', videoConfig: configuredVideo() });
    await assert.rejects(f.service.submit({ previewId: another.id, operationId: 'ambiguous-other' }), /先在 RunningHub 核对/);
    assert.equal(count, 1);
  } finally { await f.cleanup(); }
});

for (const scenario of [
  { name: 'bad promptTips while RUNNING', response: { status: 'RUNNING', promptTips: 'not-json' }, expected: 'query_failed' },
  { name: 'unknown cloud state with a task ID', response: { status: 'PROCESSING_NEW_STATE' }, expected: 'query_failed' },
  { name: 'explicit cloud FAILED with a task ID', response: { status: 'FAILED', errorMessage: 'provider rejected task' }, expected: 'failed' },
]) test(`submission safeguard: ${scenario.name}`, async () => {
  let submissions = 0, queries = 0;
  const f = await fixture({ getRunningHubKey: () => 'fake-key', fetchImpl: async url => {
    if (String(url).includes('/run/ai-app/')) {
      submissions++;
      return Response.json({ taskId: `task-${submissions}`, ...(submissions === 1 ? scenario.response : { status: 'RUNNING' }) });
    }
    assert.ok(String(url).endsWith('/query')); queries++;
    return Response.json({ taskId: 'task-1', status: 'FAILED', errorMessage: 'confirmed terminal failure' });
  } });
  try {
    const input = { projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: configuredVideo() };
    const first = await f.service.prepare(input);
    const job = await f.service.submit({ previewId: first.id, operationId: 'response-check-first' });
    assert.equal(job.taskId, 'task-1'); assert.equal(job.status, scenario.expected); assert.ok(job.error);
    const second = await f.service.prepare({ ...input, entityId: f.project.shots[1].id });
    if (scenario.expected === 'query_failed') {
      await assert.rejects(f.service.submit({ previewId: second.id, operationId: 'response-check-second' }), { code: 'ACTIVE_VIDEO_TASK' });
      assert.equal(submissions, 1);
      assert.equal((await f.service.retry(job.id)).status, 'failed');
      assert.equal(queries, 1); assert.equal(submissions, 1);
    }
    const next = await f.service.submit({ previewId: second.id, operationId: 'response-check-second' });
    assert.equal(next.status, 'running'); assert.equal(submissions, 2);
  } finally { await f.cleanup(); }
});

test('download rejects files above the shared 200MB limit before registration without resubmitting', async () => {
  let submissions = 0;
  const f = await fixture({ getRunningHubKey: () => 'fake-key', fetchImpl: async url => {
    if (String(url).includes('/run/ai-app/')) { submissions++; return Response.json({ taskId: 'task-large', status: 'RUNNING' }); }
    if (String(url).endsWith('/query')) return Response.json({ taskId: 'task-large', status: 'SUCCESS', results: [{ outputType: 'mp4', url: 'https://files.runninghub.ai/large.mp4' }] });
    return new Response('not actually a large download', { headers: { 'content-length': String(201 * 1024 * 1024) } });
  } });
  try {
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: configuredVideo() });
    const job = await f.service.submit({ previewId: preview.id, operationId: 'large-download' });
    const retried = await f.service.retry(job.id);
    assert.equal(retried.status, 'query_failed'); assert.match(retried.error, /200MB/);
    assert.equal(f.store.getEntity(f.project.id, job.entityId).media.length, 0); assert.equal(submissions, 1);
  } finally { await f.cleanup(); }
});

test('malicious delivery traversal and mismatched prompts are refused, then valid replacement can refresh', async () => {
  const f = await fixture();
  try {
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.assets[0].id, kind: 'image' });
    const job = await f.service.submit({ previewId: preview.id, operationId: 'delivery-boundary' });
    const manifest = { schemaVersion: 1, jobId: job.id, projectId: job.projectId, entityId: job.entityId,
      baseVersion: preview.baseVersion, prompt: preview.prompt, files: [{ path: '../escape.png', kind: 'image' }] };
    await writeFile(join(job.deliveryDirectory, 'result.json'), JSON.stringify(manifest));
    assert.equal((await f.service.refresh()).errors.length, 1);
    assert.equal(f.store.getEntity(job.projectId, job.entityId).media.length, 0);
    manifest.files[0].path = 'image.png'; manifest.prompt = 'wrong prompt';
    await writeFile(join(job.deliveryDirectory, 'result.json'), JSON.stringify(manifest));
    assert.match((await f.service.refresh()).errors[0].error, /不一致/);
    manifest.prompt = preview.prompt; await writeFile(join(job.deliveryDirectory, 'image.png'), 'real result in mock validator');
    await writeFile(join(job.deliveryDirectory, 'result.json'), JSON.stringify(manifest));
    assert.equal((await f.service.refresh()).imported.length, 1);
  } finally { await f.cleanup(); }
});

test('delivery bytes cannot change between validation and registration', async () => {
  const f = await fixture({ validateMedia: async path => {
    const original = await readFile(path);
    await writeFile(path, 'source was rewritten after validation');
    return { sha256: digest(original), mime: 'image/png', extension: '.png' };
  } });
  try {
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.assets[0].id, kind: 'image' });
    const job = await f.service.submit({ previewId: preview.id, operationId: 'delivery-changing' });
    await writeFile(join(job.deliveryDirectory, 'image.png'), 'validated source');
    await writeFile(join(job.deliveryDirectory, 'result.json'), JSON.stringify({ schemaVersion: 1, jobId: job.id,
      projectId: job.projectId, entityId: job.entityId, baseVersion: preview.baseVersion, prompt: preview.prompt, files: [{ path: 'image.png', kind: 'image' }] }));
    const refreshed = await f.service.refresh();
    assert.match(refreshed.errors[0].error, /登记前发生变化/);
    assert.equal(f.store.getEntity(job.projectId, job.entityId).media.length, 0);
  } finally { await f.cleanup(); }
});

test('CLI automatic images are honestly disabled and RunningHub secrets never reach child environment', async () => {
  const f = await fixture();
  try {
    const capabilities = await f.service.capabilities(); assert.equal(capabilities.codex.loggedIn, false);
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.assets[0].id, kind: 'image' });
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'automatic-image', mode: 'codex' }), /严格校验尚未验证/);
    assert.deepEqual(childEnvironment({ PATH: 'ok', RUNNINGHUB_API_KEY: 'secret', OPENAI_API_KEY: 'secret', OTHER_TOKEN: 'secret', PASSWORD: 'secret', CODEX_HOME: 'profile' }), { PATH: 'ok', CODEX_HOME: 'profile' });
  } finally { await f.cleanup(); }
});

test('restart recovery examines every project, resumes queries and leaves ambiguous submissions stopped', async () => {
  const calls = [];
  const f = await fixture({ getRunningHubKey: () => 'fake', pollIntervalMs: 60000, fetchImpl: async (url, options) => {
    calls.push(String(url)); assert.ok(String(url).endsWith('/query'));
    return Response.json({ taskId: JSON.parse(options.body).taskId, status: 'RUNNING' });
  } });
  try {
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', videoConfig: configuredVideo() });
    const common = { projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', snapshot: preview };
    const first = f.store.createJob({ ...common, id: 'restart-known-first', taskId: 'known-one', status: 'running' });
    const unknown = f.store.createJob({ ...common, id: 'restart-unknown', status: 'submitting' });
    const second = f.store.importMarkdown(text.replace('奶油变心后', '奶油变心后第二版'), 'another.md', { asNewProject: true });
    f.store.createJob({ ...common, id: 'restart-known-second', projectId: second.id, entityId: second.shots[0].id, taskId: 'known-two', status: 'submitting' });
    f.service.recover();
    assert.equal(f.service.polling.size, 2);
    assert.equal(f.store.getJob(unknown.id).status, 'submission_unknown');
    assert.equal((await f.service.retry(first.id)).status, 'running');
    assert.deepEqual(calls, ['https://www.runninghub.ai/openapi/v2/query']);
  } finally { await f.cleanup(); }
});

function fakeServer({ approval = false, loggedIn = true } = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  const requests = [], responses = [];
  child.stdin.on('data', buffer => {
    for (const line of buffer.toString().trim().split('\n')) {
      const request = JSON.parse(line);
      if (!request.method) { responses.push(request); continue; }
      requests.push(request);
      if (request.id === undefined) continue;
      let result = {};
      if (request.method === 'account/read') result = { account: loggedIn ? { type: 'chatgpt' } : null };
      if (request.method === 'thread/start') result = { thread: { id: 'thread-1' } };
      if (request.method === 'turn/start') result = { turn: { id: 'turn-1', status: 'inProgress' } };
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
        if (request.method === 'turn/start') child.stdout.write(JSON.stringify(approval
          ? { id: 901, method: 'item/commandExecution/requestApproval', params: {} }
          : { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }) + '\n');
      });
    }
  });
  return { child, requests, responses, spawnImpl: () => child };
}

test('App Server executes official initialize/account/thread/turn stdio protocol without bypassing approvals', async () => {
  const server = fakeServer();
  const turn = await runPromptTask({ cwd: tmpdir(), instruction: '整理素材为文件', spawnImpl: server.spawnImpl, timeoutMs: 1000 });
  assert.equal(turn.status, 'completed');
  assert.deepEqual(server.requests.map(item => item.method), ['initialize', 'initialized', 'account/read', 'thread/start', 'turn/start']);
  assert.equal(server.requests.find(item => item.method === 'thread/start').params.approvalPolicy, 'on-request');
  const needingApproval = fakeServer({ approval: true });
  await assert.rejects(runPromptTask({ cwd: tmpdir(), instruction: 'task', spawnImpl: needingApproval.spawnImpl, timeoutMs: 1000 }), /人工审批/);
  assert.equal(needingApproval.responses[0].error.code, -32000);
  assert.equal(needingApproval.responses[0].result, undefined);
});


test('shot previews reject another shot media before any upload and unused slots retain no old cloud files',async()=>{
 const f=await fixture();
 try {
  const other=f.project.shots[1],file=`projects/${f.project.id}/other.png`,bytes=Buffer.from('mock');
  await mkdir(join(f.dataDir,'projects',f.project.id),{recursive:true});await writeFile(join(f.dataDir,file),bytes);
  const m=f.store.addMedia(f.project.id,other.id,{file,sha256:digest(bytes),kind:'image',mime:'image/png',baseVersion:other.currentVersion});
  await assert.rejects(f.service.prepare({projectId:f.project.id,entityId:f.project.shots[0].id,kind:'video',referenceMediaIds:[m.id]}),/其他分镜/);
  const config=configuredVideo();
  const preview=await f.service.prepare({projectId:f.project.id,entityId:f.project.shots[0].id,kind:'video',videoConfig:config});
  for(const n of preview.request.nodeInfoList.filter(n=>['image','audio','video'].includes(n.fieldName)))assert.equal(n.fieldValue,'None');
 }finally{await f.cleanup();}
});


const validationFailure={result:false,error:{type:'prompt_outputs_failed_validation'},outputs_to_execute:[],node_errors:{'159':{errors:[{type:'value_not_in_list'}]}}};
test('removed H3 node is omitted and an explicit missing-node rejection recovers without resubmission',async()=>{
 const message='NODE_INFO_MISMATCH(nodeId=158, fieldName=value, reason=node_not_found_in_workflow)';
 assert.equal(DEFAULT_VIDEO_CONFIG.nodeInfoList.some(node=>node.nodeId==='158'),false);
 assert.equal(isValidationRejection({message}),true);
 assert.equal(isValidationRejection({message,taskId:'known-task'}),false);
 assert.equal(isValidationRejection({message:'NODE_INFO_MISMATCH: network timeout'}),false);
 let runs=0;
 const f=await fixture({getRunningHubKey:()=> 'mock-private-key',fetchImpl:async()=>{runs++;return Response.json({code:400,message});}});
 try{
  const preview=await f.service.prepare({projectId:f.project.id,entityId:f.project.shots[0].id,kind:'video',videoConfig:{}});
  const job=await f.service.submit({previewId:preview.id,operationId:'missing-node-rejection-test'});
  assert.equal(job.status,'failed');assert.equal(runs,1);
  f.store.updateJob(job.id,{status:'submission_unknown',error:message});
  await f.service.recover();assert.equal(f.store.getJob(job.id).status,'failed');assert.equal(runs,1);
 }finally{await f.cleanup();}
});
test('disabled legacy LoRA omits None model override; enabled invalid LoRA blocks before upload',async()=>{
 const f=await fixture();try{
  const config=structuredClone(DEFAULT_VIDEO_CONFIG);config.nodeInfoList.push({nodeId:'159',fieldName:'lora_name',fieldValue:'None'});
  let p=await f.service.prepare({projectId:f.project.id,entityId:f.project.shots[0].id,kind:'video',videoConfig:config});
  assert.equal(p.request.nodeInfoList.some(n=>n.fieldName==='lora_name'),false);
  config.nodeInfoList.find(n=>n.fieldName==='strength_model').fieldValue='0.4';
  p=await f.service.prepare({projectId:f.project.id,entityId:f.project.shots[0].id,kind:'video',videoConfig:config});assert.ok(p.blockers.some(b=>b.includes('LoRA')));
 }finally{await f.cleanup();}
});
test('explicit validation rejection is failed, releases lock, and legacy records recover without any paid call',async()=>{
 let runs=0;
 const f=await fixture({getRunningHubKey:()=> 'mock-private-key',fetchImpl:async()=>{runs++;return Response.json({code:400,message:JSON.stringify(validationFailure)});}});
 try{
  const p=await f.service.prepare({projectId:f.project.id,entityId:f.project.shots[0].id,kind:'video',videoConfig:{}});
  assert.deepEqual(p.blockers,[]);
  const job=await f.service.submit({previewId:p.id,operationId:'validation-rejection-test'});assert.equal(job.status,'failed');assert.equal(runs,1);
  f.store.updateJob(job.id,{status:'submission_unknown',error:JSON.stringify(validationFailure)});
  await f.service.recover();assert.equal(f.store.getJob(job.id).status,'failed');assert.equal(runs,1);
  assert.equal(isValidationRejection({promptTips:JSON.stringify(validationFailure)}),true);
  assert.equal(isValidationRejection({message:JSON.stringify(validationFailure),taskId:'known-task'}),false);
  assert.equal(isValidationRejection({message:'network timeout'}),false);
  assert.equal(isValidationRejection({...validationFailure,outputs_to_execute:['157']}),false);
 }finally{await f.cleanup();}
});

// 首尾帧档（FL2VA）用 137/143 两个关键帧槽，而不是多参考档的 141/142/143 + 音频槽。
async function dimensionedImage(f, width = 864, height = 480) {
  const entity = f.project.assets[0], file = `projects/${f.project.id}/frame-${width}x${height}.png`, bytes = Buffer.from(`mock frame ${width}x${height}`);
  await mkdir(join(f.dataDir, 'projects', f.project.id), { recursive: true }); await writeFile(join(f.dataDir, file), bytes);
  return f.store.addMedia(f.project.id, entity.id, { file, sha256: digest(bytes), kind: 'image', mime: 'image/png', baseVersion: entity.currentVersion, metadata: { width, height } });
}
test('the first/last-frame profile maps 137/143, drives the end-frame toggle from 159, and blocks a missing first frame', async () => {
  let uploads = 0;
  const f = await fixture({ getRunningHubKey: () => 'mock-key',
    fetchImpl: async url => {
      if (String(url).endsWith('/media/upload/binary')) { uploads++; return Response.json({ data: { fileName: 'openapi/frame.png' } }); }
      throw new Error('prepare must never submit or download');
    } });
  try {
    const media = await dimensionedImage(f);
    const entity = f.project.shots[0];
    const bare = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video', videoConfig: structuredClone(FRAME_VIDEO_CONFIG) });
    assert.equal(bare.config.mode, 'frames');
    assert.ok(bare.blockers.some(item => item.includes('首帧')));
    assert.equal(bare.blockers.some(item => item.includes('上传失败')), false);
    assert.equal(uploads, 0);

    const preview = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video',
      prompt: '首帧到尾帧的完整提示词', referenceMediaIds: [media.id],
      videoConfig: { ...structuredClone(FRAME_VIDEO_CONFIG), frameBindings: { first: media.id, last: null }, useLastFrame: false } });
    assert.deepEqual(preview.blockers, []);
    assert.equal(uploads, 1);
    const request = Object.fromEntries(preview.request.nodeInfoList.map(item => [`${item.nodeId}.${item.fieldName}`, item.fieldValue]));
    assert.equal(request['137.image'], 'openapi/frame.png');
    assert.equal(request['143.image'], 'openapi/frame.png');
    assert.equal(request['159.value'], 'false');
    assert.equal(request['136.prompt'], preview.prompt);
    assert.equal(request['135.value'], '10');
    assert.equal(request['142.value'], '0.9');
    assert.equal(preview.output.resolution, '720p');
    assert.equal(request['174.value'], 'false');
    assert.equal(preview.request.nodeInfoList.some(item => item.fieldName === 'aspect_ratio'), false);
    assert.equal(preview.request.nodeInfoList.some(item => item.fieldName === 'lora_name'), false);
    assert.equal(preview.request.nodeInfoList.length, FRAME_VIDEO_CONFIG.nodeInfoList.length);
    assert.equal(JSON.stringify(preview.request).includes('frameBindings'), false);
  } finally { await f.cleanup(); }
});
test('the frame profile reuses the first frame for slot 143 when no last frame is chosen, and enforces its own duration, pixel and reference rules', async () => {
  let uploads = 0;
  const f = await fixture({ getRunningHubKey: () => 'mock-key', fetchImpl: async url => {
    if (String(url).endsWith('/media/upload/binary')) { uploads++; return Response.json({ data: { fileName: `openapi/frame-${uploads}.png` } }); }
    throw new Error('unexpected network request'); } });
  try {
    const media = await dimensionedImage(f);
    const second = await dimensionedImage(f, 1280, 720);
    const input = { projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', referenceMediaIds: [media.id], prompt: '首尾帧' };
    const base = { ...structuredClone(FRAME_VIDEO_CONFIG), frameBindings: { first: media.id, last: null } };
    // 图2 是 LoadImage，空槽会让工作流跑不起来：没选尾帧就把首帧那份上传文件复用它，只上传一次。
    const reuse = await f.service.prepare({ ...input, videoConfig: base });
    assert.deepEqual(reuse.blockers, []);
    assert.equal(uploads, 1);
    const reused = Object.fromEntries(reuse.request.nodeInfoList.map(item => [`${item.nodeId}.${item.fieldName}`, item.fieldValue]));
    assert.equal(reused['137.image'], 'openapi/frame-1.png');
    assert.equal(reused['143.image'], reused['137.image']);
    assert.equal(reuse.config.useLastFrame, false);
    assert.equal(reused['159.value'], 'false');
    // 明确选了两张图才是真的首尾帧：图2 用自己的文件，开关按用户的选择下发。
    uploads = 0;
    const pair = await f.service.prepare({ ...input, referenceMediaIds: [media.id, second.id],
      videoConfig: { ...base, frameBindings: { first: media.id, last: second.id }, useLastFrame: true } });
    assert.deepEqual(pair.blockers, []);
    assert.equal(uploads, 2);
    const paired = Object.fromEntries(pair.request.nodeInfoList.map(item => [`${item.nodeId}.${item.fieldName}`, item.fieldValue]));
    assert.notEqual(paired['143.image'], paired['137.image']);
    assert.equal(pair.config.useLastFrame, true);
    assert.equal(paired['159.value'], 'true');
    for (const duration of ['4', '16', '1.5', '']) {
      const preview = await f.service.prepare({ ...input, videoConfig: { ...base, duration } });
      assert.ok(preview.blockers.some(item => item.includes('5–15')), `duration ${duration} must be rejected in the frame profile`);
    }
    const pixels = await f.service.prepare({ ...input, videoConfig: { ...base, pixels: '5' } });
    assert.ok(pixels.blockers.some(item => item.includes('像素/百万')));
    const audio = await audioReference(f);
    const extra = await f.service.prepare({ ...input, referenceMediaIds: [media.id, audio.id], videoConfig: { ...base, useLastFrame: false } });
    assert.ok(extra.blockers.some(item => item.includes('137') && item.includes('未绑定')));
    await assert.rejects(f.service.submit({ previewId: extra.id, operationId: 'frame-audio-rejected' }), { status: 409 });
  } finally { await f.cleanup(); }
});
test('the frame workflow id selects the frame profile on its own and unknown workflows stay blocked', async () => {
  const f = await fixture();
  try {
    const entity = f.project.shots[0];
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video', videoConfig: { workflowId: '2084282198664007682' } });
    assert.equal(preview.config.mode, 'frames');
    assert.ok(preview.request.nodeInfoList.some(item => item.nodeId === '137'));
    assert.equal(preview.request.nodeInfoList.some(item => item.nodeId === '141'), false);
    const unknown = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video', videoConfig: { workflowId: '1234567890123456789' } });
    assert.ok(unknown.blockers.some(item => item.includes('工作流 ID')));
    const both = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video', videoConfig: { mode: 'frames', workflowId: DEFAULT_VIDEO_CONFIG.workflowId } });
    assert.equal(both.config.mode, 'frames');
  } finally { await f.cleanup(); }
});
test('the frame profile derives the native target from the real first frame instead of a ratio node', async () => {
  const f = await fixture({ getRunningHubKey: () => 'mock-key',
    fetchImpl: async url => { if (String(url).endsWith('/media/upload/binary')) return Response.json({ data: { fileName: 'openapi/frame.png' } }); throw new Error('no provider call expected'); } });
  try {
    const media = await dimensionedImage(f, 864, 480);
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', referenceMediaIds: [media.id],
      videoConfig: { ...structuredClone(FRAME_VIDEO_CONFIG), outputResolution: '480p', frameBindings: { first: media.id, last: null }, useLastFrame: false } });
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual([preview.output.mode, preview.output.width, preview.output.height], ['native_target', 864, 480]);
    assert.equal(preview.request.nodeInfoList.find(n => n.nodeId === '142' && n.fieldName === 'value').fieldValue, '0.4');
    const noFrame = await f.service.prepare({ projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video',
      videoConfig: { ...structuredClone(FRAME_VIDEO_CONFIG), outputResolution: '480p', frameBindings: { first: null, last: null }, useLastFrame: false } });
    assert.ok(noFrame.blockers.some(item => item.includes('首帧尺寸')));
  } finally { await f.cleanup(); }
});
test('both profiles default to 720p and standard 24G and honour explicit instance overrides', async () => {
  const f = await fixture();
  try {
    const entity = f.project.shots[0];
    assert.equal(DEFAULT_VIDEO_CONFIG.instanceType, 'default');
    assert.equal(FRAME_VIDEO_CONFIG.instanceType, 'default');
    assert.equal(DEFAULT_VIDEO_CONFIG.outputResolution, '720p');
    assert.equal(FRAME_VIDEO_CONFIG.outputResolution, '720p');
    assert.equal(DEFAULT_VIDEO_CONFIG.pixels, '0.9');
    assert.equal(FRAME_VIDEO_CONFIG.pixels, '0.9');
    const reference = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video' });
    assert.equal(reference.request.instanceType, 'default');
    const frames = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video', videoConfig: { workflowId: FRAME_VIDEO_CONFIG.workflowId } });
    assert.equal(frames.request.instanceType, 'default');
    for (const workflowId of [DEFAULT_VIDEO_CONFIG.workflowId, FRAME_VIDEO_CONFIG.workflowId]) {
      for (const instanceType of ['default', 'plus', 'ultra']) {
        const pinned = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video', videoConfig: { workflowId, instanceType } });
        assert.equal(pinned.request.instanceType, instanceType);
      }
    }
    const bogus = await f.service.prepare({ projectId: f.project.id, entityId: entity.id, kind: 'video', videoConfig: { instanceType: 'huge' } });
    assert.ok(bogus.blockers.some(item => item.includes('instanceType')));
  } finally { await f.cleanup(); }
});
