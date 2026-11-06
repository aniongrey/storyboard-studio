import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EDGE_LABELS, LOCK_LABELS } from './forge.mjs';

// 外接 LLM：设置结构参考 Servant 的「provider / model / apiKey / temperature」，
// 只走 OpenAI 兼容的 /chat/completions，因此 Ollama、DeepSeek、豆包方舟、Groq、Gemini 兼容层都能直接接。
// 密钥只留在本机（DPAPI 加密），浏览器永远拿不到已保存的 Key；接口返回的文本也不会带凭证。

export const LLM_PROVIDERS = [
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', requiresKey: false,
    models: ['qwen3.5:9b', 'qwen3.5:4b', 'qwen2.5:latest'], note: '本机模型，成本为零；长上下文建议 9B 以上。' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'], note: '中文长文本稳定，按 token 计费。' },
  { id: 'doubao', label: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', requiresKey: true,
    models: ['doubao-seed-2-1-turbo-260628', 'doubao-seed-2-1-pro-260628', 'deepseek-v4-flash-ga-260731', 'deepseek-v4-pro-ga-260813', 'doubao-seed-2-0-lite-260428'], note: '需在方舟控制台开通对应模型。' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', requiresKey: true,
    models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-4.1-mini'], note: '国内网络通常需要自备代理或中转地址。' },
  { id: 'gemini', label: 'Google Gemini（OpenAI 兼容）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresKey: true,
    models: ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'], note: '使用 Gemini 的 OpenAI 兼容端点。' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true,
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'], note: '速度快，适合反复推演。' },
  { id: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', requiresKey: true,
    models: ['grok-4-1-fast-non-reasoning', 'grok-4-1-fast-reasoning', 'grok-4'], note: '' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', requiresKey: false,
    models: [], note: '填写任意兼容 /chat/completions 的地址；本地网关可不填 Key。' },
];

export const DEFAULT_LLM = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:9b', temperature: 0.3 };
const MAX_CONTEXT_NODES = 60;

const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const providerOf = id => LLM_PROVIDERS.find(provider => provider.id === id) || LLM_PROVIDERS[0];
const text = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function powershell(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input, encoding: 'utf8', timeout: 12000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
const protectScript = '$ErrorActionPreference="Stop"; $null=[Reflection.Assembly]::LoadWithPartialName("System.Security"); $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($encrypted))';
const unprotectScript = '$ErrorActionPreference="Stop"; $null=[Reflection.Assembly]::LoadWithPartialName("System.Security"); $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))';

function readSecret(file) {
  if (!existsSync(file)) return '';
  try { return powershell(unprotectScript, readFileSync(file, 'utf8')); }
  catch { throw fail('无法解密本机 LLM 密钥（常见于换了 Windows 账户或密钥文件被改动）。请重新保存 Key。', 503); }
}
function writeSecret(file, value) {
  let encrypted;
  try { encrypted = powershell(protectScript, value); }
  catch { throw fail('无法使用 Windows DPAPI 保存密钥。可以改用环境变量 FORGE_LLM_API_KEY。', 503); }
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

const normalizeBaseUrl = value => {
  const raw = text(value, 300).replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw fail('接口地址不是合法的 URL。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('接口地址只支持 http/https。');
  if (url.username || url.password) throw fail('接口地址里不要带用户名或密码。');
  if (url.search || url.hash) throw fail('接口地址不要带查询参数或锚点。');
  return raw;
};

export function createLlmService({ dataDir, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  const settingsDir = resolve(dataDir, 'settings');
  const settingsFile = join(settingsDir, 'llm.json');
  const keyFile = join(settingsDir, 'llm.dpapi');
  let secretCache;

  const readSettings = () => {
    let saved = {};
    try { saved = JSON.parse(readFileSync(settingsFile, 'utf8')) || {}; } catch { saved = {}; }
    const provider = providerOf(saved.provider).id;
    const preset = providerOf(provider);
    return {
      provider,
      baseUrl: normalizeBaseUrl(saved.baseUrl || preset.baseUrl) || preset.baseUrl,
      model: text(saved.model, 160) || preset.models[0] || DEFAULT_LLM.model,
      temperature: Number.isFinite(saved.temperature) ? Math.min(2, Math.max(0, saved.temperature)) : DEFAULT_LLM.temperature,
      updatedAt: text(saved.updatedAt, 40),
      source: 'settings',
    };
  };

  const settings = () => {
    const saved = readSettings();
    const provider = providerOf(env.FORGE_LLM_PROVIDER || saved.provider);
    const preset = providerOf(provider.id);
    const baseUrl = normalizeBaseUrl(env.FORGE_LLM_BASE_URL || (provider.id === saved.provider ? saved.baseUrl : preset.baseUrl)) || preset.baseUrl;
    const model = text(env.FORGE_LLM_MODEL, 160) || (provider.id === saved.provider ? saved.model : preset.models[0]) || DEFAULT_LLM.model;
    const temperature = Number.isFinite(Number(env.FORGE_LLM_TEMPERATURE)) ? Math.min(2, Math.max(0, Number(env.FORGE_LLM_TEMPERATURE))) : saved.temperature;
    const hasEnvKey = Boolean(text(env.FORGE_LLM_API_KEY, 400));
    return {
      provider: provider.id,
      baseUrl,
      model,
      temperature,
      requiresKey: provider.requiresKey,
      hasKey: hasEnvKey || existsSync(keyFile),
      keySource: hasEnvKey ? 'env' : existsSync(keyFile) ? 'dpapi' : 'none',
      updatedAt: saved.updatedAt,
    };
  };

  const publicState = () => {
    const current = settings();
    return {
      providers: LLM_PROVIDERS,
      settings: current,
      configured: current.requiresKey ? current.hasKey : Boolean(current.baseUrl && current.model),
      defaultLlm: DEFAULT_LLM,
    };
  };

  const save = ({ provider, baseUrl, model, temperature, apiKey, clearKey }) => {
    const preset = providerOf(text(provider, 40));
    if (!preset) throw fail('未知的模型服务商。');
    const nextBase = normalizeBaseUrl(baseUrl || preset.baseUrl) || preset.baseUrl;
    if (!nextBase) throw fail('请填写接口地址。');
    const nextModel = text(model, 160);
    if (!nextModel) throw fail('请填写模型名称。');
    const value = Number(temperature ?? DEFAULT_LLM.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) throw fail('温度必须是 0–2 之间的数字。');
    if (clearKey) rmSync(keyFile, { force: true });
    if (typeof apiKey === 'string' && apiKey.trim()) {
      if (apiKey.trim().length < 8 || apiKey.trim().length > 400) throw fail('API Key 长度异常。');
      writeSecret(keyFile, apiKey.trim());
      secretCache = undefined;
    }
    mkdirSync(settingsDir, { recursive: true });
    const payload = { provider: preset.id, baseUrl: nextBase, model: nextModel, temperature: value, updatedAt: new Date().toISOString() };
    const temp = `${settingsFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(payload, null, 2));
    renameSync(temp, settingsFile);
    return publicState();
  };

  const authKey = () => {
    if (text(env.FORGE_LLM_API_KEY, 400)) return text(env.FORGE_LLM_API_KEY, 400);
    if (secretCache !== undefined) return secretCache;
    secretCache = readSecret(keyFile);
    return secretCache;
  };

  const request = async (path, options = {}) => {
    const current = settings();
    const headers = { 'Content-Type': 'application/json' };
    const key = authKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    else if (current.requiresKey) throw fail(`请先在设置里填写 ${providerOf(current.provider).label} 的 API Key。`, 409, { code: 'LLM_KEY_MISSING' });
    let response;
    try {
      response = await fetchImpl(`${current.baseUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw fail(`连接 ${providerOf(current.provider).label} 失败：${error.name === 'TimeoutError' ? '请求超时' : error.message}。`, 502, { code: 'LLM_UNREACHABLE', provider: current.provider, baseUrl: current.baseUrl });
    }
    return { response, current };
  };

  const readBody = async response => {
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = null; }
    if (!response.ok) {
      const detail = text(data?.error?.message || data?.message || raw, 400) || `HTTP ${response.status}`;
      throw fail(`模型服务返回 ${response.status}：${detail}`, response.status === 401 || response.status === 403 ? 409 : 502, { code: 'LLM_PROVIDER_ERROR', providerStatus: response.status });
    }
    if (!data) throw fail('模型服务返回了无法解析的响应。', 502, { code: 'LLM_BAD_RESPONSE' });
    return data;
  };

  const chat = async ({ system, prompt, json = true, temperature, maxTokens = 4000 }) => {
    const body = {
      model: settings().model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: Number.isFinite(temperature) ? temperature : settings().temperature,
      max_tokens: maxTokens,
      stream: false,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };
    const attempt = async withFormat => {
      const { response, current } = await request('/chat/completions', { method: 'POST', body: JSON.stringify(withFormat ? body : (({ response_format, ...rest }) => rest)(body)) });
      const data = await readBody(response);
      return { data, current };
    };
    let result;
    try { result = await attempt(true); }
    catch (error) {
      // 一部分兼容端点不认 response_format，去掉后重试一次；鉴权/网络错误不重试。
      if (json && error.code !== 'LLM_KEY_MISSING' && /模型服务返回 400|无法解析/.test(error.message)) result = await attempt(false);
      else throw error;
    }
    const content = result.data?.choices?.[0]?.message?.content;
    const raw = Array.isArray(content) ? content.map(part => part?.text || '').join('') : String(content || '');
    if (!raw.trim()) throw fail('模型返回了空内容。', 502, { code: 'LLM_EMPTY' });
    return { raw, provider: result.current.provider, model: result.current.model, usage: result.data?.usage || null };
  };

  const test = async () => {
    const started = Date.now();
    const { response, current } = await request('/models', { method: 'GET' });
    if (response.ok) {
      let models = [];
      try { const data = await response.json(); models = (data.data || data.models || []).map(item => item.id || item.name).filter(Boolean).slice(0, 50); } catch { models = []; }
      return { ok: true, provider: current.provider, model: current.model, models, latencyMs: Date.now() - started };
    }
    const ping = await chat({ system: '只回复 OK。', prompt: 'Reply with OK.', json: false, maxTokens: 8, temperature: 0 });
    return { ok: true, provider: ping.provider, model: ping.model, models: [], latencyMs: Date.now() - started, reply: ping.raw.slice(0, 40) };
  };

  const listModels = async () => {
    const { response, current } = await request('/models', { method: 'GET' });
    if (!response.ok) return { provider: current.provider, models: providerOf(current.provider).models };
    let models = [];
    try { const data = await response.json(); models = (data.data || data.models || []).map(item => item.id || item.name).filter(Boolean); } catch { models = []; }
    return { provider: current.provider, models: models.slice(0, 100) };
  };

  const runTask = async (task, project, payload = {}) => {
    const definition = TASKS[task];
    if (!definition) throw fail('未知的 AI 功能。', 400);
    const built = definition.build(project, payload);
    const started = Date.now();
    const response = await chat({ system: built.system, prompt: built.prompt, json: true, maxTokens: built.maxTokens || 4000 });
    const result = parseJsonObject(response.raw);
    if (!result) {
      throw fail('模型返回的不是可解析的 JSON。原文已保留，可换模型或降低温度重试。', 502, {
        code: 'LLM_JSON_INVALID', raw: response.raw.slice(0, 6000), provider: response.provider, model: response.model,
      });
    }
    return { task, provider: response.provider, model: response.model, usage: response.usage, result, raw: response.raw.slice(0, 20000), latencyMs: Date.now() - started };
  };

  return { publicState, settings, save, test, listModels, runTask, chat, paths: { settingsFile, keyFile } };
}

export function parseJsonObject(raw) {
  const value = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const direct = tryParse(value);
  if (direct) return direct;
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return tryParse(value.slice(start, index + 1));
  }
  return null;
}
const tryParse = value => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
};

/* —— 五项 AI 功能：只产出建议，采纳与写入由界面完成 —— */
export const TASKS = {
  'result-planner': {
    maxTokens: 4000,
    build(project, payload) {
      const outcome = project.outcomes.find(item => item.id === payload.outcomeId) || project.outcomes[0];
      if (!outcome) throw fail('先建立一个固定结果，再让结果规划师倒推。', 409);
      const pool = project.cast.filter(item => item.id === outcome.leadId || !outcome.leadId).map(item => item.name).join('、');
      return {
        system: SYSTEM,
        prompt: [
          projectContext(project),
          `【本次任务】为第 ${outcome.episode} 集的固定结果「${outcome.title}」倒推三种不同的因果方案。结果细节：${outcome.detail || '未填写'}。`,
          `可用人物：${pool || '项目现有全部人物'}。硬锁定结果不可改；只能设计通往它的前因。`,
          '三种方案必须使用不同机制：利益与规则冲突、误会与信任崩塌、保护他人的两难。每方案 4–6 个事件，事件集数必须早于或等于结果集数，且按时间递增。',
          '每个事件必须给出可核对的事实性前置条件（precondition），不能写“角色决定背叛”这种结果本身。',
          '输出 JSON：{"plans":[{"name":"方案名","mechanism":"机制","rationale":"为什么能通向该结果","events":[{"episode":数字,"title":"事件名","action":"具体发生了什么","result":"产生什么新事实","preconditions":["事实"],"actors":["人物名"]}],"risk":"这条路的代价"}]}',
        ].join('\n\n'),
      };
    },
  },
  'causal-architect': {
    maxTokens: 4000,
    build(project, payload) {
      const from = project.nodes.find(item => item.id === payload.nodeId);
      const to = project.outcomes.find(item => item.id === payload.outcomeId);
      if (!from) throw fail('先选中一个起点事件。', 409);
      if (!to) throw fail('先选中一个固定结果。', 409);
      return {
        system: SYSTEM,
        prompt: [
          projectContext(project),
          `【本次任务】从第 ${from.episode} 集事件「${from.title}」出发（结果：${from.result || '未填写'}），到达第 ${to.episode} 集固定结果「${to.title}」（${LOCK_LABELS[to.lock]}）。`,
          '给出三条不同的中间事件链。每条链 3–6 个事件，必须解释每一步如何改变人物的处境或认知，而不是只写“发生争吵”。',
          '事件集数必须在起点之后、结果之前；如果集数空间不足，直接说明并给出压缩方案。',
          '输出 JSON：{"chains":[{"name":"链条名","rationale":"为什么成立","events":[{"episode":数字,"title":"","action":"","result":"","preconditions":[""],"actors":[""]}],"cost":"这条链消耗了什么"}]}',
        ].join('\n\n'),
      };
    },
  },
  'character-simulator': {
    maxTokens: 2600,
    build(project, payload) {
      const node = project.nodes.find(item => item.id === payload.nodeId);
      if (!node) throw fail('先选中一个事件。', 409);
      return {
        system: SYSTEM,
        prompt: [
          projectContext(project),
          `【本次任务】模拟第 ${node.episode} 集事件「${node.title}」中，行动者最可能采取的行动。`,
          `事件：${node.action || '未填写'}。目标：${node.goal || '未填写'}。已知结果：${node.result || '未填写'}。`,
          `每个行动者都要先判断其在该集之前知道什么，再给出行动。不能让人物使用他尚未获知的信息。`,
          '输出 JSON：{"actions":[{"character":"人物名","knows":"此时他知道什么","action":"会做什么","motive":"为什么","cost":"代价","credibility":"高/中/低","alternative":"另一种可能"}]}',
        ].join('\n\n'),
      };
    },
  },
  'script-reviewer': {
    maxTokens: 2600,
    build(project, payload) {
      const node = project.nodes.find(item => item.id === payload.nodeId);
      const scope = node ? `第 ${node.episode} 集事件「${node.title}」` : `第 ${payload.episode || 1} 集`;
      return {
        system: SYSTEM,
        prompt: [
          projectContext(project),
          `【本次任务】审查 ${scope}。只报可验证的问题，不要泛泛而谈。`,
          '重点检查：动机是否成立、角色是否知道了不该知道的事、前置条件是否缺失、与硬锁定结果是否冲突、是否重复使用同一冲突。',
          '输出 JSON：{"verdict":"通过/需修改/不成立","issues":[{"severity":"error/warn/info","title":"","detail":"","fix":"具体怎么改"}]}',
        ].join('\n\n'),
      };
    },
  },
  'lab-explore': {
    maxTokens: 3600,
    build(project, payload) {
      const node = project.nodes.find(item => item.id === payload.nodeId);
      if (!node) throw fail('先在因果图里选一个事件。', 409);
      return {
        system: SYSTEM,
        prompt: [
          projectContext(project),
          `【本次任务】剧情实验室：为第 ${node.episode} 集事件「${node.title}」探索三种其他发展。原始事件：${node.action || ''}；结果：${node.result || ''}。`,
          '三种方案要改变“如何发生”，不能改变已经硬锁定的结果集数；每条方案都要说明它会波及哪些后续事件。',
          '输出 JSON：{"options":[{"name":"方案名","approach":"一句话思路","summary":"展开会发生什么","pros":"优势","cons":"代价","affected":["可能受影响的后续事件标题"],"events":[{"episode":数字,"title":"","action":"","result":"","preconditions":[""],"actors":[""]}]}]}',
        ].join('\n\n'),
      };
    },
  },
  'storyboard-writer': {
    maxTokens: 8000,
    build(project, payload) {
      const from = Number(payload.fromEpisode) || 1;
      const to = Number(payload.toEpisode) || from;
      return {
        system: SYSTEM,
        prompt: [
          projectContext(project),
          `【本次任务】把第 ${from}–${to} 集中已有的事件改写成可拍摄的分镜脚本。只写有事件支撑的集数，不虚构新剧情。`,
          `场景代码只能用：${project.locations.map(item => `${item.code}=${item.name}`).join('、') || 'A=主场景'}。`,
          '每集 2–8 个镜头；每镜 3–6 秒；台词必须符合人物说话方式，没有台词的镜头写空数组。画面内容用中文，视频提示词用英文。',
          '输出 JSON：{"scenes":[{"episode":数字,"title":"第XX集 · 标题","locationCode":"A","note":"本集固定结果/情绪线","shots":[{"title":"镜头标题","shotSize":"景别","composition":"构图","camera":"运镜","action":["画面内容"],"dialogue":[{"speaker":"人物名","line":"台词"}],"mood":"情绪氛围","transition":"转场","duration":4,"videoPrompt":"English prompt"}]}]}',
        ].join('\n\n'),
      };
    },
  },
};

const SYSTEM = [
  '你是短剧的因果编剧，不是小说续写器。你的职责是设计可被逐条校验的事件、动机与证据链。',
  '规则：',
  '1. 只使用项目里已有人物的名字，不新增主要角色。',
  '2. 硬锁定结果不可更改，不能把它的集数或事实改掉。',
  '3. 人物只能使用他在该集之前已经知道的信息；不确定就写进“认知”字段，不要让他凭空知道。',
  '4. 事件必须给出事实性的前置条件和直接结果，避免“感情升温”“关系恶化”这种无法验证的描述。',
  '5. 只输出一个 JSON 对象，不要 Markdown 代码围栏，不要解释你的思路。',
].join('\n');

export function projectContext(project) {
  const cast = project.cast.map(item => {
    const bits = [item.role, item.faction].filter(Boolean).join(' / ');
    return `- ${item.name}${bits ? `（${bits}）` : ''}：欲望=${item.desire || '未填写'}；恐惧=${item.fear || '未填写'}；性格=${item.traits.join('、') || '未填写'}`;
  }).join('\n');
  const outcomes = project.outcomes.slice(0, 24).map(outcome => `- 第${outcome.episode}集「${outcome.title}」[${LOCK_LABELS[outcome.lock]}]：${outcome.detail || '未填写'}`).join('\n');
  const nodes = [...project.nodes].sort((left, right) => left.episode - right.episode).slice(0, MAX_CONTEXT_NODES).map(node => {
    const actors = node.actors.map(id => project.cast.find(item => item.id === id)?.name).filter(Boolean).join('、');
    const knowledge = node.knowledge.map(entry => {
      const name = project.cast.find(item => item.id === entry.characterId)?.name;
      return name ? `${name}：${{ knows: '知道', partial: '部分知道', unaware: '不知道' }[entry.level]}${entry.subject ? `“${entry.subject}”` : ''}` : '';
    }).filter(Boolean).join('；');
    return `- 第${node.episode}集「${node.title}」｜行动者=${actors || '未填'}｜目标=${node.goal || '未填'}｜行动=${node.action || '未填'}｜结果=${node.result || '未填'}${knowledge ? `｜认知=${knowledge}` : ''}`;
  }).join('\n');
  const debts = project.debts.map(debt => `- ${debt.question}（${debt.status === 'paid' ? '已兑现' : '未兑现'}；埋设${debt.planted.length}处；回收${debt.payoff.length}处）`).join('\n');
  const edges = project.edges.slice(0, 80).map(edge => {
    const from = project.nodes.find(item => item.id === edge.from)?.title;
    const to = project.nodes.find(item => item.id === edge.to)?.title;
    return from && to ? `- ${from} →（${EDGE_LABELS[edge.type]}）→ ${to}` : '';
  }).filter(Boolean).join('\n');
  return [
    `【项目】${project.title}（共 ${project.episodeCount} 集，${project.aspectRatio}）`,
    project.logline ? `【一句话】${project.logline}` : '',
    project.theme ? `【主题】${project.theme}` : '',
    project.world.rules ? `【世界规则】\n${project.world.rules}` : '',
    cast ? `【人物】\n${cast}` : '',
    outcomes ? `【固定结果】\n${outcomes}` : '',
    nodes ? `【已有事件】\n${nodes}` : '',
    edges ? `【已有因果连接】\n${edges}` : '',
    debts ? `【剧情债务】\n${debts}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 24000);
}
