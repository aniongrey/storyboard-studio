// 因果剧本工作台（StoryForge）。
// 设计口径：固定结果 → 倒推条件 → 生成因果事件 → 模拟人物选择 → 校验状态 → 拆分剧集 → 生成分镜。
// 前端不做语义判断：校验、影响分析、导出都在本机后端完成；这里只负责编辑、连线、呈现与采纳建议。

const LOCK_LABELS = { hard: '硬锁定', soft: '软锁定', open: '自由探索' };
const LOCK_TONE = { hard: 'bad', soft: 'warn', open: '' };
const EDGE_LABELS = { cause: '直接因果', requires: '必要前提', motive: '动机影响', payoff: '伏笔回收' };
const EDGE_COLORS = { cause: 'var(--accent)', requires: 'var(--muted)', motive: 'var(--ink)', payoff: 'var(--accent-hover)' };
const KNOW_LABELS = { knows: '知道全部', partial: '掌握部分', unaware: '尚不知情' };
const LEVEL_TONE = { error: 'bad', warn: 'warn', info: '' };
const AI_TASKS = [
  ['result-planner', '结果规划师', '从固定结果倒推三种因果方案'],
  ['causal-architect', '因果构造师', '在起点与终点之间补事件链'],
  ['character-simulator', '人物模拟器', '按人物已知信息推演行动'],
  ['script-reviewer', '剧情审查员', '检查动机、认知与因果漏洞'],
  ['lab-explore', '剧情实验室', '探索同一事件的三种发展'],
  ['storyboard-writer', '分镜编剧', '把事件链写成可导入的分镜稿'],
];

let ctx = null;
let root = null;
let store = { projects: [], project: null, analysis: null, llm: null };
let ui = {
  loaded: false,
  loading: false,
  selectedNodeId: null,
  selectedOutcomeId: null,
  libraryTab: 'outcomes',
  rightTab: 'inspector',
  workspaceTab: 'graph',
  inspectorSections: {},
  connectFrom: null,
  connectType: 'cause',
  targetOutcomeId: '',
  aiBusy: '',
  aiResult: null,
  aiError: null,
  exportText: '',
  exportStats: null,
  range: null,
  saving: false,
  pendingSave: false,
  dirty: false,
  scrollLeft: 0,
  fullscreen: false,
};

const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));
const linesOf = value => String(value || '').split('\n').map(item => item.trim()).filter(Boolean);

function el(tag, attrs = {}, ...children) {
  const element = ['svg', 'defs', 'marker', 'path'].includes(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') element.setAttribute('class', value);
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key.startsWith('aria-')) element.setAttribute(key, value === true ? 'true' : value === false ? 'false' : String(value));
    else if (['checked', 'disabled', 'hidden', 'selected', 'readOnly'].includes(key)) element[key] = !!value;
    else if (value === false) continue;
    else if (key === 'value') element.value = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
const btn = (label, onClick, className = '', attrs = {}) => el('button', { type: 'button', class: className, onClick, ...attrs }, label);
const badge = (label, tone = '') => el('span', { class: `badge ${tone}` }, label);
const row = (...children) => el('div', { class: 'row wrap' }, ...children);
const panel = (title, ...children) => el('section', { class: 'forge-panel' }, title ? el('div', { class: 'forge-panel-head' }, el('h3', {}, title)) : null, ...children);
const formatDate = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const nodeById = id => store.project?.nodes.find(node => node.id === id) || null;
const castById = id => store.project?.cast.find(item => item.id === id) || null;
const locationById = id => store.project?.locations.find(item => item.id === id) || null;
const castIdByName = name => store.project?.cast.find(item => item.name === name)?.id || '';
const outcomeOfNode = node => store.project?.outcomes.find(outcome => outcome.nodeId === node.id || outcome.id === node.outcomeId) || null;
const selectedNode = () => nodeById(ui.selectedNodeId);
const currentNodeIds = () => new Set((store.project?.nodes || []).map(node => node.id));

/* —— 载入与保存 —— */
export function renderForgeView(container, helpers) {
  ctx = helpers;
  root = container;
  if (!ui.loaded && !ui.loading) load();
  else render();
}

async function load(projectId) {
  ui.loading = true;
  try {
    const data = await ctx.api(`/api/forge/state${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
    store = { ...store, ...data };
    ui.loaded = true;
    ui.aiResult = null;
    ui.aiError = null;
    ui.exportText = '';
    ui.range = null;
    ui.error = null;
    ui.selectedNodeId = data.project?.nodes[0]?.id || null;
    ui.selectedOutcomeId = data.project?.outcomes[0]?.id || null;
    ui.targetOutcomeId = data.project?.outcomes.find(outcome => outcome.lock === 'hard')?.id || data.project?.outcomes[0]?.id || '';
    syncRange();
  } catch (error) {
    ui.loaded = true;
    ui.error = error;
  } finally {
    ui.loading = false;
    render();
  }
}

function syncRange() {
  if (!store.project) return;
  const last = Math.max(0, ...store.project.nodes.map(node => node.episode));
  if (!ui.range) ui.range = { from: 1, to: Math.min(store.project.episodeCount, last || 1) };
  ui.range.from = clamp(ui.range.from, 1, store.project.episodeCount);
  ui.range.to = clamp(ui.range.to, ui.range.from, store.project.episodeCount);
}

function payload() {
  const project = store.project;
  return {
    title: project.title, logline: project.logline, genre: project.genre, theme: project.theme, style: project.style,
    aspectRatio: project.aspectRatio, episodeCount: project.episodeCount, world: project.world,
    cast: project.cast, locations: project.locations, outcomes: project.outcomes, nodes: project.nodes,
    edges: project.edges, debts: project.debts, branches: project.branches, script: project.script,
  };
}

function markDirty() {
  ui.dirty = true;
  setStatus('有未保存的修改', 'warn');
}

function setStatus(message, tone = '') {
  const target = root?.querySelector('#forge-save-state');
  if (target) {
    target.textContent = message;
    target.dataset.tone = tone;
  }
}

let escapeBound = false;
function toggleFullscreen() {
  ui.fullscreen = !ui.fullscreen;
  // Esc 只在真正进过全屏后才挂监听：测试里的 document 是简化实现，没有 addEventListener。
  if (ui.fullscreen && !escapeBound && typeof document.addEventListener === 'function') {
    escapeBound = true;
    // 有弹窗时让原生对话框先处理自己的 Esc。
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !ui.fullscreen) return;
      if (document.querySelector?.('dialog[open]')) return;
      toggleFullscreen();
    });
  }
  document.body?.classList.toggle('forge-fullscreen', ui.fullscreen);
  render();
}

async function save({ rerender = true } = {}) {
  if (!store.project) return;
  if (ui.saving) { ui.pendingSave = true; return; }
  ui.saving = true;
  setStatus('正在保存…');
  const projectId = store.project.id;
  try {
    const result = await ctx.api(`/api/forge/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: payload() });
    if (store.project?.id !== projectId) return;
    // 有排队的编辑时保留最新内容，避免旧响应覆盖尚未发送的修改。
    store.project = ui.pendingSave ? { ...result.project, ...payload() } : result.project;
    store.analysis = result.analysis;
    ui.dirty = ui.pendingSave;
    setStatus(ui.pendingSave ? '正在保存…' : '已保存 · ' + formatDate(new Date()), ui.pendingSave ? '' : 'good');
    if (rerender && !ui.pendingSave) render();
  } catch (error) {
    setStatus('保存失败：' + error.message, 'bad');
    ctx.notify(error.message, true);
  } finally {
    ui.saving = false;
    if (ui.pendingSave) { ui.pendingSave = false; save({ rerender: true }); }
  }
}

/* —— 页面骨架 —— */
function render() {
  if (!root) return;
  document.body?.classList.toggle('forge-fullscreen', !!ui.fullscreen);
  if (ui.loading) {
    root.replaceChildren(el('div', { class: 'panel panel-pad' }, el('p', { class: 'muted' }, '正在打开因果剧本工作台…')));
    return;
  }
  if (ui.error) {
    root.replaceChildren(el('div', { class: 'panel panel-pad stack' },
      el('h2', {}, '因果剧本工作台没有载入'),
      el('p', { class: 'muted' }, ui.error.message),
      row(btn('重试', () => { ui.error = null; ui.loaded = false; load(); }, 'primary'))));
    return;
  }
  if (!store.project) {
    renderEmpty();
    return;
  }
  syncRange();
  const scroll = ui.scrollLeft;
  const scrollPositions = new Map([...root.querySelectorAll('[data-forge-scroll]')].map(element => [element.dataset.forgeScroll, { top: element.scrollTop, left: element.scrollLeft }]));
  root.replaceChildren(el('div', { class: 'forge-page forge-workbench' }, hero(), statsRow(), shell()));
  for (const element of root.querySelectorAll('[data-forge-scroll]')) {
    const previous = scrollPositions.get(element.dataset.forgeScroll);
    element.scrollTop = previous?.top || 0;
    element.scrollLeft = previous?.left || 0;
  }
  const wrap = root.querySelector('#forge-canvas-wrap');
  if (wrap) {
    wrap.scrollLeft = scroll || 0;
    wrap.addEventListener('scroll', () => { ui.scrollLeft = wrap.scrollLeft; });
  }
}

function renderEmpty() {
  const studioProjects = ctx.getStudioState()?.projects || [];
  root.replaceChildren(el('div', { class: 'forge-page forge-welcome' },
    el('div', { class: 'forge-hero' },
      el('div', { class: 'eyebrow' }, 'STORYFORGE / 因果剧本工作台'),
      el('h1', {}, '先定一个不能改的结果，再让事件自己长出来'),
      el('p', {}, '固定结果 → 倒推条件 → 生成因果事件 → 模拟人物选择 → 校验状态 → 拆分剧集 → 生成分镜。'),
      row(btn('＋ 新建剧本项目', createProjectModal, 'primary'), studioProjects.length ? btn('从现有分镜作品新建', createProjectModal) : null)),
    el('div', { class: 'forge-grid-2' },
      panel('它解决什么',
        el('ul', { class: 'forge-list' },
          el('li', {}, '可控性：已经决定第 19 集叶音离团，就校验每个前因是否真的通向它。'),
          el('li', {}, '创造性：只给结果，让模型给出利益、误会、两难三条不同的事件链。'),
          el('li', {}, '一致性：把客观事件和每个角色“什么时候知道了什么”分开记录。'),
          el('li', {}, '低成本：改一个事件，只重算受影响的局部，而不是重写 20 集。'))),
      panel('一条完整闭环',
        el('ol', { class: 'forge-list' },
          el('li', {}, '建立固定结果与人物欲望。'),
          el('li', {}, '在因果图上补事件、连四种因果。'),
          el('li', {}, '运行确定性校验，或请模型做剧情审查。'),
          el('li', {}, '拆集、生成分镜稿，发布成可制作的分镜作品。'))))));
}

function hero() {
  const project = store.project;
  const projects = store.projects || [];
  const llm = store.llm || {};
  const configured = llm.configured;
  return el('div', { class: 'forge-hero' },
    el('div', { class: 'forge-hero-top' },
      el('div', { class: 'grow forge-heading' },
        el('div', { class: 'eyebrow' }, 'STORYFORGE / 因果剧本'),
        el('h1', {}, project.title),
        el('p', { title: project.logline }, project.logline || '固定结果，倒推前因，把故事写成可追溯的事件链。')),
      el('div', { class: 'forge-hero-actions' },
        el('span', { class: 'forge-save-state', id: 'forge-save-state', 'data-tone': ui.dirty ? 'warn' : 'good', role: 'status' }, ui.dirty ? '有未保存的修改' : '已保存'),
        btn('项目设定', projectSettingsModal, 'quiet small'),
        btn('LLM 设置', llmModal, 'quiet small'),
        btn('重新分析', () => analyzeNow(), 'small'),
        btn('导出并发布', () => exportModal(true), 'primary'))),
    el('div', { class: 'forge-hero-meta' },
      el('label', { class: 'forge-project-switch' }, '切换剧本',
        el('select', { 'aria-label': '选择剧本项目', onChange: event => selectProject(event.target.value) },
          projects.map(item => el('option', { value: item.id, selected: item.id === project.id }, item.title)))),
      el('span', { class: 'forge-project-meta' }, `${project.genre || '未设类型'} · ${project.aspectRatio} · ${project.episodeCount} 集`),
      el('span', { class: 'forge-model-state', 'data-tone': configured ? 'good' : 'warn' }, configured ? `模型 · ${llm.settings?.model || '未设置'}` : '模型未配置 · 可用本地模板'),
      el('small', { class: 'forge-updated' }, `更新 ${formatDate(project.updatedAt)}`)),
    ui.connectFrom ? el('div', { class: 'forge-connect-hint' }, `连线模式：从「${nodeById(ui.connectFrom)?.title || '已选事件'}」出发，点击目标事件（${EDGE_LABELS[ui.connectType]}）。`, btn('取消', () => { ui.connectFrom = null; render(); }, 'quiet small'))
      : null);
}

function statsRow() {
  const stats = store.analysis?.stats || {};
  const cells = [
    ['事件', stats.nodes ?? 0, `${stats.edges ?? 0} 条因果`],
    ['固定结果', stats.outcomes ?? 0, `${stats.hardOutcomes ?? 0} 个硬锁定`],
    ['人物', stats.cast ?? 0, `${stats.locations ?? 0} 个场景`],
    ['剧情债务', stats.debtsOpen ?? 0, `共 ${stats.debts ?? 0} 项`],
    ['校验', `${stats.errors ?? 0} 错`, `${stats.warnings ?? 0} 提示`],
    ['覆盖', `${stats.coverage ?? 0}%`, '有事件的集数'],
  ];
  return el('div', { class: 'forge-stats', 'aria-label': '剧本概况' }, cells.map(([label, value, hint]) => el('div', { class: 'forge-stat' },
    el('span', { class: 'forge-stat-label' }, label),
    el('strong', {}, String(value)),
    el('small', {}, hint))));
}

function shell() {
  return el('div', { class: 'forge-shell' },
    el('aside', { class: 'forge-side forge-library', 'aria-label': '故事资料' },
      el('div', { class: 'forge-side-heading' }, el('span', { class: 'eyebrow' }, 'STORY LIBRARY'), el('h2', {}, '故事资料')),
      el('div', { class: 'forge-tabs', 'aria-label': '资料分类' },
        [['outcomes', '目标与约束'], ['cast', '人物与欲望']].map(([key, label]) => btn(label, () => { ui.libraryTab = key; render(); }, ui.libraryTab === key ? 'active' : '', { 'aria-pressed': ui.libraryTab === key }))),
      el('div', { class: 'forge-side-content', 'data-forge-scroll': `library-${ui.libraryTab}` }, ui.libraryTab === 'outcomes' ? outcomesPanel() : castPanel())),
    el('section', { class: 'forge-main', 'aria-label': '剧本工作区' }, workspacePanel()),
    el('aside', { class: 'forge-side forge-details', 'aria-label': '事件与辅助工具' }, rightPanel()));
}

/* —— 左：固定结果与人物 —— */
function outcomesPanel() {
  const project = store.project;
  const outcomes = [...project.outcomes].sort((left, right) => left.episode - right.episode);
  return panel('目标与约束',
    el('p', { class: 'forge-hint' }, '硬锁定不允许改；软锁定可以前后微调；自由探索只记录方向。'),
    el('div', { class: 'forge-stack' }, outcomes.map(outcome => {
      const node = nodeById(outcome.nodeId);
      return el('button', {
        type: 'button', class: `outcome-card lock-${outcome.lock}`, 'aria-pressed': outcome.id === ui.selectedOutcomeId,
        onClick: () => { ui.selectedOutcomeId = outcome.id; render(); },
        onDblClick: () => outcomeModal(outcome),
      },
        el('div', { class: 'row between' },
          el('strong', {}, `第 ${outcome.episode} 集`),
          badge(LOCK_LABELS[outcome.lock], LOCK_TONE[outcome.lock])),
        el('span', { class: 'outcome-title' }, outcome.title),
        el('small', {}, node ? `→ ${node.title}` : '还没有对应事件'),
        outcome.detail ? el('small', { class: 'outcome-detail' }, outcome.detail) : null);
    })),
    row(btn('＋ 固定结果', () => outcomeModal(null), 'small'), btn('编辑选中', () => outcomeModal(project.outcomes.find(item => item.id === ui.selectedOutcomeId)), 'quiet small', { disabled: !ui.selectedOutcomeId })));
}

function castPanel() {
  const project = store.project;
  return panel('人物与欲望',
    el('div', { class: 'forge-stack' }, project.cast.map(item => el('button', {
      type: 'button', class: 'cast-card',
      onClick: () => castModal(item),
    },
      el('div', { class: 'row between' }, el('strong', {}, item.name), el('small', {}, item.faction || item.role || '')),
      el('small', {}, `欲望：${item.desire || '未填写'}`),
      el('small', {}, `恐惧：${item.fear || '未填写'}`)))),
    row(btn('＋ 人物', () => castModal(null), 'small'),
      btn('从分镜作品带入', () => importCastModal(), 'quiet small', { disabled: !(ctx.getStudioState()?.projects || []).length })));
}

/* —— 中：因果图 —— */
function graphToolbar() {
  return el('div', { class: 'forge-toolbar' },
    btn('＋ 事件', () => nodeModal(null), 'primary small'),
    el('span', { class: 'forge-toolbar-label' }, '连线类型'),
    el('select', { 'aria-label': '连线类型', onChange: event => { ui.connectType = event.target.value; render(); } },
      Object.entries(EDGE_LABELS).map(([value, label]) => el('option', { value, selected: value === ui.connectType }, label))),
    ui.selectedNodeId ? btn(ui.connectFrom ? '取消连线' : '从选中事件连线', () => {
      if (ui.connectFrom) ui.connectFrom = null;
      else ui.connectFrom = ui.selectedNodeId;
      render();
    }, ui.connectFrom ? 'small active' : 'small') : null,
    el('span', { class: 'grow' }),
    btn('重新布局', () => { store.project.nodes.forEach(node => { node.x = null; node.y = null; }); save(); }, 'quiet small'));
}

function graphCanvas() {
  const project = store.project;
  if (!project.nodes.length) {
    return el('div', { class: 'forge-canvas-wrap', id: 'forge-canvas-wrap' },
      el('div', { class: 'forge-empty' },
        el('h3', {}, '因果图还是空的'),
        el('p', {}, '先放一个固定结果，或者直接创建第一个事件。'),
        row(btn('＋ 固定结果', () => outcomeModal(null), 'primary'), btn('＋ 事件', () => nodeModal(null)))));
  }
  const layout = positions();
  const canvas = el('div', { class: 'forge-canvas', style: `width:${layout.width}px;height:${layout.height}px` });
  const svg = el('svg', { class: 'forge-edges', width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}` },
    el('defs', {}, Object.entries(EDGE_COLORS).map(([type, color]) => el('marker', { id: `forge-arrow-${type}`, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
      el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color })))));
  for (const edge of project.edges) {
    const from = layout.map.get(edge.from);
    const to = layout.map.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.w, y1 = from.y + from.h / 2;
    const x2 = to.x, y2 = to.y + to.h / 2;
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.35);
    const path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    svg.append(
      el('path', { d: path, fill: 'none', stroke: EDGE_COLORS[edge.type], 'stroke-width': '1.8', 'marker-end': `url(#forge-arrow-${edge.type})`, opacity: '0.8' }),
      el('path', {
        d: path, fill: 'none', stroke: 'transparent', 'stroke-width': '14', class: 'forge-edge-hit',
        onClick: event => { event.stopPropagation(); edgeModal(edge); },
      }));
  }
  canvas.append(svg);
  // 集数表头：只标出有事件的集，跳过的集在角标里注明。
  let previousEpisode = 0;
  for (const [index, episode] of layout.episodes.entries()) {
    const x = layout.padX + index * (layout.nodeW + layout.gapX);
    const gap = previousEpisode ? episode - previousEpisode - 1 : episode - 1;
    previousEpisode = episode;
    const outcome = project.outcomes.find(item => item.episode === episode);
    canvas.append(el('div', { class: 'ep-head', style: `left:${x}px` },
      el('strong', {}, `第 ${String(episode).padStart(2, '0')} 集`),
      gap > 0 ? el('small', {}, `空 ${gap} 集`) : null,
      outcome ? el('span', { class: `badge ${LOCK_TONE[outcome.lock]}` }, outcome.title.slice(0, 10)) : null));
  }
  for (const node of project.nodes) {
    const position = layout.map.get(node.id);
    if (position) canvas.append(nodeCard(node, position));
  }
  if (ui.connectFrom) canvas.append(el('div', { class: 'forge-canvas-tip' }, '点击目标事件完成连线；按 Esc 取消。'));
  return el('div', { class: 'forge-canvas-wrap', id: 'forge-canvas-wrap' }, canvas);
}

function positions() {
  const project = store.project;
  const padX = 54, padTop = 64, nodeW = 196, nodeH = 98, gapX = 54, gapY = 18;
  const episodes = [...new Set(project.nodes.map(node => node.episode))].sort((left, right) => left - right);
  const groups = new Map(episodes.map(episode => [episode, []]));
  for (const node of project.nodes) groups.get(node.episode)?.push(node);
  const map = new Map();
  let rows = 1;
  for (const [index, episode] of episodes.entries()) {
    const items = groups.get(episode).sort((left, right) => left.order - right.order);
    items.forEach((node, rowIndex) => {
      map.set(node.id, {
        x: Number.isFinite(node.x) ? node.x : padX + index * (nodeW + gapX),
        y: Number.isFinite(node.y) ? node.y : padTop + rowIndex * (nodeH + gapY),
        w: nodeW, h: nodeH,
      });
    });
    rows = Math.max(rows, items.length);
  }
  const maxX = Math.max(0, ...[...map.values()].map(item => item.x + item.w));
  return {
    map, episodes, padX, nodeW, gapX,
    width: Math.max(padX * 2 + Math.max(1, episodes.length) * (nodeW + gapX) - gapX, maxX + padX),
    height: padTop + rows * (nodeH + gapY) + 34,
  };
}

function nodeCard(node, position) {
  const outcome = outcomeOfNode(node);
  const actors = node.actors.map(id => castById(id)?.name).filter(Boolean);
  const card = el('div', {
    class: `forge-node${outcome ? ' has-outcome' : ''}${node.status === 'confirmed' ? ' confirmed' : ''}`,
    style: `left:${position.x}px;top:${position.y}px;width:${position.w}px`,
    'aria-pressed': node.id === ui.selectedNodeId, 'data-node-id': node.id,
    role: 'button', tabindex: '0',
    onKeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleNodeClick(node); } },
  },
    el('div', { class: 'node-top' },
      el('span', { class: 'node-ep' }, `第${String(node.episode).padStart(2, '0')}集`),
      el('span', { class: 'node-dot', 'data-status': node.status }),
      outcome ? el('span', { class: 'node-goal' }, '结果') : null),
    el('h4', {}, node.title),
    el('p', {}, node.result || node.goal || node.action || '还没有写结果'),
    el('div', { class: 'node-foot' },
      el('small', {}, actors.slice(0, 3).join('、') || '无行动者'),
      el('small', {}, `${project_in(node.id)}`)));
  let drag = null;
  card.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button,input,a,select')) return;
    drag = { x: event.clientX, y: event.clientY, left: position.x, top: position.y, moved: false };
    card.setPointerCapture?.(event.pointerId);
  });
  card.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    card.style.left = `${drag.left + dx}px`;
    card.style.top = `${drag.top + dy}px`;
    const svg = root.querySelector('.forge-edges');
    if (svg) svg.style.opacity = '0.25';
  });
  card.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    const svg = root.querySelector('.forge-edges');
    if (svg) svg.style.opacity = '';
    if (moved) {
      const current = nodeById(node.id);
      current.x = Math.round(parseFloat(card.style.left));
      current.y = Math.round(parseFloat(card.style.top));
      ui.scrollLeft = root.querySelector('#forge-canvas-wrap')?.scrollLeft || 0;
      save({ rerender: false });
      render();
    } else handleNodeClick(node);
  });
  card.addEventListener('pointercancel', () => { drag = null; });
  return card;
}
const project_in = id => {
  const node = nodeById(id);
  const incoming = store.project.edges.filter(edge => edge.to === id).length;
  const outgoing = store.project.edges.filter(edge => edge.from === id).length;
  return `${incoming} 入 · ${outgoing} 出${node?.dialogue?.length ? ` · ${node.dialogue.length} 句台词` : ''}`;
};

function handleNodeClick(node) {
  if (ui.connectFrom) {
    if (ui.connectFrom === node.id) { ui.connectFrom = null; render(); return; }
    addEdge(ui.connectFrom, node.id, ui.connectType);
    ui.connectFrom = null;
    return;
  }
  ui.selectedNodeId = node.id;
  ui.rightTab = 'inspector';
  closeModal();
  render();
}

function addEdge(from, to, type) {
  const project = store.project;
  if (project.edges.some(edge => edge.from === from && edge.to === to && edge.type === type)) {
    ctx.notify('这条连线已经存在。', true);
    render();
    return;
  }
  if (project.edges.some(edge => edge.from === from && edge.to === to)) {
    ctx.notify('两个事件之间已有另一种连线；请先在画布上点掉旧线。', true);
    render();
    return;
  }
  project.edges.push({ id: `edge_${uid()}`, from, to, type, note: '' });
  ctx.notify(`已添加「${EDGE_LABELS[type]}」连线`);
  save();
}

function edgeModal(edge) {
  const typeSelect = el('select', {}, Object.entries(EDGE_LABELS).map(([value, label]) => el('option', { value, selected: value === edge.type }, label)));
  const note = el('input', { value: edge.note || '', placeholder: '为什么成立（可选）' });
  const modal = openForm('编辑因果连线',
    el('p', { class: 'muted' }, `${nodeById(edge.from)?.title || edge.from} → ${nodeById(edge.to)?.title || edge.to}`),
    el('label', { class: 'field' }, '连接类型', typeSelect),
    el('label', { class: 'field' }, '说明', note),
    row(el('span', { class: 'grow' }), btn('删除这条线', () => {
      store.project.edges = store.project.edges.filter(item => item.id !== edge.id);
      closeModal(); save();
    }, 'danger'), btn('保存', () => {
      edge.type = typeSelect.value;
      edge.note = note.value.trim();
      closeModal(); save();
    }, 'primary')));
  return modal;
}

/* —— 中：事件检查器 —— */
function inspectorDisclosure(key, title, hint, ...children) {
  return el('details', {
    class: 'inspector-disclosure', 'data-inspector-section': key, open: !!ui.inspectorSections[key],
    onToggle: event => { ui.inspectorSections[key] = event.target.open; },
  }, el('summary', {}, el('strong', {}, title), el('small', {}, hint)), el('div', { class: 'inspector-section-body' }, ...children));
}

function inspectorPanel() {
  const node = selectedNode();
  if (!node) {
    return el('section', { class: 'forge-panel forge-inspector' },
      el('p', { class: 'muted' }, '在因果图上选择一个事件，编辑它的目标、前置条件、行动者、动机、直接结果、状态变化、伏笔与台词。'),
      row(btn('＋ 新建事件', () => nodeModal(null), 'primary small')));
  }
  const outcome = outcomeOfNode(node);
  const commit = (patch, rerender = false) => {
    Object.assign(node, patch);
    // 保存返回新对象；连续输入仍需写入当前项目里的事件。
    const current = nodeById(node.id);
    Object.assign(current, patch);
    if ('episode' in patch) { node.x = current.x = null; node.y = current.y = null; }
    markDirty();
    // 只有改动会影响整页布局（集数、标题）时才重绘，避免输入框失焦后点击被吞掉。
    save({ rerender: rerender || 'episode' in patch || 'title' in patch });
  };
  const actorIds = node.actors;
  const knowledge = node.knowledge || [];
  const locationOptions = [['', '未指定'], ...store.project.locations.map(item => [item.id, `${item.code} · ${item.name}`])];
  return el('section', { class: 'forge-panel forge-inspector', id: 'forge-inspector' },
    el('div', { class: 'inspector-head' },
      el('div', { class: 'grow' }, el('div', { class: 'eyebrow' }, `EVENT / 第 ${node.episode} 集`), el('h2', {}, node.title)),
      row(badge(outcome ? `固定结果 · ${LOCK_LABELS[outcome.lock]}` : node.status === 'confirmed' ? '已确认事件' : '草案', outcome ? LOCK_TONE[outcome.lock] : node.status === 'confirmed' ? 'good' : 'warn'),
        btn('连接', () => { ui.connectFrom = node.id; render(); }, 'small'),
        btn('删除', () => deleteNode(node), 'quiet danger small'))),
    el('div', { class: 'inspector-grid' },
      field('事件标题', node.title, value => commit({ title: value })),
      el('label', { class: 'field' }, '集数', el('input', { type: 'number', min: '1', max: String(store.project.episodeCount), value: String(node.episode), onChange: event => commit({ episode: clamp(event.target.value, 1, store.project.episodeCount) }) })),
      selectField('地点', node.locationId, locationOptions, value => commit({ locationId: value })),
      selectField('状态', node.status, [['draft', '草案'], ['confirmed', '已确认']], value => commit({ status: value })),
      areaField('事件目标（编剧希望实现什么）', node.goal, value => commit({ goal: value }), { full: true, rows: 2 }),
      areaField('前置条件（每行一条事实）', node.preconditions.join('\n'), value => commit({ preconditions: linesOf(value) }), { full: true, rows: 3 }),
      el('fieldset', { class: 'field full forge-actors' }, el('legend', {}, '行动者'),
        el('div', { class: 'chip-row' }, store.project.cast.map(item => el('label', { class: 'check-chip' },
          el('input', { type: 'checkbox', checked: actorIds.includes(item.id), onChange: event => commit({ actors: event.target.checked ? [...node.actors, item.id] : node.actors.filter(id => id !== item.id) }) }),
          item.name)))),
      areaField('行动动机', node.motive, value => commit({ motive: value }), { full: true, rows: 2 }),
      areaField('行动（具体做了什么）', node.action, value => commit({ action: value }), { full: true, rows: 3 }),
      areaField('直接结果（产生什么新事实）', node.result, value => commit({ result: value }), { full: true, rows: 3 })),
    inspectorDisclosure('production', '分镜与状态', '画面节拍 · 伏笔 · 情绪',
      areaField('画面节拍（每行一个镜头动作）', node.beats.join('\n'), value => commit({ beats: linesOf(value) }), { rows: 3 }),
      areaField('状态变化（每行一条）', node.stateChanges.join('\n'), value => commit({ stateChanges: linesOf(value) }), { rows: 2 }),
      field('后续伏笔', node.foreshadow, value => commit({ foreshadow: value })),
      field('情绪基调', node.tone, value => commit({ tone: value }))),
    inspectorDisclosure('dialogue', '台词', `${node.dialogue.length} 句`,
      el('div', { class: 'forge-stack' }, node.dialogue.map((line, index) => {
        const speaker = el('select', { 'aria-label': '说话人' }, [el('option', { value: '', selected: !line.characterId }, '未指定'), ...store.project.cast.map(item => el('option', { value: item.id, selected: item.id === line.characterId }, item.name))]);
        const text = el('input', { value: line.line, placeholder: '台词内容', 'aria-label': '台词内容' });
        const tone = el('input', { value: line.tone || '', placeholder: '语气', 'aria-label': '台词语气' });
        const commitLine = () => { line.characterId = speaker.value; line.line = text.value.trim(); line.tone = tone.value.trim(); commit({ dialogue: node.dialogue }); };
        speaker.addEventListener('change', commitLine);
        text.addEventListener('change', commitLine);
        tone.addEventListener('change', commitLine);
        return el('div', { class: 'dialogue-row' }, speaker, text, tone,
          btn('×', () => { node.dialogue.splice(index, 1); commit({ dialogue: node.dialogue }, true); }, 'quiet small', { 'aria-label': '删除这句台词' }));
      })),
      btn('＋ 台词', () => { node.dialogue.push({ characterId: '', speaker: '', line: '新台词', tone: '' }); commit({ dialogue: node.dialogue }, true); }, 'small')),
    inspectorDisclosure('knowledge', '角色认知时间线', `${knowledge.length} 条记录`,
      el('p', { class: 'forge-hint' }, '该事件之后，谁知道了什么。'),
      knowledge.length ? el('div', { class: 'forge-stack' }, knowledge.map((entry, index) => el('div', { class: 'knowledge-row' },
        el('select', { 'aria-label': '角色', onChange: event => { entry.characterId = event.target.value; commit({ knowledge }); } },
          [el('option', { value: '', selected: !entry.characterId }, '角色'), ...store.project.cast.map(item => el('option', { value: item.id, selected: item.id === entry.characterId }, item.name))]),
        el('select', { 'aria-label': '认知程度', onChange: event => { entry.level = event.target.value; commit({ knowledge }); } },
          Object.entries(KNOW_LABELS).map(([value, label]) => el('option', { value, selected: value === entry.level }, label))),
        el('input', { value: entry.subject || '', placeholder: '知道的对象/事实', 'aria-label': '知道的对象或事实', onChange: event => { entry.subject = event.target.value; commit({ knowledge }); } }),
        el('select', { 'aria-label': '获知来源', onChange: event => { entry.learnedAt = event.target.value; commit({ knowledge }); } },
          [el('option', { value: '', selected: !entry.learnedAt }, '未指定来源'), ...store.project.nodes.filter(item => item.episode <= node.episode).map(item => el('option', { value: item.id, selected: item.id === entry.learnedAt }, `第${item.episode}集 · ${item.title}`))]),
        btn('×', () => { knowledge.splice(index, 1); commit({ knowledge }, true); }, 'quiet small', { 'aria-label': '删除认知记录' })))) : el('p', { class: 'forge-hint' }, '还没有记录。补上之后，人物模拟器就不会让人物使用尚未知道的信息。'),
      btn('＋ 认知记录', () => { knowledge.push({ characterId: store.project.cast[0]?.id || '', level: 'partial', subject: '', note: '', learnedAt: '' }); commit({ knowledge }, true); }, 'small')),
    inspectorDisclosure('debts', '挂靠的剧情债务', `${node.debtIds.length} 项`,
      el('div', { class: 'chip-row' }, store.project.debts.map(debt => el('label', { class: 'check-chip' },
        el('input', { type: 'checkbox', checked: node.debtIds.includes(debt.id), onChange: event => commit({ debtIds: event.target.checked ? [...node.debtIds, debt.id] : node.debtIds.filter(id => id !== debt.id) }) }),
        debt.question.slice(0, 16))))));
}

/* —— 右：校验 / 认知 / AI —— */
function rightPanel() {
  const tabs = [['inspector', '事件编辑'], ['issues', '校验'], ['knowledge', '人物状态'], ['ai', 'AI 助手']];
  return el('section', { class: 'forge-panel forge-right' },
    el('div', { class: 'forge-side-heading' }, el('span', { class: 'eyebrow' }, 'EVENT & TOOLS'), el('h2', {}, '事件与辅助')),
    el('div', { class: 'forge-tabs', 'aria-label': '事件与辅助工具分类' }, tabs.map(([key, label]) => btn(label, () => { ui.rightTab = key; render(); }, ui.rightTab === key ? 'active' : '', { 'aria-pressed': ui.rightTab === key }))),
    el('div', { class: 'forge-side-content', 'data-forge-scroll': `detail-${ui.rightTab}-${ui.selectedNodeId || ''}` },
      ui.rightTab === 'inspector' ? inspectorPanel() : ui.rightTab === 'issues' ? issuesPanel() : ui.rightTab === 'knowledge' ? knowledgePanel() : aiPanel()));
}

function issuesPanel() {
  const issues = store.analysis?.issues || [];
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...issues].sort((left, right) => (order[left.level] ?? 3) - (order[right.level] ?? 3));
  return el('div', { class: 'forge-stack' },
    row(badge(`${issues.filter(item => item.level === 'error').length} 错误`, 'bad'), badge(`${issues.filter(item => item.level === 'warn').length} 提示`, 'warn'), el('span', { class: 'grow' })),
    el('p', { class: 'forge-hint' }, '确定性检查只判断能验证的事：时间线、前提依据、认知来源、债务顺序、集数密度。语义与动机交给剧情审查员。'),
    sorted.length ? el('div', { class: 'issue-list' }, sorted.map(issue => el('button', {
      type: 'button', class: 'issue-item', 'data-level': issue.level,
      onClick: () => {
        if (issue.nodeId && nodeById(issue.nodeId)) { focusEpisode(nodeById(issue.nodeId).episode, issue.nodeId); }
        else if (issue.episode) { focusEpisode(issue.episode); }
      },
    },
      el('div', { class: 'row between' }, el('strong', {}, issue.title), badge({ error: '错误', warn: '提示', info: '说明' }[issue.level] || issue.level, LEVEL_TONE[issue.level])),
      el('small', {}, issue.detail)))) : el('p', { class: 'muted' }, '当前没有发现结构性问题。'),
    row(btn('重新分析', () => analyzeNow(), 'small'), btn('请模型审查', () => runAi('script-reviewer', { nodeId: ui.selectedNodeId }), 'small')));
}

async function analyzeNow() {
  try {
    const result = await ctx.api(`/api/forge/projects/${encodeURIComponent(store.project.id)}/analyze`, { method: 'POST', body: { project: payload() } });
    store.analysis = result.analysis;
    ctx.notify(`校验完成：${result.analysis.stats.errors} 个错误，${result.analysis.stats.warnings} 个提示`);
    render();
  } catch (error) { ctx.notify(error.message, true); }
}

function knowledgePanel() {
  const node = selectedNode();
  if (!node) return el('p', { class: 'muted' }, '先在因果图里选一个事件，查看这一集之前每个人知道什么。');
  const previous = store.project.nodes.filter(item => item.episode <= node.episode && item.id !== node.id);
  const rows = store.project.cast.map(character => {
    const records = [...previous, node].flatMap(item => (item.knowledge || []).filter(entry => entry.characterId === character.id).map(entry => ({ ...entry, node: item }))).sort((left, right) => left.node.episode - right.node.episode);
    const latest = records.at(-1);
    return el('div', { class: 'know-card' },
      el('div', { class: 'row between' }, el('strong', {}, character.name), latest ? badge(KNOW_LABELS[latest.level], latest.level === 'knows' ? 'good' : latest.level === 'partial' ? 'warn' : '') : badge('尚不知情')),
      el('small', {}, latest ? `${latest.subject || '未写对象'}｜来自第 ${latest.node.episode} 集「${latest.node.title}」` : '在这个时间点之前没有记录。'),
      latest?.note ? el('small', {}, latest.note) : null);
  });
  return el('div', { class: 'forge-stack' },
    el('p', { class: 'forge-hint' }, `客观时间线：第 ${node.episode} 集之前共 ${previous.length} 个事件。角色认知只取他自己获知过的部分，避免“未卜先知”。`),
    ...rows,
    btn('编辑本集认知记录', () => {
      ui.rightTab = 'inspector';
      ui.inspectorSections.knowledge = true;
      render();
      root.querySelector('[data-inspector-section="knowledge"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 'small'));
}

function aiPanel() {
  const node = selectedNode();
  const outcomeId = ui.selectedOutcomeId || store.project.outcomes[0]?.id || '';
  const targetOutcomeId = ui.targetOutcomeId || store.project.outcomes.find(item => item.lock === 'hard')?.id || store.project.outcomes[0]?.id || '';
  return el('div', { class: 'forge-stack' },
    el('p', { class: 'forge-hint' }, store.llm?.configured
      ? `当前模型：${store.llm.settings.provider} / ${store.llm.settings.model}。输出只是建议，采纳后才会写进因果图。`
      : '还没有可用的模型：结果规划师会退回本地模板，其余功能需要先在「LLM 设置」里配置接口。'),
    el('div', { class: 'ai-grid' }, AI_TASKS.map(([task, label, description]) => btn(`${label}\n${description}`, () => {
      if (task === 'result-planner') runAi(task, { outcomeId });
      else if (task === 'causal-architect') runAi(task, { nodeId: ui.selectedNodeId, outcomeId: targetOutcomeId });
      else if (task === 'storyboard-writer') runAi(task, { fromEpisode: ui.range.from, toEpisode: ui.range.to });
      else runAi(task, { nodeId: ui.selectedNodeId });
    }, `ai-button${ui.aiBusy === task ? ' busy' : ''}`, { disabled: Boolean(ui.aiBusy) || (!['result-planner', 'storyboard-writer'].includes(task) && !node), title: description }))),
    el('label', { class: 'field' }, '因果构造师的目标结果',
      el('select', { onChange: event => { ui.targetOutcomeId = event.target.value; } },
        store.project.outcomes.map(outcome => el('option', { value: outcome.id, selected: outcome.id === targetOutcomeId }, `第${outcome.episode}集 · ${outcome.title}`)))),
    ui.aiBusy ? el('div', { class: 'note' }, '正在请求模型，可能需要几十秒…') : null,
    ui.aiError ? aiErrorCard(ui.aiError) : null,
    ui.aiResult ? aiResultCard(ui.aiResult) : null,
    btn('LLM 设置', llmModal, 'quiet small'));
}

function aiErrorCard(error) {
  return el('div', { class: 'note error' },
    el('strong', {}, '这次没有拿到可用结果'),
    el('p', {}, error.message),
    error.details?.raw ? el('details', {}, el('summary', {}, '查看模型原文'), el('pre', { class: 'prompt-box' }, error.details.raw)) : null);
}

function aiResultCard(result) {
  const payload = result.result || result;
  const source = result.source === 'template' ? '本地模板（未使用模型）' : `模型 · ${result.model || store.llm?.settings?.model || ''}`;
  const head = el('div', { class: 'forge-panel-head' }, el('h3', {}, AI_TASKS.find(([task]) => task === result.task)?.[1] || 'AI 结果'), badge(source, result.source === 'template' ? 'warn' : 'good'));
  const cards = [];
  if (Array.isArray(payload.plans)) {
    for (const plan of payload.plans) cards.push(planCard(plan, { outcomeId: ui.selectedOutcomeId }));
  }
  if (Array.isArray(payload.chains)) {
    for (const chain of payload.chains) cards.push(planCard(chain, { outcomeId: ui.targetOutcomeId, chain: true }));
  }
  if (Array.isArray(payload.options)) {
    for (const option of payload.options) cards.push(labCard(option));
  }
  if (Array.isArray(payload.actions)) {
    cards.push(el('div', { class: 'ai-card' }, el('h4', {}, '人物最可能的行动'),
      el('div', { class: 'forge-stack' }, payload.actions.map(action => el('div', { class: 'ai-action' },
        el('strong', {}, action.character || '角色'), el('small', {}, `已知：${action.knows || '未写'}`),
        el('p', {}, action.action || ''), el('small', {}, `动机：${action.motive || '未写'}｜代价：${action.cost || '未写'}｜可信度：${action.credibility || '未评'}`))))));
  }
  if (payload.verdict || Array.isArray(payload.issues)) {
    cards.push(el('div', { class: 'ai-card' }, el('div', { class: 'row between' }, el('h4', {}, '审查结论'), badge(payload.verdict || '见下', /不成立|需修改/.test(payload.verdict || '') ? 'warn' : 'good')),
      el('div', { class: 'forge-stack' }, (payload.issues || []).map(issue => el('div', { class: 'ai-issue' },
        el('strong', {}, issue.title || '问题'), el('p', {}, issue.detail || ''), issue.fix ? el('small', {}, `建议：${issue.fix}`) : null)))));
  }
  if (Array.isArray(payload.scenes)) {
    const shots = payload.scenes.reduce((sum, scene) => sum + (scene.shots?.length || 0), 0);
    cards.push(el('div', { class: 'ai-card' },
      el('div', { class: 'row between' }, el('h4', {}, '分镜稿'), badge(`${payload.scenes.length} 场 · ${shots} 镜`, 'good')),
      el('p', { class: 'muted' }, payload.scenes.map(scene => `第${scene.episode}集 ${scene.title || ''}`).join('；')),
      row(btn('写入分镜稿', () => adoptScenes(payload, result), 'primary small'), btn('检查能否导出', () => exportModal(false), 'small'))));
  }
  const raw = el('details', {}, el('summary', {}, '模型原始返回'), el('pre', { class: 'prompt-box' }, result.raw || JSON.stringify(payload, null, 2)));
  return el('div', { class: 'forge-stack ai-result' }, head,
    result.notice ? el('div', { class: 'note' }, result.notice) : null,
    ...cards, raw);
}

function planCard(plan, { outcomeId, chain = false } = {}) {
  return el('div', { class: 'ai-card' },
    el('div', { class: 'row between' }, el('h4', {}, plan.name || '未命名方案'), badge(chain ? '事件链' : '因果方案', 'good')),
    plan.mechanism || plan.approach ? el('small', {}, plan.mechanism || plan.approach) : null,
    plan.rationale || plan.summary ? el('p', {}, plan.rationale || plan.summary) : null,
    el('ol', { class: 'ai-events' }, (plan.events || []).map(event => el('li', {},
      el('strong', {}, `第${event.episode}集 · ${event.title || ''}`),
      el('p', {}, event.action || ''),
      event.result ? el('small', {}, `结果：${event.result}`) : null,
      event.preconditions?.length ? el('small', {}, `前提：${event.preconditions.join('、')}`) : null))),
    plan.risk || plan.cost ? el('p', { class: 'ai-risk' }, `代价：${plan.risk || plan.cost}`) : null,
    row(btn('插入事件链', () => adoptChain(plan, { outcomeId }), 'primary small'), btn('只看不插入', () => ctx.notify('方案保留在这张卡里，不会写入正式图。'), 'quiet small')));
}

function labCard(option) {
  return el('div', { class: 'ai-card' },
    el('div', { class: 'row between' }, el('h4', {}, option.name || '未命名方案'), badge('实验室', 'warn')),
    el('p', {}, option.summary || option.approach || ''),
    el('ol', { class: 'ai-events' }, (option.events || []).map(event => el('li', {}, el('strong', {}, `第${event.episode}集 · ${event.title || ''}`), el('p', {}, event.action || '')))),
    option.pros ? el('small', {}, `优势：${option.pros}`) : null,
    option.cons ? el('small', {}, `代价：${option.cons}`) : null,
    option.affected?.length ? el('small', {}, `波及：${option.affected.join('、')}`) : null,
    row(btn('存为分支', () => saveBranch(option), 'small'), btn('合并到正式图', () => mergeOption(option), 'quiet small')));
}

/* —— 中央工作区：因果图 / 时间轴 / 债务 / 实验室 / 分镜稿 —— */
function workspacePanel() {
  const tabs = [['graph', '因果图'], ['overview', '剧情概览'], ['timeline', '剧集时间轴'], ['debts', '剧情债务'], ['lab', '剧情实验室'], ['script', '分镜稿与导出']];
  const graph = ui.workspaceTab === 'graph';
  return el('section', { class: 'forge-panel forge-workspace' },
    el('div', { class: 'forge-workspace-heading' },
      el('div', {}, el('span', { class: 'eyebrow' }, 'CAUSAL WORKSPACE'), el('h2', {}, '剧本工作区')),
      el('div', { class: 'forge-workspace-actions' },
        badge(`${store.project.nodes.length} 事件 · ${store.project.edges.length} 连线`),
        btn(ui.fullscreen ? '退出全屏' : '全屏', toggleFullscreen, 'quiet small', { 'aria-pressed': ui.fullscreen, title: ui.fullscreen ? '退出全屏（Esc）' : '让剧本工作区占满整个窗口' }))),
    el('div', { class: 'forge-tabs forge-workspace-tabs', 'aria-label': '工作区分类' }, tabs.map(([key, label]) => btn(label, () => { ui.workspaceTab = key; render(); }, ui.workspaceTab === key ? 'active' : '', { 'aria-pressed': ui.workspaceTab === key }))),
    el('div', { class: `forge-workspace-content${graph ? ' is-graph' : ''}`, 'data-forge-scroll': `workspace-${ui.workspaceTab}` },
      graph ? [graphToolbar(), graphCanvas(),
        el('div', { class: 'forge-graph-footer' },
          el('span', { class: 'forge-legend' }, Object.entries(EDGE_LABELS).map(([type, label]) => el('span', { class: 'legend-item' },
            el('i', { style: `background:${EDGE_COLORS[type]}` }), label))),
          el('small', {}, '拖动事件调整位置 · 点击事件编辑 · 点击连线修改')),
        el('div', { class: 'forge-episode-nav' },
          el('div', { class: 'forge-panel-head' }, el('h3', {}, '跳转剧集'), el('small', {}, selectedNode() ? `当前：第 ${selectedNode().episode} 集 · ${selectedNode().title}` : '选择一集开始编写')),
          episodeStrip())]
        : ui.workspaceTab === 'timeline' ? timelinePanel() : ui.workspaceTab === 'debts' ? debtsPanel() : ui.workspaceTab === 'lab' ? labPanel() : ui.workspaceTab === 'overview' ? overviewPanel() : scriptPanel()));
}

function episodeStrip() {
  const plan = store.analysis?.episodePlan || [];
  return el('div', { class: 'forge-timeline', 'aria-label': '剧集快速跳转', 'data-forge-scroll': 'episodes' }, plan.map(item => el('button', {
      type: 'button', class: `ep-chip${item.nodeCount ? '' : ' empty'}${item.outcomes.some(outcome => outcome.lock === 'hard') ? ' hard' : ''}`,
      onClick: () => focusEpisode(item.episode), title: item.title, 'aria-pressed': selectedNode()?.episode === item.episode,
    },
      el('span', { class: 'ep-chip-num' }, String(item.episode).padStart(2, '0')),
      el('span', { class: 'ep-chip-count' }, item.nodeCount ? `${item.nodeCount} 事件` : '空'),
      item.outcomes.some(outcome => outcome.lock === 'hard') ? el('i', { class: 'ep-chip-dot' }) : null)));
}

function overviewPanel() {
  const project = store.project;
  const nodes = [...project.nodes].sort((left, right) => left.episode - right.episode || left.order - right.order);
  const episodes = [...new Set(nodes.map(node => node.episode))].sort((left, right) => left - right);
  if (!episodes.length) {
    return el('div', { class: 'forge-stack' },
      el('p', { class: 'muted' }, '因果图还没有事件。先在「因果图」页补上事件，这里就会按集列出剧情概览。'),
      row(btn('＋ 新建事件', () => nodeModal(null), 'primary small')));
  }
  return el('div', { class: 'forge-overview' },
    el('p', { class: 'forge-hint' }, '按集浏览每个事件的目标、行动者、地点、台词与直接结果。点击一行可回到因果图编辑该事件。'),
    episodes.map(episode => {
      const items = nodes.filter(node => node.episode === episode);
      const outcome = project.outcomes.find(item => item.episode === episode);
      return el('section', { class: 'forge-overview-episode' },
        el('div', { class: 'forge-overview-ephead' },
          el('strong', {}, `第 ${episode} 集`),
          outcome ? el('span', { class: `badge ${LOCK_TONE[outcome.lock]}` }, `${LOCK_LABELS[outcome.lock]} · ${outcome.title}`) : null,
          el('small', {}, `${items.length} 个事件`)),
        el('div', { class: 'forge-overview-list' }, items.map(node => {
          const location = locationById(node.locationId);
          const dialogue = node.dialogue || [];
          const speakers = dialogue.map(line => line.characterId ? castById(line.characterId)?.name : (line.speaker || '未指定')).filter(Boolean);
          const castNames = node.actors.map(id => castById(id)?.name).filter(Boolean);
          return             el('div', { class: 'forge-overview-row', role: 'button', tabindex: '0',
            onClick: () => { ui.workspaceTab = 'graph'; handleNodeClick(node); },
            onKeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ui.workspaceTab = 'graph'; handleNodeClick(node); } },
          },
            el('div', { class: 'forge-overview-title' },
              el('strong', {}, node.title || '未命名事件'),
              outcome && outcome.nodeId === node.id ? badge('固定结果', outcome.lock === 'hard' ? 'bad' : 'warn') : null),
            el('div', { class: 'forge-overview-cells' },
              el('div', { class: 'forge-overview-cell' }, el('small', {}, '事件目标'), el('p', {}, node.goal || '—')),
              el('div', { class: 'forge-overview-cell' }, el('small', {}, '行动者'), el('p', {}, castNames.length ? castNames.join('、') : '—')),
              el('div', { class: 'forge-overview-cell' }, el('small', {}, '地点'), el('p', {}, location ? `${location.code} · ${location.name}` : '—')),
              el('div', { class: 'forge-overview-cell' }, el('small', {}, '直接结果'), el('p', {}, node.result || '—'))),
            dialogue.length ? el('div', { class: 'forge-overview-dialogue' },
              el('small', {}, `台词 · ${dialogue.length} 句`),
              dialogue.map(line => el('div', { class: 'forge-overview-line' },
                el('span', { class: 'forge-overview-speaker' }, line.characterId ? castById(line.characterId)?.name : (line.speaker || '未指定')),
                el('span', {}, line.line || ''),
                line.tone ? el('span', { class: 'forge-overview-tone' }, line.tone) : null))) : null);
        })));
    }));
}

function timelinePanel() {
  const plan = store.analysis?.episodePlan || [];
  return el('div', { class: 'forge-stack' },
    episodeStrip(),
    el('div', { class: 'forge-episode-grid' }, plan.filter(item => item.nodeCount || item.outcomes.length).map(item => el('div', { class: 'episode-row' },
      el('strong', {}, `第 ${item.episode} 集`),
      el('div', { class: 'grow' }, el('span', {}, item.title || '未命名'),
        el('small', {}, `${item.nodeCount} 个事件 · 约 ${item.duration} 秒 · ${item.outcomes.map(outcome => LOCK_LABELS[outcome.lock]).join('/') || '无固定结果'}`)),
      btn('打开', () => focusEpisode(item.episode), 'quiet small')))));
}

function focusEpisode(episode, nodeId) {
  const node = nodeById(nodeId) || store.project.nodes.find(item => item.episode === episode);
  if (node) {
    ui.selectedNodeId = node.id;
    ui.rightTab = 'inspector';
    ui.workspaceTab = 'graph';
    ui.scrollLeft = 0;
    render();
    const wrap = root.querySelector('#forge-canvas-wrap');
    const card = [...root.querySelectorAll('.forge-node')].find(item => item.dataset.nodeId === node.id);
    card?.scrollIntoView({ block: 'center', inline: 'center' });
    root.querySelector('.ep-chip[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } else {
    nodeModal(null, { episode });
  }
}

function debtsPanel() {
  const project = store.project;
  return el('div', { class: 'forge-stack' },
    el('p', { class: 'forge-hint' }, '债务不是待办事项，而是观众已经看见、却还没有得到回答的问题。删除埋设事件时，影响分析会拿它来提醒你。'),
    project.debts.length ? project.debts.map(debt => el('div', { class: 'debt-card' },
      el('div', { class: 'row between' }, el('strong', {}, debt.question), badge(debt.status === 'paid' ? '已兑现' : '未兑现', debt.status === 'paid' ? 'good' : 'warn')),
      debt.detail ? el('p', {}, debt.detail) : null,
      el('small', {}, `埋设：${debt.planted.map(id => nodeById(id)).filter(Boolean).map(item => `第${item.episode}集`).join('、') || '未埋设'}`),
      el('small', {}, `回收：${debt.payoff.map(id => nodeById(id)).filter(Boolean).map(item => `第${item.episode}集`).join('、') || '未回收'}`),
      row(btn(debt.status === 'paid' ? '标记未兑现' : '标记已兑现', () => { debt.status = debt.status === 'paid' ? 'open' : 'paid'; save(); }, 'small'),
        btn('编辑', () => debtModal(debt), 'quiet small'),
        btn('删除', () => { project.debts = project.debts.filter(item => item.id !== debt.id); save(); }, 'quiet small danger')))) : el('p', { class: 'muted' }, '还没有记录剧情债务。'),
    btn('＋ 剧情债务', () => debtModal(null), 'small'));
}

function labPanel() {
  const node = selectedNode();
  const branches = store.project.branches || [];
  return el('div', { class: 'forge-stack' },
    el('div', { class: 'row between' },
      el('p', { class: 'forge-hint' }, node ? `当前事件：第 ${node.episode} 集「${node.title}」。实验室分支不会污染正式因果图，确认后才合并。` : '先在因果图里选一个事件，再探索其他发展。'),
      btn(node ? '探索其他发展' : '选择事件后再试', () => runAi('lab-explore', { nodeId: ui.selectedNodeId }), 'small', { disabled: !node || Boolean(ui.aiBusy) })),
    branches.length ? branches.map(branch => el('div', { class: 'debt-card' },
      el('div', { class: 'row between' }, el('strong', {}, branch.name), badge(branch.status === 'merged' ? '已合并' : branch.status === 'discarded' ? '已丢弃' : '未合并', branch.status === 'merged' ? 'good' : 'warn')),
      el('p', {}, branch.summary || branch.approach || ''),
      el('ol', { class: 'ai-events' }, branch.events.map(event => el('li', {}, el('strong', {}, `第${event.episode}集 · ${event.title}`), el('p', {}, event.action || '')))),
      branch.pros ? el('small', {}, `优势：${branch.pros}`) : null,
      branch.cons ? el('small', {}, `代价：${branch.cons}`) : null,
      row(branch.status === 'draft' ? btn('合并到正式图', () => mergeBranch(branch), 'primary small') : null,
        branch.status === 'draft' ? btn('丢弃', () => { branch.status = 'discarded'; save(); }, 'quiet small') : null,
        btn('删除', () => { store.project.branches = store.project.branches.filter(item => item.id !== branch.id); save(); }, 'quiet small danger')))) : el('p', { class: 'muted' }, '还没有实验室分支。'),
    );
}

function scriptPanel() {
  const stats = store.analysis?.stats || {};
  return el('div', { class: 'forge-stack' },
    el('p', { class: 'forge-hint' }, `导出使用的是同一套规范化格式：项目元数据、风格、角色/场景设定、完整分镜。当前分镜稿${stats.scriptFresh ? '与因果图一致' : '尚未生成或已过期'}。`),
    row(el('label', { class: 'field' }, '起始集', el('input', { type: 'number', min: '1', max: String(store.project.episodeCount), value: String(ui.range.from), onChange: event => { ui.range.from = clamp(event.target.value, 1, ui.range.to); render(); } })),
      el('label', { class: 'field' }, '结束集', el('input', { type: 'number', min: String(ui.range.from), max: String(store.project.episodeCount), value: String(ui.range.to), onChange: event => { ui.range.to = clamp(event.target.value, ui.range.from, store.project.episodeCount); render(); } })),
      btn('预览剧本', () => exportModal(false), 'small'), btn('下载 .md', downloadExport, 'small'), btn('发布到分镜工作台', () => exportModal(true), 'primary small')),
    ui.exportStats ? el('div', { class: 'row wrap' }, badge(`${ui.exportStats.episodes} 场`), badge(`${ui.exportStats.shots} 镜`), badge(`约 ${ui.exportStats.duration} 秒`), badge(`${ui.exportStats.cast} 角色 · ${ui.exportStats.locations} 场景`)) : null,
    ui.exportText ? el('pre', { class: 'prompt-box forge-export-preview' }, ui.exportText) : el('div', { class: 'note' }, '点「预览剧本」查看即将导入的 Markdown 全文；导出与发布走同一条 buildExport，不会出现两份不同的文本。'));
}

async function previewExport() {
  try {
    const result = await ctx.api(`/api/forge/projects/${encodeURIComponent(store.project.id)}/export?from=${ui.range.from}&to=${ui.range.to}`);
    ui.exportText = result.markdown;
    ui.exportStats = result.stats;
    return result;
  } catch (error) { ctx.notify(error.message, true); return null; }
}

async function exportModal(publish) {
  const result = await previewExport();
  if (!result) return;
  render();
  const body = el('div', { class: 'stack' },
    row(badge(`${result.stats.episodes} 场`, 'good'), badge(`${result.stats.shots} 镜`), badge(`约 ${result.stats.duration} 秒`), badge(result.usedScript ? '使用模型分镜稿' : '由事件字段生成')),
    el('p', { class: 'muted' }, `范围：第 ${result.range.from}–${result.range.to} 集。没有事件的集不会生成空场次。`),
    el('pre', { class: 'prompt-box forge-export-preview' }, result.markdown),
    row(el('span', { class: 'grow' }), btn('复制全文', () => ctx.copy(result.markdown), 'small'), btn('下载 .md', downloadExport, 'small'),
      btn(publish ? '确认发布' : '关闭', async () => {
        if (!publish) { closeModal(); return; }
        try {
          const published = await ctx.api(`/api/forge/projects/${encodeURIComponent(store.project.id)}/publish`, { method: 'POST', body: { from: ui.range.from, to: ui.range.to } });
          ctx.notify(`已生成分镜作品：${published.project.title}（${published.project.shots} 镜）`);
          closeModal();
          ctx.openStudioProject?.(published.project.id);
        } catch (error) { ctx.notify(error.message, true); }
      }, publish ? 'primary' : '')));
  openModalBody(publish ? '发布为分镜作品' : '分镜稿预览', body);
}

function downloadExport() {
  if (!store.project) return;
  window.location.href = `/api/forge/projects/${encodeURIComponent(store.project.id)}/export?from=${ui.range.from}&to=${ui.range.to}&download=1`;
}

/* —— 采纳 AI 建议 —— */
async function runAi(task, payload) {
  if (!task) return;
  if (task === 'result-planner' && !store.llm?.configured) {
    try {
      const outcomeId = payload.outcomeId || store.project.outcomes[0]?.id;
      const result = await ctx.api(`/api/forge/projects/${encodeURIComponent(store.project.id)}/local-plan?outcomeId=${encodeURIComponent(outcomeId)}`);
      ui.selectedOutcomeId = result.outcome.id;
      ui.aiResult = { task, source: 'template', result: { plans: result.plans }, raw: JSON.stringify(result.plans, null, 2) };
      ui.aiError = null;
      ui.rightTab = 'ai';
      render();
    } catch (error) { ui.aiError = error; render(); }
    return;
  }
  if (!store.llm?.configured) {
    ctx.notify('先在 LLM 设置里配置模型；本机 Ollama 可以零成本使用。', true);
    llmModal();
    return;
  }
  ui.aiBusy = task;
  ui.aiError = null;
  ui.aiResult = null;
  ui.rightTab = 'ai';
  render();
  try {
    const result = await ctx.api(`/api/forge/projects/${encodeURIComponent(store.project.id)}/llm`, { method: 'POST', body: { task, payload } });
    ui.aiResult = result;
  } catch (error) {
    // 模型连不上/没配 Key 时，结果规划师退回本地模板，至少给出三条可执行的链。
    const code = error.details?.code || error.code;
    if (task === 'result-planner' && ['LLM_UNREACHABLE', 'LLM_KEY_MISSING'].includes(code)) {
      try {
        const outcomeId = payload.outcomeId || store.project.outcomes[0]?.id;
        const fallback = await ctx.api(`/api/forge/projects/${encodeURIComponent(store.project.id)}/local-plan?outcomeId=${encodeURIComponent(outcomeId)}`);
        ui.selectedOutcomeId = fallback.outcome.id;
        ui.aiResult = { task, source: 'template', notice: `模型不可用（${error.message}），已改用本地模板。`, result: { plans: fallback.plans } };
        ui.aiError = null;
      } catch (nested) { ui.aiError = error; }
    } else ui.aiError = error;
  } finally {
    ui.aiBusy = '';
    render();
  }
}

function adoptChain(plan, { outcomeId } = {}) {
  const project = store.project;
  const outcome = project.outcomes.find(item => item.id === outcomeId) || null;
  const events = (plan.events || []).filter(event => event.title);
  if (!events.length) { ctx.notify('这个方案没有可插入的事件。', true); return; }
  insertEvents(events, { outcome });
  ctx.notify('事件链已插入因果图，可逐条修改或回撤。');
  save();
}

function insertEvents(events, { afterId = null, outcome = null } = {}) {
  const project = store.project;
  let previous = afterId;
  const created = [];
  for (const event of events) {
    const episode = clamp(event.episode, 1, project.episodeCount);
    const node = {
      id: `node_${uid()}`,
      code: `N${String(project.nodes.length + 1).padStart(2, '0')}`,
      title: event.title || '未命名事件', episode,
      order: project.nodes.filter(item => item.episode === episode).length,
      status: 'draft', goal: '', preconditions: event.preconditions || [],
      actors: (event.actors || []).map(castIdByName).filter(Boolean),
      motive: '', action: event.action || '', result: event.result || '',
      stateChanges: [], foreshadow: '', beats: [], tone: '', locationId: '', outcomeId: '',
      x: null, y: null, knowledge: [], dialogue: [], debtIds: [],
    };
    project.nodes.push(node);
    created.push(node);
    if (previous && previous !== node.id) project.edges.push({ id: `edge_${uid()}`, from: previous, to: node.id, type: 'cause', note: '采纳的方案链' });
    previous = node.id;
  }
  if (outcome) {
    let target = nodeById(outcome.nodeId);
    if (!target) {
      target = {
        id: `node_${uid()}`, code: `N${String(project.nodes.length + 1).padStart(2, '0')}`,
        title: outcome.title, episode: outcome.episode, order: 0, status: 'draft',
        goal: outcome.detail, preconditions: [], actors: outcome.leadId ? [outcome.leadId] : [], motive: '', action: '', result: outcome.detail,
        stateChanges: [], foreshadow: '', beats: [], tone: '', locationId: '', outcomeId: outcome.id,
        x: null, y: null, knowledge: [], dialogue: [], debtIds: [],
      };
      project.nodes.push(target);
      outcome.nodeId = target.id;
      created.push(target);
    }
    if (previous && previous !== target.id) project.edges.push({ id: `edge_${uid()}`, from: previous, to: target.id, type: 'cause', note: '采纳的方案链' });
    ui.selectedNodeId = created[0]?.id || target.id;
  } else {
    ui.selectedNodeId = created[0]?.id || ui.selectedNodeId;
  }
  ui.scrollLeft = 0;
  return created;
}

function saveBranch(option) {
  store.project.branches.push({
    id: `branch_${uid()}`, nodeId: ui.selectedNodeId || '', name: option.name || '未命名方案',
    approach: option.approach || '', summary: option.summary || '', pros: option.pros || '', cons: option.cons || '',
    status: 'draft', createdAt: new Date().toISOString(), source: 'llm',
    events: (option.events || []).map(event => ({
      episode: clamp(event.episode, 1, store.project.episodeCount), title: event.title || '',
      action: event.action || '', result: event.result || '', preconditions: event.preconditions || [],
      actors: (event.actors || []).map(castIdByName).filter(Boolean),
    })),
  });
  ctx.notify('方案已存为分支，正式因果图没有改变。');
  save();
}

function mergeOption(option) {
  const events = (option.events || []).filter(event => event.title);
  if (!events.length) { ctx.notify('这个方案没有事件可合并。', true); return; }
  insertEvents(events, { afterId: ui.selectedNodeId });
  ctx.notify('已合并到正式因果图；建议运行一次影响分析。');
  save();
}

function mergeBranch(branch) {
  if (!branch.events.length) { ctx.notify('这个分支没有事件。', true); return; }
  insertEvents(branch.events, { afterId: branch.nodeId || ui.selectedNodeId });
  branch.status = 'merged';
  ctx.notify('分支已合并；原事件的下游连线仍然保留，请核对是否重复。');
  save();
}

function adoptScenes(payload, result) {
  store.project.script = {
    generatedAt: new Date().toISOString(), source: 'llm', model: result.model || store.llm?.settings?.model || '',
    fingerprint: store.analysis?.stats?.fingerprint || '', scenes: payload.scenes,
  };
  ctx.notify('分镜稿已写入；导出时会优先使用它与当前因果图一致的版本。');
  save();
}

/* —— 弹窗与表单 —— */
function modalElement() { return document.querySelector('#modal'); }
function closeModal() { const modal = modalElement(); if (modal?.open) modal.close(); }
function openModalBody(title, body) { ctx.openModal(title, body); return modalElement(); }
function openForm(title, ...children) {
  const form = el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, ...children);
  const modal = openModalBody(title, form);
  return modal;
}
function formActions(extra = null) {
  return row(el('span', { class: 'grow' }), extra, btn('取消', closeModal));
}

function field(label, value, commit, options = {}) {
  const control = el('input', { type: options.type || 'text', value: value ?? '', placeholder: options.placeholder || '' });
  control.addEventListener('change', () => commit(control.value));
  return el('label', { class: `field ${options.full ? 'full' : ''}` }, label, control);
}
function areaField(label, value, commit, { rows = 3, full = false, placeholder = '' } = {}) {
  const control = el('textarea', { rows, placeholder });
  control.value = value ?? '';
  control.addEventListener('change', () => commit(control.value));
  return el('label', { class: `field ${full ? 'full' : ''}` }, label, control);
}
function selectField(label, value, pairs, commit, { full = false } = {}) {
  const control = el('select', {}, pairs.map(([key, text]) => el('option', { value: key, selected: String(key) === String(value) }, text)));
  control.addEventListener('change', () => commit(control.value));
  return el('label', { class: `field ${full ? 'full' : ''}` }, label, control);
}

function nodeModal(node, preset = {}) {
  const editing = Boolean(node);
  const project = store.project;
  const values = editing ? {
    title: node.title, episode: node.episode, goal: node.goal, preconditions: node.preconditions.join('\n'),
    motive: node.motive, action: node.action, result: node.result, tone: node.tone, locationId: node.locationId,
    actors: [...node.actors], targetOutcomeId: node.outcomeId || '',
  } : {
    title: '', episode: preset.episode || ui.range.from, goal: '', preconditions: '', motive: '', action: '', result: '',
    tone: '', locationId: project.locations[0]?.id || '', actors: [], targetOutcomeId: '',
  };
  const body = el('div', { class: 'stack' },
    field('事件标题', values.title, value => { values.title = value; }, { full: true }),
    row(el('label', { class: 'field' }, '集数', el('input', { type: 'number', min: '1', max: String(project.episodeCount), value: String(values.episode), onInput: event => { values.episode = clamp(event.target.value, 1, project.episodeCount); } })),
      selectField('地点', values.locationId, [['', '未指定'], ...project.locations.map(item => [item.id, `${item.code} · ${item.name}`])], value => { values.locationId = value; })),
    el('label', { class: 'field' }, '行动者', el('div', { class: 'chip-row' }, project.cast.map(item => el('label', { class: 'check-chip' },
      el('input', { type: 'checkbox', checked: values.actors.includes(item.id), onChange: event => { values.actors = event.target.checked ? [...values.actors, item.id] : values.actors.filter(id => id !== item.id); } }), item.name)))),
    areaField('事件目标', values.goal, value => { values.goal = value; }, { full: true, rows: 2 }),
    areaField('前置条件（每行一条）', values.preconditions, value => { values.preconditions = value; }, { full: true, rows: 3 }),
    areaField('行动动机', values.motive, value => { values.motive = value; }, { full: true, rows: 2 }),
    areaField('行动', values.action, value => { values.action = value; }, { full: true, rows: 3 }),
    areaField('直接结果', values.result, value => { values.result = value; }, { full: true, rows: 2 }),
    field('情绪基调', values.tone, value => { values.tone = value; }, { full: true }),
    selectField('对应固定结果', values.targetOutcomeId, [['', '不挂结果'], ...project.outcomes.map(item => [item.id, `第${item.episode}集 · ${item.title}`])], value => { values.targetOutcomeId = value; }),
    row(el('span', { class: 'grow' }), btn('取消', closeModal), btn(editing ? '保存事件' : '创建事件', () => {
      if (!values.title.trim()) { ctx.notify('事件标题不能为空。', true); return; }
      if (editing) {
        const episodeChanged = values.episode !== node.episode;
        Object.assign(node, { ...values, preconditions: linesOf(values.preconditions) });
        if (episodeChanged) { node.x = null; node.y = null; }
        node.outcomeId = values.targetOutcomeId;
        if (values.targetOutcomeId) {
          for (const outcome of project.outcomes) if (outcome.id !== values.targetOutcomeId && outcome.nodeId === node.id) outcome.nodeId = '';
          const outcome = project.outcomes.find(item => item.id === values.targetOutcomeId);
          if (outcome) outcome.nodeId = node.id;
        }
      } else {
        const created = {
          id: `node_${uid()}`, code: `N${String(project.nodes.length + 1).padStart(2, '0')}`,
          title: values.title.trim(), episode: values.episode,
          order: project.nodes.filter(item => item.episode === values.episode).length,
          status: 'draft', goal: values.goal, preconditions: linesOf(values.preconditions), actors: values.actors,
          motive: values.motive, action: values.action, result: values.result, stateChanges: [], foreshadow: '',
          beats: [], tone: values.tone, locationId: values.locationId, outcomeId: values.targetOutcomeId,
          x: null, y: null, knowledge: [], dialogue: [], debtIds: [],
        };
        project.nodes.push(created);
        ui.selectedNodeId = created.id;
        if (values.targetOutcomeId) {
          const outcome = project.outcomes.find(item => item.id === values.targetOutcomeId);
          if (outcome) outcome.nodeId = created.id;
        }
      }
      closeModal(); save();
    }, 'primary')));
  openModalBody(editing ? '编辑事件' : '新建事件', el('form', { class: 'stack', onSubmit: event => { event.preventDefault(); } }, body));
}

function deleteNode(node) {
  const run = async () => {
    try {
      const result = await ctx.api(`/api/forge/projects/${encodeURIComponent(store.project.id)}/impact`, { method: 'POST', body: { nodeId: node.id, delete: true } });
      const impact = result.impact;
      const body = el('div', { class: 'stack' },
        el('p', {}, `删除「${node.title}」会影响 ${impact.affected.length} 个下游事件；其他 ${impact.unchangedCount} 个事件不受影响。`),
        impact.affected.length ? el('ul', { class: 'forge-list' }, impact.affected.map(item => el('li', {}, `第${item.episode}集 · ${item.title}`))) : null,
        impact.outcomes.length ? el('div', { class: 'note' }, `涉及固定结果：${impact.outcomes.map(item => `第${item.episode}集「${item.title}」${LOCK_LABELS[item.lock]}`).join('；')}`) : null,
        impact.debts.length ? el('div', { class: 'note warn' }, `涉及剧情债务：${impact.debts.map(item => item.question).join('、')}`) : null,
        impact.suggestions.length ? el('ul', { class: 'forge-list' }, impact.suggestions.map(text => el('li', {}, text))) : null,
        row(el('span', { class: 'grow' }), btn('取消', closeModal), btn('确认删除', () => {
          store.project.nodes = store.project.nodes.filter(item => item.id !== node.id);
          store.project.edges = store.project.edges.filter(edge => edge.from !== node.id && edge.to !== node.id);
          for (const outcome of store.project.outcomes) if (outcome.nodeId === node.id) outcome.nodeId = '';
          for (const debt of store.project.debts) { debt.planted = debt.planted.filter(id => id !== node.id); debt.payoff = debt.payoff.filter(id => id !== node.id); }
          if (ui.selectedNodeId === node.id) ui.selectedNodeId = store.project.nodes[0]?.id || null;
          closeModal(); save();
        }, 'danger')));
      openModalBody('删除事件前的影响分析', el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, body));
    } catch (error) { ctx.notify(error.message, true); }
  };
  run();
}

function outcomeModal(outcome) {
  const project = store.project;
  const values = outcome ? { ...outcome } : { episode: ui.range.from, title: '', detail: '', lock: 'soft', leadId: project.cast[0]?.id || '', mechanism: '' };
  const body = el('div', { class: 'stack' },
    field('结果标题', values.title, value => { values.title = value; }, { full: true }),
    row(el('label', { class: 'field' }, '集数', el('input', { type: 'number', min: '1', max: String(project.episodeCount), value: String(values.episode), onInput: event => { values.episode = clamp(event.target.value, 1, project.episodeCount); } })),
      selectField('锁定程度', values.lock, [['hard', '硬锁定 · 不允许模型改'], ['soft', '软锁定 · 可前后微调'], ['open', '自由探索 · 尚未确定']], value => { values.lock = value; }),
      selectField('主要人物', values.leadId, [['', '未指定'], ...project.cast.map(item => [item.id, item.name])], value => { values.leadId = value; })),
    areaField('结果细节', values.detail, value => { values.detail = value; }, { full: true, rows: 3 }),
    field('冲突机制（可选）', values.mechanism, value => { values.mechanism = value; }, { full: true }),
    row(el('span', { class: 'grow' }), outcome ? btn('删除结果', () => {
      store.project.outcomes = store.project.outcomes.filter(item => item.id !== outcome.id);
      for (const node of store.project.nodes) if (node.outcomeId === outcome.id) node.outcomeId = '';
      ui.selectedOutcomeId = store.project.outcomes[0]?.id || null;
      closeModal(); save();
    }, 'quiet danger') : null,
      btn('取消', closeModal),
      btn(outcome ? '保存结果' : '创建结果', () => {
        if (!values.title.trim()) { ctx.notify('结果标题不能为空。', true); return; }
        if (outcome) Object.assign(outcome, values);
        else {
          const created = { id: `goal_${uid()}`, ...values, status: 'planned', nodeId: '', mechanism: values.mechanism };
          store.project.outcomes.push(created);
          ui.selectedOutcomeId = created.id;
          const linkable = project.nodes.find(node => node.episode === created.episode && !node.outcomeId);
          if (linkable) { linkable.outcomeId = created.id; created.nodeId = linkable.id; }
        }
        closeModal(); save();
      }, 'primary')));
  openModalBody(outcome ? '编辑固定结果' : '新建固定结果', el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, body));
}

function castModal(character) {
  const project = store.project;
  const values = character ? { ...character } : { name: '', role: '', faction: '', voice: '', traits: [], desire: '', fear: '', description: '', visualPrompt: '', promptAlias: '', seedPrompt: '', color: '' };
  const body = el('div', { class: 'stack' },
    row(field('名字', values.name, value => { values.name = value; }), field('身份', values.role, value => { values.role = value; })),
    row(field('阵营', values.faction, value => { values.faction = value; }), field('音色备注', values.voice, value => { values.voice = value; })),
    field('性格（逗号分隔）', (values.traits || []).join('、'), value => { values.traits = value.split(/[、,，]/).map(item => item.trim()).filter(Boolean); }, { full: true }),
    field('欲望', values.desire, value => { values.desire = value; }, { full: true }),
    field('恐惧', values.fear, value => { values.fear = value; }, { full: true }),
    areaField('中文外观描述（进分镜与设定）', values.description, value => { values.description = value; }, { full: true, rows: 3 }),
    areaField('英文视觉提示词', values.visualPrompt, value => { values.visualPrompt = value; }, { full: true, rows: 3 }),
    field('提示词短名（promptAlias）', values.promptAlias, value => { values.promptAlias = value; }, { full: true }),
    field('seed_prompt', values.seedPrompt, value => { values.seedPrompt = value; }, { full: true }),
    row(el('span', { class: 'grow' }), character ? btn('删除人物', () => deleteCast(character), 'quiet danger') : null, btn('取消', closeModal), btn(character ? '保存人物' : '创建人物', () => {
      if (!values.name.trim()) { ctx.notify('人物名字不能为空。', true); return; }
      if (character) Object.assign(character, values);
      else { const created = { id: `cast_${uid()}`, ...values }; store.project.cast.push(created); }
      closeModal(); save();
    }, 'primary')));
  openModalBody(character ? '编辑人物' : '新建人物', el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, body));
}

function deleteCast(character) {
  const used = store.project.nodes.filter(node => node.actors.includes(character.id)).length;
  openModalBody('删除人物', el('form', { class: 'stack', onSubmit: event => event.preventDefault() },
    el('p', {}, `「${character.name}」出现在 ${used} 个事件里。删除会同时移除这些事件中的行动者、认知记录与台词归属；事件本身保留。`),
    row(el('span', { class: 'grow' }), btn('取消', closeModal), btn('确认删除', () => {
      store.project.cast = store.project.cast.filter(item => item.id !== character.id);
      for (const node of store.project.nodes) {
        node.actors = node.actors.filter(id => id !== character.id);
        node.knowledge = node.knowledge.filter(entry => entry.characterId !== character.id);
        node.dialogue = node.dialogue.filter(line => line.characterId !== character.id);
      }
      for (const outcome of store.project.outcomes) if (outcome.leadId === character.id) outcome.leadId = '';
      closeModal(); save();
    }, 'danger'))));
}

function debtModal(debt) {
  const project = store.project;
  const values = debt ? { ...debt, planted: [...debt.planted], payoff: [...debt.payoff] } : { question: '', detail: '', status: 'open', planted: [], payoff: [], note: '' };
  const nodeOptions = [...project.nodes].sort((left, right) => left.episode - right.episode);
  const body = el('div', { class: 'stack' },
    field('悬念问题', values.question, value => { values.question = value; }, { full: true, placeholder: '例如：苏媚真正想得到什么？' }),
    areaField('它为什么重要', values.detail, value => { values.detail = value; }, { full: true, rows: 2 }),
    el('label', { class: 'field' }, '埋设事件（可多选）', el('div', { class: 'chip-row' }, nodeOptions.map(node => el('label', { class: 'check-chip' },
      el('input', { type: 'checkbox', checked: values.planted.includes(node.id), onChange: event => { values.planted = event.target.checked ? [...values.planted, node.id] : values.planted.filter(id => id !== node.id); } }),
      `第${node.episode}集 ${node.title}`.slice(0, 22))))),
    el('label', { class: 'field' }, '回收事件（可多选）', el('div', { class: 'chip-row' }, nodeOptions.map(node => el('label', { class: 'check-chip' },
      el('input', { type: 'checkbox', checked: values.payoff.includes(node.id), onChange: event => { values.payoff = event.target.checked ? [...values.payoff, node.id] : values.payoff.filter(id => id !== node.id); } }),
      `第${node.episode}集 ${node.title}`.slice(0, 22))))),
    field('备注', values.note, value => { values.note = value; }, { full: true }),
    row(el('span', { class: 'grow' }), btn('取消', closeModal), btn(debt ? '保存债务' : '创建债务', () => {
      if (!values.question.trim()) { ctx.notify('悬念问题不能为空。', true); return; }
      if (debt) Object.assign(debt, values);
      else store.project.debts.push({ id: `debt_${uid()}`, ...values });
      closeModal(); save();
    }, 'primary')));
  openModalBody(debt ? '编辑剧情债务' : '新建剧情债务', el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, body));
}

function projectSettingsModal() {
  const project = store.project;
  const values = { title: project.title, logline: project.logline, genre: project.genre, theme: project.theme, style: project.style, aspectRatio: project.aspectRatio, episodeCount: project.episodeCount, rules: project.world.rules, tone: project.world.tone };
  const body = el('div', { class: 'stack' },
    field('项目名', values.title, value => { values.title = value; }, { full: true }),
    field('一句话', values.logline, value => { values.logline = value; }, { full: true }),
    row(field('类型', values.genre, value => { values.genre = value; }), field('画幅', values.aspectRatio, value => { values.aspectRatio = value; })),
    field('主题', values.theme, value => { values.theme = value; }, { full: true }),
    row(el('label', { class: 'field' }, '总集数', el('input', { type: 'number', min: '1', max: '120', value: String(values.episodeCount), onInput: event => { values.episodeCount = clamp(event.target.value, 1, 120); } })),
      el('span', { class: 'note grow' }, '缩小集数会把超出范围的事件夹到最后一集；先确认没有硬锁定结果受影响。')),
    areaField('世界规则（一条一行）', values.rules, value => { values.rules = value; }, { full: true, rows: 4 }),
    areaField('全局风格 / 画面口径', values.style, value => { values.style = value; }, { full: true, rows: 5 }),
    row(el('span', { class: 'grow' }), btn('删除整个项目', () => deleteProject(), 'quiet danger'), btn('取消', closeModal), btn('保存设定', () => {
      Object.assign(store.project, {
        title: values.title.trim() || project.title, logline: values.logline, genre: values.genre, theme: values.theme,
        style: values.style, aspectRatio: values.aspectRatio, episodeCount: values.episodeCount,
        world: { rules: values.rules, tone: values.tone },
      });
      syncRange();
      closeModal(); save();
    }, 'primary')));
  openModalBody('项目设定', el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, body));
}

function deleteProject() {
  const project = store.project;
  openModalBody('删除因果剧本项目', el('form', { class: 'stack', onSubmit: event => event.preventDefault() },
    el('p', {}, `将删除「${project.title}」以及它的 ${project.nodes.length} 个事件、${project.outcomes.length} 个固定结果。已发布的分镜作品不会被删除。`),
    row(el('span', { class: 'grow' }), btn('取消', closeModal), btn('确认删除', async () => {
      try {
        await ctx.api(`/api/forge/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
        ui.loaded = false; ui.selectedNodeId = null; ui.selectedOutcomeId = null; ui.aiResult = null; ui.exportText = '';
        closeModal();
        await load();
      } catch (error) { ctx.notify(error.message, true); }
    }, 'danger'))));
}

function createProjectModal() {
  const studioProjects = ctx.getStudioState()?.projects || [];
  const values = { title: '', logline: '', episodeCount: 20, fromProjectId: '' };
  const body = el('div', { class: 'stack' },
    field('项目名', values.title, value => { values.title = value; }, { full: true, placeholder: '例如：F级废物？我在禁区建立龙娘部落' }),
    field('一句话', values.logline, value => { values.logline = value; }, { full: true }),
    el('label', { class: 'field' }, '总集数', el('input', { type: 'number', min: '1', max: '120', value: String(values.episodeCount), onInput: event => { values.episodeCount = clamp(event.target.value, 1, 120); } })),
    studioProjects.length ? el('label', { class: 'field' }, '从已有分镜作品带入角色与地点（可选）',
      el('select', { onChange: event => { values.fromProjectId = event.target.value; } },
        el('option', { value: '' }, '不导入'), studioProjects.map(item => el('option', { value: item.id }, item.title)))) : null,
    row(el('span', { class: 'grow' }), btn('取消', closeModal), btn('创建', async () => {
      if (!values.title.trim()) { ctx.notify('项目名不能为空。', true); return; }
      try {
        const result = await ctx.api('/api/forge/projects', {
          method: 'POST',
          body: values.fromProjectId
            ? { fromProjectId: values.fromProjectId, title: values.title.trim() }
            : { title: values.title.trim(), logline: values.logline, episodeCount: values.episodeCount },
        });
        store.project = result.project; store.analysis = result.analysis;
        const fresh = await ctx.api('/api/forge/state');
        store.projects = fresh.projects;
        ui.selectedNodeId = result.project.nodes[0]?.id || null;
        ui.selectedOutcomeId = result.project.outcomes[0]?.id || null;
        ui.targetOutcomeId = result.project.outcomes[0]?.id || '';
        ui.range = null; ui.aiResult = null; ui.exportText = ''; syncRange();
        closeModal(); render();
        ctx.notify('剧本项目已创建');
      } catch (error) { ctx.notify(error.message, true); }
    }, 'primary')));
  openModalBody('新建因果剧本', el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, body));
}

function importCastModal() {
  const studioProjects = ctx.getStudioState()?.projects || [];
  if (!studioProjects.length) { ctx.notify('工作台里还没有分镜作品。', true); return; }
  const projectId = ctx.getStudioState()?.project?.id || studioProjects[0].id;
  openModalBody('从分镜作品带入人物与地点', el('form', { class: 'stack', onSubmit: event => event.preventDefault() },
    el('p', {}, '只把角色名、外观提示词和场景设定复制过来，不复制镜头与生成结果。'),
    el('label', { class: 'field' }, '作品', el('select', { id: 'forge-import-project' }, studioProjects.map(item => el('option', { value: item.id, selected: item.id === projectId }, item.title)))),
    row(el('span', { class: 'grow' }), btn('取消', closeModal), btn('带入', async () => {
      try {
        const chosen = document.getElementById('forge-import-project')?.value;
        const state = await ctx.api(`/api/state?projectId=${encodeURIComponent(chosen)}`);
        const characters = state.project.assets.filter(asset => asset.type === 'character');
        const locations = state.project.assets.filter(asset => asset.type === 'location');
        let added = 0;
        for (const character of characters) {
          if (store.project.cast.some(item => item.name === character.name)) continue;
          store.project.cast.push({
            id: `cast_${uid()}`, name: character.name, role: character.data?.details?.role || '', faction: '', voice: '',
            traits: [], desire: '', fear: '', description: character.data?.description || '',
            visualPrompt: character.data?.visualPrompt || '', promptAlias: character.data?.visualPrompt || character.name,
            seedPrompt: character.data?.seedPrompt || '', color: '',
          });
          added += 1;
        }
        for (const location of locations) {
          if (store.project.locations.some(item => item.code === location.code || item.name === location.name)) continue;
          store.project.locations.push({
            id: `loc_${uid()}`, code: location.code, name: location.name, heading: location.data?.details?.scene_heading || '',
            description: location.data?.description || '', visualPrompt: location.data?.visualPrompt || '', seedPrompt: location.data?.seedPrompt || '', tone: '',
          });
          added += 1;
        }
        closeModal(); save();
        ctx.notify(added ? `已带入 ${added} 个角色/场景` : '没有新的角色或场景可带入');
      } catch (error) { ctx.notify(error.message, true); }
    }, 'primary'))));
}

function llmModal() {
  const llm = store.llm || {};
  const providers = llm.providers || [];
  const current = llm.settings || {};
  let provider = providers.find(item => item.id === current.provider) || providers[0] || { id: 'custom', baseUrl: '', models: [] };
  const baseUrl = el('input', { value: current.baseUrl || provider.baseUrl || '', placeholder: 'https://.../v1' });
  const model = el('input', { value: current.model || '', placeholder: '模型名称', list: 'forge-model-list' });
  const datalist = el('datalist', { id: 'forge-model-list' }, (provider.models || []).map(item => el('option', { value: item })));
  const apiKey = el('input', { type: 'password', autocomplete: 'new-password', placeholder: current.hasKey ? '已保存；填写新 Key 可替换' : '输入 API Key' });
  const temperature = el('input', { type: 'number', min: '0', max: '2', step: '0.1', value: String(current.temperature ?? 0.3) });
  const status = el('div', { class: 'note' }, current.hasKey ? `密钥来源：${current.keySource === 'env' ? '环境变量 FORGE_LLM_API_KEY' : '本机 DPAPI 加密文件'}` : '尚未保存 Key；Ollama 与本地网关可以不填。');
  const providerSelect = el('select', {}, providers.map(item => el('option', { value: item.id, selected: item.id === provider.id }, item.label)));
  const syncProvider = () => {
    provider = providers.find(item => item.id === providerSelect.value) || provider;
    baseUrl.value = provider.baseUrl || baseUrl.value;
    if (!provider.models.includes(model.value)) model.value = provider.models[0] || model.value;
    datalist.replaceChildren(...(provider.models || []).map(item => el('option', { value: item })));
  };
  providerSelect.addEventListener('change', syncProvider);
  const saveSettings = async (notifyMessage = '') => {
    const result = await ctx.api('/api/forge/llm', {
      method: 'PUT',
      body: { provider: providerSelect.value, baseUrl: baseUrl.value, model: model.value, temperature: Number(temperature.value), apiKey: apiKey.value.trim() },
    });
    store.llm = result;
    apiKey.value = '';
    if (notifyMessage) ctx.notify(notifyMessage);
    return result;
  };
  const body = el('div', { class: 'stack' },
    el('p', { class: 'muted' }, '设置结构参考 Servant：服务商 / 模型 / API Key / 温度。只走 OpenAI 兼容的 /chat/completions；密钥只存本机，不进入浏览器 localStorage、导出或提示词。'),
    el('div', { class: 'forge-grid-2' },
      el('label', { class: 'field' }, '服务商', providerSelect),
      el('label', { class: 'field' }, '模型', model, datalist),
      el('label', { class: 'field full' }, '接口地址', baseUrl),
      el('label', { class: 'field full' }, 'API Key', apiKey)),
    el('div', { class: 'row wrap' }, el('label', { class: 'field' }, '温度', temperature),
      btn('测试连接', async () => {
        try {
          await saveSettings();
          const result = await ctx.api('/api/forge/llm/test', { method: 'POST', body: {} });
          status.textContent = `连接成功：${result.provider} / ${result.model}${result.models?.length ? `（${result.models.length} 个可用模型）` : ''}，${result.latencyMs} ms`;
          status.className = 'note';
        } catch (error) { status.textContent = error.message; status.className = 'note error'; }
      }, 'small'),
      btn('读取模型列表', async () => {
        try {
          await saveSettings();
          const result = await ctx.api('/api/forge/llm/models');
          datalist.replaceChildren(...(result.models || []).map(item => el('option', { value: item })));
          status.textContent = `已读取 ${result.models?.length || 0} 个模型，可从模型输入框下拉选择。`;
          status.className = 'note';
        } catch (error) { status.textContent = error.message; status.className = 'note error'; }
      }, 'quiet small'),
      el('span', { class: 'grow' }),
      btn('取消', closeModal),
      btn('保存', async () => {
        try { await saveSettings('LLM 设置已保存'); render(); closeModal(); }
        catch (error) { status.textContent = error.message; status.className = 'note error'; }
      }, 'primary')),
    status,
    el('details', {}, el('summary', {}, '服务商一览'),
      el('ul', { class: 'forge-list' }, providers.map(item => el('li', {}, `${item.label} · ${item.baseUrl || '自定义'}${item.note ? `｜${item.note}` : ''}`)))) ,
    el('p', { class: 'forge-hint' }, '环境变量优先：FORGE_LLM_PROVIDER / FORGE_LLM_BASE_URL / FORGE_LLM_MODEL / FORGE_LLM_API_KEY。设置窗口不会显示已保存的 Key。'));
  openModalBody('LLM 设置 · 因果剧本工作台', el('form', { class: 'stack', onSubmit: event => event.preventDefault() }, body));
}

/* —— 项目切换 —— */
async function selectProject(projectId) {
  if (!projectId) return;
  if (ui.saving) { ctx.notify('正在保存当前剧本，请保存完成后再切换。'); render(); return; }
  if (ui.dirty) { await save(); if (ui.dirty || ui.saving) { render(); return; } }
  ui.loading = true;
  render();
  try {
    const result = await ctx.api(`/api/forge/projects/${encodeURIComponent(projectId)}/select`, { method: 'POST', body: {} });
    store.project = result.project;
    store.analysis = result.analysis;
    ui.selectedNodeId = result.project.nodes[0]?.id || null;
    ui.selectedOutcomeId = result.project.outcomes[0]?.id || null;
    ui.targetOutcomeId = result.project.outcomes.find(item => item.lock === 'hard')?.id || result.project.outcomes[0]?.id || '';
    ui.range = null; ui.aiResult = null; ui.aiError = null; ui.exportText = '';
    syncRange();
  } catch (error) { ctx.notify(error.message, true); }
  finally { ui.loading = false; render(); }
}

// Esc 取消连线。
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && ui.connectFrom) { ui.connectFrom = null; render(); }
});
