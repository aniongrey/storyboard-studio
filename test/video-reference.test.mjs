import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GenerationService, VIDEO_REFERENCE_WORKFLOW } from '../server/generation.mjs';
import { createStudio } from '../server/main.mjs';

const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(30)]);
const resultBytes = Buffer.from('provider bytes are preserved without media decoding');
const results = ['909', '914', '915'].map(nodeId => ({ nodeId, outputType: 'mp4', url: `https://files.runninghub.ai/${nodeId}.mp4` }));
async function fixture({ run, download, upload } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-video-reference-'));
  const calls = [];
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false, generationOptions: {
    getRunningHubKey: () => 'mock-key', inspectCodexImpl: async () => ({}), pollIntervalMs: 1000000,
    validateMedia: () => { throw new Error('must not probe or decode reference outputs'); },
    fetchImpl: async (url, options = {}) => {
      url = String(url); calls.push({ url, options });
      if (url.endsWith('/media/upload/binary')) { if (upload) await upload(); return Response.json({ code: 0, data: { fileName: 'openapi/source.mp4' } }); }
      if (url.includes('/run/')) return run ? run() : Response.json({ taskId: '2116011399369904001', status: 'RUNNING' });
      if (url.endsWith('/query')) return Response.json({ taskId: '2116011399369904001', status: 'SUCCESS', results, usage: { consumeCoins: 3 } });
      if (url.startsWith('https://files.runninghub.ai/')) return download ? download(url) : new Response(resultBytes);
      throw new Error(`unexpected URL: ${url}`);
    },
  } });
  return { dataDir, studio, service: studio.generation, calls, async cleanup() { studio.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

const input = { content: video, filename: '中文原视频.mp4', operationId: 'reference-operation-1', outputs: ['depth', 'pose', 'mixed'] };

test('reference workflow inspection uses a read-only endpoint and returns only its graph', async () => {
  const graph = { '1': { class_type: 'VHS_LoadVideo', inputs: { video: 'example.mp4' } } };
  const service = new GenerationService({ dataDir: '.', getRunningHubKey: () => 'mock-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://www.runninghub.ai/api/openapi/getJsonApiFormat');
    assert.equal(options.headers.Authorization, 'Bearer mock-key');
    assert.deepEqual(JSON.parse(options.body), { workflowId: VIDEO_REFERENCE_WORKFLOW, apiKey: 'mock-key' });
    return Response.json({ code: 0, data: { prompt: JSON.stringify(graph), ignored: 'mock-key' } });
  } });
  try { assert.deepEqual(await service.videoReferenceWorkflow(), { workflowId: VIDEO_REFERENCE_WORKFLOW, workflow: graph }); }
  finally { service.close(); }
});

test('one independent workflow task preserves all three native outputs and deduplicates retries', async () => {
  const f = await fixture();
  try {
    const job = await f.service.submitVideoReference(input);
    assert.equal(job.projectId, null); assert.equal(job.entityId, null); assert.equal(job.status, 'running');
    assert.deepEqual(f.studio.store.state().projects, []);
    const request = JSON.parse(f.calls.find(call => call.url.includes('/run/')).options.body);
    assert.deepEqual(request, { addMetadata: true, instanceType: 'default', usePersonalQueue: false, nodeInfoList: [
      { nodeId: '906', fieldName: 'video', fieldValue: 'openapi/source.mp4' },
      ...['938', '939', '940'].map(nodeId => ({ nodeId, fieldName: 'value', fieldValue: 'true' })),
    ] });
    assert.equal(f.calls.find(call => call.url.includes('/run/')).url, `https://www.runninghub.ai/openapi/v2/run/workflow/${VIDEO_REFERENCE_WORKFLOW}`);
    assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'video-references', job.id, 'request.json'), 'utf8')), request);
    assert.equal((await f.service.submitVideoReference(input)).id, job.id);
    const done = await f.service.retry(job.id);
    assert.equal(done.status, 'ready'); assert.equal(done.outputs.length, 3);
    for (const output of done.outputs) {
      assert.deepEqual(await readFile(resolve(f.dataDir, output.file)), resultBytes);
      assert.equal(output.sha256, createHash('sha256').update(resultBytes).digest('hex'));
      assert.equal(output.reviewStatus, 'unreviewed');
    }
    assert.equal((await f.service.submitVideoReference({ ...input, operationId: 'another-operation', outputs: ['mixed', 'depth', 'pose'] })).id, job.id);
    assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 1);
    assert.equal(f.studio.store.allJobs().length, 1);
    assert.doesNotMatch(JSON.stringify(done), /mock-key/);
  } finally { await f.cleanup(); }
});

test('validation and operation conflicts cannot upload or create paid tasks', async () => {
  const f = await fixture();
  try {
    for (const change of [{ content: Buffer.alloc(0) }, { content: Buffer.alloc(30_000_000) }, { content: Buffer.from('not MP4') },
      { filename: 'x.png' }, { outputs: [] }, { outputs: ['depth', 'depth'] }, { outputs: ['anything'] }, { operationId: 'short' }]) {
      await assert.rejects(f.service.submitVideoReference({ ...input, ...change }));
    }
    assert.equal(f.calls.length, 0); assert.equal(f.studio.store.allJobs().length, 0);
    await f.service.submitVideoReference(input);
    await assert.rejects(f.service.submitVideoReference({ ...input, outputs: ['depth'] }), /不同素材或参数/);
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('concurrent duplicate submits share one task and reference tasks consume the existing concurrency limit', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ upload: () => gate });
  try {
    const first = f.service.submitVideoReference(input);
    await new Promise(resolve => setImmediate(resolve));
    const same = await f.service.submitVideoReference(input);
    assert.equal(same.status, 'preparing');
    await assert.rejects(f.service.submitVideoReference({ ...input, operationId: 'other-reference-2', outputs: ['depth'] }), /并发上限/);
    release(); const created = await first;
    assert.equal(created.id, same.id); assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 1);
  } finally { release(); await f.cleanup(); }
});

test('ambiguous submissions survive restart without resubmission; attached task resumes queries only', async () => {
  const f = await fixture({ run: () => { throw new Error('connection lost mock-key'); } });
  try {
    const job = await f.service.submitVideoReference(input);
    assert.equal(job.status, 'submission_unknown'); assert.equal(job.taskId, undefined);
    f.service.recover();
    assert.equal((await f.service.submitVideoReference({ ...input, operationId: 'unknown-retry-2' })).id, job.id);
    await assert.rejects(f.service.retry(job.id), /不能安全重试/);
    f.studio.store.updateJob(job.id, { taskId: '2116011399369904001', status: 'queued' });
    assert.equal((await f.service.retry(job.id)).status, 'ready');
    assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 1);
    assert.doesNotMatch(JSON.stringify(f.studio.store.getJob(job.id)), /mock-key/);
  } finally { await f.cleanup(); }
});

test('partial downloads resume without replacing completed outputs and reject untrusted URLs', async () => {
  let broken = true;
  const f = await fixture({ download: url => {
    if (broken && url.endsWith('/914.mp4')) throw new Error('download interrupted');
    return new Response(resultBytes);
  } });
  try {
    const job = await f.service.submitVideoReference(input);
    const failed = await f.service.retry(job.id);
    assert.equal(failed.status, 'query_failed'); assert.equal(failed.outputs.length, 1);
    broken = false;
    assert.equal((await f.service.retry(job.id)).outputs.length, 3);
    assert.equal(f.calls.filter(call => call.url.endsWith('/909.mp4')).length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 1);
    f.studio.store.updateJob(job.id, { status: 'query_failed', outputs: [], providerResult: { status: 'SUCCESS', results: [{ ...results[0], url: 'http://127.0.0.1/private' }] } });
    const blocked = await f.service.retry(job.id);
    assert.match(blocked.error, /已验证/);
    assert.ok(!f.calls.some(call => call.url.includes('127.0.0.1')));
  } finally { await f.cleanup(); }
});

test('HTTP upload requires CSRF; global jobs and range downloads work without a project', async () => {
  const f = await fixture(); const server = f.studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Studio-Token': state.csrfToken };
    const query = new URLSearchParams({ filename: input.filename, operationId: input.operationId, outputs: input.outputs.join(',') });
    const endpoint = `${base}/api/video-references?${query}`;
    assert.equal((await fetch(endpoint, { method: 'POST', body: video })).status, 403);
    const response = await fetch(endpoint, { method: 'POST', headers, body: video });
    assert.equal(response.status, 201, await response.clone().text());
    const { job } = await response.json(); await f.service.retry(job.id);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).jobs.length, 1);
    const downloaded = await fetch(`${base}/api/video-references/${job.id}/files/depth`);
    assert.match(downloaded.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), resultBytes);
    const source = await fetch(`${base}/api/video-references/${job.id}/files/source`, { headers: { Range: 'bytes=0-11' } });
    assert.equal(source.status, 206); assert.deepEqual(Buffer.from(await source.arrayBuffer()), video.subarray(0, 12));
    assert.equal((await fetch(`${base}/api/video-references/${job.id}/files/missing`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); await f.cleanup(); }
});
