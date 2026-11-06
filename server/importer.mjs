import { createHash, randomUUID } from 'node:crypto';

const copy = value => structuredClone(value);
const id = prefix => `${prefix}_${randomUUID()}`;
const normalizeFilename = value => String(value || 'storyboard.md').split(/[\\/]/).pop();

export function parseMarkdown(text, filename = 'storyboard.md') {
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('分镜文件内容为空。'), { status: 400 });
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2], start: index }] : [];
  });
  for (let i = 0; i < headings.length; i++) {
    headings[i].end = headings.slice(i + 1).find(h => h.level <= headings[i].level)?.start ?? lines.length;
  }
  const raw = heading => lines.slice(heading.start, heading.end).join('\n').trimEnd();
  const sourceLines = heading => [heading.start + 1, heading.end];
  const issues = [];
  const issue = (title, detail, entity, range) => issues.push({
    id: id('issue'), title, detail, status: 'open',
    ...(entity ? { entityId: entity.id } : {}),
    ...(range || entity?.sourceLines ? { sourceLines: range || entity.sourceLines } : {}),
  });
  const title = headings.find(h => h.level === 1)?.title?.replace(/^《|》分镜提示词$/g, '') || normalizeFilename(filename).replace(/\.md$/i, '');
  const field = (block, label) => {
    const entries = [...block.matchAll(/^- \*\*([^*]+)\*\*[：:]\s*([^\n]*)(?:\n|$)/gm)];
    const entry = entries.find(match => match[1] === label);
    if (!entry) return '';
    const next = entries.find(match => match.index > entry.index);
    return block.slice(entry.index + entry[0].indexOf(entry[2]), next?.index ?? block.length)
      .replace(/\n---\s*$/, '').trim();
  };
  const metadataHeading = headings.find(h => h.level === 2 && /项目元数据/.test(h.title));
  const metadata = metadataHeading ? raw(metadataHeading) : '';
  const styleHeading = headings.find(h => h.level === 2 && /风格总设定/.test(h.title));
  const assets = [];
  const makeEntity = (type, code, name, data, heading) => ({
    id: id(type), type, code, name, order: 0, data, sourceLines: sourceLines(heading), raw: raw(heading),
    currentVersion: null, versions: [], media: [], adoptedMediaId: null, adoptedMediaIds: { image: null, video: null },
  });
  for (const heading of headings) {
    const character = /^角色(\d+)[：:]\s*(.+)/.exec(heading.title);
    const location = /^场景([A-Z])[：:]\s*(.+)/.exec(heading.title);
    const prop = /^道具(P\d+)[：:]\s*(.+)/.exec(heading.title);
    if (heading.level !== 3 || (!character && !location && !prop)) continue;
    const block = raw(heading);
    const json = /```json\s*\n([\s\S]*?)\n```/.exec(block)?.[1];
    let details = {};
    let valid = true;
    try {
      details = JSON.parse(json || '{}');
      if (!details || typeof details !== 'object' || Array.isArray(details)) { details = {}; valid = false; }
    } catch { valid = false; }
    const type = character ? 'character' : location ? 'location' : 'prop';
    const code = (character || location || prop)[1];
    const name = details.name || (character ? character[2].replace(/（.*$/, '') : (location || prop)[2]);
    const entity = makeEntity(type, code, name, {
      description: details.appearance?.body || details.scene_heading || details.description || '',
      visualPrompt: details.visual_prompt || '', seedPrompt: details.seed_prompt || '',
      details, notes: '', confirmed: false,
      // 角色资产关联全局音色库：voicePresetId 指向 data/settings/fish-audio.json 的 voicePresets[].id
      ...(type === 'character' ? { voicePresetId: '' } : {}),
    }, heading);
    entity.order = assets.filter(a => a.type === type).length;
    assets.push(entity);
    if (!valid) issue('设定 JSON 无法解析', '原始代码块已保留，请手工修正；没有执行代码块。', entity);
  }
  const sceneHeadings = headings.filter(h => h.level === 3 && /^第.+场[：:]/.test(h.title));
  const storyScenes = sceneHeadings.map((heading, order) => ({
    id: id('scene'), title: heading.title, order,
    notes: raw(heading).split(/\n#### 镜头 /)[0].trim(),
    sourceLines: sourceLines(heading),
  }));
  const locations = assets.filter(a => a.type === 'location');
  const characters = assets.filter(a => a.type === 'character');
  const shots = headings.filter(h => h.level === 4 && /^镜头\s+/.test(h.title)).map((heading, order) => {
    const match = /^镜头\s+([^｜|]+)[｜|]\s*(.+)$/.exec(heading.title);
    if (!match) return null;
    const block = raw(heading);
    const videoPrompt = field(block, 'AI视频提示词').replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '').trim();
    const durationText = field(block, '时长');
    const duration = Number(/^[\d.]+/.exec(durationText)?.[0] || 0);
    const sceneIndex = sceneHeadings.findLastIndex(h => h.start < heading.start);
    const codes = match[1].split('-').slice(1).join('-').split('/');
    const data = {
      shotSize: field(block, '景别'), composition: field(block, '构图'), camera: field(block, '运镜'),
      action: field(block, '画面内容'), dialogue: field(block, '台词'), mood: field(block, '情绪氛围'),
      videoPrompt, duration, transition: field(block, '转场'),
      characterIds: characters.filter(a => block.includes(a.name) || block.includes(a.name.replace(/小姐|先生/g, ''))).map(a => a.id),
      locationIds: locations.filter(a => codes.includes(a.code)).map(a => a.id),
      ...(assets.some(a => a.type === 'prop') ? { propIds: assets.filter(a => a.type === 'prop' && block.includes(a.name)).map(a => a.id) } : {}),
      sceneId: storyScenes[sceneIndex]?.id || null,
    };
    const entity = makeEntity('shot', match[1].trim(), match[2], data, heading);
    entity.order = order;
    if (!duration || !videoPrompt) issue('镜头字段缺失', '时长或视频提示词未识别，请核对原文。', entity);
    return entity;
  }).filter(Boolean);
  if (!shots.length && !assets.length) {
    throw Object.assign(new Error('未识别角色、场景或镜头；首版仅支持示例分镜格式。'), { status: 400 });
  }
  const propNames = ['手机', '订婚喜帖', '糖霜戒指', '戒指盒', '爱心卡', '礼盒', '笔', '午饭托盘', '酱汁盒', '日期便签', '试味样品', '试味本', '联名合约', '品牌招牌'];
  const propPatterns = [/手机/, /订婚喜帖/, /糖霜戒指/, /戒指盒/, /爱心卡|手写卡/, /礼盒/, /提笔|写上新品牌|写下品牌/, /端一盘午饭|托盘/, /酱汁盒/, /手机\/便签|核对日期/, /样品|新品半成品/, /试味本|试味记录本/, /联名合约|独家联名/, /品牌招牌|写上新品牌/];
  propNames.forEach((name, index) => {
    if (assets.some(asset => asset.type === 'prop' && (asset.name === name || asset.code === `P${String(index + 1).padStart(2, '0')}`))) return;
    const lineIndex = lines.findIndex(line => propPatterns[index].test(line));
    if (lineIndex < 0) return;
    const entity = makeEntity('prop', `P${String(index + 1).padStart(2, '0')}`, name, {
      description: lines[lineIndex].replace(/^\s*-\s*/, '').trim(), visualPrompt: '', seedPrompt: '',
      details: { inferred: true }, notes: '从原文推断的候选道具；需确认、合并或排除。', confirmed: false,
    }, { start: lineIndex, end: lineIndex + 1 });
    entity.order = index;
    assets.push(entity);
  });
  if (shots.some(shot => shot.data.characterIds.length)) {
    issue('角色引用由文本推断', '逐镜角色关联来自名字匹配，未包含完整语义判断；请核对画内、画外和屏幕中的人物。');
  }
  const shotCodes = new Set(shots.map(shot => shot.code));
  for (const code of new Set(text.match(/\b\d{2}-[A-Z](?:\/[A-Z])?/g) || [])) {
    if (!shotCodes.has(code)) {
      const index = lines.findIndex(line => line.includes(code));
      issue('镜头引用不存在', `原文引用 ${code}，没有对应镜头；保留原引用，不自动替换。`, null, [index + 1, index + 1]);
    }
  }
  const summaryDuration = shots.reduce((sum, shot) => sum + shot.data.duration, 0);
  const statedDuration = /\*\*总预估时长\*\*[：:]\s*约?(\d+)秒/.exec(text);
  if (statedDuration && Number(statedDuration[1]) !== summaryDuration) {
    issue('时长合计与原文汇总不同', `镜头合计 ${summaryDuration} 秒，原文汇总 ${statedDuration[1]} 秒；目标时长另行保留，不自动拉长。`);
  }
  const findShot = code => shots.find(shot => shot.code === code);
  if (findShot('05-A') && text.includes('店铺夜')) {
    issue('05-A 地点归属冲突', '编号指向冷藏间 A，速查表写店铺夜；当前保留 A 引用，等待确认是否应为 C。', findShot('05-A'));
  }
  if (findShot('07-B') && findShot('26-D') && text.includes('补好') && text.includes('缺右半边')) {
    issue('爱心卡状态连续性待确认', '07-B/15-C 的卡已补好；D 场景、22-D/26-D 又出现缺右半边的卡，需确认是否同一件道具。', findShot('26-D'));
  }
  if (findShot('17-D')?.data.shotSize.includes('2S')) {
    issue('17-D 景别与人物数量待核对', '标注 2S，但构图含泡芙、草莓、螃蟹三人；保留原景别。', findShot('17-D'));
  }
  for (const shot of shots.filter(shot => shot.data.locationIds.length > 1)) {
    issue('跨地点镜头', `${shot.code} 关联多个地点，分屏/蒙太奇保留为一镜，可人工拆分。`, shot);
  }
  if (text.includes('沿用前作')) issue('前作参考图未绑定', '螃蟹要求沿用前作外观，本文件没有提供实际媒体；需要显式绑定参考图。');
  if (locations.some(location => /厨房.*摊位|甜品店.*新店/.test(location.name))) {
    issue('地点别名与变体待确认', 'C 的原店/新店、E 的厨房/摊位可能需要不同布景版本；未自动拆分或合并。');
  }
  return {
    id: id('project'), title: field(metadata, '片名') || title, aspectRatio: /16:9/.test(field(metadata, '画面比例')) ? '16:9' : '9:16',
    style: styleHeading ? raw(styleHeading) : '', targetDuration: field(metadata, '预估总时长'), summaryDuration,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    source: { filename: normalizeFilename(filename), hash: createHash('sha256').update(text).digest('hex').toUpperCase(), text, importedAt: new Date().toISOString(), parserVersion: 1 },
    storyScenes, assets: copy(assets), shots, issues,
  };
}
