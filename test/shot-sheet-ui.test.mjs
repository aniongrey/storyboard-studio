import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sheetSource = app.slice(app.indexOf('function shotSheetRows('), app.indexOf('function renderWorkspace('));
const helpers = ['text', 'mediaUrl', 'adoptedId', 'adoptedMedia', 'sceneTitleOf', 'inCurrentEpisode']
  .map(name => app.match(new RegExp(`^function ${name}\\([^\\n]+$`, 'm'))[0]).join('\n');
const editorSource = app.slice(app.indexOf('function openShotEditor('), app.indexOf('function previewStage('));
const modalCloseSource = app.match(/^modal\.addEventListener\('close',.*shot-sheet-player.*$/m)[0];
const node = (tag, attrs = {}, ...children) => ({
  tag, attrs, children: children.flat(Infinity).filter(item => item != null && item !== false),
  value: attrs.value ?? '', paused: true, pauses: 0,
  append(...items) { this.children.push(...items.flat(Infinity).filter(item => item != null && item !== false)); },
  replaceChildren(...items) {
    assert.ok(items.every(item => !Array.isArray(item)), 'Pass spread nodes to native replaceChildren; arrays would become text');
    this.children = items;
  },
  pause() { this.paused = true; this.pauses++; },
});
const walk = tree => typeof tree === 'object' && tree ? [tree, ...tree.children.flatMap(walk)] : [];
const textOf = tree => typeof tree === 'object' && tree
  ? tree.textContent ?? tree.children.map(textOf).join('') : String(tree);
const find = (tree, predicate) => walk(tree).find(predicate);
const findButton = (tree, label) => find(tree, item => item.tag === 'button' && textOf(item) === label);
const rows = tree => walk(tree).filter(item => item.attrs['data-shot-id']);
const media = (id, kind) => ({ id, kind, sha256: `${id}-hash` });

function fixture() {
  const first = { id: 's1', type: 'shot', order: 1, code: '01-A', name: '推门',
    data: { sceneId: 'indoors', duration: 4, composition: '门框构图', action: '推门迎向晨光', dialogue: '甲：你好。', shotSize: '中景', camera: '缓慢推进', characterIds: ['c1'] },
    media: [media('i1', 'image'), media('v1', 'video'), media('new-i1', 'image'), media('new-v1', 'video')], adoptedMediaIds: { image: 'i1', video: 'v1' } };
  const empty = { id: 's2', type: 'shot', order: 2, code: '02-B', name: '等待',
    data: { sceneId: 'indoors', duration: 3, action: '望向窗外' },
    media: [media('candidate-image', 'image'), media('candidate-video', 'video')], adoptedMediaIds: {} };
  const legacy = { id: 's3', type: 'shot', order: 3, code: '03-C', name: '告别',
    data: { sceneId: 'outdoors', duration: 6, dialogue: '明天见。' }, media: [media('legacy-image', 'image')], adoptedMediaId: 'legacy-image' };
  const stale = { id: 's4', type: 'shot', order: 4, code: '04-D', name: '留白', data: {},
    media: [media('unadopted-image', 'image')], adoptedMediaIds: { image: 'missing-image' } };
  return { id: 'project_1', shots: [legacy, first, stale, empty],
    assets: [{ id: 'c1', type: 'character', name: '角色甲' }],
    storyScenes: [{ id: 'indoors', title: '第一场：室内' }, { id: 'outdoors', title: '第二场：街头' }],
    storyboards: [{ id: 'board', type: 'storyboard', data: { shotIds: ['s1', 's2', 's3', 's4'] }, media: [media('group-video', 'video')], adoptedMediaIds: { video: 'group-video' } }] };
}

function contextFor(project = fixture()) {
  const container = node('main'), modal = node('dialog');
  const modalListeners = new Map();
  const context = {
    node, json: JSON.stringify,
    button: (label, onClick, className, attrs) => node('button', { onClick, class: className, ...attrs }, label),
    badge: (label, tone) => node('span', { class: `badge ${tone || ''}` }, label),
    state: { project }, search: '', shotSheetScene: 'all', currentEpisode: 'all', drafts: new Map(),
    episodeNumber: shot => shot.data?.episodeNumber || 1,
    view: 'shot', shotView: 'table', selectedId: null, requests: [],
    api: async (...args) => { context.requests.push(args); return {}; },
    $: (selector, root = container) => find(root, item => item.attrs.id === selector.slice(1)),
    modal,
    openModal(title, body) { context.modalTitle = title; modal.replaceChildren(body); modal.open = true; },
    stopPreviewPlayback() { context.stops = (context.stops || 0) + 1; },
    resetSelection(id) { context.selectedId = id; },
    renderApp() { context.renders = (context.renders || 0) + 1; },
  };
  modal.addEventListener = (event, callback) => modalListeners.set(event, callback);
  modal.close = () => { context.closed = (context.closed || 0) + 1; modal.open = false; modalListeners.get('close')?.(); };
  runInNewContext(`${helpers}\n${sheetSource}\n${editorSource}\n${modalCloseSource}`, context);
  return { context, container, modal };
}

test('sheet keeps every shot in order, leaves the saved order unchanged and does not replace members with group media', () => {
  const project = fixture(), before = project.shots.map(shot => shot.id);
  const { context, container } = contextFor(project);
  context.renderShotSheet(container);
  assert.deepEqual(rows(container).map(row => row.attrs['data-shot-id']), ['s1', 's2', 's3', 's4']);
  assert.deepEqual(project.shots.map(shot => shot.id), before);
  assert.match(textOf(context.$('#shot-sheet-count')), /4 \/ 4 镜.*13 秒/);
  assert.doesNotMatch(textOf(container), /group-video/);
  assert.deepEqual(context.requests, []);
});

test('episode filtering limits sheet rows, counts and scene options, including an empty episode', () => {
  const project = fixture();
  project.shots.find(shot => shot.id === 's3').data.episodeNumber = 2;
  const { context, container } = contextFor(project);
  context.currentEpisode = 2;
  context.renderShotSheet(container);
  assert.deepEqual(rows(container).map(row => row.attrs['data-shot-id']), ['s3']);
  assert.match(textOf(context.$('#shot-sheet-count')), /1 \/ 1 镜.*6 秒/);
  const sceneOptions = walk(container).filter(item => item.tag === 'option').map(textOf);
  assert.deepEqual(sceneOptions, ['全部场次', '第二场：街头']);
  context.currentEpisode = 3;
  container.replaceChildren();
  context.renderShotSheet(container);
  assert.equal(rows(container).length, 0);
  assert.match(textOf(context.$('#shot-sheet-count')), /0 \/ 0 镜/);
  assert.match(textOf(container), /当前范围还没有镜头，请先导入分镜/);
  assert.deepEqual(context.requests, []);
});

test('sheet thumbnails and statuses use only adopted images/videos, including legacy adoption and missing IDs', () => {
  const { context, container } = contextFor();
  context.drafts.set('s1', {});
  context.renderShotSheet(container);
  const images = walk(container).filter(item => item.tag === 'img').map(image => image.attrs.src);
  assert.deepEqual(images, ['/api/media/i1?v=i1-hash', '/api/media/legacy-image?v=legacy-image-hash']);
  for (const id of ['s2', 's4']) {
    const row = rows(container).find(row => row.attrs['data-shot-id'] === id);
    assert.match(textOf(row), /尚未采用图片或视频/);
    assert.equal(findButton(row, '预览').attrs.disabled, true);
  }
  const first = rows(container)[0];
  for (const expected of ['已采用图片', '已采用视频', '门框构图', '推门迎向晨光', '甲：你好。', '中景', '缓慢推进', '角色甲', '有未保存草稿']) assert.ok(textOf(first).includes(expected));
  const legacy = context.state.project.shots.find(shot => shot.id === 's3');
  assert.equal(context.adoptedMedia(legacy, 'image').id, 'legacy-image');
  assert.equal(context.adoptedMedia(legacy, 'video'), null);
  assert.deepEqual(context.requests, []);
});

test('search and scene controls filter saved shot content together without rebuilding the search field', () => {
  const { context, container } = contextFor();
  context.renderShotSheet(container);
  const search = find(container, item => item.attrs['aria-label'] === '搜索分镜表');
  const scene = find(container, item => item.attrs['aria-label'] === '按场次筛选分镜表');
  search.attrs.onInput({ target: { value: '晨光' } });
  assert.deepEqual(rows(container).map(row => row.attrs['data-shot-id']), ['s1']);
  assert.equal(find(container, item => item.attrs['aria-label'] === '搜索分镜表'), search);
  search.attrs.onInput({ target: { value: '明天见' } });
  assert.deepEqual(rows(container).map(row => row.attrs['data-shot-id']), ['s3']);
  scene.attrs.onChange({ target: { value: 'indoors' } });
  assert.equal(rows(container).length, 0);
  assert.match(textOf(container), /没有符合筛选的镜头/);
  assert.match(textOf(context.$('#shot-sheet-count')), /0 \/ 4 镜/);
  search.attrs.onInput({ target: { value: '' } });
  assert.deepEqual(rows(container).map(row => row.attrs['data-shot-id']), ['s1', 's2']);
  scene.attrs.onChange({ target: { value: 'unassigned' } });
  assert.deepEqual(rows(container).map(row => row.attrs['data-shot-id']), ['s4']);
  scene.attrs.onChange({ target: { value: 'all' } });
  search.attrs.onInput({ target: { value: '  01-a  ' } });
  assert.deepEqual(rows(container).map(row => row.attrs['data-shot-id']), ['s1']);
  assert.deepEqual(context.requests, []);
});

test('empty projects retain the table and show an import hint, and obsolete scene filters reset', () => {
  const { context, container } = contextFor({ ...fixture(), shots: [] });
  context.shotSheetScene = 'missing';
  context.renderShotSheet(container);
  assert.equal(context.shotSheetScene, 'all');
  assert.ok(find(container, item => item.tag === 'table'));
  assert.match(textOf(container), /当前范围还没有镜头，请先导入分镜/);
  assert.match(textOf(context.$('#shot-sheet-count')), /0 \/ 0 镜/);
});

test('preview starts with adopted video, switches to image and visits every filtered shot including empty slots', () => {
  const { context, container, modal } = contextFor();
  context.renderShotSheet(container);
  findButton(rows(container)[0], '预览').attrs.onClick();
  const video = find(modal, item => item.tag === 'video');
  assert.equal(video.attrs.src, '/api/media/v1?v=v1-hash');
  assert.equal(video.attrs.controls, true);
  assert.equal(findButton(modal, '← 上一镜').attrs.disabled, true);
  findButton(modal, '采用图片').attrs.onClick();
  assert.equal(video.pauses, 1);
  assert.equal(find(modal, item => item.tag === 'img').attrs.src, '/api/media/i1?v=i1-hash');
  findButton(modal, '下一镜 →').attrs.onClick();
  assert.match(context.modalTitle, /02-B/);
  assert.match(textOf(modal), /本镜尚未采用图片或视频/);
  assert.equal(findButton(modal, '采用图片').attrs.disabled, true);
  assert.equal(findButton(modal, '采用视频').attrs.disabled, true);
  assert.equal(find(modal, item => item.tag === 'img' || item.tag === 'video'), undefined);
  findButton(modal, '下一镜 →').attrs.onClick();
  assert.equal(find(modal, item => item.tag === 'img').attrs.src, '/api/media/legacy-image?v=legacy-image-hash');
  findButton(modal, '下一镜 →').attrs.onClick();
  assert.match(context.modalTitle, /04-D/);
  assert.equal(findButton(modal, '下一镜 →').attrs.disabled, true);
  assert.deepEqual(context.requests, []);
});

test('preview navigation stays inside the current scene filter and missing shots do not open a different one', () => {
  const { context, modal } = contextFor();
  context.shotSheetScene = 'indoors';
  context.showShotSheetPreview('s1');
  findButton(modal, '下一镜 →').attrs.onClick();
  assert.match(context.modalTitle, /02-B/);
  assert.equal(findButton(modal, '下一镜 →').attrs.disabled, true);
  const title = context.modalTitle;
  context.showShotSheetPreview('s3');
  assert.equal(context.modalTitle, title);
  assert.deepEqual(context.requests, []);
});

test('closing the preview modal pauses its active player without changing the project or adoption', () => {
  const { context, modal } = contextFor();
  const before = JSON.stringify(context.state.project);
  context.showShotSheetPreview('s1');
  const video = find(modal, item => item.tag === 'video');
  video.paused = false;
  modal.close();
  assert.equal(video.paused, true);
  assert.equal(video.pauses, 1);
  assert.equal(modal.open, false);
  assert.equal(JSON.stringify(context.state.project), before);
  assert.deepEqual(context.requests, []);
  context.showShotSheetPreview('s2');
  assert.doesNotThrow(() => modal.close());
});

test('table and modal editing return to the existing shot editor without writing or adopting media', () => {
  const { context, container, modal } = contextFor();
  context.renderShotSheet(container);
  findButton(rows(container)[1], '编辑镜头').attrs.onClick();
  assert.equal(context.view, 'shot');
  assert.equal(context.shotView, 'list');
  assert.equal(context.selectedId, 's2');
  context.shotView = 'table';
  context.showShotSheetPreview('s1');
  const video = find(modal, item => item.tag === 'video');
  findButton(modal, '编辑本镜').attrs.onClick();
  assert.equal(video.pauses, 2);
  assert.equal(context.closed, 1);
  assert.equal(context.selectedId, 's1');
  assert.equal(context.shotView, 'list');
  assert.equal(context.renders, 2);
  assert.deepEqual(context.requests, []);
});
