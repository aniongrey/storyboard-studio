import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStudio } from '../server/main.mjs';
import { sniffMedia, validateMedia } from '../server/media.mjs';

test('HTTP: append import is CSRF protected, validates input, preserves source and deduplicates on retries', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-append-http-'));
  const studio = createStudio({ dataDir: temp, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = '# 连载\n### 场景A：家\n### 第一场：起点\n#### 镜头 01-A｜开场\n- **时长**：3s\n- **画面内容**：门打开。\n- **AI视频提示词**：门打开。';
  const incoming = source.replace('01-A', '02-A').replace('起点', '第二集');
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
    const imported = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ text: source, filename: '第一集.md' }) });
    const original = (await imported.json()).project;
    const url = `${base}/api/projects/${original.id}/append-import`;
    const body = JSON.stringify({ text: incoming, filename: '第二集.md' });
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body })).status, 403);
    for (const invalid of [{ text: incoming, filename: 'bad.txt' }, { text: null, filename: 'x.md' }, { text: 'a'.repeat(2 * 1024 * 1024 + 1), filename: 'x.md' }]) {
      assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(invalid) })).status, 400);
    }
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, 200, await response.clone().text());
    const project = (await response.json()).project;
    assert.equal(project.shots.length, 2);
    assert.equal(project.assets.length, 1);
    assert.deepEqual(project.source, original.source);
    assert.equal(await (await fetch(`${base}/api/source/${original.id}`)).text(), source);
    assert.equal(project.appendedSources[0].text, incoming);
    const retry = await fetch(url, { method: 'POST', headers, body });
    assert.deepEqual((await retry.json()).project, project);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: `${incoming}\n改动`, filename: '第二集.md' }) })).status, 409);
    assert.equal(studio.store.getProject(original.id).shots.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('HTTP: scene edits protect against stale titles and preserve other scenes, projects and media', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-scene-http-'));
  const studio = createStudio({ dataDir: temp, importExample: false, forgeSeed: false,
    generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = '# 场次编辑\n### 场景A：家\n### 第一场：旧标题\n原备注\n#### 镜头 01-A｜开场\n- **时长**：3s\n- **AI视频提示词**：门打开。\n### 第二场：保留\n#### 镜头 02-A｜后续\n- **时长**：3s\n- **AI视频提示词**：人走近。';
  try {
    const imported = studio.store.importMarkdown(source, '场次.md');
    const other = studio.store.importMarkdown(source.replace('# 场次编辑', '# 另一作品'), '另一作品.md');
    const shot = imported.shots[0];
    const media = studio.store.addMedia(imported.id, shot.id, { id: 'media_scene_fixture', file: 'fixture.mp4', kind: 'video', sha256: 'fixture', baseVersion: shot.currentVersion });
    studio.store.adopt(imported.id, shot.id, media.id);
    const original = studio.store.getProject(imported.id);
    const scene = original.storyScenes[0];
    const state = await (await fetch(`${base}/api/state`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
    const url = `${base}/api/scenes/${scene.id}`;
    const patch = { projectId: original.id, baseTitle: scene.title, title: '  第一场：999宝宝出生  ' };
    assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })).status, 403);
    assert.deepEqual(studio.store.getProject(original.id), original);
    let response = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    assert.equal(response.status, 200, await response.clone().text());
    let updated = (await response.json()).scene;
    assert.equal(updated.title, patch.title.trim());
    assert.equal(updated.notes, scene.notes);
    let after = studio.store.getProject(original.id);
    assert.deepEqual(after, { ...original, updatedAt: after.updatedAt, storyScenes: [updated, original.storyScenes[1]] });
    assert.ok(Date.parse(after.updatedAt) >= Date.parse(original.updatedAt));
    response = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'VERSION_CONFLICT');
    const currentPatch = { ...patch, baseTitle: updated.title, title: updated.title, notes: '开门后999个宝宝挤出来。' };
    response = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(currentPatch) });
    assert.equal(response.status, 200);
    updated = (await response.json()).scene;
    assert.equal(updated.notes, currentPatch.notes);
    after = studio.store.getProject(original.id);
    assert.equal((await fetch(`${base}/api/scenes/scene_missing`, { method: 'PATCH', headers, body: JSON.stringify(currentPatch) })).status, 404);
    assert.equal((await fetch(`${base}/api/scenes/${other.storyScenes[0].id}`, { method: 'PATCH', headers, body: JSON.stringify(currentPatch) })).status, 404);
    assert.equal((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ ...currentPatch, baseTitle: undefined }) })).status, 409);
    for (const invalid of [{ title: ' ' }, { title: 42 }, { title: '字'.repeat(201) }, { notes: null }, { notes: '字'.repeat(20001) }]) {
      assert.equal((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ ...currentPatch, ...invalid }) })).status, 400);
    }
    assert.deepEqual(studio.store.getProject(original.id), after);
    assert.deepEqual(studio.store.getProject(other.id), other);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('HTTP: source import, edits, CSRF, independent image/voice adoption, WAV range/export and disk persistence', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-http-'));
  const dataDir = path.join(temp, 'data');
  let studio = createStudio({ dataDir, generationOptions: { codexPath: path.join(temp, 'missing-codex.exe'), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.project.shots.length, 45);
    assert.equal(state.project.summaryDuration, 160);
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
    assert.deepEqual(state.promptPreferences,{});
    const prefResponse=await fetch(`${base}/api/settings/prompt-preferences`,{method:'PATCH',headers,body:JSON.stringify({id:'camera',enabled:true})});
    assert.equal(prefResponse.status,200);
    assert.equal((await prefResponse.json()).promptPreferences.camera,true);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).promptPreferences.camera,true);
    assert.equal((await fetch(`${base}/api/settings/prompt-preferences`,{method:'PATCH',headers,body:JSON.stringify({id:'bad',enabled:true})})).status,400);
    const projectId = state.project.id;
    const shot = state.project.shots[0];
    const patch = { projectId, baseVersion: shot.currentVersion, data: { duration: 5 } };
    let response = await fetch(`${base}/api/entities/${shot.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/entities/${shot.id}`, { method: 'PATCH', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify(patch) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/entities/${shot.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/entities/${shot.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    assert.equal(response.status, 409);
    state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.project.summaryDuration, 161);
    assert.equal(state.project.shots[0].versions.length, 2);
    assert.match(await (await fetch(`${base}/api/source/${projectId}`)).text(), /\*\*时长\*\*：4s/);

    const png = path.join(temp, 'fixture.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=16x16', '-frames:v', '1', png], { windowsHide: true });
    const bytes = await readFile(png);
    const asset = state.project.assets[0];
    response = await fetch(`${base}/api/media-upload`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityId: asset.id, baseVersion: asset.currentVersion, filename: 'fixture.png', contentBase64: bytes.toString('base64') }) });
    assert.equal(response.status, 200, await response.clone().text());
    const { media } = await response.json();
    assert.equal(studio.store.getEntity(projectId, asset.id).adoptedMediaId, null);
    response = await fetch(`${base}/api/media/${media.id}`, { headers: { Range: 'bytes=0-7' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 8);
    response = await fetch(`${base}/api/adopt`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityId: asset.id, mediaId: media.id }) });
    assert.equal(response.status, 200);
    assert.equal(studio.store.getEntity(projectId, asset.id).adoptedMediaId, media.id);
    const wav = path.join(temp, 'voice.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.2', '-ac', '2', wav], { windowsHide: true });
    const voiceBytes = await readFile(wav);
    response = await fetch(`${base}/api/media-upload`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityId: asset.id, baseVersion: asset.currentVersion, filename: '角色音色.wav', contentBase64: voiceBytes.toString('base64') }) });
    assert.equal(response.status, 200, await response.clone().text());
    const { media: voice } = await response.json();
    assert.equal(voice.kind, 'audio');
    assert.equal(voice.mime, 'audio/wav');
    assert.equal(voice.metadata.originalFilename, '角色音色.wav');
    assert.equal(voice.metadata.sampleRate, 44100);
    assert.equal(voice.metadata.channels, 2);
    assert.ok(voice.metadata.duration > 0);
    assert.equal(studio.store.getEntity(projectId, asset.id).adoptedMediaIds.audio, null);
    response = await fetch(`${base}/api/media/${voice.id}`, { headers: { Range: 'bytes=0-11' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), voiceBytes.subarray(0, 12));
    response = await fetch(`${base}/api/adopt`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityId: asset.id, mediaId: voice.id }) });
    assert.equal(response.status, 200);
    const adopted = studio.store.getEntity(projectId, asset.id).adoptedMediaIds;
    assert.equal(adopted.image, media.id);
    assert.equal(adopted.audio, voice.id);
    response = await fetch(`${base}/api/export/${projectId}`);
    const exported = (await response.json()).assets.find(item => item.id === asset.id);
    assert.equal(exported.adoptedByKind.image.id, media.id);
    assert.equal(exported.adoptedByKind.audio.id, voice.id);
    response = await fetch(`${base}/api/previews`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityId: asset.id, kind: 'image', referenceMediaIds: [] }) });
    assert.equal(response.status, 200, await response.clone().text());
    const { preview } = await response.json();
    assert.ok(preview.prompt.length > 30);
    assert.ok(preview.hash);
    await new Promise(resolve => server.close(resolve));
    studio.close();
    studio = createStudio({ dataDir, importExample: false, generationOptions: { codexPath: path.join(temp, 'missing-codex.exe'), getRunningHubKey: () => '' } });
    assert.equal(studio.store.getProject(projectId).summaryDuration, 161);
    assert.equal(studio.store.getEntity(projectId, asset.id).adoptedMediaIds.image, media.id);
    assert.equal(studio.store.getEntity(projectId, asset.id).adoptedMediaIds.audio, voice.id);
    assert.equal(studio.store.getEntity(projectId, asset.id).media.length, 2);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('media validation rejects a fake WAV and audio cannot masquerade as an image', async () => {
  const { writeFile } = await import('node:fs/promises');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-audio-'));
  try {
    const fake = path.join(temp, 'fake.wav');
    const header = Buffer.alloc(64);
    header.write('RIFF'); header.write('WAVE', 8);
    await writeFile(fake, header);
    await assert.rejects(validateMedia(fake, 'audio'), /无法完整解码/);
    const wav = path.join(temp, 'voice.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.1', wav], { windowsHide: true });
    await assert.rejects(validateMedia(wav, 'image'), /媒体类型与当前任务不一致/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('media validation rejects an incomplete image even with a PNG signature', async () => {
  const { writeFile } = await import('node:fs/promises');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-corrupt-'));
  try {
    const file = path.join(temp, 'bad.png');
    await writeFile(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64)]));
    await assert.rejects(validateMedia(file, 'image'), /无法完整解码/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('HTTP: visible video controls freeze the actual request and submit directly without a Codex Agent', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-video-controls-'));
  const calls = [];
  const studio = createStudio({ dataDir: path.join(temp, 'data'), generationOptions: {
    codexPath: path.join(temp, 'missing-codex.exe'), getRunningHubKey: () => 'mock-studio-key', pollIntervalMs: 1000000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
      if (String(url).endsWith('/media/upload/binary')) return Response.json({ code: 0, data: { fileName: 'openapi/selected-reference.png' } });
      if (String(url).includes('/run/ai-app/')) return Response.json({ taskId: '99900101', status: 'QUEUED' });
      throw new Error('Unexpected request');
    }
  } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const projectId = state.project.id, asset = state.project.assets[0], shot = state.project.shots[0];
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
    const png = path.join(temp, 'reference.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16', '-frames:v', '1', png], { windowsHide: true });
    let response = await fetch(`${base}/api/media-upload`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityId: asset.id,
      baseVersion: asset.currentVersion, filename: 'reference.png', contentBase64: (await readFile(png)).toString('base64') }) });
    assert.equal(response.status, 200, await response.clone().text());
    const { media } = await response.json();
    response = await fetch(`${base}/api/previews`, { method: 'POST', headers, body: JSON.stringify({ projectId, entityId: shot.id, kind: 'video',
      prompt: '一个横屏镜头，五秒，完整发送这段文字。', referenceMediaIds: [media.id],
      videoConfig: { duration: '5', aspectRatio: '16:9 (Widescreen)', outputResolution: '720p',
        referenceBindings: ['141', '142', '143'].map(nodeId => ({ nodeId, fieldName: 'image', mediaId: media.id })) } }) });
    assert.equal(response.status, 200, await response.clone().text());
    const { preview } = await response.json();
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.output.width, 1280); assert.equal(preview.output.height, 720);
    assert.equal(calls.filter(call => call.url.endsWith('/media/upload/binary')).length, 1);
    assert.equal(calls.filter(call => call.url.includes('/run/ai-app/')).length, 0);
    const jobBody = { previewId: preview.id, operationId: 'page-video-operation-123' };
    response = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify(jobBody) });
    assert.equal(response.status, 201, await response.clone().text());
    const { job } = await response.json();
    assert.equal(job.kind, 'video'); assert.equal(job.taskId, '99900101');
    const run = calls.find(call => call.url.includes('/run/ai-app/'));
    assert.deepEqual(run.body, preview.request);
    assert.equal(run.body.nodeInfoList.find(node => node.nodeId === '150').fieldValue, preview.prompt);
    assert.equal(run.body.nodeInfoList.find(node => node.nodeId === '115').fieldValue, '16:9 (Widescreen)');
    assert.equal(run.body.nodeInfoList.find(node => node.nodeId === '186').fieldValue, '5');
    assert.equal(job.snapshot.output.width, 1280);
    response = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify(jobBody) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).job.id, job.id);
    assert.equal(calls.filter(call => call.url.includes('/run/ai-app/')).length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve)); studio.close();
    await rm(temp, { recursive: true, force: true });
  }
});


test('MP3 binding validates tagged and untagged files, serves MPEG audio, and rejects fake audio', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-mp3-'));
  const studio = createStudio({ dataDir: path.join(temp, 'data'), generationOptions: { inspectCodexImpl: async () => ({}), getRunningHubKey: () => '' } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const asset = state.project.assets[0];
    for (const tagged of [true, false]) {
      const file = path.join(temp, `voice-${tagged}.mp3`);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.2', '-id3v2_version', tagged ? '3' : '0', file], { windowsHide: true });
      const bytes = await readFile(file);
      assert.equal(sniffMedia(bytes).mime, 'audio/mpeg');
      const response = await fetch(`${base}/api/media-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken }, body: JSON.stringify({ projectId: state.project.id, entityId: asset.id, baseVersion: asset.currentVersion, filename: 'voice.mp3', contentBase64: bytes.toString('base64') }) });
      assert.equal(response.status, 200, await response.clone().text());
      const { media } = await response.json();
      assert.equal(media.kind, 'audio');
      assert.equal(media.metadata.codec, 'mp3');
      assert.ok(media.file.endsWith('.mp3'));
      const playback = await fetch(`${base}/api/media/${media.id}`, { headers: { Range: 'bytes=0-11' } });
      assert.equal(playback.status, 206);
      assert.equal(playback.headers.get('content-type'), 'audio/mpeg');
      assert.deepEqual(Buffer.from(await playback.arrayBuffer()), bytes.subarray(0, 12));
    }
    const fake = path.join(temp, 'fake.mp3');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(fake, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]));
    await assert.rejects(validateMedia(fake, 'audio'), /无法完整解码/);
    assert.throws(() => sniffMedia(Buffer.from([255, 255, 255, 255])), /支持格式不符/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(temp, { recursive: true, force: true });
  }
});
