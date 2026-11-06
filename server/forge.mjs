import { createHash, randomUUID } from 'node:crypto';

// 因果剧本工作台：结构化故事状态。
// 这里只做确定性的事——规范化、结构校验、改动影响、拆集与导出。
// 需要判断动机、情绪与创造性时，交给 forge-ai.mjs 调外部模型，模型结果永远先当建议，不直接改库。

export const LOCK_LEVELS = ['hard', 'soft', 'open'];
export const LOCK_LABELS = { hard: '硬锁定', soft: '软锁定', open: '自由探索' };
export const EDGE_TYPES = ['cause', 'requires', 'motive', 'payoff'];
export const EDGE_LABELS = { cause: '直接因果', requires: '必要前提', motive: '动机影响', payoff: '伏笔回收' };
export const KNOWLEDGE_LEVELS = ['knows', 'partial', 'unaware'];
export const KNOWLEDGE_LABELS = { knows: '知道全部', partial: '掌握部分', unaware: '尚不知情' };
export const LIMITS = { cast: 60, locations: 40, outcomes: 80, nodes: 400, edges: 1200, debts: 80, branches: 80 };
const MAX_EPISODES = 120;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max = 4000) => (typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '');
const list = value => (Array.isArray(value) ? value : []);
const record = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const uid = prefix => `${prefix}_${randomUUID()}`;
const uniqueId = (prefix, used) => {
  let id;
  do { id = uid(prefix); } while (used.has(id));
  used.add(id);
  return id;
};
const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};
const lines = (value, max, length) => list(value).map(item => text(item, length)).filter(Boolean).slice(0, max);

export function createProject(input = {}) {
  const title = text(input.title, 120) || '未命名剧本';
  return normalizeProject({
    title,
    logline: text(input.logline, 600),
    genre: text(input.genre, 120) || 'AI 短剧',
    theme: text(input.theme, 400),
    style: text(input.style, 6000),
    aspectRatio: text(input.aspectRatio, 12) || '9:16',
    episodeCount: input.episodeCount ?? 20,
    world: input.world,
    cast: input.cast,
    locations: input.locations,
    outcomes: input.outcomes,
    nodes: input.nodes,
    edges: input.edges,
    debts: input.debts,
    branches: input.branches,
    script: input.script,
  }, { id: uid('forge') });
}

export function normalizeProject(input, { id } = {}) {
  const source = record(input);
  const projectId = id || (typeof source.id === 'string' && /^forge_[a-zA-Z0-9_-]{6,80}$/.test(source.id) ? source.id : uid('forge'));
  const episodeCount = clampInt(source.episodeCount, 1, MAX_EPISODES, 20);
  const used = new Set();

  const cast = list(source.cast).slice(0, LIMITS.cast).map((item, index) => {
    const value = record(item);
    const itemId = typeof value.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(value.id) && !used.has(value.id) ? value.id : uniqueId('cast', used);
    used.add(itemId);
    return {
      id: itemId,
      name: text(value.name, 40) || `角色${index + 1}`,
      role: text(value.role, 40),
      faction: text(value.faction, 40),
      voice: text(value.voice, 60),
      traits: lines(value.traits, 12, 24),
      desire: text(value.desire, 300),
      fear: text(value.fear, 300),
      description: text(value.description, 1200),
      visualPrompt: text(value.visualPrompt, 1600),
      promptAlias: text(value.promptAlias, 400),
      seedPrompt: text(value.seedPrompt, 600),
      color: /^#[0-9a-fA-F]{6}$/.test(value.color || '') ? value.color : '',
    };
  });
  const castIds = new Set(cast.map(item => item.id));

  const usedCodes = new Set();
  const locations = list(source.locations).slice(0, LIMITS.locations).map((item, index) => {
    const value = record(item);
    let code = text(value.code, 2).toUpperCase();
    if (!/^[A-Z]$/.test(code) || usedCodes.has(code)) {
      code = '';
      for (let cursor = 0; cursor < 26; cursor++) {
        const candidate = String.fromCharCode(65 + ((index + cursor) % 26));
        if (!usedCodes.has(candidate)) { code = candidate; break; }
      }
    }
    usedCodes.add(code);
    return {
      id: typeof value.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(value.id) && !used.has(value.id) ? value.id : uniqueId('loc', used),
      code,
      name: text(value.name, 60) || `场景${code}`,
      heading: text(value.heading, 120),
      description: text(value.description, 1200),
      visualPrompt: text(value.visualPrompt, 1600),
      seedPrompt: text(value.seedPrompt, 600),
      tone: text(value.tone, 200),
    };
  });
  const locationIds = new Set(locations.map(item => item.id));

  const outcomes = list(source.outcomes).slice(0, LIMITS.outcomes).map((item, index) => {
    const value = record(item);
    return {
      id: typeof value.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(value.id) && !used.has(value.id) ? value.id : uniqueId('goal', used),
      episode: clampInt(value.episode, 1, episodeCount, Math.min(index + 1, episodeCount)),
      title: text(value.title, 100) || `第${index + 1}个结果`,
      detail: text(value.detail, 1200),
      lock: LOCK_LEVELS.includes(value.lock) ? value.lock : 'soft',
      status: value.status === 'achieved' ? 'achieved' : 'planned',
      leadId: castIds.has(value.leadId) ? value.leadId : '',
      nodeId: '',
      rawNodeId: text(value.nodeId, 80),
      mechanism: text(value.mechanism, 200),
    };
  });
  const outcomeIds = new Set(outcomes.map(item => item.id));

  const rawNodes = list(source.nodes).slice(0, LIMITS.nodes);
  const nodes = rawNodes.map((item, index) => {
    const value = record(item);
    const nodeId = typeof value.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(value.id) && !used.has(value.id) ? value.id : uniqueId('node', used);
    used.add(nodeId);
    const entry = {
      id: nodeId,
      code: text(value.code, 12) || `N${String(index + 1).padStart(2, '0')}`,
      title: text(value.title, 100) || `事件${index + 1}`,
      episode: clampInt(value.episode, 1, episodeCount, 1),
      order: Math.max(0, Math.floor(Number(value.order) || 0)),
      status: value.status === 'confirmed' ? 'confirmed' : 'draft',
      goal: text(value.goal, 400),
      preconditions: lines(value.preconditions, 12, 140),
      actors: list(value.actors).map(id => text(id, 80)).filter(id => castIds.has(id)).slice(0, 12),
      motive: text(value.motive, 500),
      action: text(value.action, 1200),
      result: text(value.result, 800),
      stateChanges: lines(value.stateChanges, 12, 200),
      foreshadow: text(value.foreshadow, 400),
      beats: lines(value.beats, 14, 260),
      tone: text(value.tone, 160),
      locationId: locationIds.has(value.locationId) ? value.locationId : '',
      outcomeId: '',
      x: Number.isFinite(value.x) ? Math.round(value.x) : null,
      y: Number.isFinite(value.y) ? Math.round(value.y) : null,
      knowledge: [],
      dialogue: [],
      debtIds: [],
    };
    entry._rawKnowledge = list(value.knowledge).slice(0, 60);
    entry._rawDialogue = list(value.dialogue).slice(0, 30);
    entry._rawOutcomeId = value.outcomeId;
    entry._rawDebtIds = list(value.debtIds).slice(0, 20);
    return entry;
  });
  const nodeIds = new Set(nodes.map(node => node.id));

  const debts = list(source.debts).slice(0, LIMITS.debts).map((item, index) => {
    const value = record(item);
    return {
      id: typeof value.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(value.id) && !used.has(value.id) ? value.id : uniqueId('debt', used),
      question: text(value.question, 160) || `未命名悬念${index + 1}`,
      detail: text(value.detail, 800),
      status: value.status === 'paid' ? 'paid' : 'open',
      planted: list(value.planted).filter(nodeId => nodeIds.has(nodeId)).slice(0, 12),
      payoff: list(value.payoff).filter(nodeId => nodeIds.has(nodeId)).slice(0, 12),
      note: text(value.note, 600),
    };
  });
  const debtIds = new Set(debts.map(item => item.id));

  for (const node of nodes) {
    node.outcomeId = outcomeIds.has(node._rawOutcomeId) ? node._rawOutcomeId : '';
    node.debtIds = node._rawDebtIds.filter(id => debtIds.has(id));
    node.knowledge = node._rawKnowledge.map(entry => {
      const value = record(entry);
      return {
        characterId: castIds.has(value.characterId) ? value.characterId : '',
        level: KNOWLEDGE_LEVELS.includes(value.level) ? value.level : 'partial',
        subject: text(value.subject, 160),
        note: text(value.note, 300),
        learnedAt: nodeIds.has(value.learnedAt) ? value.learnedAt : '',
      };
    }).filter(entry => entry.characterId);
    node.dialogue = node._rawDialogue.map(entry => {
      const value = record(entry);
      return {
        characterId: castIds.has(value.characterId) ? value.characterId : '',
        speaker: text(value.speaker, 40),
        line: text(value.line, 300),
        tone: text(value.tone, 40),
      };
    }).filter(entry => entry.line);
    delete node._rawKnowledge;
    delete node._rawDialogue;
    delete node._rawOutcomeId;
    delete node._rawDebtIds;
  }
  // 固定结果回填节点引用：先认结果自己记的 nodeId，再认节点写的 outcomeId，最后才按集数认领一个还没归属的事件。
  for (const outcome of outcomes) {
    const explicit = nodes.find(node => node.id === outcome.rawNodeId) || nodes.find(node => node.outcomeId === outcome.id)
      || (outcome.lock !== 'open' ? nodes.find(node => node.episode === outcome.episode && !node.outcomeId) : null);
    if (explicit) {
      explicit.outcomeId = outcome.id;
      outcome.nodeId = explicit.id;
    }
    delete outcome.rawNodeId;
  }
  for (const outcome of outcomes) if (outcome.nodeId && !nodeIds.has(outcome.nodeId)) outcome.nodeId = '';

  const seenEdges = new Set();
  const edges = list(source.edges).slice(0, LIMITS.edges).map(item => {
    const value = record(item);
    const from = nodeIds.has(value.from) ? value.from : '';
    const to = nodeIds.has(value.to) ? value.to : '';
    const type = EDGE_TYPES.includes(value.type) ? value.type : 'cause';
    if (!from || !to || from === to) return null;
    const key = `${from}|${to}|${type}`;
    if (seenEdges.has(key)) return null;
    seenEdges.add(key);
    return {
      id: typeof value.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(value.id) && !used.has(value.id) ? value.id : uniqueId('edge', used),
      from, to, type,
      note: text(value.note, 300),
    };
  }).filter(Boolean);

  const branches = list(source.branches).slice(0, LIMITS.branches).map(item => {
    const value = record(item);
    return {
      id: typeof value.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(value.id) && !used.has(value.id) ? value.id : uniqueId('branch', used),
      nodeId: nodeIds.has(value.nodeId) ? value.nodeId : '',
      name: text(value.name, 100) || '未命名分支',
      approach: text(value.approach, 300),
      summary: text(value.summary, 1200),
      pros: text(value.pros, 600),
      cons: text(value.cons, 600),
      status: ['draft', 'merged', 'discarded'].includes(value.status) ? value.status : 'draft',
      createdAt: text(value.createdAt, 40) || new Date().toISOString(),
      source: text(value.source, 20) || 'local',
      events: list(value.events).slice(0, 12).map(entry => {
        const event = record(entry);
        return {
          episode: clampInt(event.episode, 1, episodeCount, 1),
          title: text(event.title, 100),
          action: text(event.action, 800),
          result: text(event.result, 500),
          preconditions: lines(event.preconditions, 8, 140),
          actors: list(event.actors).filter(actorId => castIds.has(actorId)).slice(0, 8),
        };
      }).filter(event => event.title),
    };
  });

  const script = normalizeScript(source.script, { episodeCount, nodeIds });

  return {
    id: projectId,
    title: text(source.title, 120) || '未命名剧本',
    logline: text(source.logline, 600),
    genre: text(source.genre, 160) || 'AI 短剧',
    theme: text(source.theme, 400),
    style: text(source.style, 6000),
    aspectRatio: text(source.aspectRatio, 12) || '9:16',
    episodeCount,
    world: {
      rules: text(record(source.world).rules, 3000),
      tone: text(record(source.world).tone, 400),
    },
    cast, locations, outcomes, nodes, edges, debts, branches, script,
    createdAt: text(source.createdAt, 40) || new Date().toISOString(),
    updatedAt: text(source.updatedAt, 40) || new Date().toISOString(),
  };
}

function normalizeScript(input, { episodeCount, nodeIds }) {
  const value = record(input);
  if (!Array.isArray(value.scenes) || !value.scenes.length) return null;
  const scenes = value.scenes.slice(0, 200).map((item, index) => {
    const scene = record(item);
    return {
      episode: clampInt(scene.episode, 1, episodeCount, index + 1),
      title: text(scene.title, 140) || `第${index + 1}场`,
      locationCode: text(scene.locationCode, 2).toUpperCase().slice(0, 1),
      note: text(scene.note, 400),
      shots: list(scene.shots).slice(0, 40).map(shot => {
        const entry = record(shot);
        return {
          title: text(entry.title, 100) || '未命名镜头',
          shotSize: text(entry.shotSize || entry.size, 60) || '中景（MS）',
          composition: text(entry.composition, 400),
          camera: text(entry.camera, 200) || '固定',
          action: lines(entry.action, 8, 400),
          dialogue: list(entry.dialogue).slice(0, 8).map(line => {
            const item = record(line);
            return { characterId: '', speaker: text(item.speaker, 40), line: text(item.line, 300) };
          }).filter(line => line.line),
          mood: text(entry.mood, 200),
          transition: text(entry.transition, 60) || '硬切',
          duration: clampInt(entry.duration, 1, 30, 4),
          videoPrompt: text(entry.videoPrompt, 2000),
        };
      }).filter(shot => shot.title),
    };
  }).filter(scene => scene.shots.length);
  if (!scenes.length) return null;
  return {
    generatedAt: text(value.generatedAt, 40) || new Date().toISOString(),
    source: value.source === 'llm' ? 'llm' : 'template',
    model: text(value.model, 120),
    fingerprint: text(value.fingerprint, 80) || '',
    scenes,
  };
}

export function fingerprint(project) {
  const payload = {
    episodeCount: project.episodeCount,
    cast: project.cast.map(item => [item.id, item.name]),
    nodes: project.nodes.map(node => [node.id, node.episode, node.title, node.action, node.result, node.tone, node.beats, node.dialogue.map(line => [line.speaker, line.line]), node.knowledge.map(entry => [entry.characterId, entry.level, entry.subject])]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32).toUpperCase();
}

/* —— 确定性校验 —— */
const tokens = value => {
  const normalized = String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const set = new Set();
  for (let index = 0; index < normalized.length - 1; index++) set.add(normalized.slice(index, index + 2));
  return set;
};
const coverage = (needle, haystack) => {
  const left = tokens(needle);
  if (!left.size) return 1;
  const right = tokens(haystack);
  let hit = 0;
  for (const token of left) if (right.has(token)) hit++;
  return hit / left.size;
};
const nodeText = node => [node.goal, node.action, node.result, ...(node.stateChanges || []), ...(node.beats || [])].filter(Boolean).join(' ');
const incomingOf = (project, nodeId) => project.edges.filter(edge => edge.to === nodeId);
const outgoingOf = (project, nodeId) => project.edges.filter(edge => edge.from === nodeId);
function ancestorCorpus(project, nodeId) {
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  const parts = [];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of incomingOf(project, current)) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      const node = project.nodes.find(item => item.id === edge.from);
      if (!node) continue;
      parts.push(nodeText(node));
      queue.push(node.id);
    }
  }
  return parts.join(' ');
}
function ancestorIds(project, nodeId) {
  const seen = new Set();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of incomingOf(project, current)) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      queue.push(edge.from);
    }
  }
  return seen;
}
function descendants(project, nodeId) {
  const seen = new Set();
  const result = [];
  const queue = [{ id: nodeId, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of outgoingOf(project, current.id)) {
      if (seen.has(edge.to) || edge.to === nodeId) continue;
      seen.add(edge.to);
      const node = project.nodes.find(item => item.id === edge.to);
      if (!node) continue;
      result.push({ node, depth: current.depth + 1 });
      queue.push({ id: node.id, depth: current.depth + 1 });
    }
  }
  return result.sort((left, right) => left.node.episode - right.node.episode || left.depth - right.depth);
}

export function analyze(project) {
  const issues = [];
  const push = (level, code, title, detail, extra = {}) => issues.push({ id: `${code}:${extra.nodeId || extra.outcomeId || extra.debtId || issues.length}`, level, code, title, detail, ...extra });
  const nodeById = new Map(project.nodes.map(node => [node.id, node]));
  const castById = new Map(project.cast.map(item => [item.id, item]));
  const lastEpisode = Math.max(0, ...project.nodes.map(node => node.episode));

  if (!project.cast.length) push('warn', 'CAST_EMPTY', '还没有人物', '先建立人物与欲望，人物模拟器才能判断行动是否可信。');
  if (!project.outcomes.length) push('warn', 'OUTCOME_EMPTY', '还没有固定结果', '没有终点时，AI 只能续写，无法倒推。至少给一个硬锁定结果。');

  for (const node of project.nodes) {
    if (!node.actors.length) push('warn', 'NODE_NO_ACTOR', `「${node.title}」没有行动者`, '事件缺少推动者时，人物状态与动机校验不会生效。', { nodeId: node.id, episode: node.episode });
    if (!node.goal) push('warn', 'NODE_GOAL_MISSING', `「${node.title}」没写事件目标`, '事件目标决定这次改动服务哪条线，建议补一句“我希望实现什么”。', { nodeId: node.id, episode: node.episode });
    if (!node.result) push('warn', 'NODE_RESULT_MISSING', `「${node.title}」没写直接结果`, '没有结果就无法给下游事件提供前提。', { nodeId: node.id, episode: node.episode });
    const edgesIn = incomingOf(project, node.id);
    const edgesOut = outgoingOf(project, node.id);
    if (!edgesIn.length && !edgesOut.length && !node.outcomeId) push('warn', 'NODE_UNLINKED', `「${node.title}」是孤立事件`, '它既没有因果连线，也不属于任何固定结果；检查是否漏了上下游。', { nodeId: node.id, episode: node.episode });
    const upstream = ancestorIds(project, node.id);
    const corpus = ancestorCorpus(project, node.id);
    const hasUpstream = upstream.size > 0;
    if (node.preconditions.length && hasUpstream && !edgesIn.length) {
      push('warn', 'PRECONDITION_NO_EDGE', `「${node.title}」有前提却没有因果连线`, '写了前置条件，但没有任何入边，前提无法追溯到事件。', { nodeId: node.id, episode: node.episode });
    }
    // 文字前提只做保守的确定性检查：低于 20% 的双字重合才判定“上游完全没提过”。
    // 语义是否真的成立，交给剧情审查员；删除事件时的影响分析会用更严格的阈值，宁可多报。
    const gaps = node.preconditions.filter(condition => coverage(condition, corpus) < 0.2);
    if (gaps.length && edgesIn.length) {
      push('warn', 'PRECONDITION_GAP', `「${node.title}」的前提在上游找不到依据`, `缺少：${gaps.join('、')}。补一个中间事件，或把该事实并入上游事件的结果。`, { nodeId: node.id, episode: node.episode, missing: gaps });
    }
    for (const entry of node.knowledge) {
      const character = castById.get(entry.characterId);
      if (!character) continue;
      if (entry.level !== 'unaware' && !entry.learnedAt) {
        push('warn', 'KNOWLEDGE_SOURCE', `${character.name}在「${node.title}」的认知缺少来源`, '“知道/部分知道”应指向让他获知的那一集事件，否则后续对白可能凭空知道。', { nodeId: node.id, episode: node.episode });
      }
      const learned = entry.learnedAt ? nodeById.get(entry.learnedAt) : null;
      if (learned && learned.episode > node.episode) {
        push('error', 'KNOWLEDGE_TIMELINE', `${character.name}在第 ${node.episode} 集知道了第 ${learned.episode} 集才发生的事`, `认知来源「${learned.title}」晚于当前事件，时间线矛盾。`, { nodeId: node.id, episode: node.episode });
      } else if (learned && learned.id !== node.id && !upstream.has(learned.id)) {
        push('warn', 'KNOWLEDGE_UPSTREAM', `${character.name}的认知来源不在「${node.title}」的上游`, '该认知来自一条没有因果路径的事件；如果是有意为之（旁听、传闻），请在备注里写清传播方式。', { nodeId: node.id, episode: node.episode });
      }
    }
    const sameEpisode = project.nodes.filter(item => item.episode === node.episode);
    if (sameEpisode.length > 5) push('warn', 'EPISODE_DENSE', `第 ${node.episode} 集塞了 ${sameEpisode.length} 个事件`, '60–90 秒一集通常只放得下 3–5 个事件；考虑拆集或合并。', { nodeId: node.id, episode: node.episode });
  }

  for (const edge of project.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    if (from.episode > to.episode) {
      push('error', 'EDGE_TIME_REVERSED', `因果方向早于结果：${from.title} → ${to.title}`, `第 ${from.episode} 集的事件不可能成为第 ${to.episode} 集事件的原因。`, { nodeId: to.id, episode: to.episode });
    }
  }

  const hardByEpisode = new Map();
  for (const outcome of project.outcomes) {
    const node = outcome.nodeId ? nodeById.get(outcome.nodeId) : null;
    if (!node) {
      push(outcome.lock === 'hard' ? 'error' : 'warn', 'OUTCOME_UNLINKED', `固定结果「${outcome.title}」没有对应事件`, `第 ${outcome.episode} 集的结果必须落在一个具体事件上，否则无法校验它是否成立。`, { outcomeId: outcome.id, episode: outcome.episode });
    } else if (node.episode !== outcome.episode) {
      push('error', 'OUTCOME_EPISODE_MISMATCH', `「${outcome.title}」的集数与事件不一致`, `结果写第 ${outcome.episode} 集，事件「${node.title}」却在第 ${node.episode} 集。`, { outcomeId: outcome.id, nodeId: node.id, episode: outcome.episode });
    }
    if (outcome.lock === 'hard') {
      if (!hardByEpisode.has(outcome.episode)) hardByEpisode.set(outcome.episode, []);
      hardByEpisode.get(outcome.episode).push(outcome);
    }
  }
  for (const [episode, outcomes] of hardByEpisode) {
    if (outcomes.length > 1) push('warn', 'OUTCOME_DUPLICATE_EPISODE', `第 ${episode} 集有 ${outcomes.length} 个硬锁定结果`, '同一集只保留一个不可变结果，其余改成软锁定或移到相邻集，否则 AI 无法判断该保哪一条。', { episode, outcomeId: outcomes[1].id });
  }

  if (lastEpisode && !project.nodes.some(node => node.episode === 1)) push('warn', 'START_EPISODE_EMPTY', '第 1 集没有事件', '故事的起点最好有一个已确认事件，后续倒推才有落点。', { episode: 1 });
  const episodesWithNodes = new Set(project.nodes.map(node => node.episode));
  const emptyEpisodes = [];
  for (let episode = 1; episode <= Math.min(lastEpisode, project.episodeCount); episode++) {
    if (!episodesWithNodes.has(episode)) emptyEpisodes.push(episode);
  }
  if (emptyEpisodes.length) push('warn', 'EPISODE_EMPTY', `${emptyEpisodes.length} 集还没有事件`, `第 ${emptyEpisodes.join('、')} 集在因果图上完全是空的；如果只是还没设计，可以标记为自由探索。`, { episode: emptyEpisodes[0], episodes: emptyEpisodes });

  for (const debt of project.debts) {
    if (!debt.planted.length) push('warn', 'DEBT_NO_PLANT', `悬念「${debt.question}」没有埋设点`, '没有埋设的债务无法被观众感知，也无法计算回收成本。', { debtId: debt.id });
    if (!debt.payoff.length && debt.status !== 'paid') push('warn', 'DEBT_UNPAID', `悬念「${debt.question}」尚未兑现`, '它仍是一项剧情债务；删除埋设事件时会被影响分析拦下。', { debtId: debt.id });
    const planted = debt.planted.map(id => nodeById.get(id)).filter(Boolean);
    const payoff = debt.payoff.map(id => nodeById.get(id)).filter(Boolean);
    const latestPlant = Math.max(0, ...planted.map(node => node.episode));
    const earliestPayoff = payoff.length ? Math.min(...payoff.map(node => node.episode)) : 0;
    if (earliestPayoff && latestPlant && earliestPayoff < latestPlant) push('error', 'DEBT_ORDER', `悬念「${debt.question}」的回收早于埋设`, `最早回收在第 ${earliestPayoff} 集，最晚埋设却在第 ${latestPlant} 集。`, { debtId: debt.id });
  }

  const draftBranches = project.branches.filter(branch => branch.status === 'draft').length;
  if (draftBranches) push('info', 'BRANCH_PENDING', `有 ${draftBranches} 个实验室分支待决定`, '分支不会污染正式因果图，但长期保留会让你分不清哪条才是正稿。', {});

  const stats = {
    episodes: episodesWithNodes.size,
    episodeCount: project.episodeCount,
    nodes: project.nodes.length,
    edges: project.edges.length,
    cast: project.cast.length,
    locations: project.locations.length,
    outcomes: project.outcomes.length,
    hardOutcomes: project.outcomes.filter(outcome => outcome.lock === 'hard').length,
    debts: project.debts.length,
    debtsOpen: project.debts.filter(debt => debt.status !== 'paid').length,
    branchesDraft: draftBranches,
    errors: issues.filter(issue => issue.level === 'error').length,
    warnings: issues.filter(issue => issue.level === 'warn').length,
    coverage: project.episodeCount ? Math.round((episodesWithNodes.size / project.episodeCount) * 100) : 0,
    fingerprint: fingerprint(project),
    scriptFresh: Boolean(project.script && project.script.fingerprint === fingerprint(project)),
  };
  return { issues, stats, episodePlan: buildEpisodePlan(project) };
}

function buildEpisodePlan(project) {
  const plan = [];
  for (let episode = 1; episode <= project.episodeCount; episode++) {
    const nodes = project.nodes.filter(node => node.episode === episode).sort((left, right) => left.order - right.order);
    const outcomes = project.outcomes.filter(outcome => outcome.episode === episode);
    plan.push({
      episode,
      title: outcomes.find(outcome => outcome.lock === 'hard')?.title || outcomes[0]?.title || nodes[0]?.title || '',
      nodeIds: nodes.map(node => node.id),
      nodeCount: nodes.length,
      duration: nodes.reduce((sum, node) => sum + nodeDuration(node), 0),
      outcomes: outcomes.map(outcome => ({ id: outcome.id, title: outcome.title, lock: outcome.lock })),
      issueCount: 0,
    });
  }
  return plan;
}

export function nodeDuration(node) {
  return Math.max(8, 6 + (node.beats?.length || 0) * 3 + (node.dialogue?.length || 0) * 2);
}

export function episodePlan(project) {
  return buildEpisodePlan(project);
}

/* —— 改动影响：只在受影响的局部算，不改写其他事件 —— */
export function analyzeImpact(project, nodeId, next) {
  const node = project.nodes.find(item => item.id === nodeId);
  if (!node) throw bad('事件不存在。', 404);
  const before = project;
  const after = structuredClone(project);
  const at = after.nodes.findIndex(item => item.id === nodeId);
  if (next === null) {
    after.nodes.splice(at, 1);
    after.edges = after.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
    after.outcomes = after.outcomes.map(outcome => (outcome.nodeId === nodeId ? { ...outcome, nodeId: '' } : outcome));
    after.debts = after.debts.map(debt => ({ ...debt, planted: debt.planted.filter(id => id !== nodeId), payoff: debt.payoff.filter(id => id !== nodeId) }));
  } else {
    // next 是「这个事件改动后的字段」，不完整也可以；id 永远以原事件为准。
    const patch = next && typeof next === 'object' ? { ...next } : {};
    delete patch.id;
    after.nodes[at] = { ...after.nodes[at], ...patch };
  }
  const downstream = descendants(before, nodeId);
  const missing = [];
  for (const { node: item } of downstream) {
    const target = after.nodes.find(candidate => candidate.id === item.id);
    if (!target) continue;
    const corpus = ancestorCorpus(after, target.id);
    const gaps = target.preconditions.filter(condition => coverage(condition, corpus) < 0.5);
    if (gaps.length) missing.push({ nodeId: target.id, title: target.title, episode: target.episode, items: gaps });
  }
  const nextEpisode = next && Number.isFinite(next.episode) ? next.episode : node.episode;
  const affectedIds = new Set([nodeId, ...downstream.map(item => item.node.id)]);
  const outcomes = before.outcomes.filter(outcome => outcome.episode >= Math.min(node.episode, nextEpisode) && (affectedIds.has(outcome.nodeId) || outcome.episode === nextEpisode));
  const debts = before.debts.filter(debt => debt.planted.includes(nodeId) || debt.payoff.includes(nodeId));
  const suggestions = [];
  if (next && nextEpisode !== node.episode && downstream.some(item => item.node.episode < nextEpisode)) {
    suggestions.push(`事件改到第 ${nextEpisode} 集后，下游事件反而更早；需要同时后移或把集数改回来。`);
  }
  for (const gap of missing) suggestions.push(`「${gap.title}」（第 ${gap.episode} 集）失去依据：${gap.items.join('、')}。补一个中间事件，或把该事实写进上游事件的结果。`);
  for (const debt of debts) {
    if (debt.payoff.includes(nodeId)) suggestions.push(`悬念「${debt.question}」的兑现证据链会变短；保留它，或把线索移到别的埋设点。`);
    if (debt.planted.includes(nodeId)) suggestions.push(`悬念「${debt.question}」的埋设点会被改动；观众可能看不懂后面的回收。`);
  }
  if (!suggestions.length) suggestions.push('受影响的下游事件没有丢失必要前提，可以保留本次修改。');
  return {
    nodeId,
    deleted: next === null,
    affected: downstream.map(item => ({ id: item.node.id, title: item.node.title, episode: item.node.episode, depth: item.depth })),
    outcomes: outcomes.map(outcome => ({ id: outcome.id, title: outcome.title, episode: outcome.episode, lock: outcome.lock })),
    debts: debts.map(debt => ({ id: debt.id, question: debt.question, status: debt.status })),
    missing,
    suggestions,
    unchangedCount: Math.max(0, project.nodes.length - downstream.length - 1),
  };
}

/* —— 无模型时也能用的三种因果机制草案 —— */
export function localPlans(project, outcome) {
  const lead = project.cast.find(item => item.id === outcome.leadId) || project.cast.find(item => outcome.detail?.includes(item.name)) || project.cast[0];
  const leadName = lead?.name || '主角';
  const target = outcome.episode || 1;
  const start = Math.max(1, target - 5);
  const templates = [
    {
      key: 'interest', name: '利益与规则冲突', mechanism: '资源按规则被收走，申诉程序反过来保护掌权者',
      steps: [
        ['资源被按规矩收回', `${leadName}按规矩完成劳动，却被告知所得需要重新分配。`, `${leadName}失去这次劳动所得，但规则表面无可指摘。`],
        ['按规矩申诉', `${leadName}要求核对账目，提出按同一套规矩重新结算。`, `掌权者同意核对，却把解释权握在自己手里。`],
        ['程序性驳回', `账目被拆成几段，${leadName}的工签与口粮分开计算，申诉失败。`, `${leadName}第一次确认：规矩不是中立的。`],
        ['替代资源出现', `陆野一方愿意按劳动给报酬，但要求${leadName}自己走进高地营地。`, `${leadName}有了退路，也有了必须付出的代价。`],
        ['当众结算', `${leadName}在众人面前交还工签，把最后一次分配摊开说清。`, `旧秩序的合法性被当众拆开，${leadName}离开。`],
      ],
    },
    {
      key: 'trust', name: '误会与信任崩塌', mechanism: '一次可解释的误会被坐实，解释本身被当成新的罪证',
      steps: [
        ['一次误会', `${leadName}夜里带回的食物被看见，来源没有第三个人能证明。`, `“她和高地有来往”成为营内默认的猜测。`],
        ['解释被当成狡辩', `${leadName}主动交代交换过程，却被要求先承认“通敌”。`, `她越解释，越像在替对方说话。`],
        ['证据被藏起', `能证明交易公平的工签被收走，账目上只剩“来源不明”。`, `${leadName}失去自证材料。`],
        ['第三方错误处罚', `顾霜按现有证据处罚${leadName}，程序正确，结论错误。`, `${leadName}对“讲道理”本身失去信心。`],
        ['不再自证', `${leadName}停止辩解，只提出离开。`, `她带走的不是清白，而是不再需要别人相信的决心。`],
      ],
    },
    {
      key: 'dilemma', name: '保护他人的两难', mechanism: '救人必须越界，越界又正好被用来定罪',
      steps: [
        ['同伴陷入危险', `营内伤员恶化，唯一有效的药在高地。`, `${leadName}必须在规矩和同伴之间选一个。`],
        ['唯一的救援在对手手里', `陆野愿意给药，但要求${leadName}公开承认自己去做过交易。`, `承认等于坐实“通敌”，不承认等于放弃伤员。`],
        ['越界救人', `${leadName}選擇先救人，把责任写在自己名下。`, `伤员活下来，${leadName}的把柄也交了出去。`],
        ['被以此定罪', `苏媚把救人的过程重新叙述成“私通外敌”。`, `同一件事有了两个版本，掌权者选了对自己有利的那个。`],
        ['把选择说清', `${leadName}当众说明自己为什么越界，然后交还工签。`, `她不是被赶走的，而是自己决定不再留下。`],
      ],
    },
  ];
  return templates.map(template => ({
    key: template.key,
    name: template.name,
    mechanism: template.mechanism,
    rationale: `目标：第 ${target} 集「${outcome.title}」。这条方案用“${template.mechanism}”作为主要驱动力，把结果拆成 ${template.steps.length} 个可校验事件。`,
    confidence: 'template',
    events: template.steps.map((step, index) => ({
      episode: Math.min(target, start + Math.round(((target - start) * index) / Math.max(1, template.steps.length - 1))),
      title: step[0],
      action: step[1],
      result: step[2],
      preconditions: index ? [template.steps[index - 1][2]] : [],
      actors: lead ? [lead.id] : [],
    })),
    risk: template.key === 'trust' ? '误会型最依赖证据链；如果第 28 集要揭露真相，必须提前埋好能反证的材料。' : template.key === 'dilemma' ? '两难型容易让主角显得被动，需要一次主动选择来收尾。' : '利益型最稳，但需要把规则写具体，否则观众会觉得只是坏人使坏。',
  }));
}

/* —— 拆集与模板分镜（无模型时的确定性导出） —— */
const SHOT_SIZES = ['中景（MS）', '中近景（MCU）', '近景（CU）', '特写（CU）', '中远景（MLS）'];
const CAMERAS = ['固定', '缓慢推近（Slow Push In）', '手持轻晃（Handheld）', '横移跟拍（Tracking）', '轻微拉远（Pull Out）'];
const DEFAULT_STYLE = '写实自然光短剧质感，森林与营地实景参考，人物外观保持一致，9:16 竖屏，电影感构图，高细节。';
const DEFAULT_KEYWORDS = 'cinematic short drama, natural forest daylight, consistent character appearance, shallow depth of field, 9:16 vertical format, high quality, ultra detailed';

const clean = value => String(value || '').replace(/[｜|]/g, '/').replace(/\s*\n+\s*/g, ' ').trim();

function castPrompt(item) {
  return item.promptAlias || item.visualPrompt || item.description || item.name;
}

function composeVideoPrompt(project, shot, node, location) {
  const cast = node.actors.map(id => project.cast.find(item => item.id === id)).filter(Boolean);
  const people = cast.map(item => `${item.name}: ${castPrompt(item)}`).join('; ');
  const scene = location ? `${location.name}${location.description ? `, ${location.description}` : ''}` : '';
  return [
    DEFAULT_KEYWORDS,
    shot.shotSize.replace(/（.*?）/g, ''),
    shot.camera,
    shot.action.join(' '),
    people ? `characters — ${people}` : '',
    scene,
    shot.mood,
    project.aspectRatio === '16:9' ? '16:9 horizontal format' : '9:16 vertical format',
  ].filter(Boolean).join(', ');
}

function shotsForNode(project, node) {
  const location = project.locations.find(item => item.id === node.locationId) || project.locations[0] || null;
  const actors = node.actors.map(id => project.cast.find(item => item.id === id)).filter(Boolean);
  const actorNames = actors.map(item => item.name);
  const beats = node.beats.length ? node.beats : [node.action || node.goal || node.title];
  const tone = node.tone || project.world.tone || '克制、压抑，情绪不外放';
  const shots = [];
  const push = (title, sizeIndex, cameraIndex, action, dialogue, mood, transition, duration) => {
    shots.push({
      title, shotSize: SHOT_SIZES[sizeIndex % SHOT_SIZES.length], composition: `${actorNames.join('、') || '环境主体'}在画面中的关系：${action[0] || node.title}`,
      camera: CAMERAS[cameraIndex % CAMERAS.length], action, dialogue, mood, transition, duration, videoPrompt: '',
    });
  };
  push('起', 4, 1, [`${location?.name || '营地'}，${beats[0]}${actorNames.length ? `；${actorNames.join('、')}在场。` : '。'}`], [], tone, '硬切', 4);
  for (let index = 1; index < Math.min(beats.length, 4); index++) {
    push(`推进 ${index}`, index, index + 1, [beats[index]], [], tone, '硬切', 4);
  }
  for (const [index, line] of node.dialogue.slice(0, 3).entries()) {
    const speaker = project.cast.find(item => item.id === line.characterId)?.name || line.speaker || actorNames[0] || '角色';
    push(`台词 ${index + 1}`, index + 1, 0, [`${speaker}开口，${node.motive ? `动机：${node.motive}` : '把话压得很低'}。`], [{ speaker, line: line.line, tone: line.tone }], tone, '硬切', 5);
  }
  push('落点', 2, 4, [node.result || node.action || node.title], [], node.foreshadow ? `未解的钩子：${node.foreshadow}` : tone, node.foreshadow ? '淡出留钩' : '硬切', 4);
  const seen = new Set();
  return shots.filter(shot => {
    const key = `${shot.shotSize}|${shot.action.join('')}|${shot.dialogue.map(line => line.line).join('')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildScenes(project, { from = 1, to = project.episodeCount } = {}) {
  const scenes = [];
  const range = Math.max(1, Math.min(project.episodeCount, Number(to) || project.episodeCount));
  const start = Math.max(1, Math.min(range, Number(from) || 1));
  const nodes = project.nodes.filter(node => node.episode >= start && node.episode <= range).sort((left, right) => left.episode - right.episode || left.order - right.order);
  let counter = 0;
  const groups = new Map();
  for (const node of nodes) {
    if (!groups.has(node.episode)) groups.set(node.episode, []);
    groups.get(node.episode).push(node);
  }
  for (const [episode, items] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
    const outcomes = project.outcomes.filter(outcome => outcome.episode === episode);
    const locationCount = new Map();
    for (const node of items) locationCount.set(node.locationId, (locationCount.get(node.locationId) || 0) + 1);
    const locationId = [...locationCount.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || project.locations[0]?.id;
    const location = project.locations.find(item => item.id === locationId) || project.locations[0] || { code: 'A', name: '主场景' };
    const scene = {
      episode,
      title: `第${String(episode).padStart(2, '0')}集 · ${outcomes[0]?.title || items[0]?.title || '未命名'}`,
      locationCode: location.code,
      note: outcomes.length ? `固定结果：${outcomes.map(outcome => `${outcome.title}（${LOCK_LABELS[outcome.lock]}）`).join('；')}` : '本集没有固定结果，事件链自由发展。',
      shots: [],
    };
    for (const node of items) {
      const shots = shotsForNode(project, node);
      for (const shot of shots) {
        counter += 1;
        const code = `${String(counter).padStart(3, '0')}-${location.code}`;
        scene.shots.push({ ...shot, code, nodeId: node.id, nodeTitle: node.title, videoPrompt: composeVideoPrompt(project, shot, node, location) });
      }
    }
    scenes.push(scene);
  }
  return scenes;
}

export function scriptScenes(project, { from = 1, to = project.episodeCount } = {}) {
  if (!project.script || project.script.fingerprint !== fingerprint(project)) return buildScenes(project, { from, to });
  const start = Math.max(1, Number(from) || 1);
  const range = Math.min(project.episodeCount, Number(to) || project.episodeCount);
  const scenes = project.script.scenes.filter(scene => scene.episode >= start && scene.episode <= range);
  let counter = 0;
  return scenes.map(scene => ({
    ...scene,
    shots: scene.shots.map(shot => {
      counter += 1;
      const code = `${String(counter).padStart(3, '0')}-${scene.locationCode || 'A'}`;
      const node = project.nodes.filter(item => item.episode === scene.episode)[0];
      const location = project.locations.find(item => item.code === (scene.locationCode || 'A')) || project.locations[0];
      return { ...shot, code, videoPrompt: shot.videoPrompt || composeVideoPrompt(project, shot, node || { actors: [], title: scene.title }, location) };
    }),
  }));
}

export function buildExport(project, { from = 1, to = project.episodeCount, includeIndex = true } = {}) {
  const start = Math.max(1, Math.min(project.episodeCount, Number(from) || 1));
  const end = Math.max(start, Math.min(project.episodeCount, Number(to) || project.episodeCount));
  const scenes = scriptScenes(project, { from: start, to: end });
  const shots = scenes.flatMap(scene => scene.shots);
  const duration = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const usedScript = Boolean(project.script && project.script.fingerprint === fingerprint(project));
  const lines = [];
  const push = (...items) => lines.push(...items);
  const title = project.title.replace(/^《|》$/g, '');
  push(`# 《${title}》分镜提示词`, '');
  push(`> 版本：StoryForge 因果稿｜导出 ${new Date().toLocaleString('zh-CN')}`, `> 事件可追溯到因果图；模板来源：${usedScript ? `模型分镜（${project.script.model || '未记录模型'}）` : '因果事件字段（未使用模型）'}`, '');
  push('---', '', '## 一、项目元数据', '');
  push(`- **片名**：${title}`);
  if (project.genre) push(`- **类型**：${project.genre}`);
  if (project.logline) push(`- **定位**：${clean(project.logline)}`);
  if (project.theme) push(`- **主题**：${clean(project.theme)}`);
  push(`- **总场次**：${scenes.length}场`);
  push(`- **总镜头数**：${shots.length}镜`);
  push(`- **预估总时长**：约${duration}秒`);
  push(`- **画面比例**：${project.aspectRatio}${project.aspectRatio === '16:9' ? '（横屏）' : '（竖屏短剧）'}`);
  push(`- **导出范围**：第${start}–${end}集中有事件的${scenes.length}集`);
  push('', '---', '', '## 二、风格总设定', '', (project.style || DEFAULT_STYLE).trim(), '', `- **画面比例**：${project.aspectRatio}`, '');
  push('---', '', '## 三、角色设定库', '');
  project.cast.forEach((item, index) => {
    const payload = {
      name: item.name,
      role: item.role || '角色',
      faction: item.faction || '',
      appearance: { body: item.description || castPrompt(item), traits: item.traits },
      personality: { traits: item.traits, desire: item.desire, fear: item.fear },
      visual_prompt: item.visualPrompt || `${item.name}, ${item.description || ''}, cinematic 3D style, consistent appearance`,
      seed_prompt: item.seedPrompt || `[CHARACTER:${item.name}] ${castPrompt(item)}, cinematic style, consistent appearance`,
    };
    push(`### 角色${index + 1}：${item.name}`, '', '```json', JSON.stringify(payload, null, 2), '```', '');
  });
  push('---', '', '## 四、场景设定库', '');
  project.locations.forEach(item => {
    const payload = {
      scene_id: item.code,
      scene_heading: item.heading || `INT. ${item.name} - 日`,
      environment: { type: 'exterior', key_elements: [item.description || item.name] },
      lighting: { type: 'natural', quality: item.tone || 'natural' },
      atmosphere: { mood: item.tone || '' },
      visual_prompt: item.visualPrompt || `${item.name}, ${item.description || ''}, natural light, cinematic, 9:16`,
      seed_prompt: item.seedPrompt || `[SCENE:${item.name}] ${item.description || ''}`,
    };
    push(`### 场景${item.code}：${item.name}`, '', '```json', JSON.stringify(payload, null, 2), '```', '');
  });
  push('---', '', '## 五、完整分镜提示词', '');
  for (const scene of scenes) {
    push(`### 第${scene.episode}场：${scene.title}`, '');
    const location = project.locations.find(item => item.code === scene.locationCode);
    push(`**场景**：${location?.name || '未命名场景'}  `);
    push(`**情绪线**：${scene.note || ''}  `);
    push(`**色调**：${location?.tone || '自然光，低饱和'}`, '', '---', '');
    for (const shot of scene.shots) {
      push(`#### 镜头 ${shot.code}｜${clean(shot.title)}`, '');
      push(`- **景别**：${shot.shotSize}`);
      push(`- **构图**：${clean(shot.composition)}`);
      push(`- **运镜**：${shot.camera}`);
      push('- **画面内容**：');
      for (const line of shot.action.length ? shot.action : ['（空镜）']) push(`  - ${clean(line)}`);
      push('');
      if (shot.dialogue.length) {
        push(`- **台词**：${shot.dialogue.map(line => `${line.speaker}：“${line.line.replace(/[“”"]/g, '')}”`).join('\n  ')}`);
      } else {
        push('- **台词**：（无，纯动作）');
      }
      push('');
      push(`- **情绪氛围**：${clean(shot.mood)}`, '');
      push('- **AI视频提示词**：', '```', clean(shot.videoPrompt), '```', '');
      push(`- **时长**：${shot.duration}s`);
      push(`- **转场**：${shot.transition}`, '', '---', '');
    }
  }
  if (includeIndex) {
    push('## 六、因果链索引', '');
    push('> 本节仅供追溯，不参与镜头解析。每个镜头都能回到它所属事件与剧情目标。', '');
    for (const scene of scenes) {
      const nodes = project.nodes.filter(node => node.episode === scene.episode);
      for (const node of nodes) {
        const outcome = project.outcomes.find(item => item.nodeId === node.id);
        push(`- 第${String(scene.episode).padStart(2, '0')}集 · ${node.title}｜目标：${clean(node.goal) || '未填写'}｜结果：${clean(node.result) || '未填写'}${node.foreshadow ? `｜伏笔：${clean(node.foreshadow)}` : ''}${outcome ? `｜固定结果：${outcome.title}（${LOCK_LABELS[outcome.lock]}）` : ''}`);
      }
    }
    if (project.debts.length) {
      push('', '### 剧情债务');
      for (const debt of project.debts) {
        const planted = debt.planted.map(id => project.nodes.find(node => node.id === id)).filter(Boolean).map(node => `第${node.episode}集`).join('、') || '未埋设';
        const payoff = debt.payoff.map(id => project.nodes.find(node => node.id === id)).filter(Boolean).map(node => `第${node.episode}集`).join('、') || '未兑现';
        push(`- ${debt.question}｜埋设：${planted}｜回收：${payoff}｜状态：${debt.status === 'paid' ? '已兑现' : '未兑现'}`);
      }
    }
  }
  const markdown = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
  return {
    markdown,
    scenes,
    stats: { episodes: scenes.length, shots: shots.length, duration, cast: project.cast.length, locations: project.locations.length },
    usedScript,
    range: { from: start, to: end },
  };
}

export function scriptPreview(project, options) {
  const built = buildExport(project, options);
  return { markdown: built.markdown, stats: built.stats, usedScript: built.usedScript };
}

/* —— 从已有分镜作品提取角色/地点，作为新因果项目的起点 —— */
export function seedFromStudio(studioProject, { title } = {}) {
  const characters = (studioProject.assets || []).filter(asset => asset.type === 'character');
  const locations = (studioProject.assets || []).filter(asset => asset.type === 'location');
  return createProject({
    title: title || studioProject.title,
    genre: 'AI 短剧',
    aspectRatio: studioProject.aspectRatio || '9:16',
    style: studioProject.style || '',
    episodeCount: Math.max(1, Math.min(30, (studioProject.storyScenes || []).length || 20)),
    cast: characters.map(character => ({
      name: character.name,
      role: character.data?.details?.role || '',
      description: character.data?.description || '',
      visualPrompt: character.data?.visualPrompt || '',
      seedPrompt: character.data?.seedPrompt || '',
      promptAlias: character.data?.visualPrompt || character.name,
    })),
    locations: locations.map(location => ({
      code: location.code,
      name: location.name,
      heading: location.data?.details?.scene_heading || '',
      description: location.data?.description || '',
      visualPrompt: location.data?.visualPrompt || '',
      seedPrompt: location.data?.seedPrompt || '',
    })),
  });
}
