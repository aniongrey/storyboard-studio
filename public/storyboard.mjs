export function storyboardShots(project, board) {
  return (board.data.shotIds || []).map(id => project.shots.find(shot => shot.id === id)).filter(Boolean);
}

export function storyboardSummary(project, board) {
  return storyboardShots(project, board).map(shot => shot.name?.trim() ||
    (shot.data.action || shot.data.composition || '').replace(/\s+/g, ' ').trim().slice(0, 48) || `未命名镜头 ${shot.code || ''}`.trim()).join(' → ');
}

export function storyboardProblem(project, shotIds, boardId) {
  if (!Array.isArray(shotIds) || shotIds.length < 1 || shotIds.length > 6 || new Set(shotIds).size !== shotIds.length) return '请选择1至6个不同的连续镜头。';
  const episode = project.shots.find(shot => shot.id === shotIds[0])?.data.episodeNumber ?? 1;
  if (shotIds.some(id => { const shot = project.shots.find(shot => shot.id === id); return shot && (shot.data.episodeNumber ?? 1) !== episode; })) return '故事板不能跨集，请按集分别成组。';
  const ordered = project.shots.filter(shot => (shot.data.episodeNumber ?? 1) === episode).sort((a, b) => a.order - b.order);
  const positions = shotIds.map(id => ordered.findIndex(shot => shot.id === id)).sort((a, b) => a - b);
  if (positions[0] < 0) return '故事板只能引用本作品的镜头。';
  if (positions.at(-1) - positions[0] !== shotIds.length - 1) return '故事板需要连续镜头。';
  const existing = (project.storyboards || []).find(board => board.id === boardId);
  // Keep existing groups readable; new membership must fit the audio slots.
  if ((!existing || shotIds.some(id => !existing.data.shotIds.includes(id)) || shotIds.length !== existing.data.shotIds.length) && storyboardSpeakingCharacters(project, { data: { shotIds } }).length > 3) return '每组最多3个说话角色；请将第四个角色所在镜头分到下一组。';
  const tailIds = new Set(ordered.slice(-4).map(shot => shot.id));
  const isTail = ids => ids.length === 4 && ids.every(id => tailIds.has(id));
  // Single-shot repairs coexist with the original multi-shot group.
  if ((project.storyboards || []).some(board => board.id !== boardId && shotIds.length > 1 && board.data.shotIds.length > 1 && board.data.shotIds.some(id => shotIds.includes(id)) && !(existing && (isTail(shotIds) || isTail(board.data.shotIds))))) return '所选镜头已属于其他故事板。';
  if ((project.storyboards || []).some(board => board.id !== boardId && board.data.shotIds.length === shotIds.length && shotIds.every(id => board.data.shotIds.includes(id)))) return '这些镜头已经组成故事板。';
  return '';
}

// 每组最多四镜、三个不同说话角色；不足四镜留白，不重复补片尾。
export function planStoryboardGroups(project, { startShotId, limit = 0, episodeNumber } = {}) {
  const ordered = project.shots.filter(shot => episodeNumber === undefined || (shot.data.episodeNumber ?? 1) === episodeNumber).sort((a, b) => a.order - b.order);
  const claimed = new Set((project.storyboards || []).flatMap(board => board.data.shotIds));
  const first = startShotId
    ? ordered.findIndex(shot => shot.id === startShotId)
    : ordered.findIndex(shot => !claimed.has(shot.id));
  const groups = [], blockers = [];
  if (first < 0) return { groups, remaining: ordered.filter(shot => !claimed.has(shot.id)).length, skipped: 0, blockers };
  let index = first, skipped = 0;
  while (index < ordered.length) {
    if (claimed.has(ordered[index].id)) { skipped++; index++; continue; }
    if (limit > 0 && groups.length >= limit) break;
    const shotIds = [];
    const episode = ordered[index].data.episodeNumber ?? 1;
    while (index < ordered.length && shotIds.length < 4 && !claimed.has(ordered[index].id) && (ordered[index].data.episodeNumber ?? 1) === episode) {
      const candidate = [...shotIds, ordered[index].id];
      if (storyboardSpeakingCharacters(project, { data: { shotIds: candidate } }).length > 3) {
        if (!shotIds.length) { blockers.push(`镜头 ${ordered[index].code} 单镜超过3个说话角色，请先拆分对白镜头。`); index++; skipped++; }
        break;
      }
      shotIds.push(ordered[index++].id);
    }
    if (!shotIds.length) continue;
    groups.push(shotIds);
    for (const id of shotIds) claimed.add(id);
  }
  return { groups, remaining: ordered.filter(shot => !claimed.has(shot.id)).length, skipped, blockers };
}

const panelNames = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const shotCounts = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
const panelsFor = count => count > 4 ? ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] : panelNames;
const panelOrder = count => panelsFor(count).slice(0, count).join(', ') + (count < panelsFor(count).length ? `; ignore the empty ${count === 2 ? 'bottom panels' : panelsFor(count).slice(count).join(', ')+' panels'}` : '');
const dialogueAudioInstruction = '<Audio 1> is the complete dialogue track for this storyboard. Preserve its speech, speaker identities, timing and pauses exactly; do not generate additional speech or audio.\nAudio reuse: fully_copy';

export function storyboardAssets(project, board) {
  const ids = new Set(storyboardShots(project, board).flatMap(shot => ['characterIds', 'locationIds', 'propIds'].flatMap(key => shot.data[key] || [])));
  return project.assets.filter(asset => ids.has(asset.id));
}

export function storyboardDuration(project, board) {
  return storyboardShots(project, board).reduce((sum, shot) => sum + (Number(shot.data.duration) || 0), 0);
}

export function storyboardSource(project, board) {
  const dependencies = [...storyboardShots(project, board), ...storyboardAssets(project, board)];
  return {
    shotIds: [...board.data.shotIds],
    dependencyVersions: Object.fromEntries(dependencies.map(entity => [entity.id, entity.currentVersion])),
    referenceImages: Object.fromEntries(dependencies.map(entity => [entity.id, entity.adoptedMediaIds?.image || (entity.media || []).find(media => media.id === entity.adoptedMediaId && media.kind === 'image')?.id || null])),
    projectVersion: project.versions?.at(-1)?.id,
    imageRequirements: board.data.imageRequirements || '',
  };
}

export function storyboardMediaFresh(project, board, media) {
  return Boolean(media?.metadata?.storyboardSource) && JSON.stringify(media.metadata.storyboardSource) === JSON.stringify(storyboardSource(project, board));
}

export function composeStoryboardPrompt(project, board, kind, config = {}) {
  const video = kind === 'video';
  const audio = video && storyboardAudio(board);
  const shots = storyboardShots(project, board);
  const panels = panelsFor(shots.length), grid = shots.length > 4 ? '3×2' : '2×2';
  const speech = video ? storyboardSpeech(project, board, config) : null;
  const duration = config.duration === undefined ? storyboardDuration(project, board) : Number(config.duration);
  const total = storyboardDuration(project, board);
  const lines = [
    video
      ? `Create one video clip with ${shotCounts[shots.length]} shots from the ${grid} storyboard in <Picture 1>. Read panels in order: ${panelOrder(shots.length)}. Render each shot full-screen. Do not show the grid, borders, captions or all panels at once. End after the last described shot; do not invent shots for empty cells.`
      : `Create ONE ${grid} storyboard image containing ${shotCounts[shots.length]} distinct shots. Panel order: ${panels.join(', ')}.${shots.length < panels.length ? ` Use only ${panels.slice(0, shots.length).join(', ')}; leave ${shots.length === 2 ? 'both bottom panels' : panels.slice(shots.length).join(', ')+' panels'} empty with solid white, no objects or text.` : ''} Choose one representative still moment per shot. Every panel has the same aspect ratio. No panel numbers, labels, captions or dialogue text. Preserve character and location consistency across panels.`,
    `Global visual style: ${project.style || ''}`,
    `Aspect ratio: ${video ? config.aspectRatio || project.aspectRatio : project.aspectRatio}`,
  ];
  if (audio) lines.push(dialogueAudioInstruction);
  for (const asset of storyboardAssets(project, board)) {
    lines.push(`${asset.type} ${asset.name}: ${[asset.data.description, asset.data.visualPrompt, asset.data.seedPrompt].filter(Boolean).join('\n')}`);
    if (video) for (const binding of config.referenceBindings || []) {
      if (audio && binding.fieldName === 'audio') continue;
      if (asset.media.some(media => media.id === binding.mediaId)) {
        const slots = binding.fieldName === 'audio' ? ['144', '160', '189'] : ['141', '142', '143', '161', '175', '176'];
        const index = slots.indexOf(binding.nodeId);
        if (index >= 0) lines.push(`${asset.name} reference: <${binding.fieldName === 'audio' ? 'Audio' : 'Picture'} ${index + 1}>.`);
      }
    }
  }
  if (video) for (const subject of speech.subjects) {
    lines.push(`${subject.tag} is ${subject.asset.name}.`);
    if (subject.speaker) for (const ref of speech.references(subject.asset).filter(ref => ref.audio)) lines.push(`${ref.tag} is the voice-timbre reference for ${subject.tag} (${subject.speaker}).`);
  }
  let elapsed = 0;
  shots.forEach((shot, index) => {
    const d = shot.data;
    const seconds = total > 0 ? duration * (Number(d.duration) || 0) / total : duration / shots.length;
    lines.push(`\nPanel ${index + 1} (${panels[index]}), shot ${shot.code} — ${shot.name}`);
    for (const [key, label] of [['characterIds', 'Characters'], ['locationIds', 'Locations'], ['propIds', 'Props']]) {
      const names = (d[key] || []).map(id => project.assets.find(asset => asset.id === id)?.name).filter(Boolean);
      if (names.length) lines.push(`${label}: ${names.join(', ')}`);
    }
    if (video) lines.push(`Timing: ${elapsed.toFixed(2)}–${(elapsed + seconds).toFixed(2)} seconds`);
    elapsed += seconds;
    const visualFields = !video && typeof d.firstFramePrompt === 'string' && d.firstFramePrompt.trim()
      ? [['firstFramePrompt', 'First frame (before subsequent action)'], ['shotSize', 'Shot size']]
      : [['action', 'Action'], ['shotSize', 'Shot size'], ['composition', 'Composition'], ['mood', 'Mood']];
    for (const [key, label] of visualFields) {
      if (d[key]) lines.push(`${label}: ${d[key]}`);
    }
    if (video && d.dialogue) lines.push(...(speech.dialogue[index].length ? speech.dialogue[index] : [`Non-spoken source note (do not read aloud): ${d.dialogue}`]));
    if (video) for (const [key, label] of [['camera', 'Camera'], ['transition', 'Transition'], ...(!audio ? [['sound', 'Sound'], ['overall_soundscape', 'Soundscape'], ['non_diegetic_music', 'Music']] : [])]) {
      if (d[key]) lines.push(`${label}: ${d[key]}`);
    }
  });
  if (video) lines.push(`\nTarget duration: ${duration} seconds. The shot timings above are proportional to the planned cut lengths; do not change the source shot plans.`);
  const extra = board.data[video ? 'videoRequirements' : 'imageRequirements'];
  if (extra) lines.push(`\nAdditional ${video ? 'video' : 'image'} requirements:\n${extra}`);
  return lines.join('\n');
}

export function storyboardFinalPrompt(project, board, config = {}) {
  if (!board.data.finalPrompt?.trim()) return composeStoryboardPrompt(project, board, 'video', config);
  return storyboardAudio(board) ? board.data.finalPrompt : syncStoryboardAudio(project, board, config);
}

function syncStoryboardAudio(project, board, config) {
  const prompt = board.data.finalPrompt;
  const speakers = storyboardSpeakingCharacters(project, board);
  const voices = new Map();
  for (const match of prompt.matchAll(/(<Subject \d+>) \(S(\d+)\)/g)) {
    const asset = speakers[Number(match[2]) - 1];
    if (!asset) continue;
    const tags = (config.referenceBindings || []).filter(binding => binding.fieldName === 'audio' && (asset.media || []).some(media => media.kind === 'audio' && media.id === binding.mediaId))
      .map(binding => ['144','160','189'].indexOf(binding.nodeId) + 1).filter(index => index > 0).map(index => `<Audio ${index}>`);
    const label = `${match[1]} (S${match[2]})`;
    const appearance = JSON.stringify(asset.data || {});
    const existing = prompt.split('\n').find(line => line.startsWith(`${label} uses `) && !/<Audio \d+>/.test(line));
    const fallback = existing?.match(/ uses ([^.]+)\./)?.[1] || (/female|woman|mother|queen|女/i.test(appearance) ? 'a distinct consistent female Mandarin voice' : 'a distinct consistent Mandarin voice');
    voices.set(label, { label, tags, voice: tags.length ? `the voice timbre from ${tags.join(' and ')}` : fallback });
  }
  if (!voices.size) return prompt;
  const sections = prompt.split(/(?=^(?:subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):)/m);
  return sections.map(section => {
    const definitions = section.startsWith('subject_definitions:');
    const retention = section.startsWith('retention_analysis:');
    const lines = section.split('\n').flatMap(line => {
      // Dialogue content is never rewritten; only the speaker's voice instruction before <d> changes.
      const prefix = line.split('<d>')[0];
      const voice = [...voices.values()].find(item => prefix.includes(item.label));
      if (voice && /\bsays\b/.test(prefix) && line.includes('<d>')) return line.replace(/\bsays\b.*?(?=<d>)/, `says using ${voice.voice}: `);
      if ((definitions || retention) && /^<Audio \d+>/.test(line)) return [];
      if (definitions && voice && /\buses\b|voice.timbre reference/.test(line)) return [];
      return [line];
    });
    if (definitions) {
      while (lines.at(-1) === '') lines.pop();
      lines.push(...[...voices.values()].map(item => `${item.label} uses ${item.voice}. Use its timbre only, never its original spoken words.`), '', '');
    }
    if (retention) {
      while (lines.at(-1) === '') lines.pop();
      lines.push(...[...voices.values()].flatMap(item => item.tags.map(tag => `${tag}: reference - retain the assigned voice timbre for ${item.label}, without copying source content.`)), '', '');
    }
    return lines.join('\n');
  }).join('');
}

const dialogueEntries = shot => [...(shot.data.dialogue || '').matchAll(/^([^\n：:]+)[：:]\s*(.+)$/gm)].filter(match => !/^[（(]/.test(match[1].trim())).map(match => ({name:match[1].trim(),text:match[2].trim().replace(/^["“]|["”]$/g, '')}));
const visibleText = name => /(配文|字幕|屏幕|文字|文案)/.test(name);

export function storyboardSpeakingCharacters(project, board) {
  const speakers = new Map();
  for (const shot of storyboardShots(project, board)) for (const {name} of dialogueEntries(shot)) {
    if (visibleText(name)) continue;
    const asset = project.assets.find(asset => asset.type === 'character' && asset.name === name && (shot.data.characterIds || []).includes(asset.id));
    if (asset) speakers.set(asset.id, asset);
  }
  return [...speakers.values()];
}

function storyboardSpeech(project, board, config = {}) {
  const shots = storyboardShots(project, board), assets = storyboardAssets(project, board);
  const dialogueAudio = storyboardAudio(board);
  const subjects = assets.map((asset, index) => ({ asset, tag: `<Subject ${index + 1}>` }));
  const references = asset => (config.referenceBindings || []).flatMap(binding => {
    if (dialogueAudio && binding.fieldName === 'audio') return [];
    if (!(asset.media || []).some(media => media.id === binding.mediaId)) return [];
    const audio = binding.fieldName === 'audio';
    const index = (audio ? ['144', '160', '189'] : ['141', '142', '143', '161', '175', '176']).indexOf(binding.nodeId);
    return index < 0 ? [] : [{tag:`<${audio ? 'Audio' : 'Picture'} ${index + 1}>`,audio}];
  });
  let speakerCount = 0;
  const dialogue = shots.map(shot => {
    return dialogueEntries(shot).map(({name,text}) => {
      if (visibleText(name)) return `Visible text: "${text}". This text is not spoken.`;
      const subject = subjects.find(({asset}) => asset.type === 'character' && asset.name === name && (shot.data.characterIds || []).includes(asset.id));
      if (!subject) throw new Error(`镜头 ${shot.code} 的说话人“${name}”无法对应关联角色，请先确认，未修改最终提示词。`);
      subject.speaker ||= `S${++speakerCount}`;
      const audio = references(subject.asset).filter(ref => ref.audio).map(ref => ref.tag);
      return `${subject.tag} (${subject.speaker}) says${dialogueAudio ? ' in sync with their matching segment in <Audio 1>' : audio.length ? ` using the voice timbre from ${audio.join(' and ')}` : ' in the same consistent voice'}: <d>[Chinese] ${text}</d> Only this speaker moves their lips; the other characters listen with their lips closed.`;
    });
  });
  return {subjects,references,dialogue};
}

export function formatStoryboardFinalPrompt(project, board, config = {}) {
  const shots = storyboardShots(project, board);
  const dialogueAudio = storyboardAudio(board);
  const total = storyboardDuration(project, board), duration = Number(config.duration) || total;
  const {subjects,references,dialogue} = storyboardSpeech(project, board, config);
  const identify = value => subjects.reduce((text, { asset, tag }) => text.replaceAll(asset.name, `${tag} (${asset.name})`), value || '');
  const definitions = subjects.map(({ asset, tag }) => `${tag} is ${asset.name}, the ${asset.type} shown in <Picture 1>. Source appearance: ${[asset.data.description, asset.data.visualPrompt, asset.data.seedPrompt].filter(Boolean).join('\n')}${references(asset).filter(ref => !ref.audio).map(ref => ` Additional visual reference: ${ref.tag}.`).join('')}`);
  const voices = subjects.flatMap(subject => subject.speaker ? references(subject.asset).filter(ref => ref.audio).map(ref => ({tag:ref.tag,subject})) : []);
  definitions.push(...voices.map(({tag,subject}) => `${tag} is the voice-timbre reference for ${subject.tag} (${subject.speaker}); do not copy its original spoken content.`));
  if (dialogueAudio) definitions.push(dialogueAudioInstruction);
  let elapsed = 0;
  const details = shots.map((shot, index) => {
    const d = shot.data, seconds = total > 0 ? duration * (Number(d.duration) || 0) / total : duration / shots.length;
    const start = elapsed; elapsed += seconds;
    const cut = index ? `At ${String(Math.floor(start / 60)).padStart(2,'0')}:${(start % 60).toFixed(3).padStart(6,'0')}, the shot cuts to ` : '';
    const lines = [`[Shot ${index + 1}] ${cut}the ${panelsFor(shots.length)[index]} panel's composition in <Picture 1>, rendered full-screen. Shot ${shot.code}: ${shot.name}. This shot ends at ${elapsed.toFixed(2)} seconds.`];
    for (const [key, label] of [['action','Action'],['shotSize','Shot size'],['composition','Composition'],['mood','Mood'],['transition','Transition']]) {
      if (d[key]) lines.push(`${label}: ${identify(d[key])}`);
    }
    const camera = d.camera?.trim() ? identify(d.camera) :
      index === 0 ? 'The camera pushes in with small amplitude at slow speed from the storyboard composition, establishing the spatial relationship without changing screen direction.' :
      index === shots.length - 1 ? 'The camera pushes in with small amplitude at slow speed, eases to a stop before the shot ends, and holds the final expression or object state.' :
      /(跑|走|移动|追|奔|穿过)/.test(d.action || '') ? 'The camera tracks the moving subject with small amplitude at a matching speed, keeping the subject within the storyboard framing.' :
      'The camera holds a static shot at the storyboard angle, allowing the dialogue or reaction to play without reframing.';
    lines.push(`Camera: ${camera}`, ...dialogue[index]);
    if (d.dialogue && !dialogue[index].length) lines.push(`Non-spoken source note (do not read aloud or invent dialogue): ${d.dialogue}`);
    return lines.join('\n');
  });
  const collect = keys => shots.flatMap((shot, index) => keys.filter(key => shot.data[key]).map(key => `[Shot ${index + 1}] ${shot.data[key]}`)).join('\n');
  return [
    `subject_definitions:\n<Picture 1> is the adopted storyboard, defining composition and shot order.\n${definitions.join('\n\n')}`,
    `summary:\n[reference generation${dialogueAudio ? ' + complete dialogue track' : voices.length ? ' + audio reference' : ''}] Generate ${shots.length} full-screen shots in ${panelOrder(shots.length)} order. Do not show the grid, borders or added subtitles. End after the last described shot; do not invent shots for empty cells. Duration: ${duration} seconds. Aspect ratio: ${config.aspectRatio || project.aspectRatio}.`,
    `retention_analysis:\n<Picture 1>: fully_preserved - preserve its shot-planning role, not the visible grid.\n${subjects.map(({ asset, tag }) => `${tag} (appears in ${shots.flatMap((shot, index) => ['characterIds','locationIds','propIds'].some(key => (shot.data[key] || []).includes(asset.id)) ? [`[Shot ${index + 1}]`] : []).join(', ')}): fully_preserved - retain identity, appearance, clothing, materials and proportions.`).join('\n')}\n${voices.map(({tag}) => `${tag}: reference - use voice timbre without copying the source speech.`).join('\n')}`,
    `detailed_description:\nVisual style: ${project.style || 'Follow the storyboard visual style'}. Preserve the established camera axis, eyelines and character screen positions across cuts unless a source shot explicitly changes them.\n${details.join('\n\n')}${board.data.videoRequirements ? '\nAdditional requirements: '+board.data.videoRequirements : ''}`,
    `overall_soundscape:\n${dialogueAudio ? 'Use only the complete <Audio 1> track, including its pauses; add no other sound.' : collect(['sound','overall_soundscape']) || 'Natural room or location ambience with synchronized physical sounds; no additional speech.'}`,
    `non_diegetic_music:\n${dialogueAudio ? 'N/A' : collect(['non_diegetic_music','music']) || 'N/A'}`,
  ].join('\n\n');
}

const adopted = (entity, kind) => (entity.media || []).find(media => media.kind === kind && media.id === (entity.adoptedMediaIds?.[kind] || entity.adoptedMediaId));
export const storyboardAudio = board => adopted(board, 'audio');

export function previewSequence(project, scope = 'all') {
  if (scope === 'storyboards') {
    return (project.storyboards || [])
      .filter(board => !storyboardProblem(project, board.data.shotIds, board.id))
      .sort((a, b) => Math.min(...storyboardShots(project, a).map(shot => shot.order)) - Math.min(...storyboardShots(project, b).map(shot => shot.order)))
      .flatMap(board => {
        const video = adopted(board, 'video'), image = adopted(board, 'image');
        return video || image ? [{ shot: board, media: video || image, kind: video ? 'video' : 'image', plan: storyboardDuration(project, board) }] : [];
      });
  }
  const boards = (project.storyboards || []).filter(board => !storyboardProblem(project, board.data.shotIds, board.id) && adopted(board, 'video'));
  const result = [];
  for (const shot of [...project.shots].sort((a, b) => a.order - b.order)) {
    const board = boards.find(item => item.data.shotIds.includes(shot.id));
    if (board) {
      if (result.some(entry => entry.shot.id === board.id)) continue;
      result.push({ shot: board, media: adopted(board, 'video'), kind: 'video', plan: storyboardDuration(project, board) });
    } else {
      const video = adopted(shot, 'video'), image = adopted(shot, 'image');
      if (video || image) result.push({ shot, media: video || image, kind: video ? 'video' : 'image', plan: Number(shot.data.duration) || 0 });
    }
  }
  return result;
}

// 粗剪预览的画面比例取「本段媒体自己的尺寸」，而不是作品比例：竖幅四宫格与横屏视频都能占满舞台。
// 媒体元数据里没有尺寸时退回给的比例（作品比例），再没有就用 9:16。
export function mediaRatio(media, fallback) {
  const width = Number(media?.metadata?.width), height = Number(media?.metadata?.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return `${width} / ${height}`;
  return ratioText(fallback);
}

// 把 '9:16'、'9 / 16'、'16x9' 这类写法统一成 CSS `aspect-ratio` 能用的 `<w> / <h>`。
export function ratioText(value) {
  const parts = String(value || '').match(/\d+(?:\.\d+)?/g);
  return parts && parts.length >= 2 && Number(parts[0]) > 0 && Number(parts[1]) > 0 ? `${parts[0]} / ${parts[1]}` : '9 / 16';
}

export function ratioValue(ratio) {
  const parts = String(ratio || '').split('/').map(Number);
  return parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : 9 / 16;
}
