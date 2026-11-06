import { randomUUID } from 'node:crypto';
import { storyboardDuration } from '../public/storyboard.mjs';
import { referenceGroups, automaticReferences, automaticBindings, videoPromptBlocks, assembleVideoPrompt } from '../public/video-editor.mjs';
import { DEFAULT_VIDEO_CONFIG, DEFAULT_INSTANCE_TYPE, INSTANCE_TYPES, VIDEO_ASPECT_RATIOS, VIDEO_OUTPUT_RESOLUTIONS } from './generation.mjs';

// 顺序自动生成视频：为一批镜头或故事板依次「准备预览 → 提交 RunningHub 任务 → 等远端跑完」，
// 同一时刻在跑的任务数不超过账号并发上限。本模块只管排队与状态推进；收费提交仍由 GenerationService 完成。
const now = () => new Date().toISOString();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// 队列项状态：pending 待提交，preparing/submitted/generating 在跑，ready/failed/blocked/skipped 已结束。
const ACTIVE_ITEM_STATES = ['preparing', 'submitted', 'generating'];
const DONE_ITEM_STATES = ['ready', 'failed', 'blocked', 'skipped'];
const READY_JOB_STATES = ['ready'];
const FAILED_JOB_STATES = ['failed', 'delivery_invalid'];
const ACTIVE_JOB_STATES = ['preparing', 'submitting', 'queued', 'running', 'downloading', 'query_failed'];
const OUTPUT_RESOLUTIONS = new Set(['native', '480p', '720p', '1080p']);
const adoptedMedia = (entity, kind) => {
  const id = entity.adoptedMediaIds?.[kind] || (entity.media || []).find(media => media.id === entity.adoptedMediaId && media.kind === kind)?.id || null;
  return id ? (entity.media || []).find(media => media.id === id && media.kind === kind) || null : null;
};

// 与页面共用自动关联；故事板四宫格固定占参考图 1，镜头排除参考视频。
// 超出的素材保留在引用中，由 prepare 阻塞，不静默丢弃。
export function storyboardVideoReferences(project, board) {
  const media = new Map(referenceGroups(project, board).flatMap(group => group.media).map(media => [media.id,media]));
  const referenceMediaIds = automaticReferences(project, board).filter(id => board.type !== 'shot' || media.get(id)?.kind !== 'video');
  const image = adoptedMedia(board, 'image') || (board.type === 'shot' ? referenceMediaIds.map(id => media.get(id)).find(media => media.kind === 'image') : null) || null;
  const bindings = automaticBindings(referenceMediaIds.map(id => media.get(id)));
  return { image, bindings, referenceMediaIds };
}

function sanitizeTemplate(template = {}) {
  const result = {};
  if (template.duration !== undefined && template.duration !== null && String(template.duration).trim() !== '') result.duration = String(template.duration).trim();
  if (VIDEO_ASPECT_RATIOS.includes(template.aspectRatio)) result.aspectRatio = template.aspectRatio;
  if (OUTPUT_RESOLUTIONS.has(template.outputResolution)) result.outputResolution = template.outputResolution;
  if (template.pixels !== undefined) {
    const pixels = Number(template.pixels);
    if (!Number.isFinite(pixels) || pixels < 0.2 || pixels > 2) throw fail('像素/百万需要 0.2–2.0 之间的数值。');
    result.pixels = String(pixels);
  }
  if (INSTANCE_TYPES.includes(template.instanceType)) result.instanceType = template.instanceType;
  else result.instanceType = DEFAULT_INSTANCE_TYPE;
  if (typeof template.usePersonalQueue === 'boolean') result.usePersonalQueue = template.usePersonalQueue;
  return result;
}

// 队列默认按多参考档；时长留空时，镜头用本镜计划，故事板用有效镜头计划合计。
// 超出工作流范围由 prepare 阻塞，不静默改数。
export function storyboardVideoConfig(project, board, template = {}) {
  const references = storyboardVideoReferences(project, board);
  const config = structuredClone(DEFAULT_VIDEO_CONFIG);
  config.mode = 'reference';
  config.duration = template.duration || String(board.type === 'shot' ? board.data.duration : storyboardDuration(project, board));
  config.aspectRatio = template.aspectRatio || VIDEO_ASPECT_RATIOS.find(ratio => ratio.split(' ')[0] === String(project.aspectRatio || '').split(' ')[0]) || config.aspectRatio;
  config.outputResolution = template.outputResolution || config.outputResolution;
  if (template.pixels !== undefined) {
    config.pixels = String(template.pixels);
    config.nodeInfoList.find(node => node.nodeId === '147' && node.fieldName === 'value').fieldValue = config.pixels;
  }
  config.instanceType = template.instanceType || DEFAULT_INSTANCE_TYPE;
  config.usePersonalQueue = template.usePersonalQueue === true;
  config.referenceBindings = references.bindings;
  return { config, references };
}

// 远端明确拒绝并发（HTTP 200 但 code 421）或本机锁已满：都没创建远端任务，可以等下一轮重试。
const isConcurrencyRejection = reason => ['ACTIVE_VIDEO_TASK', 'PROVIDER_CONCURRENCY_REJECTED'].includes(reason?.code) || /421|并发|concurren/i.test(String(reason?.message || ''));
const isUnknownSubmission = reason => /提交结果不明|submission_unknown/.test(String(reason?.message || ''));

export class AutoQueue {
  constructor({ store, generation, pollIntervalMs = 8000, backoffMs = 45000, logger = console } = {}) {
    Object.assign(this, { store, generation, pollIntervalMs, backoffMs, logger });
    this.timer = null; this.working = false; this.closed = false;
  }

  async create({ projectId, entityIds, template = {}, includeGenerated = false, concurrency } = {}) {
    const project = this.store.getProject(projectId);
    if (concurrency !== undefined) this.store.setVideoConcurrency(concurrency);
    if (!Array.isArray(entityIds) || !entityIds.length) throw fail('请选择要生成视频的镜头或故事板。');
    if (entityIds.length > 200) throw fail('一次最多排队 200 个镜头或故事板。');
    // 先确认密钥可用：不然整条队列会逐个撞上同一个错误，白白刷出一堆失败任务。
    let key = '';
    try { key = await this.generation.getRunningHubKey(); }
    catch (reason) { throw fail(`本机 RunningHub 密钥读不出来（${reason.message}）；请在“接口与工作流设置”里重新保存一次 Key 再排队。`, 409); }
    if (!key) throw fail('尚未配置 RunningHub API Key；视频只能直连本机后端提交，请先在“接口与工作流设置”里保存 Key。', 409);
    const items = [], skipped = [], seen = new Set();
    for (const id of entityIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const board = [...project.shots, ...(project.storyboards || [])].find(item => item.id === id);
      if (!board) throw fail('镜头或故事板不存在。', 404);
      // 镜头也可用关联资产采用图；没有可用参考图就不进队列。
      const image = storyboardVideoReferences(project, board).image;
      if (!image) { skipped.push({ entityId: board.id, code: board.code, name: board.name, reason: board.type === 'shot' ? '镜头及关联资产还没有采用参考图片' : '还没有采用四宫格图片' }); continue; }
      if (!includeGenerated && adoptedMedia(board, 'video')) { skipped.push({ entityId: board.id, code: board.code, name: board.name, reason: '已有采用视频' }); continue; }
      items.push({ index: items.length, entityId: board.id, code: board.code, name: board.name, status: 'pending', jobId: null, error: null, blockers: [], note: null, attempts: 0 });
    }
    if (!items.length) throw fail(`队列只收录已有采用参考图片、且符合生成范围的镜头或故事板：所选 ${skipped.length || entityIds.length} 个条目都还不满足条件。请先在镜头或关联资产的“媒体”页采用图片，再排队生成视频。`);
    const settings = this.store.settings();
    const run = { id: `run_${randomUUID()}`, projectId: project.id, kind: 'video', status: 'running',
      concurrency: settings.videoConcurrency, accountConcurrency: settings.accountConcurrency, template: sanitizeTemplate(template),
      items, skipped, note: null, waitUntil: null, createdAt: now(), finishedAt: null };
    const created = this.store.createAutoRun(run);
    this.kick();
    return created;
  }

  async pause(id, note = '队列已暂停；已在远端跑的任务不会被取消，仍可查询与下载。') {
    return this.store.updateAutoRun(id, { status: 'paused', note });
  }
  async resume(id) {
    const run = this.store.getAutoRun(id);
    if (run.status === 'completed' || run.status === 'cancelled') throw fail('该队列已结束，不能继续。');
    const updated = this.store.updateAutoRun(id, { status: 'running', note: null, waitUntil: null });
    this.kick();
    return updated;
  }
  async cancel(id) {
    const run = this.store.getAutoRun(id);
    if (run.status === 'cancelled') return run;
    const items = run.items.map(item => ['pending'].includes(item.status)
      ? { ...item, status: 'skipped', note: '队列已取消，未提交', finishedAt: now() }
      : item);
    return this.store.updateAutoRun(id, { status: 'cancelled', items, note: '已取消：不再提交新任务；已在跑的任务保留，可继续查询与下载。', finishedAt: now() });
  }

  kick() {
    if (this.closed) return;
    if (this.timer) return;
    const timer = setTimeout(() => { this.timer = null; this.tick().catch(() => {}); }, 0);
    timer.unref?.(); this.timer = timer;
  }

  recover() {
    for (const run of this.store.autoRuns()) if (run.status === 'running') { this.kick(); return; }
  }

  async tick() {
    if (this.closed || this.working) return;
    this.working = true;
    try {
      for (const run of this.store.autoRuns().filter(item => item.status === 'running')) {
        if (this.closed) return;
        await this._advance(run.id);
      }
    } catch (reason) {
      if (!this.closed) this.logger?.error?.(`自动生成队列：${reason.message}`);
    } finally {
      this.working = false;
      let pending = false;
      try { pending = !this.closed && this.store.autoRuns().some(run => run.status === 'running'); } catch { pending = false; }
      if (pending) {
        const timer = setTimeout(() => { this.timer = null; this.tick().catch(() => {}); }, this.pollIntervalMs);
        timer.unref?.(); this.timer = timer;
      }
    }
  }

  // 一轮推进：先把在跑的任务状态回填，再按并发上限提交新的任务，最后判定是否结束。
  async _advance(id) {
    if (this.closed) return;
    const run = this.store.getAutoRun(id);
    if (run.status !== 'running') return;
    if (run.waitUntil && Date.parse(run.waitUntil) > Date.now()) return;
    const items = run.items.map(item => ({ ...item })), startedAt = now();
    let backoff = false;
    // 1. 远端任务 → 队列项
    for (const item of items) {
      // 上次提交没走完（进程中断等）留下的中间态：重新排队，不要一直占着并发额度。
      if (item.status === 'preparing' && !item.jobId) { Object.assign(item, { status: 'pending', note: '上次提交未完成，重新排队' }); continue; }
      if (!ACTIVE_ITEM_STATES.includes(item.status) || !item.jobId) continue;
      let job; try { job = this.store.getJob(item.jobId); } catch { continue; }
      if (READY_JOB_STATES.includes(job.status)) { Object.assign(item, { status: 'ready', error: null, finishedAt: now() }); continue; }
      // 被并发拒绝：远端没有创建任务，放回队列等下一轮，不算失败。
      if (job.manualResolution === 'provider_concurrency_rejected') {
        item.attempts = (item.attempts || 0) + 1;
        Object.assign(item, { status: 'pending', jobId: null, error: null, finishedAt: null, note: `并发已满，稍后自动重试（第 ${item.attempts} 次尝试）` });
        backoff = true;
        continue;
      }
      if (FAILED_JOB_STATES.includes(job.status)) { Object.assign(item, { status: 'failed', error: job.error || '生成失败', finishedAt: now() }); continue; }
      if (job.status === 'submission_unknown') {
        await this.pause(id, `任务 ${job.id} 的提交结果不明：请先在 RunningHub 后台核对并补录 taskId，核对完成后再继续队列。`);
        return;
      }
      if (job.status === 'query_failed') {
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts > 10) { Object.assign(item, { status: 'failed', error: job.error || '查询连续失败，已停止重试；可在“生成任务”里手动重查。', finishedAt: now() }); continue; }
        // query_failed 不会自动重排，队列负责再查一次；成功则照常下载。
        try { await this.generation.retry(job.id); } catch { /* 下一轮继续 */ }
      }
      item.status = 'generating';
    }
    // 2. 提交新任务，直到达到并发上限
    let inflight = items.filter(item => ACTIVE_ITEM_STATES.includes(item.status)).length;
    const limit = this._limit(run);
    let pausing = false;
    for (const item of items) {
      if (backoff) break; // 刚被并发拒绝：等退避时间到了再提交，本轮不再试
      if (item.status !== 'pending' || inflight >= limit) continue;
      const outcome = await this._startItem(run, item);
      if (outcome === 'started') inflight++;
      else if (outcome === 'busy') { backoff = true; break; }
      else if (outcome === 'paused') { pausing = true; break; }
    }
    // 3. 落盘：进度、退避或结束
    const patch = { items, updatedAt: now() };
    if (backoff) patch.waitUntil = new Date(Date.now() + this.backoffMs).toISOString();
    else patch.waitUntil = null;
    if (pausing) return; // pause() 已经写过状态，避免用旧 items 覆盖
    if (items.every(item => DONE_ITEM_STATES.includes(item.status))) {
      const count = state => items.filter(item => item.status === state).length;
      Object.assign(patch, { status: 'completed', finishedAt: startedAt,
        note: `队列结束：完成 ${count('ready')}，失败 ${count('failed')}，待处理阻塞 ${count('blocked')}，已跳过 ${count('skipped')}。` });
    }
    // 本轮期间用户可能点了暂停或取消：不要用这轮的旧结果覆盖刚写下的状态。
    if (this.store.getAutoRun(id).status !== 'running') return;
    this.store.updateAutoRun(id, patch);
  }

  // 本机并发上限 = min(手动设置, 账号读到的上限)。账号上限只是「不超过」，不会把设置顶大。
  _limit(run) {
    const manual = Math.max(1, this.store.videoConcurrency());
    const account = Number(this.store.settings().accountConcurrency?.concurrentLimit);
    return Number.isFinite(account) && account > 0 ? Math.max(1, Math.min(manual, account)) : manual;
  }

  async _startItem(run, item) {
    const project = this.store.getProject(run.projectId);
    const board = this.store.getEntity(project.id, item.entityId);
    if (!['shot', 'storyboard'].includes(board.type)) { Object.assign(item, { status: 'failed', error: '队列只支持镜头或故事板。', finishedAt: now() }); return 'failed'; }
    const { config, references } = storyboardVideoConfig(project, board, run.template);
    item.startedAt = now();
    if (!references.image) { Object.assign(item, { status: 'blocked', blockers: [board.type === 'shot' ? '本镜与关联资产已没有采用的参考图片；请在“媒体”页采用图片后再排队。' : '本组的四宫格采用已被移除；请在“媒体”页重新采用四宫格后再排队。'], finishedAt: now() }); return 'blocked'; }
    let preview;
    try {
      const input = { projectId: project.id, entityId: board.id, kind: 'video', videoConfig: config, referenceMediaIds: references.referenceMediaIds };
      if (board.type === 'shot') {
        const media = new Map(referenceGroups(project, board).flatMap(group => group.media).map(media => [media.id, media]));
        const ordered = [...references.bindings].sort((a, b) => ['image', 'audio'].indexOf(a.fieldName) - ['image', 'audio'].indexOf(b.fieldName)).map(binding => media.get(binding.mediaId));
        for (const id of references.referenceMediaIds) if (!ordered.some(media => media.id === id)) ordered.push(media.get(id));
        input.prompt = assembleVideoPrompt(videoPromptBlocks(project, board, ordered, config), this.store.state(project.id).promptPreferences);
        if (!input.prompt.trim()) { Object.assign(item, { status: 'blocked', blockers: ['尚未勾选有内容的提示词区域；请在镜头视频页选择提示词区域后再排队。'], finishedAt: now() }); return 'blocked'; }
      }
      preview = await this.generation.prepare(input);
    } catch (reason) {
      Object.assign(item, { status: 'failed', error: reason.message, finishedAt: now() });
      return 'failed';
    }
    if ((preview.blockers || []).length) { Object.assign(item, { status: 'blocked', blockers: preview.blockers, finishedAt: now() }); return 'blocked'; }
    // 每次重试都是一份新预览（新 jobId），所以 operationId 也必须换：旧 operationId 已被上一次尝试占用，
    // 而每次尝试都先 prepare 再 submit，用同一个 operationId 会被服务端判成「已用于不同预览」。
    const attempt = (item.attempts || 0) + 1;
    item.attempts = attempt;
    item.status = 'preparing';
    try {
      const operationId = attempt === 1 ? `${run.id}-${item.index}` : `${run.id}-${item.index}-r${attempt}`;
      const job = await this.generation.submit({ previewId: preview.id, operationId, mode: 'desktop' });
      Object.assign(item, { jobId: job.id, status: 'submitted', error: null, blockers: [], note: null });
      return 'started';
    } catch (reason) {
      if (isUnknownSubmission(reason)) { await this.pause(run.id, reason.message); return 'paused'; }
      if (isConcurrencyRejection(reason)) { Object.assign(item, { status: 'pending', note: `并发已满，稍后自动重试（第 ${attempt} 次尝试）` }); return 'busy'; }
      Object.assign(item, { status: 'failed', error: reason.message, finishedAt: now() });
      return 'failed';
    }
  }

  close() { this.closed = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
