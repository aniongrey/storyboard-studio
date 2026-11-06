import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { IMAGE_UPLOAD_MAX_BYTES, LOCAL_UPLOAD_MAX_BYTES, mediaUploadProblem } from '../public/media-limits.mjs';
import { validateMedia } from '../server/media.mjs';
import { createStudio } from '../server/main.mjs';
import { GenerationService, DEFAULT_VIDEO_CONFIG } from '../server/generation.mjs';
import { StudioStore } from '../server/store.mjs';

const source = await readFile(new URL('../examples/奶油变心后_分镜提示词.md', import.meta.url), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=', 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function oversizedPng(file) {
  await mkdir(join(file, '..'), { recursive: true });
  const handle = await open(file, 'w');
  try {
    await handle.write(png);
    await handle.truncate(IMAGE_UPLOAD_MAX_BYTES);
  } finally { await handle.close(); }
}

async function generationFixture(fetchImpl) {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-media-limits-'));
  const store = new StudioStore({ dataDir });
  const project = store.importMarkdown(source, 'fixture.md');
  const service = new GenerationService({ store, dataDir, appRoot: dataDir,
    getRunningHubKey: () => 'mock-upload-key', fetchImpl,
    inspectCodexImpl: async () => ({ available: false, loggedIn: false }) });
  return { dataDir, store, project, service,
    async cleanup() { service.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

async function addReference(f, { oversized = false } = {}) {
  const entity = f.project.assets[0];
  const file = `projects/${f.project.id}/reference.png`;
  await mkdir(join(f.dataDir, 'projects', f.project.id), { recursive: true });
  if (oversized) await oversizedPng(join(f.dataDir, file));
  else await writeFile(join(f.dataDir, file), png);
  return f.store.addMedia(f.project.id, entity.id, { file, kind: 'image', mime: 'image/png',
    sha256: digest(png), baseVersion: entity.currentVersion, metadata: { size: 1, width: 1, height: 1 } });
}

function videoInput(f, media) {
  return { projectId: f.project.id, entityId: f.project.shots[0].id, kind: 'video', referenceMediaIds: [media.id],
    videoConfig: { ...structuredClone(DEFAULT_VIDEO_CONFIG),
      referenceBindings: ['141', '142', '143'].map(nodeId => ({ nodeId, fieldName: 'image', mediaId: media.id })) } };
}

test('image uploads use a strict decimal 30 MB boundary while local audio/video keep 60 MiB', () => {
  assert.equal(IMAGE_UPLOAD_MAX_BYTES, 30_000_000);
  assert.equal(LOCAL_UPLOAD_MAX_BYTES, 60 * 1024 * 1024);
  assert.equal(mediaUploadProblem(IMAGE_UPLOAD_MAX_BYTES - 1, true), '');
  for (const size of [IMAGE_UPLOAD_MAX_BYTES, IMAGE_UPLOAD_MAX_BYTES + 1, 30 * 1024 * 1024]) {
    assert.match(mediaUploadProblem(size, true), /30,000,000/);
  }
  for (const kind of ['audio', 'video']) {
    assert.equal(mediaUploadProblem(IMAGE_UPLOAD_MAX_BYTES, kind === 'image'), '');
    assert.equal(mediaUploadProblem(LOCAL_UPLOAD_MAX_BYTES, kind === 'image'), '');
    assert.match(mediaUploadProblem(LOCAL_UPLOAD_MAX_BYTES + 1, kind === 'image'), /60 MB/);
  }
});

test('browser upload recognizes an uppercase PNG extension without a MIME type and rejects before reading', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const notices = [];
  let reads = 0, performs = 0, requests = 0;
  const context = { mediaUploadProblem, notify: (...args) => notices.push(args),
    perform: async work => { performs++; await work(); }, api: async () => { requests++; } };
  runInNewContext(app.slice(app.indexOf('async function uploadMedia('), app.indexOf('function renderVersions(')), context);
  await context.uploadMedia({ name: 'legacy.PNG', type: '', size: IMAGE_UPLOAD_MAX_BYTES,
    arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }, { id: 'asset' });
  assert.deepEqual([reads, performs, requests], [0, 0, 0]);
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /30,000,000/);
  assert.equal(notices[0][1], true);
});

test('real media validation rejects an oversized PNG before attempting to decode it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-validator-limit-'));
  try {
    const file = join(dataDir, 'oversized.png');
    await oversizedPng(file);
    await assert.rejects(validateMedia(file, 'image'), { status: 400, code: 'IMAGE_UPLOAD_LIMIT' });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP rejects an oversized image before writing media or a partial upload', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-http-media-limit-'));
  let networkCalls = 0;
  const studio = createStudio({ dataDir, importExample: false, forgeSeed: false,
    generationOptions: { getRunningHubKey: () => '', inspectCodexImpl: async () => ({}),
      fetchImpl: () => { networkCalls++; throw new Error('unexpected provider request'); } } });
  const project = studio.store.importMarkdown(source, 'fixture.md');
  const entity = project.assets[0];
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { csrfToken } = await (await fetch(`${base}/api/state`)).json();
    const filesBefore = await readdir(dataDir, { recursive: true });
    const bytes = Buffer.alloc(IMAGE_UPLOAD_MAX_BYTES);
    png.copy(bytes);
    const response = await fetch(`${base}/api/media-upload`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': csrfToken },
      body: JSON.stringify({ projectId: project.id, entityId: entity.id, baseVersion: entity.currentVersion,
        filename: 'oversized.png', contentBase64: bytes.toString('base64') }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /30,000,000/);
    assert.deepEqual(studio.store.getEntity(project.id, entity.id).media, []);
    const filesAfter = await readdir(dataDir, { recursive: true });
    assert.deepEqual(filesAfter.sort(), filesBefore.sort());
    assert.equal(filesAfter.some(file => file.endsWith('.part')), false);
    assert.equal(networkCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('preparation checks legacy image bytes instead of trusting a small metadata.size', async () => {
  let networkCalls = 0;
  const f = await generationFixture(() => { networkCalls++; throw new Error('unexpected provider request'); });
  try {
    const media = await addReference(f, { oversized: true });
    assert.equal(media.metadata.size, 1);
    for (const kind of ['image', 'video']) {
      await assert.rejects(f.service.prepare({ ...videoInput(f, media), kind }),
        { status: 400, code: 'IMAGE_UPLOAD_LIMIT' });
    }
    assert.equal(networkCalls, 0);
    assert.equal(f.service.previews.size, 0);
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('new upload code 200 and lowercase filename bind the returned file without paid submission', async () => {
  let uploads = 0;
  const f = await generationFixture(async (url, options) => {
    assert.ok(String(url).endsWith('/media/upload/binary'));
    assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), png);
    uploads++;
    return Response.json({ code: 200, message: 'success', data: { filename: 'openapi/new-upload.png', download_url: 'https://example.invalid/reference.png' } });
  });
  try {
    const media = await addReference(f);
    const preview = await f.service.prepare(videoInput(f, media));
    assert.deepEqual(preview.blockers, []);
    assert.equal(uploads, 1);
    for (const nodeId of ['141', '142', '143']) {
      assert.equal(preview.request.nodeInfoList.find(node => node.nodeId === nodeId && node.fieldName === 'image').fieldValue, 'openapi/new-upload.png');
    }
    assert.equal(f.store.state().jobs.length, 0);
  } finally { await f.cleanup(); }
});

test('provider upload errors or missing filenames block paid submission', async t => {
  for (const response of [
    { name: 'provider error', value: { code: 400, message: 'rejected upload', data: { filename: 'openapi/do-not-use.png' } }, message: /rejected upload/ },
    { name: 'missing filename', value: { code: 200, data: {} }, message: /缺少文件标识/ },
  ]) {
    await t.test(response.name, async () => {
      let uploads = 0;
      const f = await generationFixture(async url => {
        assert.ok(String(url).endsWith('/media/upload/binary'));
        uploads++;
        return Response.json(response.value);
      });
      try {
        const media = await addReference(f);
        const preview = await f.service.prepare(videoInput(f, media));
        assert.ok(preview.blockers.some(blocker => response.message.test(blocker)));
        await assert.rejects(f.service.submit({ previewId: preview.id, operationId: `blocked-upload-${response.name.replaceAll(' ', '-')}` }), { status: 409 });
        assert.equal(uploads, 1);
        assert.equal(f.store.state().jobs.length, 0);
      } finally { await f.cleanup(); }
    });
  }
});
