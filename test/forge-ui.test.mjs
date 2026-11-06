import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizeProject, analyze } from '../server/forge.mjs';

const source = readFileSync(new URL('../public/forge.js', import.meta.url), 'utf8');
const walk = tree => typeof tree === 'object' && tree ? [tree, ...tree.children.flatMap(walk)] : [];
const matches = (item, selector) => {
  if (selector.startsWith('#')) return item.attrs.id === selector.slice(1);
  if (selector.startsWith('.')) return String(item.attrs.class || '').split(/\s+/).includes(selector.slice(1));
  const attribute = selector.match(/^(\w+)?\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (attribute) return (!attribute[1] || item.tag === attribute[1]) && attribute[2] in item.attrs && (attribute[3] === undefined || String(item.attrs[attribute[2]]) === attribute[3]);
  return item.tag === selector;
};

function element(tag, attrs = {}, ...children) {
  const listeners = new Map();
  return {
    tag, attrs, children: children.flat(Infinity).filter(item => item != null && item !== false),
    dataset: Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])),
    style: {}, value: attrs.value ?? '', checked: Boolean(attrs.checked), open: Boolean(attrs.open), scrollLeft: 0, scrollTop: 0,
    classList: { add() {}, remove() {} },
    get textContent() { return this.children.map(item => typeof item === 'object' ? item.textContent : String(item)).join(''); },
    set textContent(value) { this.children = [value]; },
    append(...items) { this.children.push(...items.flat(Infinity)); },
    replaceChildren(...items) { this.children = items.flat(Infinity); },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, callback) { listeners.set(type, callback); },
    fire(type, event = {}) {
      const callback = listeners.get(type) || Object.entries(this.attrs).find(([key]) => key.toLowerCase() === `on${type}`)?.[1];
      assert.equal(typeof callback, 'function', `Missing ${type} handler on ${this.tag}`);
      return callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return this.children.flatMap(walk).filter(item => matches(item, selector)); },
    scrollIntoView(options) { this.scrolled = options; },
  };
}

function setup({ saveResponse = response => response } = {}) {
  let project = normalizeProject({
    id: 'forge_ui_test', title: '界面测试剧本', episodeCount: 4,
    cast: [{ id: 'cast_a', name: '甲', desire: '找到钥匙' }, { id: 'cast_b', name: '乙', desire: '打开大门' }],
    locations: [{ id: 'loc_a', name: '门口' }],
    outcomes: [{ id: 'out_a', episode: 2, title: '打开大门', lock: 'hard', nodeId: 'node_b' }],
    nodes: [
      { id: 'node_a', title: '找到钥匙', episode: 1, actors: ['cast_a'], result: '甲拿到钥匙', knowledge: [{ characterId: 'cast_a', level: 'knows', subject: '钥匙位置', learnedAt: 'node_a' }] },
      { id: 'node_b', title: '打开大门', episode: 2, actors: ['cast_a'], outcomeId: 'out_a', preconditions: ['甲拿到钥匙'], result: '大门打开' },
    ],
  });
  const windowListeners = new Map(), calls = [], notifications = [];
  const container = element('main');
  const data = { projects: [project], project, analysis: analyze(project), llm: { configured: false } };
  const helpers = {
    getStudioState: () => ({ projects: [] }), notify(message) { notifications.push(message); }, copy() {}, openModal() {},
    async api(path, options) {
      calls.push({ path, options });
      assert.equal(options?.method, 'PATCH', 'UI navigation must not call a generation endpoint');
      project = normalizeProject(structuredClone(options.body), { id: project.id });
      return saveResponse({ project, analysis: analyze(project) });
    },
  };
  const forge = runInNewContext(`${source.replace(/^export /gm, '')}\n
    el = mockElement;
    ({ ui, focusEpisode, selectProject, get project() { return store.project; },
       mount(data, container, helpers) {
         store = data; root = container; ctx = helpers;
         ui.loaded = true; ui.selectedNodeId = data.project.nodes[0].id;
         ui.selectedOutcomeId = data.project.outcomes[0].id;
         render();
       } });`, {
    mockElement: element, document: { querySelector: () => null },
    window: { addEventListener: (type, callback) => windowListeners.set(type, callback) },
    crypto: { randomUUID: () => 'test-edge' },
  });
  forge.mount(data, container, helpers);
  const button = label => {
    const found = walk(container).find(item => item.tag === 'button' && item.textContent === label);
    assert.ok(found, `Missing visible button: ${label}`);
    return found;
  };
  const node = title => container.querySelectorAll('.forge-node').find(item => item.textContent.includes(title));
  return { forge, get project() { return project; }, container, button, node, calls, notifications, windowListeners };
}

test('forge UI: the real element helper creates SVG geometry in its namespace and ordinary HTML normally', () => {
  class DomNode {
    constructor(tag, namespaceURI) { this.tag = tag; this.namespaceURI = namespaceURI; this.children = []; this.attrs = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attrs[key] = value; }
  }
  const svgNamespace = 'http://www.w3.org/2000/svg', htmlNamespace = 'http://www.w3.org/1999/xhtml';
  const creation = [];
  const realEl = runInNewContext(`${source.replace(/^export /gm, '')}\nel;`, {
    Node: DomNode, window: { addEventListener() {} },
    document: {
      createElement(tag) { creation.push(['html', tag]); return new DomNode(tag, htmlNamespace); },
      createElementNS(namespace, tag) { creation.push(['svg', tag]); return new DomNode(tag, namespace); },
      createTextNode(text) { return Object.assign(new DomNode('#text', null), { textContent: text }); },
    },
  });
  const path = realEl('path', { d: 'M 0 0 L 10 10' });
  const marker = realEl('marker', { id: 'arrow' }, path);
  const defs = realEl('defs', {}, marker);
  const svg = realEl('svg', { viewBox: '0 0 10 10' }, defs);
  const html = realEl('div', {}, svg, '因果图');
  for (const item of [svg, defs, marker, path]) assert.equal(item.namespaceURI, svgNamespace);
  assert.equal(html.namespaceURI, htmlNamespace);
  assert.equal(html.children[0], svg);
  assert.equal(html.children[1].textContent, '因果图');
  assert.deepEqual(creation, [['svg', 'path'], ['svg', 'marker'], ['svg', 'defs'], ['svg', 'svg'], ['html', 'div']]);
});

test('forge UI: selecting an event opens editing and connecting survives workspace switches', async () => {
  const { forge, project, container, button, node, calls, windowListeners } = setup();
  assert.equal(forge.ui.libraryTab, 'outcomes');
  assert.equal(forge.ui.workspaceTab, 'graph');
  assert.equal(forge.ui.rightTab, 'inspector');
  node('打开大门').fire('keydown', { key: 'Enter' });
  assert.equal(forge.ui.selectedNodeId, 'node_b');
  assert.equal(forge.ui.rightTab, 'inspector');
  assert.match(container.querySelector('#forge-inspector').textContent, /打开大门/);
  button('从选中事件连线').fire('click');
  button('剧集时间轴').fire('click');
  assert.equal(forge.ui.connectFrom, 'node_b');
  button('因果图').fire('click');
  node('找到钥匙').fire('keydown', { key: 'Enter' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forge.ui.connectFrom, null);
  assert.equal(project.edges.length, 1);
  assert.equal(project.edges[0].from, 'node_b');
  assert.equal(project.edges[0].to, 'node_a');
  assert.equal(calls.length, 1);
  button('从选中事件连线').fire('click');
  windowListeners.get('keydown')({ key: 'Escape' });
  assert.equal(forge.ui.connectFrom, null);
});

test('forge UI: all workspaces remain reachable and choosing an episode returns to the graph editor', () => {
  const { forge, container, button, calls } = setup();
  button('人物与欲望').fire('click');
  assert.equal(forge.ui.libraryTab, 'cast');
  button('＋ 人物');
  button('目标与约束').fire('click');
  assert.equal(forge.ui.libraryTab, 'outcomes');
  button('＋ 固定结果');
  const tabs = [
    ['timeline', '剧集时间轴', '打开'], ['debts', '剧情债务', '＋ 剧情债务'],
    ['lab', '剧情实验室', '探索其他发展'], ['script', '分镜稿与导出', '预览剧本'],
    ['graph', '因果图', '＋ 事件'],
  ];
  for (const [key, label, action] of tabs) {
    button(label).fire('click');
    assert.equal(forge.ui.workspaceTab, key);
    button(action);
    for (const [, tabLabel] of tabs) button(tabLabel);
    for (const tabLabel of ['事件编辑', '校验', '人物状态', 'AI 助手']) button(tabLabel);
  }
  button('分镜稿与导出').fire('click');
  button('人物状态').fire('click');
  forge.focusEpisode(2);
  assert.equal(forge.ui.workspaceTab, 'graph');
  assert.equal(forge.ui.rightTab, 'inspector');
  assert.equal(forge.ui.selectedNodeId, 'node_b');
  assert.ok(container.querySelector('#forge-canvas-wrap'));
  assert.equal(calls.length, 0);
});

test('forge UI: character knowledge links to the editable record and expands its section', () => {
  const { forge, container, button, calls } = setup();
  button('人物状态').fire('click');
  assert.match(container.textContent, /钥匙位置/);
  button('编辑本集认知记录').fire('click');
  assert.equal(forge.ui.rightTab, 'inspector');
  const section = container.querySelector('[data-inspector-section="knowledge"]');
  assert.ok(section);
  assert.equal(section.open, true);
  assert.ok(section.scrolled);
  assert.match(section.textContent, /认知/);
  assert.equal(forge.ui.selectedNodeId, 'node_a');
  assert.equal(calls.length, 0);
});

test('forge UI: repeated actor edits and dialogue/knowledge additions and removals survive saved snapshots', async () => {
  const app = setup(), flush = () => new Promise(resolve => setImmediate(resolve));
  const selected = () => app.project.nodes.find(item => item.id === 'node_a');
  const field = label => walk(app.container).find(item => item.tag === 'label' && item.children[0] === label).querySelector('textarea');
  for (const [label, key, value] of [['事件目标（编剧希望实现什么）', 'goal', '拿到钥匙'], ['行动动机', 'motive', '必须救人'], ['事件目标（编剧希望实现什么）', 'goal', '悄悄拿到钥匙']]) {
    const input = field(label); input.value = value; input.fire('change'); await flush();
    assert.equal(selected()[key], value);
  }
  const actors = app.container.querySelector('.forge-actors').querySelectorAll('.check-chip');
  for (const [index, checked, expected] of [[0, false, []], [1, true, ['cast_b']], [0, true, ['cast_b', 'cast_a']], [1, false, ['cast_a']]]) {
    const checkbox = actors[index].querySelector('input');
    checkbox.checked = checked;
    checkbox.fire('change');
    await flush();
    assert.deepEqual(selected().actors, expected);
  }
  const open = key => {
    const section = app.container.querySelector(`[data-inspector-section="${key}"]`);
    section.open = true; section.fire('toggle');
  };
  open('dialogue');
  app.button('＋ 台词').fire('click'); await flush();
  assert.equal(selected().dialogue.length, 1);
  const row = app.container.querySelector('.dialogue-row');
  const speaker = row.querySelector('[aria-label="说话人"]');
  speaker.value = 'cast_b'; speaker.fire('change'); await flush();
  const text = row.querySelector('[aria-label="台词内容"]');
  text.value = '钥匙就在这里。'; text.fire('change'); await flush();
  assert.equal(selected().dialogue[0].characterId, 'cast_b');
  assert.equal(selected().dialogue[0].line, '钥匙就在这里。');
  app.button('＋ 台词').fire('click'); await flush();
  assert.equal(app.container.querySelectorAll('.dialogue-row').length, 2);
  app.container.querySelector('.dialogue-row').querySelector('[aria-label="删除这句台词"]').fire('click'); await flush();
  assert.equal(selected().dialogue.length, 1);
  assert.equal(app.container.querySelectorAll('.dialogue-row').length, 1);
  open('knowledge');
  app.button('＋ 认知记录').fire('click'); await flush();
  assert.equal(selected().knowledge.length, 2);
  assert.equal(app.container.querySelectorAll('.knowledge-row').length, 2);
  const record = app.container.querySelectorAll('.knowledge-row')[1];
  const character = record.querySelector('[aria-label="角色"]');
  character.value = 'cast_b'; character.fire('change'); await flush();
  const subject = record.querySelector('[aria-label="知道的对象或事实"]');
  subject.value = '门后的秘密'; subject.fire('change'); await flush();
  assert.equal(selected().knowledge[1].characterId, 'cast_b');
  assert.equal(selected().knowledge[1].subject, '门后的秘密');
  for (const remaining of [1, 0]) {
    app.container.querySelector('.knowledge-row').querySelector('[aria-label="删除认知记录"]').fire('click'); await flush();
    assert.equal(selected().knowledge.length, remaining);
    assert.equal(app.container.querySelectorAll('.knowledge-row').length, remaining);
  }
});

test('forge UI: edits made during an in-flight save reach the following saved snapshot', async () => {
  const responses = [], flush = () => new Promise(resolve => setImmediate(resolve));
  const app = setup({ saveResponse: response => new Promise(resolve => responses.push(() => resolve(response))) });
  const input = label => walk(app.container).find(item => item.tag === 'label' && item.children[0] === label).querySelector('textarea');
  const goal = input('事件目标（编剧希望实现什么）');
  goal.value = '趁守卫不在拿钥匙'; goal.fire('change');
  const motive = input('行动动机');
  motive.value = '不能让同伴等到天亮'; motive.fire('change');
  assert.equal(app.calls.length, 1);
  responses.shift()(); await flush();
  assert.equal(app.calls.length, 2);
  responses.shift()(); await flush();
  const saved = app.project.nodes.find(item => item.id === 'node_a');
  assert.equal(saved.goal, '趁守卫不在拿钥匙');
  assert.equal(saved.motive, '不能让同伴等到天亮');
});

test('forge UI: dragging after a field save persists the position shown on the existing card', async () => {
  const app = setup(), flush = () => new Promise(resolve => setImmediate(resolve));
  const card = app.node('找到钥匙');
  const goal = walk(app.container).find(item => item.tag === 'label' && item.children[0] === '事件目标（编剧希望实现什么）').querySelector('textarea');
  goal.value = '先找到钥匙'; goal.fire('change'); await flush();
  card.fire('pointerdown', { button: 0, clientX: 100, clientY: 100, target: { closest: () => null } });
  card.fire('pointermove', { clientX: 145, clientY: 140 });
  const position = { x: parseFloat(card.style.left), y: parseFloat(card.style.top) };
  card.fire('pointerup'); await flush();
  const saved = app.project.nodes.find(item => item.id === 'node_a');
  assert.equal(saved.goal, '先找到钥匙');
  assert.equal(saved.x, position.x);
  assert.equal(saved.y, position.y);
  assert.equal(app.calls.length, 2);
});

test('forge UI: project switching is blocked during saving without losing queued edits', async () => {
  const responses = [], flush = () => new Promise(resolve => setImmediate(resolve));
  const app = setup({ saveResponse: response => new Promise(resolve => responses.push(() => resolve(response))) });
  const input = label => walk(app.container).find(item => item.tag === 'label' && item.children[0] === label).querySelector('textarea');
  const goal = input('事件目标（编剧希望实现什么）');
  goal.value = '保存前的目标'; goal.fire('change');
  const motive = input('行动动机');
  motive.value = '保存期间补充的动机'; motive.fire('change');
  const projectId = app.forge.project.id;
  await app.forge.selectProject('forge_other_project');
  assert.equal(app.forge.project.id, projectId);
  assert.equal(app.calls.length, 1);
  assert.ok(app.notifications.some(message => /保存/.test(message)));
  responses.shift()(); await flush();
  responses.shift()(); await flush();
  assert.equal(app.forge.project.id, projectId);
  const saved = app.project.nodes.find(item => item.id === 'node_a');
  assert.equal(saved.goal, '保存前的目标');
  assert.equal(saved.motive, '保存期间补充的动机');
  assert.equal(app.forge.ui.dirty, false);
  assert.equal(app.calls.length, 2);
});
