import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseMarkdown } from './importer.mjs';
import { storyboardProblem, planStoryboardGroups, storyboardSummary } from '../public/storyboard.mjs';

const copy = value => value === undefined ? undefined : structuredClone(value);
const now = () => new Date().toISOString();
const makeId = prefix => `${prefix}_${randomUUID()}`;
const fail = (message, status = 400, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const entities = project => [...project.assets, ...project.shots, ...(project.storyboards || [])];
const mergedHistory = project => (project.shotMergeArchives || []).flatMap(archive => [...archive.shots, ...archive.storyboards]);
// 账号并发上限：本机同时允许几个付费视频任务在跑。默认 1（首版行为），上限 32 防止手滑写大。
export const MAX_VIDEO_CONCURRENCY = 32;
export const DEFAULT_VIDEO_CONCURRENCY = 1;
const normalizeConcurrency = value => Number.isInteger(value) && value >= 1 && value <= MAX_VIDEO_CONCURRENCY ? value : DEFAULT_VIDEO_CONCURRENCY;
const ACTIVE_VIDEO_STATES = ['preparing', 'submitting', 'queued', 'running', 'downloading', 'query_failed', 'submission_unknown'];
const AUTO_RUN_HISTORY = 20;
const migrateAdoption = document => {
  document.settings = { videoConcurrency: DEFAULT_VIDEO_CONCURRENCY, accountConcurrency: null, ...(document.settings || {}) };
  document.settings.videoConcurrency = normalizeConcurrency(document.settings.videoConcurrency);
  document.autoRuns ??= [];
  for (const project of document.projects) {
    project.storyboards ??= [];
    project.episodes ??= [1];
    for (const shot of project.shots) shot.data.episodeNumber ??= 1;
    for (const entity of entities(project)) {
      entity.adoptedMediaIds = { image: null, video: null, audio: null, ...entity.adoptedMediaIds };
      const adopted = entity.media.find(media => media.id === entity.adoptedMediaId);
      if (adopted && !entity.adoptedMediaIds[adopted.kind]) entity.adoptedMediaIds[adopted.kind] = adopted.id;
    }
  }
  return document;
};

export class StudioStore {
  constructor({ dataDir }) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, 'studio.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS studio_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    const row = this.db.prepare('SELECT value FROM studio_state WHERE id=1').get();
    this.document = migrateAdoption(row ? JSON.parse(row.value) : { activeProjectId: null, projects: [], jobs: [] });
    if (!row) this.db.prepare('INSERT INTO studio_state (id,value) VALUES (1,?)').run(JSON.stringify(this.document));
  }

  read() {
    if (this.inTransaction) return;
    const version = this.db.prepare('PRAGMA data_version').get().data_version;
    if (version === this.dataVersion) return;
    this.document = migrateAdoption(JSON.parse(this.db.prepare('SELECT value FROM studio_state WHERE id=1').get().value));
    this.dataVersion = version;
  }

  // shortcut: one JSON row for a local studio, use separate records when project size makes rewrites costly.
  change(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    this.read();
    const before = this.document;
    this.document = copy(before);
    this.inTransaction = true;
    try {
      const result = operation();
      migrateAdoption(this.document);
      this.db.prepare('UPDATE studio_state SET value=? WHERE id=1').run(JSON.stringify(this.document));
      this.db.exec('COMMIT');
      this.inTransaction = false;
      return copy(result);
    } catch (error) {
      this.document = before;
      this.db.exec('ROLLBACK');
      this.inTransaction = false;
      throw error;
    }
  }

  project(projectId) {
    this.read();
    projectId ??= this.document.activeProjectId;
    const project = this.document.projects.find(item => item.id === projectId);
    if (!project) fail('作品不存在。', 404);
    return project;
  }

  entity(projectId, entityId) {
    const entity = entities(this.project(projectId)).find(item => item.id === entityId);
    if (!entity) fail('资产或镜头不存在。', 404);
    return entity;
  }

  state(projectId) {
    this.read();
    const active = projectId || this.document.activeProjectId;
    return copy({
      promptPreferences: copy(this.document.promptPreferences || {}),
      settings: this.settings(),
      projects: this.document.projects.map(({ id, title }) => ({ id, title })),
      project: active ? this.project(active) : null,
      jobs: this.document.jobs.filter(job => !job.projectId || !active || job.projectId === active),
      autoRuns: this.document.autoRuns.filter(run => !active || run.projectId === active).slice(-AUTO_RUN_HISTORY),
    });
  }

  settings() {
    this.read();
    return copy({ videoConcurrency: normalizeConcurrency(this.document.settings?.videoConcurrency), accountConcurrency: this.document.settings?.accountConcurrency || null });
  }

  allJobs() { this.read(); return copy(this.document.jobs); }

  videoConcurrency() { return this.settings().videoConcurrency; }

  setVideoConcurrency(value) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_VIDEO_CONCURRENCY) fail(`并发上限必须是 1–${MAX_VIDEO_CONCURRENCY} 的整数。`);
    return this.change(() => { this.document.settings.videoConcurrency = value; return this.settings(); });
  }

  // 最近一次从 RunningHub 读到的账号队列状态（含失败原因），只作展示与取上限用，不参与提交判定。
  setAccountConcurrency(account) {
    return this.change(() => { this.document.settings.accountConcurrency = account ? copy(account) : null; return this.settings(); });
  }

  setPromptPreference(id, enabled) {
    const allowed = ['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music','global_style','composition','camera','mood','transition','timing'];
    if (!allowed.includes(id) || typeof enabled !== 'boolean') fail('提示词选项无效。');
    return this.change(() => { this.document.promptPreferences ??= {}; this.document.promptPreferences[id] = enabled; return this.document.promptPreferences; });
  }

  getProject(projectId) { return copy(this.project(projectId)); }
  getEntity(projectId, entityId) {
    const project = this.project(projectId);
    const entity = [...entities(project), ...mergedHistory(project)].find(item => item.id === entityId);
    if (!entity) fail('资产或镜头不存在。', 404);
    return copy(entity);
  }

  importMarkdown(text, filename, { asNewProject = false } = {}) {
    if (typeof text !== 'string') fail('分镜内容必须是文本。');
    const agentInstructions = { file: 'AGENTS.md', text: readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8') };
    return this.change(() => {
    const hash = createHash('sha256').update(text).digest('hex').toUpperCase();
    const duplicate = this.document.projects.find(project => project.source.hash === hash);
    if (duplicate) { this.document.activeProjectId = duplicate.id; return { ...duplicate, agentInstructions }; }
    const project = parseMarkdown(text, filename);
    project.episodes = [1];
    for (const shot of project.shots) shot.data.episodeNumber = 1;
    project.agentInstructions = agentInstructions;
    const previous = this.document.projects.find(item =>
      item.source.filename.toLowerCase() === project.source.filename.toLowerCase() || item.title === project.title);
    if (previous && !asNewProject) {
      const oldEntities = entities(previous);
      const newEntities = entities(project);
      const key = entity => `${entity.type}:${entity.code}`;
      const comparison = {
        previousProjectId: previous.id, previousHash: previous.source.hash, incomingHash: project.source.hash,
        previous: { title: previous.title, assets: previous.assets.length, shots: previous.shots.length, duration: previous.summaryDuration },
        incoming: { title: project.title, assets: project.assets.length, shots: project.shots.length, duration: project.summaryDuration },
        changed: newEntities.filter(entity => oldEntities.some(old => key(old) === key(entity) && old.raw !== entity.raw)).map(entity => entity.code),
        added: newEntities.filter(entity => !oldEntities.some(old => key(old) === key(entity))).map(entity => entity.code),
        removed: oldEntities.filter(entity => !newEntities.some(next => key(next) === key(entity))).map(entity => entity.code),
      };
      fail('发现同名文件或作品的新内容；请比较差异后明确选择另建作品，已有编辑没有覆盖。', 409,
        { code: 'IMPORT_CHANGED', comparison, details: { code: 'IMPORT_CHANGED', comparison } });
    }
    for (const entity of entities(project)) {
      entity.adoptedMediaIds = { image: null, video: null, audio: null, ...entity.adoptedMediaIds };
      const revision = { id: makeId('rev'), at: now(), data: copy(entity.data), name: entity.name, code: entity.code, order: entity.order };
      entity.currentVersion = revision.id;
      entity.versions = [revision];
    }
    project.versions = [{ id: makeId('projectrev'), at: now(), title: project.title, style: project.style, aspectRatio: project.aspectRatio, targetDuration: project.targetDuration }];
    project.source.file = `projects/${project.id}/imports/${project.source.hash}/original.md`;
    const sourceFile = join(this.dataDir, project.source.file);
    mkdirSync(dirname(sourceFile), { recursive: true });
    try { writeFileSync(sourceFile, text, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existingHash = createHash('sha256').update(readFileSync(sourceFile)).digest('hex').toUpperCase();
      if (existingHash !== project.source.hash) fail('原文副本路径已有不同内容；没有覆盖。', 409);
    }
    this.document.projects.push(project);
    this.document.activeProjectId = project.id;
    return project;
    });
  }

  selectProject(projectId) {
    this.project(projectId);
    return this.change(() => { this.document.activeProjectId = projectId; return this.project(projectId); });
  }

  addEpisode(projectId, number, name = '') {
    if (!Number.isSafeInteger(number) || number < 1) fail('集数必须是正整数。');
    if (typeof name !== 'string' || name.trim().length > 80) fail('集数名称必须是不超过80字的文本。');
    return this.change(() => {
      const project = this.project(projectId);
      if (project.episodes.includes(number)) fail(`第${number}集已存在。`, 409);
      project.episodes.push(number);
      project.episodes.sort((a, b) => a - b);
      if (name.trim()) project.episodeNames = { ...project.episodeNames, [number]: name.trim() };
      project.updatedAt = now();
      return project;
    });
  }

  deleteEpisode(projectId, number, { baseUpdatedAt } = {}) {
    if (!Number.isSafeInteger(number) || number < 1) fail('集数必须是正整数。');
    return this.change(() => {
      const project = this.project(projectId);
      if (!project.episodes.includes(number)) fail('集数不存在。', 404);
      if (project.episodes.length === 1) fail('请至少保留一集。', 409);
      if (typeof baseUpdatedAt !== 'string' || baseUpdatedAt !== project.updatedAt) fail('作品已有更新，请刷新后核对再删除。', 409, { code: 'VERSION_CONFLICT' });
      const shots = project.shots.filter(shot => shot.data.episodeNumber === number);
      const shotIds = new Set(shots.map(shot => shot.id));
      const storyboards = project.storyboards.filter(board => board.data.shotIds.some(id => shotIds.has(id)));
      if (storyboards.some(board => board.data.shotIds.some(id => !shotIds.has(id)))) fail('故事板跨集，未删除。', 409);
      const ids = new Set([...shotIds, ...storyboards.map(board => board.id)]);
      const jobs = this.document.jobs.filter(job => job.projectId === projectId && ids.has(job.entityId));
      if (jobs.some(job => !['ready', 'failed', 'delivery_invalid', 'interrupted', 'cancelled'].includes(job.status))) fail('本集还有未结束或状态不明的生成任务，未删除。', 409);
      const runs = this.document.autoRuns.filter(run => run.projectId === projectId && run.items.some(item => ids.has(item.entityId)));
      if (runs.some(run => !['completed', 'cancelled'].includes(run.status))) fail('本集还有未结束的自动队列，未删除。', 409);
      const remainingShots = project.shots.filter(shot => !shotIds.has(shot.id));
      const remainingBoards = project.storyboards.filter(board => !ids.has(board.id));
      const sceneIds = new Set(shots.map(shot => shot.data.sceneId).filter(id => id && !remainingShots.some(shot => shot.data.sceneId === id)));
      // 删除工作条目时保留完整备份和原文件，避免连带移除共用素材。
      const archive = { id: makeId('episodearchive'), at: now(), episodeNumber: number, name: project.episodeNames?.[number] || '',
        shots: copy(shots), storyboards: copy(storyboards), storyScenes: copy(project.storyScenes.filter(scene => sceneIds.has(scene.id))),
        sourceAnnotations: copy(project.sourceAnnotations?.[number] || null), issues: copy(project.issues.filter(issue => ids.has(issue.entityId))),
        jobs: copy(jobs), autoRuns: copy(runs) };
      (project.episodeArchives ??= []).push(archive);
      project.episodes = project.episodes.filter(episode => episode !== number);
      if (project.episodeNames) delete project.episodeNames[number];
      if (project.sourceAnnotations) delete project.sourceAnnotations[number];
      project.shots = remainingShots;
      project.storyboards = remainingBoards;
      project.storyScenes = project.storyScenes.filter(scene => !sceneIds.has(scene.id));
      project.issues = project.issues.filter(issue => !ids.has(issue.entityId));
      this.document.jobs = this.document.jobs.filter(job => !jobs.some(removed => removed.id === job.id));
      // 完成队列保留其他集的历史项，只移除本集的项。
      for (const run of runs) run.items = run.items.filter(item => !ids.has(item.entityId));
      this.document.autoRuns = this.document.autoRuns.filter(run => !runs.includes(run) || run.items.length);
      project.summaryDuration = project.shots.reduce((sum, shot) => sum + shot.data.duration, 0);
      project.updatedAt = now();
      return { project, archive };
    });
  }

  getSourceAnnotations(projectId, episodeNumber) {
    const project = this.project(projectId);
    if (!Number.isSafeInteger(episodeNumber) || !project.episodes.includes(episodeNumber)) fail('请选择本作品已有的集数。');
    return copy(project.sourceAnnotations?.[episodeNumber] || null);
  }

  saveSourceAnnotations(projectId, { episodeNumber, baseVersion, videoPath = '', marks = [], audioPath, audioName, audioDuration } = {}) {
    if (typeof videoPath !== 'string' || videoPath.length > 4000) fail('原视频路径须为不超过4000字的文本。');
    if (audioPath !== undefined && (typeof audioPath !== 'string' || audioPath.length > 4000)) fail('音频路径须为不超过4000字的文本。');
    if (audioName !== undefined && (typeof audioName !== 'string' || audioName.length > 300)) fail('音频名称须为不超过300字的文本。');
    if (!Array.isArray(marks) || marks.length > 2000) fail('打标须为不超过2000条的列表。');
    const normalizedMarks = marks.map(mark => {
      if (!mark || typeof mark !== 'object' || Array.isArray(mark)) fail('每条打标须为文本记录。');
      const record = Object.fromEntries(['time', 'camera', 'content'].map(key => {
        const value = mark[key] ?? '';
        if (typeof value !== 'string' || value.length > 20000) fail('打标字段须为不超过20000字的文本。');
        return [key, value];
      }));
      // 镜号是可选的切音依据，没填就不落字段，旧记录结构保持不变。
      const shotCode = mark.shotCode ?? '';
      if (typeof shotCode !== 'string' || shotCode.length > 200) fail('打标镜号须为不超过200字的文本。');
      if (shotCode) record.shotCode = shotCode;
      if (mark.title !== undefined) {
        if (typeof mark.title !== 'string' || mark.title.length > 300) fail('镜头标题须为不超过300字的文本。');
        if (mark.title) record.title = mark.title;
      }
      if (mark.comparisons !== undefined) {
        if (!Array.isArray(mark.comparisons) || mark.comparisons.length > 500) fail('每个镜头的比对时间点须为不超过500条的列表。');
        record.comparisons = mark.comparisons.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.time !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(item.time) || !Number.isFinite(Number(item.time)) || Number(item.time) < 0) fail('比对时间点须为有效的非负秒数文本。');
          const comparison = { time: String(Number(item.time)) };
          for (const [key, max] of [['generatedMediaId', 200], ['sourceMediaId', 200], ['note', 20000], ['sourceVideoPath', 4000]]) {
            if (item[key] === undefined) continue;
            if (typeof item[key] !== 'string' || item[key].length > max) fail('比对图片、说明或原视频路径字段无效。');
            if (item[key] || !key.endsWith('MediaId')) comparison[key] = item[key];
          }
          if (item.status !== undefined) {
            if (!['unreviewed', 'pass', 'note', 'needs_review'].includes(item.status)) fail('比对检查状态无效。');
            comparison.status = item.status;
          }
          return comparison;
        });
      }
      return record;
    });
    return this.change(() => {
      const previous = this.getSourceAnnotations(projectId, episodeNumber);
      if (baseVersion !== (previous?.currentVersion || null)) fail('打标已在其他页面更新；本次输入没有覆盖，请先复制保留后刷新。', 409, { code: 'VERSION_CONFLICT' });
      const project = this.project(projectId);
      const shotIds = new Set(project.shots.filter(shot => (shot.data.episodeNumber ?? 1) === episodeNumber).map(shot => shot.id));
      const owners = [...project.shots.filter(shot => shotIds.has(shot.id)), ...(project.storyboards || []).filter(board => board.data.shotIds?.length && board.data.shotIds.every(id => shotIds.has(id)))];
      const imageIds = new Set(owners.flatMap(owner => owner.media.filter(media => media.kind === 'image').map(media => media.id)));
      const previousImages = new Set();
      // 镜头归集变化后仍保留旧配对；新增时间点或图片引用继续按本集校验。
      for (const mark of previous?.marks || []) for (const comparison of mark.comparisons || []) {
        for (const key of ['generatedMediaId', 'sourceMediaId']) if (comparison[key]) previousImages.add(`${comparison.time}:${key}:${comparison[key]}`);
      }
      for (const mark of normalizedMarks) for (const comparison of mark.comparisons || []) {
        if (['generatedMediaId', 'sourceMediaId'].some(key => comparison[key] && !imageIds.has(comparison[key]) && !previousImages.has(`${comparison.time}:${key}:${comparison[key]}`))) fail('比对图片须来自当前作品、本集的镜头或故事板。');
      }
      // 音频只由上传接口写入：调用方没带 audioPath 时保留上一条，正常保存打标不会清掉已导入的音频。
      const audio = audioPath === undefined
        ? { audioPath: previous?.audioPath || '', audioName: previous?.audioName || '', audioDuration: previous?.audioDuration ?? null }
        : { audioPath, audioName: audioName || '', audioDuration: Number(audioDuration) > 0 ? Number(audioDuration) : null };
      const data = { videoPath, ...audio, marks: normalizedMarks };
      const at = now();
      const version = { id: makeId('sourcerev'), at, data: copy(data) };
      const annotations = { ...data, currentVersion: version.id, updatedAt: at, versions: [...(previous?.versions || []), version] };
      (project.sourceAnnotations ??= {})[episodeNumber] = annotations;
      project.updatedAt = at;
      return annotations;
    });
  }

  appendMarkdown(projectId, text, filename, { episodeNumber = 1 } = {}) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 2 * 1024 * 1024) fail('请提供不超过 2 MB 的 Markdown 文本。');
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.md')) fail('请选择 .md 文件。');
    const agentInstructions = { file: 'AGENTS.md', text: readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8') };
    return this.change(() => {
      const project = this.project(projectId);
      if (!project.episodes.includes(episodeNumber)) fail('请选择本作品已有的集数。');
      const hash = createHash('sha256').update(text).digest('hex').toUpperCase();
      const duplicate = [project.source, ...(project.appendedSources || [])].find(source => source.hash === hash);
      if (duplicate) {
        if ((duplicate.episodeNumber || 1) !== episodeNumber) fail(`这份原文已导入第${duplicate.episodeNumber || 1}集，没有重复导入。`, 409);
        return project;
      }
      const incoming = parseMarkdown(text, filename);
      if (!incoming.shots.length) fail('追加内容必须包含镜头。');
      const assetMap = new Map(), addedAssets = [];
      for (const asset of incoming.assets) {
        const matches = [...project.assets, ...addedAssets].filter(existing => existing.type === asset.type && existing.name === asset.name);
        if (matches.length > 1) fail(`资产名称有歧义：${asset.name}，请先明确要复用的资产。`, 409);
        let target = matches[0];
        if (!target) {
          if ([...project.assets, ...addedAssets].some(existing => existing.type === asset.type && existing.code === asset.code)) fail(`新增资产编号重复：${asset.type}:${asset.code}。`, 409);
          asset.order = Math.max(-1, ...project.assets.filter(existing => existing.type === asset.type).map(existing => existing.order), ...addedAssets.filter(existing => existing.type === asset.type).map(existing => existing.order)) + 1;
          addedAssets.push(asset);
          target = asset;
        }
        assetMap.set(asset.id, target.id);
      }
      const shotCodes = new Set(project.shots.filter(shot => shot.data.episodeNumber === episodeNumber).map(shot => shot.code));
      const sceneIds = new Set(incoming.storyScenes.map(scene => scene.id));
      const sceneOrder = Math.max(-1, ...project.storyScenes.map(scene => scene.order)) + 1;
      incoming.storyScenes.forEach((scene, index) => { scene.order = sceneOrder + index; });
      const shotOrder = Math.max(-1, ...project.shots.map(shot => shot.order)) + 1;
      incoming.shots.forEach((shot, index) => {
        shot.data.episodeNumber = episodeNumber;
        if (shotCodes.has(shot.code)) fail(`新增镜头编号重复：${shot.code}。`, 409);
        shotCodes.add(shot.code);
        if (!Number.isFinite(shot.data.duration) || shot.data.duration < 0) fail(`镜头 ${shot.code} 时长无效。`);
        if (shot.data.sceneId && !sceneIds.has(shot.data.sceneId)) fail(`镜头 ${shot.code} 的剧情场引用不存在。`);
        for (const [field, type] of [['characterIds', 'character'], ['locationIds', 'location'], ['propIds', 'prop']]) {
          if (shot.data[field] === undefined) continue;
          shot.data[field] = shot.data[field].map(id => {
            if (!incoming.assets.some(asset => asset.id === id && asset.type === type) || !assetMap.has(id)) fail(`镜头 ${shot.code} 含未知资产引用。`);
            return assetMap.get(id);
          });
        }
        const locationCodes = shot.code.split('-').slice(1).join('-').split('/');
        for (const code of locationCodes.filter(code => /^[A-Z]$/.test(code))) if (!incoming.assets.some(asset => asset.type === 'location' && asset.code === code)) fail(`镜头 ${shot.code} 缺少场景 ${code} 的定义。`);
        shot.order = shotOrder + index;
      });
      for (const entity of [...addedAssets, ...incoming.shots]) {
        entity.adoptedMediaIds = { image: null, video: null, audio: null };
        const revision = { id: makeId('rev'), at: now(), data: copy(entity.data), name: entity.name, code: entity.code, order: entity.order };
        entity.currentVersion = revision.id;
        entity.versions = [revision];
      }
      for (const issue of incoming.issues) if (issue.entityId && assetMap.has(issue.entityId)) issue.entityId = assetMap.get(issue.entityId);
      const source = { ...incoming.source, episodeNumber, file: `projects/${project.id}/imports/${hash}/original.md`, agentInstructions,
        assetIds: [...new Set(assetMap.values())], sceneIds: incoming.storyScenes.map(scene => scene.id), shotIds: incoming.shots.map(shot => shot.id) };
      const sourceFile = join(this.dataDir, source.file);
      mkdirSync(dirname(sourceFile), { recursive: true });
      try { writeFileSync(sourceFile, text, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (createHash('sha256').update(readFileSync(sourceFile)).digest('hex').toUpperCase() !== hash) fail('追加原文副本路径已有不同内容；没有覆盖。', 409);
      }
      project.appendedSources ??= [];
      project.appendedSources.push(source);
      project.assets.push(...addedAssets);
      project.storyScenes.push(...incoming.storyScenes);
      project.shots.push(...incoming.shots);
      project.issues.push(...incoming.issues);
      project.summaryDuration = project.shots.reduce((sum, shot) => sum + shot.data.duration, 0);
      project.updatedAt = now();
      return project;
    });
  }

  cleanupEmptyEntries(projectId, { episodeNumber, entityIds, baseVersions } = {}) {
    if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) fail('请指定要清理的集数。');
    if (!Array.isArray(entityIds) || !entityIds.length || entityIds.length > 500 || entityIds.some(id => typeof id !== 'string') || new Set(entityIds).size !== entityIds.length) fail('请提供不重复的镜头或故事板 ID。');
    if (!baseVersions || typeof baseVersions !== 'object' || Array.isArray(baseVersions)) fail('请提供条目的当前版本。');
    return this.change(() => {
      const project = this.project(projectId), ids = new Set(entityIds);
      const selected = entityIds.map(id => this.entity(projectId, id));
      for (const entity of selected) {
        if (!['shot', 'storyboard'].includes(entity.type)) fail('只允许清理空镜头与空故事板。');
        if (entity.currentVersion !== baseVersions[entity.id]) fail('条目已有更新，未清理；请刷新后核对。', 409, { code: 'VERSION_CONFLICT' });
        const shots = entity.type === 'shot' ? [entity] : entity.data.shotIds.map(id => this.entity(projectId, id));
        if (!shots.length || shots.some(shot => shot.data.episodeNumber !== episodeNumber)) fail('清理条目必须属于指定集数。', 409);
        if (entity.media.length || entity.adoptedMediaId || Object.values(entity.adoptedMediaIds).some(Boolean)) fail('条目已有媒体，不能作为空条目清理。', 409);
      }
      if (this.document.jobs.some(job => job.projectId === projectId && ids.has(job.entityId)) || this.document.autoRuns.some(run => run.projectId === projectId && run.items.some(item => ids.has(item.entityId)))) fail('条目有关联生成任务，不能作为遗留空条目清理。', 409);
      if (project.storyboards.some(board => !ids.has(board.id) && board.data.shotIds.some(id => ids.has(id)))) fail('镜头仍被保留的故事板引用，未清理。', 409);
      const shots = project.shots.filter(shot => ids.has(shot.id));
      const remainingShots = project.shots.filter(shot => !ids.has(shot.id));
      const sceneIds = new Set(shots.map(shot => shot.data.sceneId).filter(id => id && !remainingShots.some(shot => shot.data.sceneId === id)));
      const archive = { id: makeId('cleanup'), at: now(), episodeNumber, shots: copy(shots), storyboards: copy(project.storyboards.filter(board => ids.has(board.id))), storyScenes: copy(project.storyScenes.filter(scene => sceneIds.has(scene.id))), issues: copy(project.issues.filter(issue => ids.has(issue.entityId))) };
      (project.entryArchives ??= []).push(archive);
      project.shots = remainingShots;
      project.storyboards = project.storyboards.filter(board => !ids.has(board.id));
      project.storyScenes = project.storyScenes.filter(scene => !sceneIds.has(scene.id));
      project.issues = project.issues.filter(issue => !ids.has(issue.entityId));
      project.summaryDuration = project.shots.reduce((sum, shot) => sum + shot.data.duration, 0);
      project.updatedAt = now();
      return { archive, project };
    });
  }

  restoreEmptyEntries(projectId, archiveId) {
    return this.change(() => {
      const project = this.project(projectId), archive = project.entryArchives?.find(item => item.id === archiveId);
      if (!archive) fail('清理备份不存在。', 404);
      if (archive.restoredAt) fail('这批条目已经恢复。', 409);
      if (!project.episodes.includes(archive.episodeNumber)) fail('原集数已不存在，未恢复。', 409);
      const restored = [...archive.shots, ...archive.storyboards];
      if (restored.some(item => entities(project).some(existing => existing.id === item.id || existing.type === item.type && existing.code === item.code && (item.type !== 'shot' || existing.data.episodeNumber === archive.episodeNumber)))) fail('恢复会与现有条目冲突，未覆盖。', 409);
      if (archive.shots.some(shot => ['characterIds', 'locationIds', 'propIds'].some(field => (shot.data[field] || []).some(id => !project.assets.some(asset => asset.id === id))))) fail('原条目引用的资产已不存在，未恢复。', 409);
      project.shots.push(...copy(archive.shots));
      project.storyboards.push(...copy(archive.storyboards));
      project.storyScenes.push(...copy(archive.storyScenes).filter(scene => !project.storyScenes.some(existing => existing.id === scene.id)));
      project.issues.push(...copy(archive.issues).filter(issue => !project.issues.some(existing => existing.id === issue.id)));
      project.shots.sort((a, b) => a.order - b.order);
      project.storyboards.sort((a, b) => a.order - b.order);
      project.storyScenes.sort((a, b) => a.order - b.order);
      for (const board of project.storyboards) {
        const problem = storyboardProblem(project, board.data.shotIds, board.id);
        if (problem) fail(`恢复会破坏故事板：${problem}`, 409);
      }
      archive.restoredAt = now();
      project.summaryDuration = project.shots.reduce((sum, shot) => sum + shot.data.duration, 0);
      project.updatedAt = now();
      return { project, archiveId };
    });
  }

  mergeStoryboardShots(projectId, boardId, { baseVersion, baseVersions, code, name, duration } = {}) {
    if (typeof code !== 'string' || !code.trim() || code.length > 200 || typeof name !== 'string' || !name.trim() || name.length > 200) fail('请提供合并镜头的编号和名称。');
    if (!Number.isFinite(duration) || duration <= 0) fail('合并镜头时长必须是正数。');
    if (!baseVersions || typeof baseVersions !== 'object' || Array.isArray(baseVersions)) fail('请提供原镜头与故事板的当前版本。');
    return this.change(() => {
      const project = this.project(projectId), board = this.entity(projectId, boardId);
      if (board.type !== 'storyboard' || board.data.shotIds.length < 2 || board.data.shotIds.length > 4) fail('请选择包含2至4个连续镜头的故事板。');
      const problem = storyboardProblem(project, board.data.shotIds, board.id);
      if (problem) fail(problem, 409);
      if (board.currentVersion !== baseVersion) fail('故事板已有更新，未合并。', 409, { code: 'VERSION_CONFLICT' });
      if (!board.data.finalPrompt?.trim()) fail('请先保存合并镜头的最终提示词。', 409);
      const shots = board.data.shotIds.map(id => this.entity(projectId, id)).sort((a, b) => a.order - b.order);
      const shotIds = new Set(shots.map(shot => shot.id));
      const oldBoards = project.storyboards.filter(item => item.id !== board.id && item.data.shotIds.some(id => shotIds.has(id)));
      if (oldBoards.some(item => item.data.shotIds.some(id => !shotIds.has(id)))) fail('其他故事板还引用了范围外镜头，未合并。', 409);
      for (const entity of [...shots, ...oldBoards]) if (baseVersions[entity.id] !== entity.currentVersion) fail('原镜头或故事板已有更新，未合并。', 409, { code: 'VERSION_CONFLICT' });
      if (project.shots.some(shot => !shotIds.has(shot.id) && shot.data.episodeNumber === shots[0].data.episodeNumber && shot.code === code.trim())) fail('本集镜头编号重复。', 409);
      const affected = new Set([...shotIds, board.id, ...oldBoards.map(item => item.id)]);
      if (this.document.jobs.some(job => job.projectId === projectId && affected.has(job.entityId) && !['ready', 'failed', 'delivery_invalid', 'interrupted', 'cancelled'].includes(job.status))) fail('原镜头还有未结束或状态不明的任务，未合并。', 409);
      if (this.document.autoRuns.some(run => run.projectId === projectId && !['completed', 'cancelled'].includes(run.status) && run.items.some(item => affected.has(item.entityId)))) fail('原镜头仍在自动队列中，未合并。', 409);
      const archive = { id: makeId('shotmerge'), at: now(), episodeNumber: shots[0].data.episodeNumber, shots: copy(shots), storyboards: copy(oldBoards), boardBefore: copy(board) };
      (project.shotMergeArchives ??= []).push(archive);
      const merged = shots[0];
      merged.code = code.trim();
      merged.name = name.trim();
      merged.data = { ...merged.data, duration, videoPrompt: board.data.finalPrompt,
        sourceShotCodes: archive.shots.flatMap(shot => shot.data.sourceShotCodes?.length ? shot.data.sourceShotCodes : [shot.code]),
        sourceShotVersions: archive.shots.map(shot => ({ id: shot.id, code: shot.code, version: shot.currentVersion })),
        mergedStoryboardId: board.id,
        characterIds: [...new Set(shots.flatMap(shot => shot.data.characterIds))],
        locationIds: [...new Set(shots.flatMap(shot => shot.data.locationIds))],
        propIds: [...new Set(shots.flatMap(shot => shot.data.propIds || []))],
      };
      project.shots = project.shots.filter(shot => !shotIds.has(shot.id) || shot.id === merged.id);
      project.storyboards = project.storyboards.filter(item => !oldBoards.includes(item));
      board.data.shotIds = [merged.id];
      for (const entity of [merged, board]) {
        const revision = { id: makeId('rev'), at: now(), data: copy(entity.data), name: entity.name, code: entity.code, order: entity.order };
        entity.currentVersion = revision.id;
        entity.versions.push(revision);
      }
      project.summaryDuration = project.shots.reduce((sum, shot) => sum + shot.data.duration, 0);
      project.updatedAt = now();
      return { entity: merged, storyboard: board, archiveId: archive.id, removedShotIds: shots.slice(1).map(shot => shot.id) };
    });
  }

  createStoryboard(projectId, { name, shotIds }) {
    return this.change(() => {
      const project = this.project(projectId);
      const problem = storyboardProblem(project, shotIds);
      if (problem) fail(problem);
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) fail('故事板名称不能为空。');
      const id = makeId('board');
      const ordinal = Math.max(0, ...project.storyboards.map(board => Number(/^SB-(\d+)$/.exec(board.code)?.[1]) || 0)) + 1;
      const board = { id, type: 'storyboard', name: name?.trim() || storyboardSummary(project, { data: { shotIds } }), code: `SB-${ordinal}`,
        order: Math.max(-1, ...project.storyboards.map(board => board.order)) + 1, data: { shotIds: copy(shotIds), imageRequirements: '', videoRequirements: '' },
        media: [], adoptedMediaIds: { image: null, video: null, audio: null }, adoptedMediaId: null };
      const revision = { id: makeId('rev'), at: now(), data: copy(board.data), name: board.name, code: board.code, order: board.order };
      board.currentVersion = revision.id;
      board.versions = [revision];
      project.storyboards.push(board);
      project.updatedAt = now();
      return board;
    });
  }

  // 从一个镜头开始批量成组：一次事务里建完，中途任何一组不合法就整批回滚，不留半成品。
  createStoryboards(projectId, { startShotId, namePrefix, limit, episodeNumber } = {}) {
    return this.change(() => {
      const project = this.project(projectId);
      if (episodeNumber !== undefined && !project.episodes.includes(episodeNumber)) fail('请选择本作品已有的集数。');
      if (startShotId !== undefined && !project.shots.some(shot => shot.id === startShotId)) fail('起始镜头不存在。', 404);
      if (episodeNumber !== undefined && startShotId !== undefined && this.entity(projectId, startShotId).data.episodeNumber !== episodeNumber) fail('起始镜头不属于所选集数。');
      if (namePrefix !== undefined && (typeof namePrefix !== 'string' || namePrefix.length > 60)) fail('名称前缀必须是不超过 60 字的文本。');
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) fail('本次最多新建 1–200 个故事板。');
      const plan = planStoryboardGroups(project, { startShotId, limit: limit || 0, episodeNumber });
      if (plan.blockers.length) fail(plan.blockers.join('\n'));
      const boards = [];
      for (const shotIds of plan.groups) {
        const problem = storyboardProblem(project, shotIds);
        if (problem) fail(problem);
        const id = makeId('board');
        const ordinal = Math.max(0, ...project.storyboards.map(board => Number(/^SB-(\d+)$/.exec(board.code)?.[1]) || 0)) + 1;
        const board = { id, type: 'storyboard', name: namePrefix?.trim() ? `${namePrefix.trim()} ${ordinal}` : storyboardSummary(project, { data: { shotIds } }), code: `SB-${ordinal}`,
          order: Math.max(-1, ...project.storyboards.map(board => board.order)) + 1, data: { shotIds: copy(shotIds), imageRequirements: '', videoRequirements: '' },
          media: [], adoptedMediaIds: { image: null, video: null, audio: null }, adoptedMediaId: null };
        const revision = { id: makeId('rev'), at: now(), data: copy(board.data), name: board.name, code: board.code, order: board.order };
        board.currentVersion = revision.id;
        board.versions = [revision];
        project.storyboards.push(board);
        boards.push(board);
      }
      project.updatedAt = now();
      return { boards, created: boards.length, skipped: plan.skipped, remaining: plan.remaining };
    });
  }

  autoRuns(projectId) { this.read(); return copy(this.document.autoRuns.filter(run => !projectId || run.projectId === projectId)); }

  getAutoRun(id) {
    this.read();
    const run = this.document.autoRuns.find(item => item.id === id);
    if (!run) fail('自动生成队列不存在。', 404);
    return copy(run);
  }

  createAutoRun(run) {
    return this.change(() => {
      if (!run?.projectId) fail('自动生成队列必须属于某个作品。');
      if (this.document.autoRuns.some(item => item.id === run.id)) fail('队列 ID 已存在。', 409);
      const created = { ...copy(run), items: copy(run.items || []), createdAt: run.createdAt || now(), updatedAt: now() };
      this.document.autoRuns.push(created);
      // 只保留最近的历史：整份状态是单行 JSON，队列记录不该无限长大。
      const keep = [];
      for (const item of this.document.autoRuns) {
        const sameProject = keep.filter(other => other.projectId === item.projectId);
        if (sameProject.length < AUTO_RUN_HISTORY) keep.push(item);
      }
      this.document.autoRuns = keep;
      return created;
    });
  }

  updateAutoRun(id, patch) {
    return this.change(() => {
      const run = this.document.autoRuns.find(item => item.id === id);
      if (!run) fail('自动生成队列不存在。', 404);
      Object.assign(run, copy(patch), { updatedAt: now() });
      return run;
    });
  }

  updateEntity(projectId, entityId, patch) {
    return this.change(() => {
    const entity = this.entity(projectId, entityId);
    if (patch.baseVersion !== entity.currentVersion) fail('该条目已有更新；请刷新后比较，未覆盖现有编辑。', 409, { code: 'VERSION_CONFLICT', currentVersion: entity.currentVersion });
    if (patch.data !== undefined && (!patch.data || typeof patch.data !== 'object' || Array.isArray(patch.data))) fail('data 必须是对象。');
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) fail('名称不能为空。');
    if (patch.code !== undefined && typeof patch.code !== 'string') fail('编号必须是文本。');
    if (patch.order !== undefined && (!Number.isInteger(patch.order) || patch.order < 0)) fail('排序必须是非负整数。');
    const nextData = { ...entity.data, ...copy(patch.data || {}) };
    if (entity.type === 'storyboard') {
      const problem = storyboardProblem(this.project(projectId), nextData.shotIds, entity.id);
      if (problem) fail(problem);
      if (Object.keys(nextData).some(key => !['shotIds', 'imageRequirements', 'videoRequirements', 'finalPrompt'].includes(key))) fail('故事板只保存镜头引用、额外生成要求与最终提示词；剧情请编辑原镜头。');
      if (nextData.finalPrompt !== undefined && (typeof nextData.finalPrompt !== 'string' || nextData.finalPrompt.length > 150000)) fail('最终提示词必须是不超过 150000 字的文本。');
      for (const key of ['imageRequirements', 'videoRequirements']) if (typeof nextData[key] !== 'string' || nextData[key].length > 20000) fail('额外生成要求必须是不超过 20000 字的文本。');
    }
    if (entity.type === 'shot' && (!Number.isFinite(nextData.duration) || nextData.duration < 0)) fail('镜头时长必须是非负数。');
    if (entity.type === 'shot') {
      const project = this.project(projectId);
      if (!project.episodes.includes(nextData.episodeNumber)) fail('请选择本作品已有的集数。');
      if ((nextData.episodeNumber !== entity.data.episodeNumber || (patch.code !== undefined && patch.code !== entity.code)) && project.shots.some(shot => shot.id !== entity.id && shot.data.episodeNumber === nextData.episodeNumber && shot.code === (patch.code ?? entity.code))) fail('本集镜头编号重复。', 409);
      if (nextData.episodeNumber !== entity.data.episodeNumber) {
        const nextProject = { ...project, shots: project.shots.map(shot => shot.id === entity.id ? { ...shot, data: nextData } : shot) };
        for (const board of project.storyboards.filter(board => board.data.shotIds.includes(entity.id))) {
          const problem = storyboardProblem(nextProject, board.data.shotIds, board.id);
          if (problem) fail(`无法更改集数：${problem}`, 409);
        }
      }
      for (const [field, type] of [['characterIds', 'character'], ['locationIds', 'location']]) {
        if (!Array.isArray(nextData[field]) || nextData[field].some(value => !project.assets.some(asset => asset.id === value && asset.type === type))) fail(`${field} 含未知引用。`);
      }
      if (nextData.propIds !== undefined && (!Array.isArray(nextData.propIds) || nextData.propIds.some(id => !project.assets.some(asset => asset.id === id && asset.type === 'prop')))) fail('propIds 含未知引用。');
      for (const field of ['action', 'shotSize', 'composition', 'camera', 'dialogue', 'mood', 'transition']) if (nextData[field] !== undefined && typeof nextData[field] !== 'string') fail(`${field} 必须是文本。`);
      if (nextData.sceneId && !project.storyScenes.some(scene => scene.id === nextData.sceneId)) fail('未知剧情场引用。');
    }
      const current = entity;
      current.data = nextData;
      if (patch.name !== undefined) current.name = patch.name.trim();
      if (patch.code !== undefined) current.code = patch.code;
      if (patch.order !== undefined) current.order = patch.order;
      const revision = { id: makeId('rev'), at: now(), data: copy(current.data), name: current.name, code: current.code, order: current.order };
      current.currentVersion = revision.id;
      current.versions.push(revision);
      const project = this.project(projectId);
      project.summaryDuration = project.shots.reduce((sum, shot) => sum + shot.data.duration, 0);
      project.updatedAt = now();
      return current;
    });
  }

  updateScene(projectId, sceneId, { baseTitle, title, notes } = {}) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) fail('剧情场标题须为 1–200 个字。');
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 20000)) fail('剧情场备注必须是不超过 20000 字的文本。');
    return this.change(() => {
      const project = this.project(projectId);
      const scene = project.storyScenes.find(item => item.id === sceneId);
      if (!scene) fail('剧情场不存在。', 404);
      if (baseTitle !== scene.title) fail('剧情场标题已有更新；请刷新后比较，未覆盖现有编辑。', 409, { code: 'VERSION_CONFLICT', currentTitle: scene.title });
      scene.title = title.trim();
      if (notes !== undefined) scene.notes = notes;
      project.updatedAt = now();
      return scene;
    });
  }

  updateProject(projectId, patch) {
    for (const field of ['style', 'title', 'aspectRatio', 'targetDuration']) {
      if (patch[field] !== undefined && typeof patch[field] !== 'string') fail(`${field} 必须是文本。`);
    }
    if (patch.title !== undefined && !patch.title.trim()) fail('作品名不能为空。');
    return this.change(() => {
      const project = this.project(projectId);
      if (patch.baseVersion !== undefined && patch.baseVersion !== project.versions.at(-1).id) fail('作品设置已有更新；请刷新后比较。', 409, { code: 'VERSION_CONFLICT', currentVersion: project.versions.at(-1).id });
      for (const field of ['style', 'title', 'aspectRatio', 'targetDuration']) if (patch[field] !== undefined) project[field] = patch[field];
      project.updatedAt = now();
      project.versions.push({ id: makeId('projectrev'), at: now(), title: project.title, style: project.style, aspectRatio: project.aspectRatio, targetDuration: project.targetDuration });
      return project;
    });
  }

  reorderShot(projectId, entityId, direction, baseVersion) {
    if (!['up', 'down'].includes(direction)) fail('移动方向必须是 up 或 down。');
    return this.change(() => {
      const project = this.project(projectId);
      const shot = this.entity(projectId, entityId);
      if (shot.type !== 'shot') fail('只允许移动镜头。');
      if (baseVersion !== shot.currentVersion) fail('镜头已有更新；请刷新后再移动。', 409, { code: 'VERSION_CONFLICT', currentVersion: shot.currentVersion });
      const ordered = project.shots.filter(item => item.data.episodeNumber === shot.data.episodeNumber).sort((a, b) => a.order - b.order);
      const index = ordered.findIndex(item => item.id === shot.id);
      const neighbor = ordered[index + (direction === 'up' ? -1 : 1)];
      if (!neighbor) return project;
      [shot.order, neighbor.order] = [neighbor.order, shot.order];
      for (const board of project.storyboards) {
        const problem = storyboardProblem(project, board.data.shotIds, board.id);
        if (problem) fail('移动会拆散故事板；请保持组内镜头连续。', 409);
      }
      for (const current of [shot, neighbor]) {
        const revision = { id: makeId('rev'), at: now(), data: copy(current.data), name: current.name, code: current.code, order: current.order };
        current.currentVersion = revision.id;
        current.versions.push(revision);
      }
      project.updatedAt = now();
      project.summaryDuration = project.shots.reduce((sum, item) => sum + item.data.duration, 0);
      return project;
    });
  }

  setIssue(projectId, issueId, status) {
    if (!['open', 'resolved'].includes(status)) fail('问题状态无效。');
    const issue = this.project(projectId).issues.find(item => item.id === issueId);
    if (!issue) fail('问题不存在。', 404);
    return this.change(() => { const current = this.project(projectId).issues.find(item => item.id === issueId); current.status = status; return current; });
  }

  addMedia(projectId, entityId, media) {
    return this.change(() => {
    const entity = this.entity(projectId, entityId);
    if (!['image', 'video', 'audio'].includes(media.kind)) fail('媒体类型无效。');
    if (typeof media.file !== 'string' || !media.file || /^(?:[a-z]:|[\\/])/i.test(media.file) || media.file.split(/[\\/]/).includes('..')) fail('媒体路径必须位于 data 目录内。');
    if (!entity.versions.some(revision => revision.id === media.baseVersion)) fail('媒体引用的基础版本不存在。', 409);
    if (media.id) {
      const existing = this.document.projects.flatMap(project => [...entities(project), ...mergedHistory(project)].flatMap(item => item.media)).find(item => item.id === media.id);
      if (existing) {
        if (!entity.media.some(item => item.id === media.id) || existing.file !== media.file || existing.sha256 !== media.sha256 || existing.kind !== media.kind) fail('媒体 ID 已用于不同结果。', 409);
        return existing;
      }
    }
      const result = { ...copy(media), id: media.id || makeId('media'), at: media.at || now() };
      this.entity(projectId, entityId).media.push(result);
      this.project(projectId).updatedAt = now();
      return result;
    });
  }

  detachVideoMedia(projectId, { mediaIds, baseUpdatedAt } = {}) {
    if (!Array.isArray(mediaIds) || !mediaIds.length || mediaIds.some(id => typeof id !== 'string' || !id)) fail('请明确指定要删除的视频媒体。');
    return this.change(() => {
      const project = this.project(projectId);
      if (baseUpdatedAt !== project.updatedAt) fail('作品已有更新，请刷新后核对再删除。', 409);
      if (this.document.jobs.some(job => job.projectId === projectId && job.kind === 'video' && !['ready', 'failed', 'delivery_invalid', 'interrupted', 'cancelled'].includes(job.status))) fail('作品还有未结束或状态不明的视频任务，未删除。', 409);
      if (this.document.autoRuns.some(run => run.projectId === projectId && !['completed', 'cancelled'].includes(run.status))) fail('作品还有未结束的自动队列，未删除。', 409);
      const ids = new Set(mediaIds);
      const removed = entities(project).flatMap(entity => entity.media.filter(media => ids.has(media.id)));
      if (removed.length !== ids.size || removed.some(media => media.kind !== 'video')) fail('只能删除本作品中已存在的视频媒体。', 409);
      for (const entity of entities(project)) {
        entity.media = entity.media.filter(media => !ids.has(media.id));
        if (ids.has(entity.adoptedMediaIds.video)) entity.adoptedMediaIds.video = null;
        if (ids.has(entity.adoptedMediaId)) entity.adoptedMediaId = null;
      }
      project.updatedAt = now();
      // 文件由调用方按返回清单清理，保留其他作品仍在使用的文件。
      return { removed };
    });
  }

  adopt(projectId, entityId, mediaId) {
    const entity = this.entity(projectId, entityId);
    if (!entity.media.some(media => media.id === mediaId)) fail('候选媒体不存在。', 404);
    return this.change(() => {
      const current = this.entity(projectId, entityId);
      const media = current.media.find(item => item.id === mediaId);
      current.adoptedMediaIds[media.kind] = mediaId;
      current.adoptedMediaId = mediaId;
      this.project(projectId).updatedAt = now();
      return current;
    });
  }

  createJob(job) {
    return this.change(() => {
    if (job.purpose === 'video_reference') {
      if (job.kind !== 'video' || job.projectId !== null || job.entityId !== null) fail('视频转参考任务独立保存，不绑定作品或镜头。');
    } else this.entity(job.projectId, job.entityId);
    if (!['image', 'video', 'prompt'].includes(job.kind)) fail('任务类型无效。');
    if (job.operationId) {
      const existing = this.document.jobs.find(item => item.operationId === job.operationId);
      if (existing) {
        if (existing.projectId !== job.projectId || existing.entityId !== job.entityId || existing.kind !== job.kind || existing.snapshot?.id !== job.snapshot?.id || existing.snapshot?.hash !== job.snapshot?.hash) fail('该操作 ID 已对应不同生成快照。', 409, { code: 'OPERATION_CONFLICT' });
        return existing;
      }
    }
    if (job.kind === 'video' && job.singleVideo === true) {
      // 本机同时放行几个付费视频任务由「账号并发」设置决定（默认 1）。自动生成队列也走这条锁。
      const limit = normalizeConcurrency(this.document.settings?.videoConcurrency);
      const active = this.document.jobs.filter(item => item.kind === 'video' && ACTIVE_VIDEO_STATES.includes(item.status) && item.id !== job.id);
      if (active.length >= limit) fail(`已有 ${active.length} 个视频任务在运行（本机并发上限 ${limit}）；未创建第二个任务。`, 409, { code: 'ACTIVE_VIDEO_TASK', details: { jobId: active[0]?.id, projectId: active[0]?.projectId, status: active[0]?.status, limit } });
    }
    if (job.id && this.document.jobs.some(item => item.id === job.id)) fail('任务 ID 已存在。', 409);
      const created = { ...copy(job), id: job.id || makeId('job'), status: job.status || 'prepared', createdAt: job.createdAt || now(), updatedAt: now(), outputs: copy(job.outputs || []), log: copy(job.log || []) };
      this.document.jobs.push(created);
      return created;
    });
  }

  getJob(jobId) {
    this.read();
    const job = this.document.jobs.find(item => item.id === jobId);
    if (!job) fail('任务不存在。', 404);
    return copy(job);
  }

  updateJob(jobId, patch) {
    return this.change(() => {
    const original = this.getJob(jobId);
    if (['id', 'projectId', 'entityId', 'kind', 'createdAt'].some(field => patch[field] !== undefined && patch[field] !== original[field])) fail('不可更改任务标识。');
      const job = this.document.jobs.find(item => item.id === jobId);
      Object.assign(job, copy(patch), { updatedAt: now() });
      return job;
    });
  }

  getMedia(mediaId) {
    this.read();
    for (const project of this.document.projects) {
      for (const entity of [...entities(project), ...mergedHistory(project)]) {
        const media = entity.media.find(item => item.id === mediaId);
        if (media) return copy({ ...media, entity, project });
      }
    }
    fail('媒体不存在。', 404);
  }

  close() { this.db.close(); }
}
