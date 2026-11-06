import express from 'express';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { StudioStore, MAX_VIDEO_CONCURRENCY } from './store.mjs';
import { GenerationService, DEFAULT_VIDEO_CONFIG, FRAME_VIDEO_CONFIG, DEFAULT_INSTANCE_TYPE, INSTANCE_TYPES, VIDEO_DURATION_LIMITS, VIDEO_OUTPUT_RESOLUTIONS, VIDEO_ASPECT_RATIOS, composePrompt } from './generation.mjs';
import { AutoQueue } from './autoqueue.mjs';
import { safeWithin, sniffMedia, validateMedia, revealMediaFile } from './media.mjs';
import { LOCAL_UPLOAD_MAX_BYTES, SOURCE_VIDEO_UPLOAD_MAX_BYTES, SOURCE_AUDIO_UPLOAD_MAX_BYTES, mediaUploadProblem } from '../public/media-limits.mjs';
import { planAudioCut, cutAudioClip, probeSourceMedia, fileSha256, sourceAudioExtension, sourceAudioMime, audioCutLabel, MAX_AUDIO_CLIP_SECONDS } from './source-audio.mjs';
import { extractSourceFrame, sourceVideoFile, sourceFrameSeconds } from './source-frame.mjs';
import { getRunningHubKey, saveRunningHubKey } from './secrets.mjs';
import { ForgeStore } from './forge-store.mjs';
import { createLlmService } from './forge-ai.mjs';
import { createForgeApi } from './forge-api.mjs';
import { createFishAudioService, buildDialogueScript, FISH_AUDIO_BASE } from './fish-audio.mjs';
import { sendFishAudioResult } from './fish-audio-response.mjs';
import { storyboardAssets, storyboardShots, storyboardSource, storyboardMediaFresh, previewSequence } from '../public/storyboard.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const checkedId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw fail('无效对象 ID');
  return value;
};

export function createStudio({ dataDir = process.env.STUDIO_DATA_DIR || path.join(appRoot, 'data'), importExample = true, generationOptions = {}, revealMediaFileImpl = revealMediaFile, extractSourceFrameImpl = extractSourceFrame, forgeSeed = true, llmOptions = {} } = {}) {
  dataDir = path.resolve(dataDir);
  const store = new StudioStore({ dataDir });
  if (importExample && !store.state().projects.length) {
    const example = path.join(appRoot, 'examples', '奶油变心后_分镜提示词.md');
    if (fs.existsSync(example)) store.importMarkdown(fs.readFileSync(example, 'utf8'), path.basename(example));
  }
  // 因果剧本工作台有自己的表；首次启动放一份可运行的示例（龙娘部落第 1–20 集）。
  const forge = new ForgeStore({ dataDir });
  if (forgeSeed) forge.seed(path.join(appRoot, 'examples', 'storyforge-龙娘部落.json'));
  const llm = createLlmService({ dataDir, ...llmOptions });
  const fishAudio = createFishAudioService({ dataDir });
  const generation = new GenerationService({ store, dataDir, appRoot, getRunningHubKey, validateMedia, codexPath: process.env.CODEX_PATH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), ...generationOptions });
  const autoqueue = new AutoQueue({ store, generation, pollIntervalMs: Math.max(5000, Number(generation.pollIntervalMs) || 5000) });
  const app = express();
  const csrfToken = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const port = req.socket.localPort;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host?.toLowerCase())) return res.status(403).json({ error: '仅接受本机工作台地址' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`)) return res.status(403).json({ error: '请求来源不匹配' });
      if (req.get('X-Studio-Token') !== csrfToken) return res.status(403).json({ error: '页面已过期，请刷新后重试' });
    }
    next();
  });
  app.use(express.json({ limit: '90mb' }));
  app.use('/api/forge', createForgeApi({ forgeStore: forge, studioStore: store, llm }));

  // 媒体与原视频/原音频共用同一套 Range 下发，播放器才能拖动时间轴。
  async function sendFileWithRanges(req, res, { file, mime, etag, cacheControl = 'private, max-age=0, no-cache' }) {
    const stat = await fsp.stat(file);
    res.set({ 'Content-Type': mime || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl, ...(etag ? { ETag: `"${etag}"` } : {}) });
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
      const suffix = !match[1];
      const start = suffix ? Math.max(0, stat.size - Number(match[2])) : Number(match[1]);
      const end = suffix || !match[2] ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1);
      if (start > end || start >= stat.size) return res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return pipeline(fs.createReadStream(file, { start, end }), res);
    }
    res.set('Content-Length', stat.size);
    return pipeline(fs.createReadStream(file), res);
  }

  app.get('/api/state', async (req, res) => {
    const state = store.state(req.query.projectId || undefined);
    for (const entity of [...(state.project?.assets || []), ...(state.project?.shots || []), ...(state.project?.storyboards || [])]) {
      const refs = entity.type === 'storyboard' ? storyboardAssets(state.project, entity).map(asset => asset.id) : entity.type === 'shot' ? [...entity.data.characterIds, ...entity.data.locationIds] : [];
      const usedMedia = entity.media.find(media => media.id === entity.adoptedMediaId) || entity.media.at(-1);
      const mediaChanged = media => {
        if (entity.type === 'storyboard') return media.kind === 'video' && (!storyboardMediaFresh(state.project, entity, media) || media.baseVersion !== entity.currentVersion);
        const dependencies = media.metadata?.dependencies || media.metadata?.dependencyVersions || {};
        const map = Array.isArray(dependencies) ? Object.fromEntries(dependencies.map(item => [item.id, item.version])) : dependencies;
        return media.baseVersion !== entity.currentVersion || Object.entries(map).some(([id, version]) => {
          const dep = [...state.project.assets, ...state.project.shots].find(item => item.id === id);
          return dep && dep.currentVersion !== version;
        }) || (media.metadata?.projectVersion && media.metadata.projectVersion !== state.project.versions.at(-1)?.id);
      };
      for (const media of entity.media) media.stale = mediaChanged(media);
      const revisionTime = entity.versions.at(-1)?.at || '';
      entity.dependencyChanged = Boolean(usedMedia && mediaChanged(usedMedia)) || (entity.type === 'shot' && (
        refs.some(id => { const asset = state.project.assets.find(item => item.id === id); return asset?.versions.length > 1 && asset.versions.at(-1).at > revisionTime; })
        || (state.project.versions.length > 1 && state.project.versions.at(-1).at > revisionTime)
      ));
      entity.relatedAssetIds = refs;
    }
    let capabilities;
    try { capabilities = await generation.capabilities(); }
    catch (error) { capabilities = { codex: { available: false, loggedIn: false, message: error.message }, runninghub: { configured: false } }; }
    capabilities.runninghub = { ...capabilities.runninghub, defaultVideoConfig: DEFAULT_VIDEO_CONFIG,
      videoProfiles: { reference: DEFAULT_VIDEO_CONFIG, frames: FRAME_VIDEO_CONFIG },
      videoControls: { aspectRatios: VIDEO_ASPECT_RATIOS, outputResolutions: VIDEO_OUTPUT_RESOLUTIONS, durationMin: VIDEO_DURATION_LIMITS.reference.min, durationMax: VIDEO_DURATION_LIMITS.reference.max, durationInteger: true, resolutionMode: 'native_generation', instanceTypes: INSTANCE_TYPES, defaultInstanceType: DEFAULT_INSTANCE_TYPE,
        concurrency: { min: 1, max: MAX_VIDEO_CONCURRENCY, default: 1, detectEndpoint: '/api/settings/video-concurrency/detect' },
        profiles: {
          reference: { label: '多参考素材', durationMin: VIDEO_DURATION_LIMITS.reference.min, durationMax: VIDEO_DURATION_LIMITS.reference.max, ratioSelectable: true, frameSlots: false, maxImages: 6, audioReferences: true, videoReferences: true, outputRatio: 'selected_ratio' },
          frames: { label: '首尾帧', durationMin: VIDEO_DURATION_LIMITS.frames.min, durationMax: VIDEO_DURATION_LIMITS.frames.max, ratioSelectable: false, frameSlots: true, maxImages: 2, audioReferences: false, videoReferences: false, outputRatio: 'first_frame' },
        } } };
    res.json({ ...state, capabilities, csrfToken, voicePresets: fishAudio.publicState().voicePresets });
  });
  app.post('/api/imports', (req, res) => {
    const { text, filename, asNewProject } = req.body;
    if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw fail('请上传不超过 2 MB 的 Markdown 文本');
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.md')) throw fail('请选择 .md 文件');
    res.json({ project: store.importMarkdown(text, path.basename(filename), { asNewProject: asNewProject === true }) });
  });
  app.post('/api/projects/select', (req, res) => res.json({ project: store.selectProject(req.body.projectId) }));
  app.post('/api/projects/:id/episodes', (req, res) => res.status(201).json({ project: store.addEpisode(checkedId(req.params.id), req.body.number, req.body.name) }));
  app.delete('/api/projects/:id/episodes/:number', (req, res) => res.json(store.deleteEpisode(checkedId(req.params.id), Number(req.params.number), req.body)));
  app.get('/api/projects/:id/source-annotations', (req, res) => res.json({ annotations: store.getSourceAnnotations(checkedId(req.params.id), Number(req.query.episodeNumber)) }));
  app.put('/api/projects/:id/source-annotations', (req, res) => res.json({ annotations: store.saveSourceAnnotations(checkedId(req.params.id), req.body) }));
  app.post('/api/projects/:id/source-video', async (req, res) => {
    const projectId = checkedId(req.params.id), episodeNumber = Number(req.query.episodeNumber);
    const current = store.getSourceAnnotations(projectId, episodeNumber);
    const baseVersion = req.query.baseVersion || null;
    if (baseVersion !== (current?.currentVersion || null)) throw fail('打标已更新，请先保留输入并刷新后再上传。', 409);
    const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
    const extension = /\.(mp4|webm|mov|mkv|m4v)$/i.exec(filename)?.[0].toLowerCase();
    if (!extension) throw fail('请选择 MP4、WebM、MOV、MKV 或 M4V 原视频文件。');
    if (!req.is('application/octet-stream')) throw fail('请直接上传原视频文件。');
    if (Number(req.headers['content-length']) > SOURCE_VIDEO_UPLOAD_MAX_BYTES) throw fail('原视频上传上限为 1 GB。', 413);
    const file = path.join(dataDir, 'projects', projectId, 'source-videos', `${randomUUID()}${extension}`);
    let size = 0;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await pipeline(req, async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > SOURCE_VIDEO_UPLOAD_MAX_BYTES) throw fail('原视频上传上限为 1 GB。', 413);
          yield chunk;
        }
      }, fs.createWriteStream(`${file}.part`, { flags: 'wx' }));
      if (!size) throw fail('请选择非空的视频文件。');
      await fsp.rename(`${file}.part`, file);
      const annotations = store.saveSourceAnnotations(projectId, { episodeNumber, baseVersion, videoPath: file, marks: current?.marks || [] });
      res.status(201).json({ annotations });
    } catch (error) {
      await fsp.unlink(`${file}.part`).catch(() => {});
      await fsp.unlink(file).catch(() => {});
      throw error;
    }
  });
  app.get('/api/projects/:id/source-video', (req, res) => {
    const annotations = store.getSourceAnnotations(checkedId(req.params.id), Number(req.query.episodeNumber));
    const file = sourceVideoFile(annotations?.videoPath || '');
    res.sendFile(file, { dotfiles: 'deny' });
  });
  app.get('/api/projects/:id/source-frame', async (req, res) => {
    const projectId = checkedId(req.params.id), episodeNumber = Number(req.query.episodeNumber);
    const annotations = store.getSourceAnnotations(projectId, episodeNumber);
    if (!annotations || req.query.version !== annotations.currentVersion) throw fail('原视频镜头记录已更新，请刷新比对分析后重试。', 409);
    const seconds = sourceFrameSeconds(req.query.time), inputFile = sourceVideoFile(annotations.videoPath);
    if (inputFile.split(/[/\\]/).some(part => part.startsWith('.'))) throw fail('不能读取隐藏路径中的原视频。');
    try { if (!(await fsp.stat(inputFile)).isFile()) throw new Error('not a file'); }
    catch { throw fail('原视频文件已不在原位置，请重新上传或保存路径。', 404); }
    const frame = await extractSourceFrameImpl({ inputFile, seconds });
    if (!Buffer.isBuffer(frame) || !frame.length) throw fail('这个时间点没有可用的原视频图片。');
    res.type('png').send(frame);
  });
  // 原视频打标的音频：每集只保存一条，重新导入直接替换上一条（旧文件删掉，只保留当前这一条）。
  app.post('/api/projects/:id/source-audio', async (req, res) => {
    const projectId = checkedId(req.params.id), episodeNumber = Number(req.query.episodeNumber);
    const current = store.getSourceAnnotations(projectId, episodeNumber);
    const baseVersion = req.query.baseVersion || null;
    if (baseVersion !== (current?.currentVersion || null)) throw fail('打标已更新，请先保留输入并刷新后再导入音频。', 409);
    const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
    const extension = sourceAudioExtension(filename);
    if (!extension) throw fail('请选择 WAV、MP3 或 M4A 音频文件。');
    if (!req.is('application/octet-stream')) throw fail('请直接上传音频文件。');
    if (Number(req.headers['content-length']) > SOURCE_AUDIO_UPLOAD_MAX_BYTES) throw fail('音频上传上限为 500 MB。', 413);
    const file = path.join(dataDir, 'projects', projectId, 'source-audio', `${randomUUID()}${extension}`);
    let size = 0;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await pipeline(req, async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > SOURCE_AUDIO_UPLOAD_MAX_BYTES) throw fail('音频上传上限为 500 MB。', 413);
          yield chunk;
        }
      }, fs.createWriteStream(`${file}.part`, { flags: 'wx' }));
      if (!size) throw fail('请选择非空的音频文件。');
      await fsp.rename(`${file}.part`, file);
      const probe = await probeSourceMedia(file);
      if (!probe.audio) throw fail('这个文件里没有可用的音轨。', 400);
      const annotations = store.saveSourceAnnotations(projectId, {
        episodeNumber, baseVersion, videoPath: current?.videoPath || '', marks: current?.marks || [],
        audioPath: file, audioName: path.basename(filename), audioDuration: probe.duration,
      });
      const previous = current?.audioPath;
      if (previous && previous !== file && path.dirname(previous) === path.dirname(file)) await fsp.unlink(previous).catch(() => {});
      res.status(201).json({ annotations });
    } catch (error) {
      await fsp.unlink(`${file}.part`).catch(() => {});
      await fsp.unlink(file).catch(() => {});
      throw error;
    }
  });
  app.get('/api/projects/:id/source-audio', async (req, res) => {
    const annotations = store.getSourceAnnotations(checkedId(req.params.id), Number(req.query.episodeNumber));
    const file = annotations?.audioPath || '';
    if (!path.isAbsolute(file) || !sourceAudioExtension(file)) throw fail('请先导入本集音频后再试听。');
    try { await fsp.stat(file); } catch { throw fail('本集音频文件已不在原位置，请重新导入。', 404); }
    await sendFileWithRanges(req, res, { file, mime: sourceAudioMime(file), etag: annotations.currentVersion });
  });
  // 故事板按本集打标时间点切出本组音频：宁可多切（前后留白 + 帧对齐），
  // 切出的文件登记到本组媒体并默认采用，本组视频只传这一条音频（Audio 1）。
  app.post('/api/projects/:id/storyboards/:boardId/cut-audio', async (req, res) => {
    const project = store.getProject(checkedId(req.params.id));
    const board = store.getEntity(project.id, checkedId(req.params.boardId));
    if (board.type !== 'storyboard') throw fail('只有故事板可以切出本组音频。');
    const shots = storyboardShots(project, board);
    if (!shots.length) throw fail('本组还没有关联镜头。');
    const episodeNumber = shots[0].data.episodeNumber ?? 1;
    const annotations = store.getSourceAnnotations(project.id, episodeNumber);
    const usable = file => typeof file === 'string' && path.isAbsolute(file) && !/^[/\\]{2}/.test(file) && fs.existsSync(file);
    const source = [{ file: annotations?.audioPath || '', label: '本集导入音频' }, { file: annotations?.videoPath || '', label: '原视频音轨' }].find(item => usable(item.file));
    if (!source) throw fail('本集还没有导入音频，也没有可播放的原视频路径；请先在“原视频打标”里导入音频或上传原视频。');
    const probe = await probeSourceMedia(source.file);
    if (!probe.audio) throw fail('这个文件里没有可用音轨，请先导入本集音频。', 400);
    const plan = planAudioCut({
      groupCodes: shots.map(shot => shot.code),
      episodeShots: project.shots.filter(shot => (shot.data.episodeNumber ?? 1) === episodeNumber).sort((a, b) => a.order - b.order),
      episodeMarks: annotations?.marks || [],
      before: req.body?.before, after: req.body?.after, range: typeof req.body?.range === 'string' ? req.body.range : '',
      duration: probe.duration || 0, fps: probe.fps,
    });
    const outputFile = path.join(dataDir, 'projects', project.id, 'storyboards', board.id, 'audio', `${randomUUID()}.wav`);
    if (plan.end - plan.start > MAX_AUDIO_CLIP_SECONDS) throw fail(`这段范围有 ${Math.round(plan.end - plan.start)} 秒，比一组镜头该有的长太多；请在本集打标里填对应镜号，或在本组音频里直接填写起止时间。`, 400);
    await cutAudioClip({ inputFile: source.file, outputFile, start: plan.start, end: plan.end });
    let metadata;
    try { metadata = await validateMedia(outputFile, 'audio'); }
    catch (error) { await fsp.unlink(outputFile).catch(() => {}); throw error; }
    const media = store.addMedia(project.id, board.id, {
      id: `media_${randomUUID()}`, file: path.relative(dataDir, outputFile).split(path.sep).join('/'), kind: 'audio',
      mime: metadata.mime, sha256: metadata.sha256 || await fileSha256(outputFile), baseVersion: board.currentVersion, prompt: '',
      metadata: { ...metadata, imported: true, originalFilename: `${board.code || 'storyboard'}-${audioCutLabel(plan.start, plan.end)}.wav`,
        audioCut: { episodeNumber, source: source.label, sourceFile: source.file, start: plan.start, end: plan.end, points: plan.points, note: plan.note } },
    });
    if (req.body?.adopt !== false) store.adopt(project.id, board.id, media.id);
    res.status(201).json({ media, plan, entity: store.getEntity(project.id, board.id) });
  });
  app.post('/api/projects/:id/append-import', (req, res) => res.json({ project: store.appendMarkdown(checkedId(req.params.id), req.body.text, req.body.filename, { episodeNumber: req.body.episodeNumber }) }));
  app.post('/api/projects/:id/cleanup-empty', (req, res) => res.json(store.cleanupEmptyEntries(checkedId(req.params.id), req.body)));
  app.post('/api/projects/:id/cleanup-empty/:archiveId/restore', (req, res) => res.json(store.restoreEmptyEntries(checkedId(req.params.id), checkedId(req.params.archiveId))));
  app.patch('/api/projects/:id', (req, res) => res.json({ project: store.updateProject(req.params.id, req.body) }));
  app.patch('/api/entities/:id', (req, res) => res.json({ entity: store.updateEntity(req.body.projectId, req.params.id, req.body) }));
  app.patch('/api/scenes/:id', (req, res) => res.json({ scene: store.updateScene(checkedId(req.body?.projectId), checkedId(req.params.id), req.body || {}) }));
  app.post('/api/storyboards', (req, res) => res.status(201).json({ entity: store.createStoryboard(req.body.projectId, req.body) }));
  app.post('/api/storyboards/:id/merge-shots', (req, res) => res.json(store.mergeStoryboardShots(checkedId(req.body.projectId), checkedId(req.params.id), req.body)));
  // 连续镜头按每组最多四镜、三个说话角色自动分组。
  app.post('/api/storyboards/auto', (req, res) => res.status(201).json(store.createStoryboards(req.body.projectId, {
    startShotId: req.body.startShotId, namePrefix: req.body.namePrefix, limit: req.body.limit, episodeNumber: req.body.episodeNumber,
  })));
  app.patch('/api/settings/video-concurrency', (req, res) => res.json({ settings: store.setVideoConcurrency(req.body.value) }));
  // 读取 RunningHub 的账号并发上限（queue/status）。接口不可用时只回报原因，不影响手动设置与提交。
  app.post('/api/settings/video-concurrency/detect', async (req, res) => {
    let account, error = null;
    try { account = await generation.queueStatus(); }
    catch (reason) { error = reason.message; account = { fetchedAt: new Date().toISOString(), error }; }
    res.json({ account, settings: store.setAccountConcurrency(account), error });
  });
  app.post('/api/auto-runs', async (req, res) => res.status(201).json({ run: await autoqueue.create(req.body) }));
  app.get('/api/auto-runs/:id', (req, res) => res.json({ run: store.getAutoRun(checkedId(req.params.id)) }));
  app.post('/api/auto-runs/:id/pause', async (req, res) => res.json({ run: await autoqueue.pause(checkedId(req.params.id)) }));
  app.post('/api/auto-runs/:id/resume', async (req, res) => res.json({ run: await autoqueue.resume(checkedId(req.params.id)) }));
  app.post('/api/auto-runs/:id/cancel', async (req, res) => res.json({ run: await autoqueue.cancel(checkedId(req.params.id)) }));
  app.get('/api/entities/:id/prompt', (req, res) => {
    const project = store.getProject(req.query.projectId);
    const entity = store.getEntity(project.id, req.params.id);
    if (!['image', 'video', 'prompt'].includes(req.query.kind)) throw fail('未知提示词类型');
    res.json({ prompt: composePrompt(project, entity, req.query.kind) });
  });
  app.post('/api/shots/reorder', (req, res) => {
    store.reorderShot(req.body.projectId, req.body.entityId, req.body.direction, req.body.baseVersion);
    res.json(store.state(req.body.projectId));
  });
  app.post('/api/issues/:id', (req, res) => res.json({ issue: store.setIssue(req.body.projectId, req.params.id, req.body.status) }));
  app.post('/api/adopt', (req, res) => res.json({ entity: store.adopt(req.body.projectId, req.body.entityId, req.body.mediaId) }));
  app.post('/api/projects/:id/detach-video-media', (req, res) => res.json(store.detachVideoMedia(checkedId(req.params.id), req.body)));

  app.post('/api/media-upload', async (req, res) => {
    const { projectId, entityId, baseVersion, contentBase64 } = req.body;
    checkedId(projectId); checkedId(entityId);
    const entity = store.getEntity(projectId, entityId);
    const boardSource = entity.type === 'storyboard' ? storyboardSource(store.getProject(projectId), entity) : undefined;
    if (baseVersion !== entity.currentVersion) throw fail('条目已更新，请刷新后重新绑定素材', 409);
    if (typeof contentBase64 !== 'string' || contentBase64.length > Math.ceil(LOCAL_UPLOAD_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) throw fail('上传内容无效或超过本地上限 60 MB');
    const bytes = Buffer.from(contentBase64, 'base64');
    const type = sniffMedia(bytes);
    const problem = mediaUploadProblem(bytes.length, type.kind === 'image');
    if (problem) throw fail(problem);
    const mediaId = `media_${randomUUID()}`;
    const relative = path.join('projects', projectId, entity.type === 'shot' ? 'shots' : 'assets', entityId, 'versions', mediaId, `asset${type.extension}`);
    const file = path.join(dataDir, relative);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.part`, bytes, { flag: 'wx' });
    try {
      const metadata = await validateMedia(`${file}.part`, type.kind);
      await fsp.rename(`${file}.part`, file);
      const media = store.addMedia(projectId, entityId, { id: mediaId, file: relative, kind: type.kind, mime: metadata.mime, sha256: metadata.sha256, baseVersion, prompt: '', metadata: { ...metadata, ...(boardSource ? { storyboardSource: boardSource } : {}), imported: true, originalFilename: path.basename(String(req.body.filename || 'asset')) } });
      res.json({ media });
    } catch (error) {
      await fsp.unlink(`${file}.part`).catch(() => {});
      throw error;
    }
  });
  app.post('/api/media/:id/reveal', async (req, res) => {
    const media = store.getMedia(checkedId(req.params.id));
    let file;
    try {
      file = await safeWithin(dataDir, media.file);
      if (!(await fsp.stat(file)).isFile()) throw fail('媒体文件不存在。', 404);
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('媒体文件不存在，可能已被移动或删除。', 404);
      throw error;
    }
    await revealMediaFileImpl(file);
    res.json({ opened: true });
  });
  app.get('/api/media/:id', async (req, res) => {
    const media = store.getMedia(req.params.id);
    const file = await safeWithin(dataDir, media.file);
    await sendFileWithRanges(req, res, { file, mime: media.mime || ({ video: 'video/mp4', audio: 'audio/wav', image: 'image/png' }[media.kind]), etag: media.sha256, cacheControl: 'private, max-age=31536000, immutable' });
  });
  app.get('/api/source/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(project.source.filename)}` }).send(project.source.text);
  });
  app.post('/api/refresh', async (req, res) => res.json(await generation.refresh(req.body.projectId)));
  app.post('/api/previews', async (req, res) => res.json({ preview: await generation.prepare(req.body) }));
  app.get('/api/video-references/workflow', async (req, res) => res.json(await generation.videoReferenceWorkflow()));
  app.post('/api/video-references', express.raw({ type: 'application/octet-stream', limit: '30mb' }), async (req, res) => {
    const job = await generation.submitVideoReference({ content: req.body, filename: req.query.filename,
      operationId: req.query.operationId, outputs: typeof req.query.outputs === 'string' ? req.query.outputs.split(',') : undefined });
    res.status(201).json({ job });
  });
  app.get('/api/video-references/:id/files/:kind', async (req, res) => {
    const job = store.getJob(checkedId(req.params.id));
    const source = req.params.kind === 'source';
    const output = source ? job.snapshot?.source : job.outputs.find(item => item.kind === req.params.kind);
    if (job.purpose !== 'video_reference' || !output?.file) throw fail('参考文件不存在', 404);
    const file = await safeWithin(dataDir, output.file);
    const name = source ? output.filename : `${path.parse(job.snapshot.source.filename).name}-${req.params.kind}.mp4`;
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    await sendFileWithRanges(req, res, { file, mime: 'video/mp4', etag: output.sha256 });
  });
  app.post('/api/jobs', async (req, res) => res.status(201).json({ job: await generation.submit(req.body) }));
  app.get('/api/jobs/:id', (req, res) => res.json({ job: store.getJob(req.params.id) }));
  app.post('/api/jobs/:id/retry', async (req, res) => res.json({ job: await generation.retry(req.params.id) }));
  app.post('/api/jobs/:id/attach-task', async (req, res) => {
    const job = store.getJob(req.params.id);
    if (job.kind !== 'video' || job.taskId || !['submission_unknown', 'failed'].includes(job.status)) throw fail('此任务不能补录 taskId', 409);
    if (typeof req.body.taskId !== 'string' || !/^\d{8,32}$/.test(req.body.taskId)) throw fail('请输入 RunningHub 后台的数字 taskId');
    store.updateJob(job.id, { taskId: req.body.taskId, status: 'queued', error: null, taskIdManuallyAttached: true });
    res.json({ job: await generation.retry(job.id) });
  });
  app.post('/api/jobs/:id/resolve-unknown', (req, res) => {
    const job = store.getJob(req.params.id);
    if (job.kind !== 'video' || job.taskId || job.status !== 'submission_unknown') throw fail('此任务不处于待核对状态', 409);
    if (req.body.confirmedNotSubmitted !== true) throw fail('需要先在 RunningHub 后台核对本次任务不存在');
    res.json({ job: store.updateJob(job.id, { status: 'failed', manualResolution: 'confirmed_not_submitted', error: '用户已核对远端无本次任务，关闭不明状态；本操作没有重新提交生成。' }) });
  });
  app.patch('/api/settings/prompt-preferences', (req, res) => res.json({ promptPreferences: store.setPromptPreference(req.body.id, req.body.enabled) }));
  app.post('/api/settings/runninghub', (req, res) => res.json(saveRunningHubKey(req.body.key)));
  // Fish Audio Drama-3 语音：状态、音色映射与密钥、台词合成、音频写入角色槽位。
  app.get('/api/fish-audio/state', (req, res) => res.json(fishAudio.publicState()));
  app.post('/api/fish-audio/settings', (req, res) => res.json(fishAudio.save(req.body)));
  app.post('/api/fish-audio/synthesize', async (req, res) => {
    const { text, referenceId, format, download } = req.body;
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw fail('台词文本为空或过长');
    if (typeof referenceId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(referenceId)) throw fail('音色 ID 无效');
    const result = await fishAudio.synthesize({ text, referenceId, format });
    return sendFishAudioResult(res, result, download);
  });
  app.post('/api/fish-audio/attach', async (req, res) => {
    const { projectId, entityId, mediaId } = req.body;
    const media = store.getMedia(checkedId(mediaId));
    const entity = store.getEntity(projectId, entityId);
    if (media.kind !== 'audio') throw fail('只能把音频写入角色音色槽位', 409);
    res.json({ media });
  });
  app.get('/api/export/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    const exportEntity = entity => ({ id: entity.id, code: entity.code, name: entity.name, type: entity.type, currentVersion: entity.currentVersion, data: entity.data,
      adopted: entity.media.find(item => item.id === entity.adoptedMediaId) || null,
      adoptedByKind: Object.fromEntries(['image', 'video', 'audio'].map(kind => [kind, entity.media.find(item => item.id === entity.adoptedMediaIds?.[kind]) || null])), candidates: entity.media.length });
    const manifest = { schemaVersion: 1, exportedAt: new Date().toISOString(), projectId: project.id, title: project.title, aspectRatio: project.aspectRatio, style: project.style, episodes: project.episodes, ...(project.episodeNames ? { episodeNames: project.episodeNames } : {}), sourceHash: project.source.hash, storyScenes: project.storyScenes, assets: project.assets.map(exportEntity), shots: project.shots.toSorted((a, b) => a.order - b.order).map(exportEntity), storyboards: project.storyboards.map(exportEntity), sequence: previewSequence(project).map(entry => ({ entityId: entry.shot.id, mediaId: entry.media.id, kind: entry.kind, plannedDuration: entry.plan })) };
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${project.title}-选用清单.json`)}`).json(manifest);
  });

  app.use(express.static(path.join(appRoot, 'public'), { etag: false, maxAge: 0 }));
  app.use((req, res) => res.status(404).json({ error: '地址不存在' }));
  app.use((error, req, res, next) => {
    if ((req.aborted || res.destroyed) && ['ECONNABORTED', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) return;
    if (res.headersSent || res.destroyed) return next(error);
    let message = String(error.message || '本机服务发生错误');
    try { const key = getRunningHubKey(); if (key) message = message.replaceAll(key, '[已隐藏]'); } catch {}
    message = message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
    const status = error.type === 'entity.too.large' ? 413 : error.status || 500;
    res.status(status).json({ error: message.slice(0, 1500), code: error.code, comparison: error.comparison, details: error.details });
  });
  return { app, store, generation, autoqueue, forge, llm, csrfToken, close() { autoqueue.close(); generation.close(); forge.close(); store.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = createStudio();
  const port = Number(process.env.PORT || 4318);
  const server = studio.app.listen(port, '127.0.0.1');
  server.once('listening', () => {
    console.log(`分镜资产工作台 http://127.0.0.1:${server.address().port}`);
    Promise.resolve(studio.generation.recover()).catch(error => console.error(`任务恢复：${error.message}`));
    Promise.resolve(studio.autoqueue.recover()).catch(error => console.error(`队列恢复：${error.message}`));
  });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。请打开现有工作台或设置 PORT 后重试。` : error.message); studio.close(); process.exitCode = 1; });
  const stop = () => server.close(() => { studio.close(); process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
