import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import proxyAgent from 'https-proxy-agent';

const { HttpsProxyAgent } = proxyAgent;

// Fish Audio Drama-3 文本转语音。
// 端点 POST https://api.fish.audio/v1/tts，Bearer 鉴权，必须带 `model: drama-3` 请求头（缺失会静默回退旧模型）。
// text 支持 <|speaker:N|> 多说话人标签与 [表演指令] / <emphasis> 等情感标签，reference_id 可为数组。
// 本机直连 api.fish.audio 不通（沙箱/网络策略），必须经代理；默认 127.0.0.1:7890，可用 FISH_AUDIO_PROXY 覆盖。

export const FISH_AUDIO_BASE = 'https://api.fish.audio';
export const FISH_AUDIO_MODEL = 'drama-3';
const DEFAULT_PROXY = 'http://127.0.0.1:7890';

// 官方文档标注的可发音配对标签：只改变被包裹词汇的表达方式。
export const FISH_EMPHASIS_TAGS = ['whisper', 'emphasis', 'soft', 'fast', 'slow', 'stress', 'forceful'];

const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/* —— 密钥：DPAPI 加密落在本机，环境变量 FISH_AUDIO_API_KEY 兜底（沙箱不能 spawn powershell 时用） —— */
function secretFile() {
  return process.env.FISH_AUDIO_SECRET_FILE || join(process.env.LOCALAPPDATA || process.cwd(), 'StoryboardStudio', 'fish-audio.dpapi');
}
function powershell(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
const protectScript = '$ErrorActionPreference="Stop"; $null=[Reflection.Assembly]::LoadWithPartialName("System.Security"); $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($encrypted))';
const unprotectScript = '$ErrorActionPreference="Stop"; $null=[Reflection.Assembly]::LoadWithPartialName("System.Security"); $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))';

function readSecret() {
  const file = secretFile();
  if (!existsSync(file)) return '';
  try { return powershell(unprotectScript, readFileSync(file, 'utf8')); }
  catch { throw fail('无法解密本机 Fish Audio 密钥（常见于换了 Windows 账户或密钥文件被改动）。请重新保存 Key。', 503); }
}
function writeSecret(value) {
  let encrypted;
  try { encrypted = powershell(protectScript, value); }
  catch { throw fail('无法使用 Windows DPAPI 保存密钥。可以改用环境变量 FISH_AUDIO_API_KEY。', 503); }
  mkdirSync(dirname(secretFile()), { recursive: true });
  const file = secretFile();
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

/* —— 台词脚本构建：把一组说话人台词转成 Drama-3 多说话人脚本 ——
   输入 lines: [{ speaker: 角色名, voiceIndex: 音色下标, text: 原台词, cue?: 表演说明, mood?: 情绪 }]
   输出 { script: '<|speaker:N|>[指令]台词...', entries: [{ speaker, voiceIndex, line, tag, ending, reason }] } */
export function buildDialogueScript(lines, voiceMap) {
  // voiceMap: 角色名 -> 音色下标（对应 reference_id 数组）
  const entries = [];
  const parts = [];
  for (const raw of lines) {
    const speaker = String(raw.speaker || '').trim();
    const voiceIndex = voiceMap[speaker] ?? raw.voiceIndex ?? 0;
    const context = { cue: raw.cue || '', mood: raw.mood || '', character: speaker };
    const punct = classifyLinePunctuation(raw.text, context);
    const tag = buildEmotionTag(punct.line, context);
    const entry = { speaker, voiceIndex, line: punct.line, tag, ending: punct.ending, reason: punct.reason, text: raw.text };
    entries.push(entry);
    parts.push(`<|speaker:${voiceIndex}|>${tag ? tag + ' ' : ''}${punct.line}`);
  }
  return { script: parts.join(''), entries };
}

/* —— 台词标点优化：按 AGENTS.md「台词语气标点方法」逐句判定 ——
   只改最终提示词里的口语台词标点，不增删台词文字；有明确语气线索才改，其余保留。 */
const TRAILING_PUNCT = /[。！？!?～….、，]$/;
const stripPunct = line => line.replace(/[。！？!?～…]+$/g, '');

// 判定一句台词该改成哪种句尾标点：'～' 撒娇/轻快、'！' 喊叫/命令、'？！' 强烈质问、'' 保持不变。
export function classifyLinePunctuation(text, context = {}) {
  const s = String(text || '').trim();
  if (!s) return { line: s, ending: '', reason: '空' };
  const { cue = '', mood = '', character = '' } = context;
  const clue = `${cue} ${mood} ${character}`;
  // 已有表达性标点优先保留，不重复追加。
  if (/[！!]$/.test(s) && !/？！$/.test(s)) return { line: s, ending: '！', reason: '已有叹号' };
  if (/～$/.test(s)) return { line: s, ending: '～', reason: '已有波浪号' };
  if (/[？?]$/.test(s)) {
    // 仅明确强烈惊讶/质问时升级为 ？！
    if (/(强烈|质问|震惊|惊愕|不敢置信|怒吼|难以置信|什么|竟|居然|难道|还敢)/.test(clue)) return { line: stripPunct(s) + '？！', ending: '？！', reason: '强烈质问' };
    return { line: s, ending: '？', reason: '保留疑问' };
  }
  // 台词自身的命令/劝阻语气：命令词在句首或整句祈使结构（别/快/站住…）才算命令。
  // 句中出现的「别」「快」「给我」多为陈述（如「嫁给别人」「很快」「给我10分钟」），不误判。
  if (/^(别|不要|别再|不许|不准|快|赶快|赶紧|站住|必须|立即|马上|听着|回来|停下|让开|滚|少废话|闭嘴)/.test(s)) return { line: stripPunct(s) + '！', ending: '！', reason: '命令/劝阻' };
  // 撒娇 / 逗弄 / 轻快招呼 / 拖长尾音 → ～
  if (/(撒娇|逗弄|轻快|俏皮|调皮|哄|软糯|甜|尾音|俏生生|讨好|黏人)/.test(clue) || /(嘛|呀|啦|呢|吧)呀?$/.test(s) && /(撒娇|俏皮|轻快|哄|逗弄)/.test(clue)) return { line: stripPunct(s) + '～', ending: '～', reason: '撒娇/轻快' };
  // 喊叫 / 警告 / 愤怒 / 强烈命令 / 兴奋（来自上下文情绪）→ ！
  if (/(怒|吼|喊|叫|喝|斥|厉声|命令|警告|严厉|激动|兴奋|焦急|急切|生气|恼|失望|决绝)/.test(clue)) return { line: stripPunct(s) + '！', ending: '！', reason: '喊叫/命令' };
  return { line: s, ending: '', reason: '平静/保留' };
}

/* —— 情感标签：为 Drama-3 生成 [表演指令]，必要时加 <emphasis> 等配对标签 —— */
const MOOD_TO_DIRECTION = [
  ['愤怒', 'angry, voice rising'], ['生气', 'annoyed, sharp'], ['怒', 'angry, voice rising'],
  ['失望', 'disappointed, voice heavy'], ['撒娇', 'coquettishly, playful and sweet'], ['俏皮', 'playful and bright'],
  ['开心', 'brightly, light and warm'], ['喜悦', 'with soft joy'], ['兴奋', 'excitedly, animated'],
  ['急切', 'urgently, insistent'], ['焦急', 'urgently, hurried'], ['焦急', 'urgently, hurried'],
  ['难过', 'sadly, voice subdued'], ['悲伤', 'with quiet sorrow'], ['落寞', 'lonely, voice low and distant'],
  ['委屈', 'wounded, plaintive'], ['不安', 'uneasily, voice unsteady'], ['克制', 'with restrained intensity'],
  ['紧张', 'nervously, tense'], ['温柔', 'gently, soft and tender'], ['冷淡', 'cold and flat'],
  ['平静', 'calm and even'], ['坚定', 'firm and resolute'], ['决绝', 'resolute, final and unyielding'],
  ['犹豫', 'hesitant, faltering'], ['怀旧', 'nostalgic, soft with remembrance'], ['疲惫', 'tired, drained'],
  ['质问', 'demanding, pointed'], ['恳求', 'pleading, imploring'], ['隐瞒', 'evasive, guarded'],
  ['僵持', 'strained, tight-lipped'], ['讽刺', 'sarcastic, dry'], ['反讽', 'sarcastic, dry'],
  ['无奈', 'resigned, helpless'], ['宠溺', 'indulgent, doting'], ['期待', 'hopeful, expectant'],
];
export function emotionDirection(text) {
  const t = String(text || '');
  for (const [key, value] of MOOD_TO_DIRECTION) if (t.includes(key)) return value;
  return '';
}

export function buildEmotionTag(line, context = {}) {
  const cue = String(context.cue || '').trim();
  const mood = String(context.mood || '').trim();
  const direction = emotionDirection(`${cue} ${mood}`);
  if (direction) return `[${direction}]`;
  return '';
}

/* —— 请求：经代理走 https CONNECT 隧道 —— */
function proxyUrlFor(env = process.env) {
  const explicit = (env.FISH_AUDIO_PROXY || '').trim();
  if (explicit) return explicit;
  return DEFAULT_PROXY;
}

export function requestTts({ text, referenceId, format = 'mp3', apiKey, env = process.env, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const key = apiKey ?? '';
    if (!key) return reject(fail('未配置 Fish Audio API Key。', 409, { code: 'FISH_KEY_MISSING' }));
    const body = JSON.stringify({ text, reference_id: referenceId, format });
    const proxyUrl = proxyUrlFor(env);
    let agent;
    try { agent = new HttpsProxyAgent(proxyUrl); } catch { agent = undefined; }
    const req = https.request({
      host: 'api.fish.audio', path: '/v1/tts', method: 'POST',
      ...(agent ? { agent } : {}),
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'model': FISH_AUDIO_MODEL,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, contentType: res.headers['content-type'] || 'audio/mpeg', audio: buffer, size: buffer.length });
        } else {
          let message = `Fish Audio HTTP ${res.statusCode}`;
          try { message = JSON.parse(buffer.toString('utf8'))?.message || buffer.toString('utf8').slice(0, 300) || message; } catch {}
          reject(fail(message, res.statusCode === 401 || res.statusCode === 403 ? 409 : 502, { code: 'FISH_PROVIDER_ERROR', providerStatus: res.statusCode }));
        }
      });
    });
    req.on('timeout', () => req.destroy(fail('Fish Audio 请求超时。', 502, { code: 'FISH_TIMEOUT' })));
    req.on('error', err => reject(fail(`连接 Fish Audio 失败：${err.message}。可在设置里指定代理（FISH_AUDIO_PROXY）。`, 502, { code: 'FISH_UNREACHABLE' })));
    req.write(body);
    req.end();
  });
}

export function createFishAudioService({ dataDir, env = process.env, timeoutMs = 120000 } = {}) {
  const settingsDir = resolve(dataDir, 'settings');
  const settingsFile = join(settingsDir, 'fish-audio.json');
  const keyFile = join(settingsDir, 'fish-audio.dpapi');
  let secretCache;

  const readSettings = () => {
    let saved = {};
    try { saved = JSON.parse(readFileSync(settingsFile, 'utf8')) || {}; } catch { saved = {}; }
    return {
      voices: typeof saved.voices === 'object' && saved.voices ? saved.voices : {},
      // 全局音色库：角色资产通过 voicePresetId 关联到这里的一条记录。
      voicePresets: Array.isArray(saved.voicePresets) ? saved.voicePresets.filter(p => p && typeof p.id === 'string' && typeof p.voiceId === 'string') : [],
      // API Key 直接存在配置文件里（明文），优先级低于环境变量、高于 DPAPI。
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
      proxy: typeof saved.proxy === 'string' ? saved.proxy : '',
      format: typeof saved.format === 'string' ? saved.format : 'mp3',
      updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : '',
    };
  };

  // 配置文件里的明文 Key 优先（用户要求“直接写到配置文件”，改动会立即生效）；环境变量与 DPAPI 依次兜底。
  const authKey = () => {
    const fileKey = readSettings().apiKey.trim();
    if (fileKey) return fileKey;
    if (String(env.FISH_AUDIO_API_KEY || '').trim()) return env.FISH_AUDIO_API_KEY.trim();
    if (secretCache !== undefined) return secretCache;
    try { secretCache = readSecret(); } catch (error) { secretCache = ''; if (error.status === 503) throw error; }
    return secretCache;
  };

  const hasKey = () => {
    if (readSettings().apiKey.trim()) return true;
    if (String(env.FISH_AUDIO_API_KEY || '').trim()) return true;
    return existsSync(keyFile);
  };

  const publicState = () => {
    const current = readSettings();
    const { apiKey, ...safe } = current;
    return { ...safe, configured: hasKey(), hasApiKey: Boolean(apiKey), proxy: current.proxy || proxyUrlFor(env), model: FISH_AUDIO_MODEL };
  };

  // 角色资产只存 voicePresetId；真正发给 Fish Audio 的 voiceId 由全局音色库解析。
  const resolveVoiceId = (voicePresetId) => {
    const preset = readSettings().voicePresets.find(item => item.id === voicePresetId);
    return preset?.voiceId || '';
  };

  const normalizePresets = list => {
    if (!Array.isArray(list)) throw fail('音色库必须是数组。');
    const seen = new Set();
    return list.map(item => {
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim();
      const voiceId = String(item?.voiceId || '').trim();
      if (!id || !name || !voiceId) throw fail('每条音色都需要 id、名称和音色 ID。');
      if (!/^[a-zA-Z0-9_-]{2,64}$/.test(id)) throw fail(`音色 id 不合法：${id}`);
      if (!/^[a-zA-Z0-9_-]{8,64}$/.test(voiceId)) throw fail(`音色 ID 不合法：${voiceId}`);
      if (seen.has(id)) throw fail(`音色 id 重复：${id}`);
      seen.add(id);
      return { id, name, voiceId, note: String(item?.note || '') };
    });
  };

  const save = ({ voices, voicePresets, proxy, format, apiKey, clearKey }) => {
    const current = readSettings();
    let nextVoices = current.voices;
    if (voices !== undefined) {
      if (!voices || typeof voices !== 'object' || Array.isArray(voices)) throw fail('音色映射必须是对象。');
      nextVoices = voices;
    }
    let nextPresets = current.voicePresets;
    if (voicePresets !== undefined) nextPresets = normalizePresets(voicePresets);
    let nextProxy = current.proxy;
    if (proxy !== undefined) {
      if (typeof proxy !== 'string' || proxy.length > 300) throw fail('代理地址无效。');
      nextProxy = proxy.trim();
    }
    const nextFormat = format !== undefined ? String(format) : current.format;
    if (!['mp3', 'wav', 'pcm'].includes(nextFormat)) throw fail('音频格式必须是 mp3 / wav / pcm。');
    let nextApiKey = current.apiKey;
    if (clearKey) { nextApiKey = ''; rmSync(keyFile, { force: true }); }
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const trimmed = apiKey.trim();
      if (trimmed.length < 8 || trimmed.length > 400) throw fail('API Key 长度异常。');
      nextApiKey = trimmed; // 直接写入配置文件（明文），不再走 DPAPI。
      secretCache = undefined;
    }
    mkdirSync(settingsDir, { recursive: true });
    const payload = { apiKey: nextApiKey, voices: nextVoices, voicePresets: nextPresets, proxy: nextProxy, format: nextFormat, updatedAt: new Date().toISOString() };
    const temp = `${settingsFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(temp, settingsFile);
    return publicState();
  };

  // 单句/单说话人合成：返回音频 Buffer。
  const synthesize = async ({ text, referenceId, format }) => {
    const key = authKey();
    return requestTts({ text, referenceId, format: format || readSettings().format || 'mp3', apiKey: key, env, timeoutMs });
  };

  return { publicState, save, synthesize, authKey, hasKey, resolveVoiceId, paths: { settingsFile, keyFile } };
}
