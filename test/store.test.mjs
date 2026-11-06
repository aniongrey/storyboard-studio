import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { StudioStore } from '../server/store.mjs';
import { parseMarkdown } from '../server/importer.mjs';

const filename = '奶油变心后_分镜提示词.md';
const text = readFileSync(new URL(`../examples/${filename}`, import.meta.url), 'utf8');
const fixture = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'storyboard-store-test-'));
  return { dataDir, store: new StudioStore({ dataDir }), cleanup() { this.store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
};

test('real source: 6 characters, 6 locations, 8 scenes, 45 shots, 160 seconds and original provenance', () => {
  const project = parseMarkdown(text, filename);
  assert.equal(project.assets.filter(a => a.type === 'character').length, 6);
  assert.equal(project.assets.filter(a => a.type === 'location').length, 6);
  assert.equal(project.assets.filter(a => a.type === 'prop').length, 14);
  assert.equal(project.storyScenes.length, 8);
  assert.equal(project.shots.length, 45);
  assert.equal(project.summaryDuration, 160);
  assert.equal(project.source.text, text);
  assert.equal(project.source.hash, 'CE671E9C0D45D4010FE8ACA8997398470D1249E82FCBE10944D5C41021263A8C');
  assert.equal(project.title, '奶油变心后，我爱上了红烧肉');
  assert.equal(project.shots.find(s => s.code === '27-B/E').data.locationIds.length, 2);
  assert.match(project.shots[0].data.videoPrompt, /^3D Pixar/);
  assert.equal(project.shots[0].data.duration, 4);
  assert.equal(project.shots[0].data.transition, '硬切');
  assert.ok(project.shots[0].data.action.includes('打烊前'));
  assert.ok(project.assets.every(a => a.sourceLines[0] >= 1 && a.raw));
  assert.ok(project.issues.some(i => i.detail.includes('31-C')));
  assert.ok(project.issues.some(i => i.title.includes('05-A')));
  assert.ok(project.issues.some(i => i.title.includes('时长')));
  assert.ok(project.issues.some(i => i.title.includes('爱心卡')));
  assert.throws(() => parseMarkdown('# 普通笔记\n无分镜。'), { status: 400 });
  const malformed = parseMarkdown('# 测试\n### 角色1：测试角色\n```json\nnull\n```');
  assert.equal(malformed.assets[0].name, '测试角色');
  assert.ok(malformed.issues.some(issue => issue.title.includes('JSON')));
});

test('edits persist, append versions, reject stale writes, and returned objects cannot mutate storage', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    assert.equal(readFileSync(join(f.dataDir, project.source.file), 'utf8'), text);
    const original = project.shots[0];
    const updated = f.store.updateEntity(project.id, original.id, { baseVersion: original.currentVersion, name: '新的镜头名', data: { duration: 7 } });
    assert.equal(updated.versions.length, 2);
    assert.equal(f.store.getProject().summaryDuration, 163);
    assert.throws(() => f.store.updateEntity(project.id, original.id, { baseVersion: original.currentVersion, data: { duration: 99 } }), { status: 409 });
    assert.throws(() => f.store.updateEntity(project.id, original.id, { baseVersion: updated.currentVersion, data: { locationIds: ['not-a-location'] } }), { status: 400 });
    updated.data.duration = 90;
    assert.equal(f.store.getEntity(project.id, original.id).data.duration, 7);
    f.store.updateProject(project.id, { title: '保存后的作品名', style: '新风格' });
    f.store.setIssue(project.id, project.issues[0].id, 'resolved');
    f.store.close();
    f.store = new StudioStore({ dataDir: f.dataDir });
    assert.equal(f.store.getProject().title, '保存后的作品名');
    assert.equal(f.store.getProject().versions.length, 2);
    assert.equal(f.store.getProject().issues[0].status, 'resolved');
    assert.equal(f.store.getEntity(project.id, original.id).name, '新的镜头名');
    assert.equal(f.store.getEntity(project.id, original.id).versions[0].data.duration, 4);
  } finally { f.cleanup(); }
});

test('unchanged reads reuse the parsed document and own writes keep the updated cache', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    f.store.read();
    const cached = f.store.document;
    f.store.getProject(project.id);
    f.store.getEntity(project.id, project.shots[0].id);
    f.store.state(project.id);
    assert.equal(f.store.document, cached);
    f.store.setPromptPreference('camera', true);
    const updated = f.store.document;
    assert.notEqual(updated, cached);
    assert.equal(f.store.state().promptPreferences.camera, true);
    assert.equal(f.store.document, updated);
  } finally { f.cleanup(); }
});

test('external writes invalidate reads and survive the next local write and a failed transaction', () => {
  const f = fixture();
  let other;
  try {
    const project = f.store.importMarkdown(text, filename), shot = project.shots[0];
    f.store.read();
    const cached = f.store.document;
    other = new StudioStore({ dataDir: f.dataDir });
    other.updateProject(project.id, { title: '另一连接的标题' });
    assert.equal(f.store.getProject(project.id).title, '另一连接的标题');
    assert.notEqual(f.store.document, cached);
    other.updateEntity(project.id, shot.id, { baseVersion: shot.currentVersion, name: '另一连接的镜头' });
    f.store.setPromptPreference('camera', true);
    assert.equal(other.getEntity(project.id, shot.id).name, '另一连接的镜头');
    assert.equal(other.getProject(project.id).title, '另一连接的标题');
    assert.equal(other.state().promptPreferences.camera, true);
    const beforeFailure = f.store.document;
    assert.throws(() => f.store.change(() => {
      f.store.document.projects[0].title = '不应保存的标题';
      f.store.document.promptPreferences.camera = false;
      throw new Error('测试事务失败');
    }), /测试事务失败/);
    assert.equal(f.store.document, beforeFailure);
    assert.equal(f.store.getProject(project.id).title, '另一连接的标题');
    assert.equal(f.store.getEntity(project.id, shot.id).name, '另一连接的镜头');
    assert.equal(f.store.state().promptPreferences.camera, true);
    assert.equal(other.getProject(project.id).title, '另一连接的标题');
  } finally { other?.close(); f.cleanup(); }
});

test('reimport deduplicates by hash, changed source needs an explicit new project and keeps edits', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    const original = project.shots[0];
    f.store.updateEntity(project.id, original.id, { baseVersion: original.currentVersion, name: '保留人工修改' });
    assert.equal(f.store.importMarkdown(text, 'renamed.md').id, project.id);
    assert.equal(f.store.state().projects.length, 1);
    const changed = text.replace('擦掉嘴角奶油', '擦掉嘴角奶油（修订）');
    assert.throws(() => f.store.importMarkdown(changed, filename), error => error.status === 409 && error.code === 'IMPORT_CHANGED' && error.comparison.changed.includes('01-A'));
    assert.equal(f.store.getEntity(project.id, original.id).name, '保留人工修改');
    const independent = f.store.importMarkdown(changed, filename, { asNewProject: true });
    assert.notEqual(independent.id, project.id);
    assert.equal(f.store.state().projects.length, 2);
    assert.equal(f.store.getProject(project.id).source.text, text);
  } finally { f.cleanup(); }
});

test('media are candidates, explicit adoption and jobs survive restart with all prior versions', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    const entity = project.assets[0];
    const mediaInput = { id: 'media_test', file: 'projects/test/image.png', sha256: 'a'.repeat(64), kind: 'image', mime: 'image/png', baseVersion: entity.currentVersion, prompt: '测试图', jobId: 'job_test', metadata: { width: 512 } };
    const media = f.store.addMedia(project.id, entity.id, mediaInput);
    assert.equal(f.store.getEntity(project.id, entity.id).adoptedMediaId, null);
    assert.equal(f.store.addMedia(project.id, entity.id, mediaInput).id, media.id);
    assert.equal(f.store.getEntity(project.id, entity.id).media.length, 1);
    assert.throws(() => f.store.addMedia(project.id, entity.id, { ...mediaInput, id: 'bad', file: '../outside.png' }), { status: 400 });
    const video = f.store.addMedia(project.id, entity.id, { ...mediaInput, id: 'media_video', file: 'projects/test/video.mp4', kind: 'video', mime: 'video/mp4' });
    f.store.adopt(project.id, entity.id, media.id);
    f.store.updateEntity(project.id, entity.id, { baseVersion: entity.currentVersion, data: { description: '新描述' } });
    const job = f.store.createJob({ id: 'job_test', projectId: project.id, entityId: entity.id, kind: 'image', status: 'waiting', snapshot: { prompt: '测试图' } });
    f.store.updateJob(job.id, { status: 'completed', outputs: [media.id], taskId: 'remote_task', log: ['已登记'] });
    f.store.close();
    f.store = new StudioStore({ dataDir: f.dataDir });
    assert.equal(f.store.getEntity(project.id, entity.id).media.length, 2);
    assert.equal(f.store.getEntity(project.id, entity.id).adoptedMediaId, media.id);
    assert.equal(f.store.getMedia(video.id).project.id, project.id);
    assert.equal(f.store.getJob(job.id).taskId, 'remote_task');
    assert.deepEqual(f.store.getJob(job.id).outputs, [media.id]);
    assert.equal(f.store.state().jobs.length, 1);
  } finally { f.cleanup(); }
});

test('reordering atomically saves both revisions and project settings reject stale base versions', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    const [first, second] = project.shots;
    const moved = f.store.reorderShot(project.id, first.id, 'down', first.currentVersion);
    assert.equal(moved.shots.find(shot => shot.id === first.id).order, 1);
    assert.equal(moved.shots.find(shot => shot.id === second.id).order, 0);
    assert.equal(moved.shots.find(shot => shot.id === second.id).versions.length, 2);
    assert.equal(moved.shots.find(shot => shot.id === first.id).versions.at(-1).order, 1);
    assert.equal(moved.summaryDuration, 160);
    assert.throws(() => f.store.reorderShot(project.id, first.id, 'down', first.currentVersion), { status: 409 });
    const settingBase = project.versions.at(-1).id;
    f.store.updateProject(project.id, { baseVersion: settingBase, title: '新标题' });
    assert.throws(() => f.store.updateProject(project.id, { baseVersion: settingBase, title: '旧页面覆盖' }), { status: 409 });
    assert.equal(f.store.getProject().title, '新标题');
  } finally { f.cleanup(); }
});

test('CLI imports are visible to an already running store without losing edits from another connection', () => {
  const f = fixture();
  let other;
  try {
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/import-md.mjs', import.meta.url)), '--data-dir', f.dataDir, fileURLToPath(new URL(`../examples/${filename}`, import.meta.url))], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).shots, 45);
    assert.equal(JSON.parse(cli.stdout).agentInstructions.file, 'AGENTS.md');
    assert.match(JSON.parse(cli.stdout).agentInstructions.text, /最多3个不同的实际说话角色/);
    const project = f.store.getProject();
    assert.equal(f.store.state().projects.length, 1);
    other = new StudioStore({ dataDir: f.dataDir });
    const entity = project.shots[0];
    other.updateEntity(project.id, entity.id, { baseVersion: entity.currentVersion, name: '另一连接的修改' });
    assert.equal(f.store.getEntity(project.id, entity.id).name, '另一连接的修改');
    assert.throws(() => f.store.updateEntity(project.id, entity.id, { baseVersion: entity.currentVersion, name: '旧连接覆盖' }), { status: 409 });
    f.store.createJob({ projectId: project.id, entityId: entity.id, kind: 'image', operationId: 'extra-field', snapshot: {} });
    assert.equal(other.state().jobs[0].operationId, 'extra-field');
    assert.equal(other.getEntity(project.id, entity.id).name, '另一连接的修改');
  } finally { other?.close(); f.cleanup(); }
});

test('operation ID deduplication is durable and rejects a different preview without creating a second job', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    const input = { projectId: project.id, entityId: project.shots[0].id, kind: 'video', operationId: 'once-only', snapshot: { id: 'preview1', hash: 'abc', prompt: '最终提示词' } };
    const first = f.store.createJob(input);
    assert.equal(f.store.createJob(input).id, first.id);
    assert.throws(() => f.store.createJob({ ...input, snapshot: { id: 'preview2', hash: 'def' } }), { status: 409, code: 'OPERATION_CONFLICT' });
    assert.equal(f.store.state().jobs.length, 1);
    f.store.close();
    f.store = new StudioStore({ dataDir: f.dataDir });
    assert.equal(f.store.createJob(input).id, first.id);
    assert.equal(f.store.state().jobs.length, 1);
  } finally { f.cleanup(); }
});

test('a shot adopts image and video independently and older single-pointer databases migrate safely', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    const shot = project.shots[0];
    const image = f.store.addMedia(project.id, shot.id, { id: 'shot_frame', kind: 'image', file: 'frame.png', baseVersion: shot.currentVersion, sha256: '1'.repeat(64) });
    const video = f.store.addMedia(project.id, shot.id, { id: 'shot_video', kind: 'video', file: 'video.mp4', baseVersion: shot.currentVersion, sha256: '2'.repeat(64) });
    f.store.adopt(project.id, shot.id, image.id);
    f.store.adopt(project.id, shot.id, video.id);
    let adopted = f.store.getEntity(project.id, shot.id);
    assert.deepEqual(adopted.adoptedMediaIds, { image: image.id, video: video.id, audio: null });
    assert.equal(adopted.adoptedMediaId, video.id);
    f.store.close();
    f.store = new StudioStore({ dataDir: f.dataDir });
    assert.deepEqual(f.store.getEntity(project.id, shot.id).adoptedMediaIds, { image: image.id, video: video.id, audio: null });
    const legacy = JSON.parse(f.store.db.prepare('SELECT value FROM studio_state WHERE id=1').get().value);
    const legacyShot = legacy.projects[0].shots[0];
    delete legacyShot.adoptedMediaIds;
    legacyShot.adoptedMediaId = image.id;
    const migration = new StudioStore({ dataDir: f.dataDir });
    try { migration.db.prepare('UPDATE studio_state SET value=? WHERE id=1').run(JSON.stringify(legacy)); }
    finally { migration.close(); }
    adopted = f.store.getEntity(project.id, shot.id);
    assert.deepEqual(adopted.adoptedMediaIds, { image: image.id, video: null, audio: null });
    assert.equal(adopted.media.length, 2);
    f.store.adopt(project.id, shot.id, video.id);
    assert.deepEqual(f.store.getEntity(project.id, shot.id).adoptedMediaIds, { image: image.id, video: video.id, audio: null });
  } finally { f.cleanup(); }
});

test('single-video creation blocks concurrent and ambiguous tasks but operation retries return the first job', () => {
  const f = fixture();
  let other;
  try {
    const project = f.store.importMarkdown(text, filename);
    const input = { projectId: project.id, entityId: project.shots[0].id, kind: 'video', singleVideo: true, status: 'preparing', operationId: 'one-video', snapshot: { id: 'preview1', hash: 'abc' } };
    const first = f.store.createJob(input);
    other = new StudioStore({ dataDir: f.dataDir });
    assert.equal(other.createJob(input).id, first.id);
    for (const status of ['preparing', 'submitting', 'queued', 'running', 'downloading', 'query_failed', 'submission_unknown']) {
      f.store.updateJob(first.id, { status });
      assert.throws(() => other.createJob({ ...input, operationId: `other-${status}` }), { status: 409, code: 'ACTIVE_VIDEO_TASK' });
    }
    assert.equal(other.state().jobs.length, 1);
    f.store.updateJob(first.id, { status: 'ready' });
    assert.notEqual(other.createJob({ ...input, operationId: 'next-video' }).id, first.id);
  } finally { other?.close(); f.cleanup(); }
});

test('audio references remain independent adopted candidates and migrate from older adoption maps', () => {
  const f = fixture();
  try {
    const project = f.store.importMarkdown(text, filename);
    const character = project.assets.find(asset => asset.type === 'character');
    assert.deepEqual(character.adoptedMediaIds, { image: null, video: null, audio: null });
    const image = f.store.addMedia(project.id, character.id, { id: 'character_views', kind: 'image', mime: 'image/png', file: 'views.png', baseVersion: character.currentVersion, sha256: '1'.repeat(64) });
    const audioInput = { id: 'character_voice', kind: 'audio', mime: 'audio/wav', file: 'voice.wav', baseVersion: character.currentVersion, sha256: '2'.repeat(64), metadata: { originalFilename: '测试音色.wav', sampleRate: 24000 } };
    const audio = f.store.addMedia(project.id, character.id, audioInput);
    assert.equal(f.store.addMedia(project.id, character.id, audioInput).id, audio.id);
    assert.throws(() => f.store.addMedia(project.id, character.id, { ...audioInput, kind: 'image' }), { status: 409 });
    assert.equal(f.store.getEntity(project.id, character.id).adoptedMediaIds.audio, null);
    f.store.adopt(project.id, character.id, image.id);
    f.store.adopt(project.id, character.id, audio.id);
    assert.deepEqual(f.store.getEntity(project.id, character.id).adoptedMediaIds, { image: image.id, video: null, audio: audio.id });
    assert.equal(f.store.getMedia(audio.id).metadata.sampleRate, 24000);
    f.store.close();
    f.store = new StudioStore({ dataDir: f.dataDir });
    assert.deepEqual(f.store.getEntity(project.id, character.id).adoptedMediaIds, { image: image.id, video: null, audio: audio.id });
    const legacy = JSON.parse(f.store.db.prepare('SELECT value FROM studio_state WHERE id=1').get().value);
    const legacyCharacter = legacy.projects[0].assets.find(asset => asset.id === character.id);
    delete legacyCharacter.adoptedMediaIds.audio;
    const migration = new StudioStore({ dataDir: f.dataDir });
    try { migration.db.prepare('UPDATE studio_state SET value=? WHERE id=1').run(JSON.stringify(legacy)); }
    finally { migration.close(); }
    assert.deepEqual(f.store.getEntity(project.id, character.id).adoptedMediaIds, { image: image.id, video: null, audio: audio.id });
    f.store.adopt(project.id, character.id, image.id);
    assert.deepEqual(f.store.getEntity(project.id, character.id).adoptedMediaIds, { image: image.id, video: null, audio: audio.id });
    assert.equal(f.store.getEntity(project.id, character.id).media.length, 2);
  } finally { f.cleanup(); }
});


test('prompt checkboxes default off and save globally across projects, store connections and restarts', () => {
  const f=fixture();
  try {
    assert.deepEqual(f.store.state().promptPreferences,{});
    f.store.setPromptPreference('subject_definitions',true);
    const second=new StudioStore({dataDir:f.dataDir});
    assert.equal(second.state().promptPreferences.subject_definitions,true);
    second.setPromptPreference('camera',true);second.close();
    f.store.setPromptPreference('subject_definitions',false);
    assert.deepEqual(f.store.state().promptPreferences,{subject_definitions:false,camera:true});
    assert.throws(()=>f.store.setPromptPreference('invalid',true));
    assert.throws(()=>f.store.setPromptPreference('camera','true'));
  } finally {f.cleanup();}
});

const episode = (code, extra = '') => `# 连载测试
### 角色1：哥哥
\`\`\`json
{"name":"哥哥","visual_prompt":"哥哥形象"}
\`\`\`
### 场景A：家中客厅
\`\`\`json
{"name":"家中客厅","scene_heading":"温暖客厅"}
\`\`\`
${extra}
### 第一场：第${code === '01-A' ? 1 : 2}集
#### 镜头 ${code}｜牵手
- **时长**：4s
- **画面内容**：哥哥牵手。
- **台词**：哥哥：“别怕。”
- **AI视频提示词**：哥哥牵手。
`;
const episodeExtra = `### 角色2：居民
\`\`\`json
{"name":"居民","visual_prompt":"紧张的居民"}
\`\`\`
### 场景E：城市广场
\`\`\`json
{"name":"城市广场","scene_heading":"钟楼广场"}
\`\`\`
### 道具P15：简朴行李
\`\`\`json
{"name":"简朴行李","description":"小包袱","visual_prompt":"褪色布包袱"}
\`\`\`
`;
const secondEpisode = episode('02-A', episodeExtra) + `
#### 镜头 03-E｜离家
- **时长**：3s
- **画面内容**：哥哥带着简朴行李走过城市广场，居民围观。
- **台词**：居民：“走吧！”
- **AI视频提示词**：哥哥带着简朴行李离开。
`;

test('append imports reuse existing assets without altering edits, media, boards or original provenance and persist idempotently', () => {
  const f = fixture();
  try {
    const originalText = episode('01-A');
    const first = f.store.importMarkdown(originalText, '第一集.md');
    const brother = first.assets[0];
    const edited = f.store.updateEntity(first.id, brother.id, { baseVersion: brother.currentVersion, data: { description: '已确认的人物设定' } });
    const media = f.store.addMedia(first.id, brother.id, { id: 'brother_image', file: 'brother.png', sha256: 'a'.repeat(64), kind: 'image', baseVersion: edited.currentVersion });
    f.store.adopt(first.id, brother.id, media.id);
    f.store.createStoryboard(first.id, { name: '第一集故事板', shotIds: [first.shots[0].id] });
    const before = f.store.getProject(first.id);
    const appended = f.store.appendMarkdown(first.id, secondEpisode, '第二集.md');
    assert.equal(appended.id, first.id);
    assert.deepEqual(appended.source, before.source);
    assert.deepEqual(appended.assets.slice(0, before.assets.length), before.assets);
    assert.deepEqual(appended.shots.slice(0, before.shots.length), before.shots);
    assert.deepEqual(appended.storyScenes.slice(0, before.storyScenes.length), before.storyScenes);
    assert.deepEqual(appended.storyboards, before.storyboards);
    assert.deepEqual(appended.versions, before.versions);
    assert.equal(appended.assets.length, 5);
    assert.equal(appended.shots.length, 3);
    assert.deepEqual(appended.shots.map(shot => shot.order), [0, 1, 2]);
    assert.deepEqual(appended.storyScenes.map(scene => scene.order), [0, 1]);
    assert.equal(appended.summaryDuration, 11);
    assert.deepEqual(appended.shots[1].data.characterIds, [brother.id]);
    assert.deepEqual(appended.shots[1].data.locationIds, [before.assets[1].id]);
    const luggage = appended.assets.find(asset => asset.code === 'P15');
    assert.deepEqual(appended.shots[2].data.propIds, [luggage.id]);
    assert.equal(appended.shots[2].data.locationIds[0], appended.assets.find(asset => asset.code === 'E').id);
    assert.ok(appended.shots.slice(1).every(shot => shot.currentVersion && shot.versions.length === 1));
    const source = appended.appendedSources[0];
    assert.equal(source.text, secondEpisode);
    assert.equal(readFileSync(join(f.dataDir, source.file), 'utf8'), secondEpisode);
    assert.equal(readFileSync(join(f.dataDir, before.source.file), 'utf8'), originalText);
    assert.equal(source.agentInstructions.text, readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8'));
    assert.deepEqual(source.shotIds, appended.shots.slice(1).map(shot => shot.id));
    assert.deepEqual(f.store.appendMarkdown(first.id, secondEpisode, '不同文件名.md'), appended);
    assert.deepEqual(f.store.appendMarkdown(first.id, originalText, '第一集副本.md'), appended);
    f.store.close();
    f.store = new StudioStore({ dataDir: f.dataDir });
    assert.deepEqual(f.store.getProject(first.id), appended);
  } finally { f.cleanup(); }
});

test('append import rejects invalid inputs, duplicate codes and missing location definitions atomically', () => {
  const f = fixture();
  try {
    const first = f.store.importMarkdown(episode('01-A'), '第一集.md');
    const before = f.store.getProject(first.id);
    for (const [input, expected] of [
      [`${episode('01-A')}\n重复镜头`, /镜头编号重复/],
      [secondEpisode.replace('角色2：居民', '角色1：居民'), /资产编号重复/],
      [secondEpisode.replace('镜头 03-E', '镜头 03-F'), /缺少场景 F/],
      [secondEpisode + secondEpisode.slice(secondEpisode.indexOf('#### 镜头 03-E')), /镜头编号重复/],
      ['# 资产\n### 角色8：路人', /必须包含镜头/],
    ]) {
      assert.throws(() => f.store.appendMarkdown(first.id, input, '第二集.md'), expected);
      assert.deepEqual(f.store.getProject(first.id), before);
    }
    for (const [input, name] of [[null, 'x.md'], ['', 'x.md'], ['a'.repeat(2 * 1024 * 1024 + 1), 'x.md'], [secondEpisode, 'x.txt']]) {
      assert.throws(() => f.store.appendMarkdown(first.id, input, name), { status: 400 });
      assert.deepEqual(f.store.getProject(first.id), before);
    }
    assert.throws(() => f.store.appendMarkdown('missing', secondEpisode, 'x.md'), { status: 404 });
    const hash = createHash('sha256').update(secondEpisode).digest('hex').toUpperCase();
    const directory = join(f.dataDir, 'projects', first.id, 'imports', hash);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'original.md'), '不能覆盖的原有文件');
    assert.throws(() => f.store.appendMarkdown(first.id, secondEpisode, '第二集.md'), { status: 409 });
    assert.equal(readFileSync(join(directory, 'original.md'), 'utf8'), '不能覆盖的原有文件');
    assert.deepEqual(f.store.getProject(first.id), before);
  } finally { f.cleanup(); }
});

test('explicit prop JSON headings link shots and suppress duplicate inferred names or codes', () => {
  const project = parseMarkdown(secondEpisode, '第二集.md');
  const prop = project.assets.find(asset => asset.type === 'prop');
  assert.equal(prop.code, 'P15');
  assert.equal(prop.name, '简朴行李');
  assert.equal(prop.data.description, '小包袱');
  assert.equal(prop.data.visualPrompt, '褪色布包袱');
  assert.deepEqual(project.shots[1].data.propIds, [prop.id]);
  for (const heading of ['道具P16：手机', '道具P01：特别行李']) {
    const parsed = parseMarkdown(episode('01-A', `### ${heading}\n\`\`\`json\n{}\n\`\`\`\n`) + '\n手机出现在画面里。');
    assert.equal(parsed.assets.filter(asset => asset.type === 'prop').length, 1);
    assert.equal(parsed.assets.find(asset => asset.type === 'prop').raw.startsWith(`### ${heading}`), true);
  }
});

test('CLI appends to a live project idempotently and rejects conflicting or incomplete options', () => {
  const f = fixture();
  try {
    const first = f.store.importMarkdown(episode('01-A'), '第一集.md');
    const sourceFile = join(f.dataDir, '第二集.md');
    writeFileSync(sourceFile, secondEpisode);
    const script = fileURLToPath(new URL('../scripts/import-md.mjs', import.meta.url));
    const args = [script, sourceFile, '--data-dir', f.dataDir, '--append-to', first.id];
    for (let retry = 0; retry < 2; retry++) {
      const cli = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr);
      const output = JSON.parse(cli.stdout);
      assert.equal(output.id, first.id);
      assert.equal(output.shots, 3);
      assert.equal(output.props, 1);
      assert.equal(output.agentInstructions.file, 'AGENTS.md');
      assert.equal(f.store.getProject(first.id).appendedSources.length, 1);
    }
    const before = f.store.getProject(first.id);
    for (const options of [['--append-to'], ['--append-to', first.id, '--as-new-project']]) {
      const cli = spawnSync(process.execPath, [script, sourceFile, '--data-dir', f.dataDir, ...options], { encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /用法/);
      assert.deepEqual(f.store.getProject(first.id), before);
    }
    assert.equal(f.store.state().projects.length, 1);
  } finally { f.cleanup(); }
});
