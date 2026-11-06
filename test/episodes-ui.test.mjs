import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { storyboardShots, storyboardSummary, storyboardDuration } from '../public/storyboard.mjs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('state refresh selects a remaining episode when the selected episode has been removed', async () => {
  const context = { state: { project: { id: 'project_1' } }, currentEpisode: 1, selectedId: null, hasCustomVideoConfig: true,
    api: async () => ({ project: { id: 'project_1', episodes: [2], episodeNames: { 2: '第1集打标版' } } }) };
  runInNewContext(app.slice(app.indexOf('async function loadState('), app.indexOf('function resetSelection(')), context);
  await context.loadState(false);
  assert.equal(context.currentEpisode, 2);
  context.currentEpisode = 'all';
  await context.loadState(false);
  assert.equal(context.currentEpisode, 'all');
});

test('initial load chooses the highest episode number and refresh preserves a manual selection', async () => {
  const context = { state: { project: null }, currentEpisode: null, selectedId: null, hasCustomVideoConfig: true,
    api: async () => ({ project: { id: 'project_1', episodes: [3, 12, 1] } }) };
  runInNewContext(app.slice(app.indexOf('async function loadState('), app.indexOf('function resetSelection(')), context);
  await context.loadState(false);
  assert.equal(context.currentEpisode, 12);
  context.currentEpisode = 1;
  await context.loadState(false);
  assert.equal(context.currentEpisode, 1);
  context.currentEpisode = 7;
  await context.loadState(false);
  assert.equal(context.currentEpisode, 12);
});

const node = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(Boolean),
  append(...items) { this.children.push(...items.flat(Infinity)); }, replaceChildren(...items) { this.children = items; } });
const walk = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(walk)] : [];
const textOf = tree => tree && typeof tree === 'object' ? tree.children.map(textOf).join('') : String(tree);
function contextFor() {
  const context = { node, storyboardShots, storyboardSummary, storyboardDuration, currentEpisode: 2, search: '', view: 'shot', shotView: 'list', selectedId: null,
    text: value => typeof value === 'object' ? JSON.stringify(value) : value || '', displayMedia: () => null,
    button: (label, action, cls, attrs) => node('button', { ...attrs, onClick: action }, label),
    badge: label => node('span', {}, label), row: (...items) => node('div', {}, items),
    state: { project: { id: 'project_1', episodes: [1, 2], storyScenes: [],
      assets: [{ id: 'c', type: 'character', name: '共享角色', media: [], data: {} }],
      shots: [{ id: 's1', type: 'shot', name: '第一集镜头', code: '01-A', media: [], data: { episodeNumber: 1 } },
        { id: 's2', type: 'shot', name: '第二集镜头', code: '01-A', media: [], data: { episodeNumber: 2 } }],
      storyboards: [{ id: 'b1', type: 'storyboard', code: 'SB-1', name: '第一集组', media: [], data: { shotIds: ['s1'] } },
        { id: 'b2', type: 'storyboard', code: 'SB-2', name: '第二集组', media: [], data: { shotIds: ['s2'] } }] } },
    typeNames: { shot: '镜头' }, selected: () => null, dirty: false, requests: [],
    api: async (path, options) => { context.requests.push({ path, ...options }); return { project: context.state.project }; },
    resetSelection(id) { context.reset = id; }, loadState: async () => {}, notify: () => {}, modal: { open: false },
    openModal(title, body) { context.dialog = { title, body }; },
  };
  context.entities = () => [...context.state.project.assets, ...context.state.project.shots, ...context.state.project.storyboards];
  runInNewContext(app.slice(app.indexOf('function cjkNumber('), app.indexOf('// 集数 + 搜索词')), context);
  runInNewContext(app.slice(app.indexOf('function renderEntityList('), app.indexOf('/* —— 粗剪预览')), context);
  runInNewContext(app.slice(app.indexOf('async function importFile('), app.indexOf("$('#import-file').addEventListener")), context);
  return context;
}

test('shot and storyboard lists follow the same episode while assets remain shared', () => {
  const context = contextFor(), container = node('div');
  context.renderEntityList(container);
  assert.match(textOf(container), /第二集镜头/);
  assert.doesNotMatch(textOf(container), /第一集镜头/);
  context.shotView = 'boards';
  context.renderEntityList(container);
  assert.match(textOf(container), /第二集组/);
  assert.doesNotMatch(textOf(container), /第一集组/);
  context.view = 'character';
  context.currentEpisode = 3;
  context.renderEntityList(container);
  assert.match(textOf(container), /共享角色/);
  assert.deepEqual(context.requests, []);
});

test('legacy storyboard names retain visible member titles and searchable source content without rewriting data', () => {
  const context = contextFor(), container = node('div'), project = context.state.project;
  const board = project.storyboards[1];
  board.name = '多参考镜头';
  project.shots[1].name = '推门发现空屋';
  project.shots[1].data.action = '门边落着一张纸条';
  project.shots[1].data.dialogue = '甲：有人吗？';
  project.shots.push({ id: 's3', type: 'shot', code: '02-A', name: '', media: [], data: { episodeNumber: 2, action: '拾起纸条看清字迹' } });
  board.data.shotIds.push('s3');
  const before = JSON.stringify(project);
  context.shotView = 'boards';
  for (const search of ['', '推门发现空屋', '纸条', '有人吗', '02-A']) {
    context.search = search;
    context.renderEntityList(container);
    assert.match(textOf(container), /多参考镜头/);
    assert.match(textOf(container), /01-A · 推门发现空屋.*02-A · 拾起纸条看清字迹/);
    assert.doesNotMatch(textOf(container), /第一集镜头/);
  }
  context.search = '不存在的剧情';
  context.renderEntityList(container);
  assert.match(textOf(container), /没有符合筛选的故事板/);
  assert.equal(JSON.stringify(project), before);
  assert.deepEqual(context.requests, []);
});

test('storyboard member titles remain visible in every editor tab', () => {
  const context = contextFor(), board = context.state.project.storyboards[1], container = node('div');
  board.name = '多参考镜头';
  context.selected = () => board;
  context.adoptedId = () => null;
  context.renderEditForm = context.renderGeneration = context.renderMedia = context.renderVersions = () => {};
  runInNewContext(app.slice(app.indexOf('function renderEditor('), app.indexOf('function field(')), context);
  for (const tab of ['edit', 'generate', 'video', 'media', 'versions']) {
    context.editorTab = tab;
    context.renderEditor(container);
    const members = walk(container).find(item => item.attrs['aria-label'] === '组内镜头');
    assert.match(textOf(members), /01-A · 第二集镜头/);
    assert.match(textOf(container), /多参考镜头/);
  }
  assert.deepEqual(context.requests, []);
});

test('import destination lists saved episodes and sends the selected episode to append without rewriting the text', async () => {
  const context = contextFor();
  let reads = 0;
  const file = { name: '续集.md', size: 100, async text() { reads++; return '原稿全文'; } };
  await context.importFile(file);
  assert.equal(reads, 0);
  assert.equal(context.requests.length, 0);
  const options = walk(context.dialog.body).filter(item => item.tag === 'option');
  assert.deepEqual(options.map(textOf), ['作为新作品导入', '追加到当前作品 · 第1集', '追加到当前作品 · 第2集']);
  assert.equal(options[2].attrs.selected, true);
  await context.importFile(file, false, '2');
  assert.equal(reads, 1);
  assert.equal(context.requests[0].path, '/api/projects/project_1/append-import');
  assert.deepEqual(JSON.parse(JSON.stringify(context.requests[0].body)), { text: '原稿全文', filename: '续集.md', asNewProject: false, episodeNumber: 2 });
  assert.equal(context.currentEpisode, 2);
  assert.equal(context.view, 'shot');
});

test('custom episode names appear in shared pickers and import destinations while values stay numeric', async () => {
  const context = contextFor();
  context.state.project.episodeNames = { 2: '第1集自分镜版' };
  const options = walk(context.episodePicker('选择集数')).filter(item => item.tag === 'option');
  assert.deepEqual(options.map(textOf), ['全部集数', '第1集', '第1集自分镜版']);
  assert.equal(options[2].attrs.value, '2');
  await context.importFile({ name: '分镜.md', size: 100, async text() { return '分镜全文'; } });
  assert.deepEqual(walk(context.dialog.body).filter(item => item.tag === 'option').map(textOf),
    ['作为新作品导入', '追加到当前作品 · 第1集', '追加到当前作品 · 第1集自分镜版']);
  context.showAddEpisode();
  assert.ok(walk(context.dialog.body).some(item => item.attrs['aria-label'] === '新增集数名称'));
});
