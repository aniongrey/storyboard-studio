import {referenceGroups,automaticReferences,automaticBindings,frameBindings,isFrameConfig,frameRole,videoPromptBlocks,assembleVideoPrompt,referenceToken} from './video-editor.mjs';
import {storyboardShots,storyboardSummary,storyboardProblem,storyboardDuration,storyboardSource,composeStoryboardPrompt,storyboardFinalPrompt,formatStoryboardFinalPrompt,previewSequence,planStoryboardGroups,mediaRatio,ratioValue} from './storyboard.mjs';
import {renderForgeView} from './forge.js';
import {planVideoOutput} from './video-resolution.mjs';
import {mediaUploadProblem,SOURCE_VIDEO_UPLOAD_MAX_BYTES,SOURCE_AUDIO_UPLOAD_MAX_BYTES,VIDEO_REFERENCE_UPLOAD_MAX_BYTES} from './media-limits.mjs';
import {sourceComparisonContext,sourceComparisonFor,sourceComparisonTitle} from './source-comparison.mjs';
const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const modal = $('#modal');
const labels = {overview:'作品概览',annotations:'原视频镜头',references:'视频转参考',character:'角色资产',location:'地点资产',prop:'道具资产',shot:'镜头工作台',jobs:'生成任务',forge:'因果剧本'};
const typeNames = {character:'角色',location:'地点',prop:'道具',shot:'镜头',storyboard:'故事板',image:'图片',video:'视频',audio:'音频',prompt:'提示词'};
const statusNames = {draft:'待执行',pending:'待执行',preparing:'正在准备',waiting_delivery:'等待 Codex 交付',awaiting_delivery:'等待 Codex 交付',awaiting_codex:'等待 Codex 交付',delivery_invalid:'交付清单需修正',submitting:'正在提交',submission_unknown:'提交结果不明',query_failed:'查询失败，可恢复',queued:'远端排队',running:'正在生成',downloading:'正在下载',ready:'已完成',completed:'已完成',succeeded:'已完成',failed:'失败',cancelled:'已停止',blocked:'缺少配置',interrupted:'任务中断'};
// 两个档位对应两个已核对的 RunningHub 应用：多参考（Ref2VA，最多 6 图 + 3 音）与首尾帧（FL2VA，图1→图2）。
// 实例规格默认标准 24G，用户可在生成参数中切换。
const defaultInstanceType = 'default';
const defaultVideoConfig = {mode:'reference',workflowId:'2084320751339032577',duration:'10',aspectRatio:'9:16 (Portrait Widescreen)',pixels:'0.9',outputResolution:'720p',instanceType:defaultInstanceType,usePersonalQueue:false,nodeInfoList:[{nodeId:'150',fieldName:'value',fieldValue:''},{nodeId:'115',fieldName:'aspect_ratio',fieldValue:'9:16 (Portrait Widescreen)'},{nodeId:'186',fieldName:'value',fieldValue:'10'},{nodeId:'147',fieldName:'value',fieldValue:'0.9'}],referenceBindings:[]};
const frameVideoDefaults = {mode:'frames',workflowId:'2084282198664007682',duration:'10',pixels:'0.9',outputResolution:'720p',frameBindings:{first:null,last:null},useLastFrame:true,instanceType:defaultInstanceType,usePersonalQueue:false,nodeInfoList:[{nodeId:'137',fieldName:'image',fieldValue:'None'},{nodeId:'143',fieldName:'image',fieldValue:'None'},{nodeId:'159',fieldName:'value',fieldValue:'true'},{nodeId:'142',fieldName:'value',fieldValue:'0.9'},{nodeId:'135',fieldName:'value',fieldValue:'10'},{nodeId:'136',fieldName:'prompt',fieldValue:''},{nodeId:'174',fieldName:'value',fieldValue:'false'},{nodeId:'175',fieldName:'strength_model',fieldValue:'0'}]};
const videoProfileLabels = {reference:'多参考素材',frames:'首尾帧'};
const videoAspectOptions = [['1:1 (Square)','1:1 · 正方形'],['2:3 (Portrait Photo)','2:3 · 竖幅'],['3:2 (Photo)','3:2 · 横幅'],['3:4 (Portrait Standard)','3:4 · 竖幅'],['4:3 (Standard)','4:3 · 横幅'],['9:16 (Portrait Widescreen)','9:16 · 竖屏短视频'],['16:9 (Widescreen)','16:9 · 横屏'],['21:9 (Ultrawide)','21:9 · 超宽屏']];
// 实例规格两档共用。规格越高单价越高，所以默认值放在最上面并标出来。
const videoInstanceOptions = [['default','标准 · 24G（默认）'],['plus','Plus · 48G'],['ultra','ultra · 84G']];
let state = {projects:[],project:null,jobs:[],capabilities:{}};
let view = 'overview';
try {const saved = localStorage.getItem('studio.view');if(Object.hasOwn(labels,saved))view=saved;} catch {}
let sidebarCollapsed = window.matchMedia('(max-width: 820px)').matches;
try {const saved = localStorage.getItem('studio.sidebarCollapsed');if(saved!==null)sidebarCollapsed=saved==='true';} catch {}
let selectedId = null;
let editorTab = 'edit';
let search = '';
let taskFilter = 'all';
const videoReferenceDraft = { file: null, outputs: ['mixed'], operationId: null };
let shotView = 'list';
let shotSheetScene = 'all';
let currentEpisode = null;
// 自动生成队列面板的展开状态：null 表示还没手动开合过，按「跑着就展开、结束就收起」自动判断。
let autoRunOpen = null;
// 粗剪预览：previewRemainingMs 是「本段还剩多少毫秒」的权威值，-1 表示下一帧按整段重新计算。
// 视频段落以播放器的时间轴为准（用户拖动进度后粗剪进度立刻跟随），静帧段落才用它自己的倒计时。
let previewIndex = 0;
let previewScope = 'all';
let previewPlaying = false;
let previewMuted = false;
let previewRaf = null;
let previewSlotStart = 0;
let previewRunRemainingMs = 0;
let previewRemainingMs = -1;
let previewPlayer = null;
let previewAdvanceAt = 0;
// 集数选择由整个镜头工作台共用，资产始终全剧共用。
// stripScroll 记住序列列表的滚动位置——每次重画都换掉整块 DOM，不记就会「点一下弹回顶部」。
let previewQuery = '';
let previewStripScroll = 0;
let draft = null;
let dirty = false;
let preview = null;
let previewEpoch = 0;
let generationKind = 'image';
let finalPrompt = '';
let promptLoadedKey = null;
let promptLoading = false;
let promptEdited = false;
let referenceIds = new Set();
let videoEditorKey = null;
let videoBlocks = [];
const videoBlockEdits = new Map();
let operationId = null;
let busy = false;
let toastTimer;
let videoConfig = readConfig();
let hasCustomVideoConfig = false;
try {hasCustomVideoConfig = !!localStorage.getItem('studio.videoConfig');} catch {}
// 生成时长是普通可改参数：按镜头记住手动改过的值，没改过时才用设定编辑里的计划剪辑时长当默认值。
let videoDurations = {};
try {videoDurations = JSON.parse(localStorage.getItem('studio.videoDurations') || '{}') || {};} catch {videoDurations = {};}
const drafts = new Map();
const sourceAnnotationDrafts = new Map();
let sourceAnnotationPlayer = null;

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    // aria-* 必须是 "true"/"false" 字符串：写成布尔会被序列化成空属性，[aria-x=true] 选择器与辅助技术都会失效。
    else if (key.startsWith('aria-')) element.setAttribute(key, value === true ? 'true' : value === false ? 'false' : String(value));
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') element[key] = !!value;
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
function button(text, action, className = '', attrs = {}) {return node('button',{type:'button',class:className,onClick:action,...attrs},text);}
function icon(name) {
  const paths = {
    panel:'M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1',
    overview:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    annotations:'M4 4h16v16H4zM9 4v16M4 9h5M4 15h5M13 9l4 3-4 3z',
    references:'M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4',
    character:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
    location:'m3 10 9-7 9 7v11H3zM9 21v-8h6v8',
    prop:'m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M8 5l9 5',
    shot:'M3 4h18v16H3zM3 9h18M8 4v5M16 4v5M7 13h4M7 16h10',
    forge:'M4 4h16v16H4zM8 8h8M8 12h5M8 16h8',
    jobs:'M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9M12 7v5l3 2',
    source:'M5 3h10l4 4v14H5zM14 3v5h5M9 12h6M9 16h6',
    settings:'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    refresh:'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15',
    plus:'M12 5v14M5 12h14',
    folder:'M3 6h7l2 3h9v12H3z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  for (const [key,value] of Object.entries({class:'ui-icon',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'})) svg.setAttribute(key,value);
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',paths[name]);svg.append(path);return svg;
}
function badge(text, tone = '') {return node('span',{class:`badge ${tone}`},text);}
function row(...children) {return node('div',{class:'row'},...children);}
function json(value) {return JSON.stringify(value,null,2);}
function date(value) {if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
function text(value) {return value == null ? '' : typeof value === 'string' ? value : json(value);}
function mediaUrl(media) {return `/api/media/${encodeURIComponent(media.id)}?v=${encodeURIComponent(media.sha256 || media.id)}`;}
function mediaFilename(media) {return media.metadata?.originalFilename || media.originalFilename || media.metadata?.filename || media.file?.split(/[\\/]/).at(-1) || '未记录文件名';}
function mediaTypeLabel(media) {const format=media.kind==='audio'?'WAV':media.mime?.split('/').at(-1)?.toUpperCase();return (typeNames[media.kind]||'素材')+(format?' · '+format:'');}
function audioMetadata(media) {const m=media.metadata||{};return [Number(m.duration)>0?Number(m.duration).toFixed(2)+' 秒':null,Number(m.sampleRate)>0?Number(m.sampleRate)+' Hz':null,Number(m.channels)>0?Number(m.channels)+' 声道':null].filter(Boolean).join(' · ');}
function mediaElement(entity,media) {
  if(media.kind==='audio')return node('div',{class:'audio-preview'},node('span',{class:'audio-icon','aria-hidden':true},'♫'),node('strong',{},'角色参考音频'),node('audio',{src:mediaUrl(media),controls:true,preload:'metadata','aria-label':entity.name+' · '+mediaFilename(media)+'试听'}));
  if(media.kind==='video')return node('video',{src:mediaUrl(media),controls:true,preload:'metadata','aria-label':entity.name+'候选视频'});
  return node('img',{src:mediaUrl(media),alt:entity.name+' · '+mediaFilename(media),loading:'lazy'});
}
function mediaCaption(media) {return node('div',{},node('div',{class:'media-filename',title:mediaFilename(media)},mediaFilename(media)),node('small',{},mediaTypeLabel(media)),media.kind==='audio'&&audioMetadata(media)?node('small',{},audioMetadata(media)):null,media.kind==='audio'?node('small',{},'音色参考；节点作用与克隆效果尚未验证。'):null);}
function entities() {return [...(state.project?.assets || []),...(state.project?.shots || []),...(state.project?.storyboards || [])];}
function selected() {return entities().find(e => e.id === selectedId);}
function adoptedId(entity,kind) {return entity.adoptedMediaIds?.[kind] || (entity.media || []).find(m=>m.id===entity.adoptedMediaId&&m.kind===kind)?.id || null;}
function isAdopted(entity,media) {return media.id===adoptedId(entity,media.kind);}
function displayMedia(entity, kind = 'image') {return (entity.media || []).find(m => m.id === adoptedId(entity,kind) && m.kind === kind) || [...(entity.media || [])].reverse().find(m => m.kind === kind);}
function currentVersion(entity) {return typeof entity.currentVersion === 'object' ? entity.currentVersion.id : entity.currentVersion;}
function count(type) {return type === 'shot' ? (state.project?.shots || []).filter(inCurrentEpisode).length : (state.project?.assets || []).filter(e => e.type === type).length;}
function readConfig() {
  try {
    const saved=JSON.parse(localStorage.getItem('studio.videoConfig'));
    const valid=saved&&typeof saved==='object'&&!Array.isArray(saved);
    const frame=valid&&(saved.mode==='frames'||saved.workflowId===frameVideoDefaults.workflowId);
    const config={...structuredClone(frame?frameVideoDefaults:defaultVideoConfig),...(valid?saved:{})};
    if(valid&&saved.pixels===undefined)config.pixels=(saved.nodeInfoList||[]).find(item=>item.nodeId===(frame?'142':'147')&&item.fieldName==='value')?.fieldValue??'0.4';
    // 只迁移一次上一版的 48G 默认配置，此后保留用户选择。
    if(localStorage.getItem('studio.instanceDefaultStandard24G')!=='1'){
      if(!config.instanceType||config.instanceType==='plus')config.instanceType=defaultInstanceType;
      if(valid)localStorage.setItem('studio.videoConfig',JSON.stringify(config));
      localStorage.setItem('studio.instanceDefaultStandard24G','1');
    }
    syncNativePixels(config);
    if(valid)localStorage.setItem('studio.videoConfig',JSON.stringify(config));
    return config;
  } catch {return structuredClone(defaultVideoConfig);}
}
function syncNativePixels(config,framePair=null){
  if(nativePixelConflict(config))return null;
  const frame=config.mode==='frames'||config.workflowId===frameVideoDefaults.workflowId;
  const pixelNode=(config.nodeInfoList||[]).find(item=>item.nodeId===(frame?'142':'147')&&item.fieldName==='value');
  const aspect=frame?{width:framePair?.[0]??0,height:framePair?.[1]??0}:(config.aspectRatio||defaultVideoConfig.aspectRatio);
  try{
    const output=planVideoOutput(config.outputResolution||'native',aspect,config.pixels??pixelNode?.fieldValue??'0.4');
    config.pixels=String(output.pixels);
    if(pixelNode)pixelNode.fieldValue=config.pixels;
    return output;
  }catch{return null;}
}
function nativePixelConflict(config){
  if((config.outputResolution||'native')!=='native'||config.pixels===undefined)return '';
  const frame=config.mode==='frames'||config.workflowId===frameVideoDefaults.workflowId;
  const nodeId=frame?'142':'147';
  const item=(config.nodeInfoList||[]).find(item=>item.nodeId===nodeId&&item.fieldName==='value');
  return item&&Number(config.pixels)!==Number(item.fieldValue)
    ? `生成像素 ${config.pixels} 与工作流节点 ${nodeId}.value=${item.fieldValue} 不一致，请先统一；不会自动覆盖。`:'';
}
function isFrameMode(){return isFrameConfig(videoConfig);}
// 服务端给的是权威默认配置；拿不到（离线/旧后端）时退回本地副本。
function videoProfile(mode=videoConfig.mode){return state.capabilities?.runninghub?.videoProfiles?.[mode]||(mode==='frames'?frameVideoDefaults:defaultVideoConfig);}
function durationRange(){return isFrameMode()?{min:5,max:15}:{min:1,max:30};}
function persistConfig() {hasCustomVideoConfig=true;try{localStorage.setItem('studio.videoConfig',json(videoConfig));}catch{notify('浏览器未允许保存配置；本次会话仍可使用。',true);}}
function plannedDuration(entity) {if(entity?.type==='storyboard')return String(storyboardDuration(state.project,entity));return entity?.type==='shot'&&Number(entity.data?.duration)>0?String(Number(entity.data.duration)):'';}
function persistVideoDurations() {try{localStorage.setItem('studio.videoDurations',json(videoDurations));}catch{}}
// 把界面参数写回 nodeInfoList：同一个参数在两档里的节点号不同（时长 186 / 135、比例 115、
// 像素 多参考147 / 首尾帧142、尾帧开关 159），节点不存在就跳过。仅用于让高级 JSON 面板与实际参数一致；
// 真正生效以服务端按档位写入为准。
function syncConfigValue(key,value){
  const mapping={duration:[['186','value'],['135','value']],aspectRatio:[['115','aspect_ratio']],pixels:[[isFrameMode()?'142':'147','value']],useLastFrame:[['159','value']]}[key]||[];
  const text=key==='useLastFrame'?(value===false?'false':'true'):String(value);
  for(const [nodeId,fieldName] of mapping){const item=(videoConfig.nodeInfoList||[]).find(n=>n.nodeId===nodeId&&n.fieldName===fieldName);if(item)item.fieldValue=text;}
}
// 只在「本镜没手动改过」时把计划剪辑时长填进来当默认值；改过就用改过的值，不再被计划值覆盖。
// 两个档位的时长范围不同（多参考 1–30、首尾帧 5–15），所以填进来的值会被夹到当前档位范围内。
function applyDurationDefault(entity) {
  if(!['shot','storyboard'].includes(entity?.type))return;
  const planned=plannedDuration(entity);
  const {min,max}=durationRange();
  let value=videoDurations[entity.id]??(planned||String(videoConfig.duration??''));
  const numeric=Number(value);
  if(entity.type==='shot'&&value&&Number.isFinite(numeric)&&numeric>0)value=String(Math.min(Math.max(numeric,min),max));
  videoConfig.duration=value;
  syncConfigValue('duration',value);
}
function rememberDuration(entity,value) {
  if(!['shot','storyboard'].includes(entity?.type))return;
  const text=String(value??'');
  if(text&&text!==plannedDuration(entity))videoDurations[entity.id]=text;else delete videoDurations[entity.id];
  persistVideoDurations();
}
function durationHint(entity) {
  const {min,max}=durationRange();
  const planned=plannedDuration(entity);
  if(entity?.type==='storyboard')return `组内有效镜头计划合计 ${planned} 秒；本次支持 ${min}–${max} 整数秒，留白格不加时长。修改生成时长会按计划时长比例分配，不改原镜头。`;
  if(!planned)return min+'–'+max+' 秒整数；'+(isFrameMode()?'输出比例跟随首帧，像素数在此调整。':'比例与原生生成清晰度在此调整。');
  const current=String(videoConfig.duration??'');
  if(!current)return '留空不是默认值，请填 '+min+'–'+max+' 的整数；本镜计划剪辑时长是 '+planned+' 秒。';
  if(current===planned)return '默认取本镜计划剪辑时长 '+planned+' 秒，可直接改；改这里不会改动计划剪辑时长。';
  return '已改为 '+current+' 秒（本镜计划 '+planned+' 秒）；只影响本次生成，计划剪辑时长不变。';
}
function notify(message, error = false) {const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error',error); toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => {toast.hidden = true;},error ? 8500 : 4200);}
async function copy(value) {try {await navigator.clipboard.writeText(text(value)); notify('已复制');} catch {const textarea = node('textarea',{value:text(value),readonly:true,rows:12}); openModal('复制内容',node('div',{class:'stack'},node('p',{class:'muted'},'请选中以下内容复制。'),textarea)); textarea.select();}}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) {headers.set('Content-Type','application/json');headers.set('X-Studio-Token',state.csrfToken || '');}
  const response = await fetch(path,{...options,headers,body:options.body === undefined ? undefined : JSON.stringify(options.body)});
  let result;
  try {result = await response.json();} catch {throw new Error(`服务返回了无法读取的响应（${response.status}）`);}
  if (!response.ok) {const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `请求失败（${response.status}）`);error.status = response.status;error.details = result;throw error;}
  return result;
}
async function perform(action, success) {if (busy) return;busy = true;document.body.setAttribute('aria-busy','true');const indicator=$('#busy-state');if(indicator)indicator.hidden=false;syncGenerationActions();try {const result = await action();if (success) notify(success);return result;} catch (error) {notify(error.message,true);return null;} finally {busy = false;document.body.removeAttribute('aria-busy');const indicator=$('#busy-state');if(indicator)indicator.hidden=true;syncGenerationActions();}}
async function loadState(render = true) {const result = await api(`/api/state${state.project?.id ? `?projectId=${encodeURIComponent(state.project.id)}` : ''}`);state = result;if(currentEpisode!=='all'&&state.project?.episodes?.length&&!state.project.episodes.includes(currentEpisode))currentEpisode=Math.max(...state.project.episodes);const serverConfig=state.capabilities?.runninghub?.defaultVideoConfig;if(!hasCustomVideoConfig&&serverConfig)videoConfig=structuredClone(serverConfig);if (selectedId && !selected()) selectedId = null;if (render) renderApp();}
function resetSelection(id) {
  if(dirty && draft && selected()?.type!=='storyboard') drafts.set(draft.id,draft);
  const entity = id ? entities().find(e=>e.id===id) : null;
  if(entity&&['shot','storyboard'].includes(entity.type)&&currentEpisode!=='all')currentEpisode=episodeNumber(entity);
  const tab = defaultEditorTab(entity);
  selectedId = id;editorTab = tab;draft = drafts.get(id)||null;dirty = entity?.type==='storyboard'?hasStoryboardDrafts(entity):!!draft;preview = null;previewEpoch++;operationId = null;referenceIds = new Set();generationKind = tab==='video' ? 'video' : 'image';
  finalPrompt = '';promptLoadedKey=null;promptLoading=false;promptEdited=false;videoEditorKey=null;
}
function changeView(next) {stopPreviewPlayback();view = next;search = '';document.body.classList.remove('forge-fullscreen');if (!['character','location','prop','shot'].includes(next) || (selected()?.type !== next && !(next==='shot'&&selected()?.type==='storyboard'))) resetSelection(null);renderApp();}
function invalidatePreview() {preview = null;previewEpoch++;operationId = null;const container = $('#preview-content');if (container) container.replaceChildren(previewEmpty());syncGenerationActions();}
function markDirty() {dirty = true;if(draft)drafts.set(draft.id,draft);invalidatePreview();const label = $('#dirty-label');if (label) label.textContent = '有未保存的修改';const save = $('#save-entity');if (save) save.disabled = false;}
function openModal(title, body, className = '') {modal.className=className;modal.replaceChildren(node('div',{class:'modal-header'},node('h2',{id:'modal-title'},title),button('关闭',() => modal.close(),'quiet small',{'aria-label':'关闭对话框'})),node('div',{class:'modal-body'},body));if (!modal.open) modal.showModal();}

function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  $('.shell')?.classList.toggle('sidebar-collapsed',collapsed);
  const toggle = $('#sidebar-toggle');
  const label = collapsed ? '展开侧栏' : '收起侧栏';
  toggle?.setAttribute('aria-expanded',String(!collapsed));
  toggle?.setAttribute('aria-label',label);
  toggle?.setAttribute('title',label);
  const text = $('#sidebar-toggle-label');if(text)text.textContent=label;
  try {localStorage.setItem('studio.sidebarCollapsed',String(collapsed));} catch {}
}

function renderApp() {
  try {localStorage.setItem('studio.view',view);} catch {}
  destroySourceAnnotationPlayer();
  document.title = `${state.project?.title || '分镜资产工作台'} · 分镜资产工作台`;
  // 离开粗剪预览就停掉播放循环；留在预览里重绘时，把已播过的时长结算进剩余值，避免重播当前段。
  if(view==='shot'&&shotView==='preview'){
    if(previewPlaying)previewRemainingMs=previewRemainingFromVideo()??Math.max(0,previewRunRemainingMs-(performance.now()-previewSlotStart));
  } else stopPreviewPlayback();
  const projectSelect = node('select',{id:'project-select','aria-label':'选择作品',title:state.project?.title||'选择作品',onChange:async event => {
    const projectId = event.target.value;
    const result = await perform(() => api('/api/projects/select',{method:'POST',body:{projectId}}));
    if (result) {state.project = {id:projectId};currentEpisode=null;resetSelection(null);view='overview';await loadState();}
  }},state.projects.length ? state.projects.map(p => node('option',{value:p.id,selected:p.id===state.project?.id},p.title)) : node('option',{value:''},'尚未导入作品'));
  const codex = state.capabilities?.codex || {};
  const sidebarAction = (name,label,action,attrs={}) => button([icon(name),node('span',{class:'sidebar-label'},label)],action,'sidebar-action',{'aria-label':label,title:label,...attrs});
  const navGroup = (title,keys) => node('div',{class:'nav-group'},node('div',{class:'nav-group-label'},title),keys.map(key=>button([
    icon(key),node('span',{class:'sidebar-label'},labels[key]),node('span',{class:'nav-count'},['character','location','prop','shot'].includes(key)?count(key):key==='jobs'?(state.jobs||[]).length:'')
  ],()=>{changeView(key);if(window.matchMedia('(max-width: 820px)').matches)setSidebarCollapsed(true);},'',{'aria-label':labels[key],title:labels[key],'aria-current':view===key?'page':null})));
  const toggleLabel = sidebarCollapsed?'展开侧栏':'收起侧栏';
  const sidebar = node('aside',{class:'sidebar',id:'workspace-sidebar','aria-label':'工作区侧栏'},
    button([icon('panel'),node('span',{class:'sidebar-label',id:'sidebar-toggle-label'},toggleLabel)],()=>setSidebarCollapsed(!sidebarCollapsed),'sidebar-toggle',{id:'sidebar-toggle','aria-label':toggleLabel,'aria-expanded':!sidebarCollapsed,'aria-controls':'sidebar-body',title:toggleLabel}),
    node('div',{class:'sidebar-body',id:'sidebar-body'},
      node('div',{class:'sidebar-context'},node('span',{class:'sidebar-kicker'},'当前工作区'),node('div',{class:'sidebar-page'},labels[view])),
      node('div',{class:'project-picker'},node('label',{for:'project-select'},'当前作品'),projectSelect,state.project?node('div',{class:'project-episodes'},node('small',{},'当前集数'),node('div',{class:'row'},episodePicker('选择当前作品集数'),button('＋',showAddEpisode,'small',{'aria-label':'新增集数',title:'新增集数'})),node('small',{class:'muted'},'角色、地点、道具全剧共用')):null),
      button([icon('folder')],()=>{setSidebarCollapsed(false);$('#project-select')?.focus();},'sidebar-project-shortcut',{'aria-label':'切换作品与集数',title:'切换作品与集数'}),
      node('nav',{class:'nav','aria-label':'主导航'},navGroup('创作',['overview','annotations','references','shot','forge']),navGroup('共享资产',['character','location','prop']),navGroup('任务中心',['jobs'])),
      node('div',{class:'sidebar-bottom'},
        sidebarAction('plus','导入分镜',()=>$('#import-file').click(),{class:'sidebar-action sidebar-import'}),
        node('div',{class:'sidebar-tools'},sidebarAction('source','原文',showSource,{disabled:!state.project}),sidebarAction('refresh','刷新资产',refreshAssets,{disabled:!state.project}),sidebarAction('settings','设置',showSettings)),
        node('span',{class:'inline-status',id:'busy-state',hidden:!busy,role:'status','aria-live':'polite'},'正在处理…'),
        node('div',{class:'sidebar-connections'},node('div',{class:'connection'},node('span',{class:'dot good','aria-hidden':true}),'本机工作区 · 文件保存在本地'),node('div',{class:'connection'},node('span',{class:`dot ${codex.loggedIn?'good':'bad'}`,'aria-hidden':true}),codex.loggedIn?'Codex CLI 已登录':'当前会话生图 · 文件交付')))));
  const content = node('main',{class:view==='forge'?'content forge-content':'content',id:'main-content',tabindex:'-1','aria-label':labels[view]});
  // 资产/镜头工作台固定成一屏高：左列表与右栏各自滚，整页不再跟着滚（.pane-scroll，窄屏自动失效）。
  // 粗剪预览是整宽单栏，舞台要靠视口高度撑大，仍然走整页滚动。
  const paneScroll = ['character','location','prop','shot'].includes(view) && !(view==='shot' && ['preview','table'].includes(shotView));
  app.replaceChildren(node('div',{class:`shell${paneScroll?' pane-scroll':''}${sidebarCollapsed?' sidebar-collapsed':''}`},button('',()=>setSidebarCollapsed(true),'sidebar-backdrop',{'aria-label':'关闭侧栏遮罩',tabindex:'-1'}),sidebar,node('div',{class:'main'},content)));
  sidebar.querySelector('[aria-current=page]')?.scrollIntoView({block:'nearest'});
  if (view === 'references') renderVideoReferences(content);
  else if (!state.project) renderWelcome(content);
  else if (view === 'overview') renderOverview(content);
  else if (view === 'annotations') renderSourceAnnotations(content);
  else if (view === 'forge') renderForgeView(content, forgeHelpers());
  else if (view === 'jobs') renderJobs(content);
  else renderWorkspace(content);
}
// 因果剧本模块只通过这组入口跟工作台打交道：读作品列表、发请求、开弹窗、回跳到分镜作品。
function forgeHelpers() {
  return {
    api,
    notify,
    copy,
    openModal,
    getStudioState:() => state,
    openStudioProject:async projectId => {
      const result = await perform(() => api('/api/projects/select',{method:'POST',body:{projectId}}));
      if (!result) return;
      state.project = {id:projectId};
      currentEpisode = null;
      resetSelection(null);
      view = 'overview';
      await loadState(false);
      renderApp();
    },
  };
}
function heading(title,subtitle,actions) {return node('div',{class:`page-heading${actions?' has-actions':''}`},node('h1',{class:'sr-only'},title),actions || null);}
function renderWelcome(container) {
  container.append(heading('从一份分镜开始','导入 Markdown，角色、地点与镜头会在这里各就各位。'));
  const drop = node('div',{class:'file-drop',onDragover:e => {e.preventDefault();drop.classList.add('dragging');},onDragleave:() => drop.classList.remove('dragging'),onDrop:e => {e.preventDefault();drop.classList.remove('dragging');if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);}},node('span',{class:'empty-icon','aria-hidden':true},'▤'),node('h2',{},'放入你的分镜提示词文件'),node('p',{class:'muted'},'支持本项目示例格式的 .md 文件；原文会完整保留。'),button('选择 Markdown 文件',() => $('#import-file').click(),'primary'),node('small',{},'也可以把文件拖到这里'));
  container.append(drop,node('div',{class:'stats'},[['角色','设定与一致性提示词'],['地点','环境、光线与参考图'],['镜头','画面、对白与视频提示词']].map(([title,description]) => node('div',{class:'panel stat'},node('h3',{},title),node('p',{class:'muted'},description)))));
}
function renderOverview(container) {
  const p = state.project;
  const duration = (p.shots || []).filter(inCurrentEpisode).reduce((sum,s) => sum + (Number(s.data?.duration)||0),0);
  const openIssues = (p.issues || []).filter(i => i.status !== 'resolved');
  container.append(heading('作品概览','让设定、参考图和每一次生成都有清楚的位置。',button('导出选用清单',() => {window.location.href=`/api/export/${encodeURIComponent(p.id)}`;},'',{disabled:!p})),node('section',{class:'hero'},node('div',{class:'eyebrow'},'PROJECT / 当前作品'),node('h2',{},p.title),node('p',{},'先整理和确认资产，再逐镜生成。每一次编辑与生成都会留下版本，满意之后再采用。'),node('div',{class:'row wrap'},badge(p.aspectRatio || '9:16'),badge(`${p.storyScenes?.length || 0} 场剧情`),badge(`目标 ${text(p.targetDuration) || '待设定'}`),badge(`${openIssues.length} 项待确认`,'warn'))));
  container.append(node('div',{class:'stats'},[['角色条目',count('character')],['地点资产',count('location')],['道具候选',count('prop')],['分镜镜头',count('shot')],['计划总时长',`${duration}″`]].map(([label,value]) => node('div',{class:'panel stat'},node('div',{class:'stat-number'},value),node('div',{class:'stat-label'},label)))));
  const issues = node('section',{class:'panel panel-pad'},node('div',{class:'row between'},node('h2',{},'原稿待确认'),node('span',{class:'pending-count'},`${openIssues.length} 项未处理`)),node('p',{class:'muted',style:'font-size:12px;margin-top:6px'},'保留原稿差异，由你判断；勾选表示已确认处理。'),node('div',{class:'issue-list'},(p.issues || []).length ? p.issues.map(issue => node('div',{class:`issue ${issue.status==='resolved'?'resolved':''}`},node('label',{class:'row',style:'align-items:flex-start'},node('input',{class:'issue-check',type:'checkbox',checked:issue.status==='resolved','aria-label':`确认处理：${issue.title}`,onChange:async e => {const result = await perform(() => api(`/api/issues/${encodeURIComponent(issue.id)}`,{method:'POST',body:{projectId:p.id,status:e.target.checked?'resolved':'open'}}));if (result) await loadState();else e.target.checked=!e.target.checked;}}),node('div',{class:'grow'},node('h3',{},issue.title),node('p',{},issue.detail),issue.entityId ? button('查看相关条目',() => {const entity=entities().find(e=>e.id===issue.entityId);if(entity){view=entity.type;resetSelection(entity.id);renderApp();}},'quiet small') : null)))) : node('div',{class:'empty'},'暂无待确认问题')));
  const right = node('div',{class:'stack'},node('section',{class:'panel panel-pad'},node('h2',{},'从设定到画面'),node('div',{class:'workflow-steps'},[['确认资产','角色、地点和道具，先有一致的设定。','character'],['交给 Codex 生图','创建文件任务，在当前 Codex 会话执行。','character'],['刷新并采用','图片按任务目录交付，刷新后选择满意版本。','jobs'],['预览后生成视频','完整检查提示词与参考映射，再直连 RunningHub。','shot']].map(([title,description,next],i)=>node('div',{class:'workflow-step'},node('span',{class:'step-num'},i+1),node('div',{class:'grow'},node('h3',{},title),node('p',{},description)),button('→',()=>changeView(next),'quiet small',{'aria-label':`前往${title}`}))))),node('section',{class:'panel panel-pad'},node('div',{class:'row between'},node('h3',{},'原文与项目设定'),button('编辑',showProjectSettings,'quiet small')),node('p',{class:'overview-source',style:'margin-top:12px'},p.source?.filename || '未记录原文件名'),node('p',{class:'overview-source'},`导入 ${date(p.source?.importedAt)}`),node('details',{},node('summary',{},'原文校验值'),node('code',{},p.source?.hash || '—')),node('hr',{class:'divider'}),node('p',{class:'muted',style:'font-size:12px;white-space:pre-wrap;max-height:160px;overflow:auto'},text(p.style) || '暂无全局风格'),button('查看完整原文',showSource,'quiet small')));
  container.append(node('div',{class:'overview-grid'},issues,right));
}
function shotSheetRows() {
  const query=search.trim().toLowerCase();
  return [...(state.project?.shots||[])].sort((a,b)=>(a.order||0)-(b.order||0)).filter(shot=>
    inCurrentEpisode(shot)&&
    (shotSheetScene==='all'||(shot.data?.sceneId||'unassigned')===shotSheetScene)&&
    (!query||`${shot.code} ${shot.name} ${sceneTitleOf(shot)} ${text(shot.data)}`.toLowerCase().includes(query)));
}
function renderShotSheet(container) {
  const shots=(state.project.shots||[]).filter(inCurrentEpisode),scenes=state.project.storyScenes||[];
  if(shotSheetScene!=='all'&&!shots.some(shot=>(shot.data?.sceneId||'unassigned')===shotSheetScene))shotSheetScene='all';
  const searchInput=node('input',{type:'search',placeholder:'搜索镜号、标题、画面或对白…',value:search,'aria-label':'搜索分镜表',onInput:event=>{search=event.target.value;renderShotSheetRows($('#shot-sheet-rows'));}});
  const sceneSelect=node('select',{'aria-label':'按场次筛选分镜表',onChange:event=>{shotSheetScene=event.target.value;renderShotSheetRows($('#shot-sheet-rows'));}},
    node('option',{value:'all',selected:shotSheetScene==='all'},'全部场次'),
    scenes.filter(scene=>shots.some(shot=>shot.data?.sceneId===scene.id)).map(scene=>node('option',{value:scene.id,selected:shotSheetScene===scene.id},scene.title)),
    shots.some(shot=>!shot.data?.sceneId)?node('option',{value:'unassigned',selected:shotSheetScene==='unassigned'},'未归属场次'):null);
  const body=node('tbody',{id:'shot-sheet-rows'});
  const table=node('table',{class:'shot-sheet-table'},node('caption',{class:'shot-sheet-caption'},'分镜表 · 已保存的逐镜内容与采用素材'),
    node('thead',{},node('tr',{},['镜号 / 画面','镜头 / 场次','画面与动作','景别 / 运镜','对白','计划时长','采用素材','操作'].map(label=>node('th',{scope:'col'},label)))),body);
  container.append(node('section',{class:'shot-sheet','aria-label':'可预览分镜表'},
    node('div',{class:'shot-sheet-toolbar'},searchInput,sceneSelect,node('span',{id:'shot-sheet-count',class:'muted',role:'status','aria-live':'polite'})),
    node('p',{class:'muted shot-sheet-note'},'逐镜显示已保存的内容。预览只读取本镜已采用的图片或视频；未采用素材的镜头也会保留在表中。'),
    node('div',{class:'shot-sheet-scroll',role:'region','aria-label':'分镜表，可横向滚动',tabindex:'0'},table)));
  renderShotSheetRows(body);
}
function renderShotSheetRows(container) {
  if(!container)return;
  const items=shotSheetRows(),total=(state.project.shots||[]).filter(inCurrentEpisode).length;
  const duration=items.reduce((sum,shot)=>sum+(Number(shot.data?.duration)||0),0);
  const count=$('#shot-sheet-count');if(count)count.textContent=`${items.length} / ${total} 镜 · 计划 ${Number(duration.toFixed(1))} 秒`;
  if(!items.length){container.replaceChildren(node('tr',{},node('td',{colspan:8,class:'shot-sheet-empty'},total?'没有符合筛选的镜头，请更换搜索词或场次。':'当前范围还没有镜头，请先导入分镜。')));return;}
  container.replaceChildren(...items.map(shot=>{
    const d=shot.data||{},image=adoptedMedia(shot,'image'),video=adoptedMedia(shot,'video');
    const open=()=>showShotSheetPreview(shot.id);
    const assets=[...(d.characterIds||[]),...(d.locationIds||[]),...(d.propIds||[])].map(id=>state.project.assets.find(asset=>asset.id===id)?.name).filter(Boolean);
    return node('tr',{'data-shot-id':shot.id},
      node('td',{},node('strong',{},shot.code||'—'),button(image?node('img',{src:mediaUrl(image),alt:`${shot.code} 已采用分镜图`,loading:'lazy'}):video?'▶ 视频':'暂无采用画面',open,'shot-sheet-thumb',{disabled:!image&&!video,'aria-label':`预览镜头 ${shot.code}`})),
      node('td',{},node('strong',{},shot.name||'未命名镜头'),node('small',{},sceneTitleOf(shot)),assets.length?node('small',{},assets.join(' / ')):null,drafts.has(shot.id)?badge('有未保存草稿','warn'):null),
      node('td',{},d.composition&&d.composition!==d.action?node('p',{},d.composition):null,node('p',{},d.action||d.composition||'—')),
      node('td',{},node('p',{},d.shotSize||'—'),node('small',{},d.camera||'运镜待定')),
      node('td',{},node('p',{},d.dialogue||'—')),
      node('td',{class:'shot-sheet-duration'},Number(d.duration)>0?`${Number(d.duration)} 秒`:'未设定'),
      node('td',{},image?badge('已采用图片','good'):null,video?badge('已采用视频','good'):null,!image&&!video?node('small',{},'尚未采用图片或视频'):null),
      node('td',{},node('div',{class:'stack'},button('预览',open,'small',{disabled:!image&&!video,'aria-label':`打开镜头 ${shot.code} 预览`}),button('编辑镜头',()=>openShotEditor(shot),'quiet small',{'aria-label':`编辑镜头 ${shot.code}`}))));
  }));
}
function showShotSheetPreview(shotId,kind='video') {
  const items=shotSheetRows(),index=items.findIndex(shot=>shot.id===shotId),shot=items[index];
  if(!shot)return;
  $('#shot-sheet-player',modal)?.pause?.();
  const image=adoptedMedia(shot,'image'),video=adoptedMedia(shot,'video'),media=kind==='image'?(image||video):(video||image);
  const mediaView=media?node(media.kind==='video'?'video':'img',{
    id:'shot-sheet-player',src:mediaUrl(media),...(media.kind==='video'?{controls:true,playsinline:true,preload:'metadata','aria-label':`${shot.code} 已采用视频`}:{alt:`${shot.code} ${shot.name} 已采用分镜图`})
  }):node('div',{class:'empty'},'本镜尚未采用图片或视频。可回到编辑器查看候选素材。');
  const edit=()=>{ $('#shot-sheet-player',modal)?.pause?.();modal.close();openShotEditor(shot); };
  openModal(`${shot.code} · ${shot.name}`,node('div',{class:'shot-sheet-preview'},
    node('div',{class:'row between wrap'},node('span',{class:'muted'},`${index+1} / ${items.length} 镜 · ${sceneTitleOf(shot)}`),
      node('div',{class:'view-switch',role:'group','aria-label':'本镜预览素材'},
        button('采用图片',()=>showShotSheetPreview(shot.id,'image'),'',{disabled:!image,'aria-pressed':media?.kind==='image'}),
        button('采用视频',()=>showShotSheetPreview(shot.id,'video'),'',{disabled:!video,'aria-pressed':media?.kind==='video'}))),
    node('div',{class:'shot-sheet-media'},mediaView),
    node('div',{class:'shot-sheet-preview-copy'},node('strong',{},`${shot.data?.shotSize||'景别未设定'} · 计划 ${Number(shot.data?.duration)||'—'} 秒`),
      shot.data?.composition&&shot.data.composition!==shot.data.action?node('p',{},shot.data.composition):null,node('p',{},shot.data?.action||shot.data?.composition||'暂无动作描述'),shot.data?.camera?node('p',{},`运镜：${shot.data.camera}`):null,shot.data?.dialogue?node('p',{},`对白：${shot.data.dialogue}`):null),
    node('div',{class:'row wrap'},button('← 上一镜',()=>showShotSheetPreview(items[index-1]?.id),'small',{disabled:index===0}),button('下一镜 →',()=>showShotSheetPreview(items[index+1]?.id),'small',{disabled:index===items.length-1}),node('span',{class:'grow'}),button('编辑本镜',edit,'primary'))));
}
function renderWorkspace(container) {
  container.append(heading(labels[view],'',view==='shot'?shotViewSwitch():null));
  // 队列面板放在镜头工作台顶部：三种视图都能看到进度，不用来回切页。
  const autoRun=view==='shot'?latestAutoRun():null;
  if(autoRun)container.append(autoRunPanel(autoRun));
  if (view==='shot'&&shotView==='table') {renderShotSheet(container);return;}
  if (view==='shot'&&shotView==='preview') {const area=node('section',{class:'preview-workspace','aria-label':'粗剪预览'});container.append(area);renderPreview(area);return;}
  const list = node('section',{class:'workspace-list','aria-label':`${typeNames[view]}列表`});
  const boardsMode=view==='shot'&&shotView==='boards';
  const searchInput = node('input',{type:'search',placeholder:boardsMode?'搜索组名、镜头标题、画面或对白…':view==='shot'?'搜索镜号、标题、画面…':'搜索名称、编号、设定…',value:search,'aria-label':'搜索条目',onInput:e=>{search=e.target.value;renderEntityList($('#entity-list'));}});
  list.append(node('div',{class:'searchbar'},searchInput));
  list.append(node('div',{id:'entity-list'}));
  const detail = node('section',{class:'panel editor',id:'editor','aria-label':'条目详情'});
  container.append(node('div',{class:'workspace'},list,detail));
  renderEntityList($('#entity-list'));renderEditor(detail);
}
function renderEntityList(container) {
  if (!container) return;
  const query=search.trim().toLowerCase();
  const listType=view==='shot'&&shotView==='boards'?'storyboard':view;
  const matched=entities().filter(e=>e.type===listType&&(!query||`${e.name} ${e.code} ${text(e.data)} ${e.type==='storyboard'?storyboardShots(state.project,e).map(shot=>`${shot.code} ${shot.name} ${text(shot.data)}`).join(' '):''}`.toLowerCase().includes(query))).sort((a,b)=>(a.order||0)-(b.order||0));
  const items=['shot','storyboard'].includes(listType)?matched.filter(inCurrentEpisode):matched;
  if(listType==='storyboard'){
    const filtered=query||currentEpisode!=='all';
    container.replaceChildren(items.length?node('div',{class:'stack'},items.map(board=>node('button',{type:'button',class:'storyboard-list-item','aria-pressed':board.id===selectedId,onClick:()=>{resetSelection(board.id);renderEntityList(container);renderEditor($('#editor'));}},
      node('small',{},`${board.code} · ${board.name}`),node('strong',{class:'storyboard-summary'},storyboardShots(state.project,board).map(shot=>node('span',{},`${shot.code} · ${storyboardSummary(state.project,{data:{shotIds:[shot.id]}})}`))),node('small',{},`${storyboardDuration(state.project,board)} 秒 · ${board.media.length} 个素材`))))
      :node('div',{class:'empty panel'},filtered?`没有符合筛选的故事板（共 ${matched.length} 组，当前筛选 ${[query?`「${query}」`:'',currentEpisode!=='all'?episodeLabel(currentEpisode):''].filter(Boolean).join(' · ')}）。`:'还没有故事板。点击上方“创建故事板”。'));
    return;
  }
  if (!items.length) {container.replaceChildren(node('div',{class:'empty panel'},node('span',{class:'empty-icon'},'◇'),query?'没有符合搜索的条目':view==='shot'?'当前范围还没有镜头，请先导入分镜。':'尚无此类资产'));return;}
  const select=e=>{resetSelection(e.id);renderEntityList(container);renderEditor($('#editor'));if(window.matchMedia('(max-width: 820px)').matches)$('#editor').scrollIntoView({block:'start',behavior:'auto'});};
  if(view!=='shot') {container.replaceChildren(node('div',{class:'asset-grid'},items.map(e=>{const media=displayMedia(e);return node('button',{class:'asset-card',type:'button','aria-pressed':e.id===selectedId,onClick:()=>select(e)},node('div',{class:'asset-visual'},media?node('img',{src:mediaUrl(media),alt:e.name,loading:'lazy'}):node('div',{},node('div',{class:'asset-monogram'},e.code || e.name.slice(0,2)),node('div',{class:'asset-empty-label'},'等待第一张参考图')),node('span',{class:'asset-status'},media?(isAdopted(e,media)?'已采用':'候选图'):(e.type==='prop'&&!e.data?.confirmed?'待确认':'暂无图片'))),node('div',{class:'asset-card-body'},node('div',{class:'asset-card-name'},e.name),node('div',{class:'asset-card-description'},text(e.data?.description)||text(e.data?.visualPrompt)||'点击补充设定'),row(badge(`${e.versions?.length || 1} 版设定`),badge(`${e.media?.length || 0} 个素材`))));})));}
  else {
    const groups=new Map();
    for(const e of items){const key=e.data?.sceneId||'unassigned';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
    const groupsNode=node('div',{class:'shot-groups'});
    for(const [sceneId,shots] of groups){const scene=(state.project.storyScenes||[]).find(s=>s.id===sceneId);groupsNode.append(node('section',{},node('div',{class:'scene-heading'},node('strong',{},scene?.title||'未归属场次'),node('span',{class:'line'}),node('small',{},`${shots.length} 镜`)),shots.map(e=>{const media=displayMedia(e);const refs=[...(e.data?.characterIds||[]),...(e.data?.locationIds||[])].map(id=>entities().find(a=>a.id===id)?.name).filter(Boolean);return node('button',{class:'shot-row',type:'button','aria-pressed':e.id===selectedId,onClick:()=>select(e)},node('span',{class:'shot-thumb'},media?node('img',{src:mediaUrl(media),alt:'',loading:'lazy'}):e.code),node('span',{class:'grow'},node('span',{class:'shot-name'},`${e.code} · ${e.name}`),node('span',{class:'shot-meta',style:'display:block'},`${e.data?.shotSize||'景别待定'} · ${refs.join(' / ')||'关联待确认'}`),node('span',{class:'shot-meta',style:'display:block'},`${(e.media||[]).filter(m=>m.kind==='image').length} 张图 · ${(e.media||[]).filter(m=>m.kind==='video').length} 段视频`)),node('span',{class:'shot-duration'},Number(e.data?.duration)||'—',node('small',{},' 秒')));})));}
    container.replaceChildren(groupsNode);
  }
}
/* —— 粗剪预览：按镜头顺序连续播放「已采用素材」的镜头 ——
   时长口径：采用视频用视频自身时长，采用静帧用本镜计划剪辑时长；两者都没有则退化为 3 秒。
   播放状态只有一个权威值 previewRemainingMs（本段剩余毫秒），-1 表示按整段重算，避免边界处出现双真相。 */
function sceneTitleOf(entity) {return (state.project?.storyScenes||[]).find(s=>s.id===entity.data?.sceneId)?.title||'未归属场次';}
function adoptedMedia(entity,kind) {return (entity.media||[]).find(media=>media.id===adoptedId(entity,kind))||null;}
function previewEntries() {
  return previewSequence(state.project,previewScope).map(entry=>({...entry,scene:entry.shot.type==='storyboard'?'故事板 · '+entry.shot.name:sceneTitleOf(entry.shot)}));
}
/* —— 集数筛选：保存的归属优先，旧服务未返回归属时兼容文本标题。 —— */
function cjkNumber(raw) {
  const digits={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  if(/^\d+$/.test(raw)) return Number(raw);
  if(raw==='十') return 10;
  if(raw.length===1) return digits[raw]||0;
  if(raw[0]==='十') return 10+(digits[raw[1]]||0);
  if(raw[1]==='十') return (digits[raw[0]]||0)*10+(digits[raw[2]]||0);
  return digits[raw[0]]||0;
}
function episodeNumber(entity) {
  if(!entity) return 1;
  if(entity.type==='shot'&&Number.isSafeInteger(entity.data?.episodeNumber))return entity.data.episodeNumber;
  if(entity.type==='storyboard'){
    const first=storyboardShots(state.project,entity)[0];
    if(Number.isSafeInteger(first?.data?.episodeNumber))return first.data.episodeNumber;
  }
  const parts=[entity.name,entity.code];
  if(entity.type==='shot') parts.unshift(sceneTitleOf(entity));
  else if(entity.type==='storyboard'){const first=storyboardShots(state.project,entity)[0];if(first)parts.unshift(sceneTitleOf(first));}
  const match=/第\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*集/.exec(parts.filter(Boolean).join(' '));
  return match?(cjkNumber(match[1])||1):1;
}
function episodeLabel(number) {return state.project?.episodeNames?.[number] || `第${number}集`;}
function inCurrentEpisode(entity) {return currentEpisode==='all'||episodeNumber(entity)===currentEpisode;}
function episodePicker(label) {
  return node('select',{class:'episode-picker','aria-label':label,onChange:event=>changeEpisode(event.target.value)},
    node('option',{value:'all',selected:currentEpisode==='all'},'全部集数'),
    (state.project?.episodes||[1]).map(number=>node('option',{value:String(number),selected:currentEpisode===number},episodeLabel(number))));
}
function changeEpisode(value) {
  if(dirty&&selected()?.type==='storyboard'){notify('请先保存或撤销故事板的修改，再切换集数。',true);renderApp();return;}
  stopPreviewPlayback();resetSelection(null);
  currentEpisode=value==='all'?'all':Number(value);
  shotSheetScene='all';previewIndex=0;previewRemainingMs=-1;previewStripScroll=0;
  renderApp();
}
function showAddEpisode() {
  if(dirty&&selected()?.type==='storyboard'){notify('请先保存或撤销故事板的修改，再新增集数。',true);return;}
  const next=Math.max(...(state.project.episodes||[1]))+1;
  const number=node('input',{type:'number',min:'1',step:'1',required:true,value:String(next),'aria-label':'新增集数编号'});
  const name=node('input',{type:'text',maxlength:'80',placeholder:'例如：第1集自分镜版','aria-label':'新增集数名称'});
  openModal('新增集数',node('form',{class:'stack',onSubmit:async event=>{
    event.preventDefault();
    const value=Number(number.value);
    const result=await perform(()=>api(`/api/projects/${encodeURIComponent(state.project.id)}/episodes`,{method:'POST',body:{number:value,name:name.value.trim()}}),'集数已新增');
    if(result){modal.close();await loadState(false);changeEpisode(String(value));}
  }},node('label',{class:'field'},'第几集',number),node('label',{class:'field'},'集数名称（可选）',name),node('p',{class:'muted'},'新集从空镜头列表开始，角色、地点和道具沿用当前作品。'),node('button',{type:'submit',class:'primary'},'新增集数')));
}
// 集数 + 搜索词筛过的粗剪序列；previewIndex 是这个列表的下标，所以播放/换段都必须用它而不是 previewEntries()。
function previewItems() {
  const query=previewQuery.trim().toLowerCase();
  return previewEntries().filter(entry=>{
    if(!inCurrentEpisode(entry.shot))return false;
    if(!query)return true;
    const haystacks=[entry.shot.code,entry.shot.name,entry.scene,episodeLabel(episodeNumber(entry.shot))];
    return haystacks.filter(Boolean).join(' ').toLowerCase().includes(query);
  });
}
function previewHoldMs(entry) {
  const known=Number(entry?.media?.metadata?.duration);
  if(entry?.kind==='video'&&known>0)return Math.max(600,Math.round(known*1000));
  if(entry?.plan>0)return Math.max(600,Math.round(entry.plan*1000));
  return 3000;
}
function previewHold() {const stage=$('#preview-stage');return (stage&&Number(stage.dataset.hold))||previewHoldMs(previewItems()[previewIndex])||3000;}
function previewSeconds(ms) {return (ms/1000).toFixed(1)+'″';}
// 每一段按自己的媒体定比例：采用视频按视频尺寸，采用四宫格/静帧按图片尺寸，取不到才退回作品比例。
function previewRatio(entry) {return mediaRatio(entry?.media, state.project?.aspectRatio);}
function previewRatioValue(entry) {return ratioValue(previewRatio(entry));}
function shotViewSwitch() {
  const boards=(state.project?.storyboards||[]).filter(inCurrentEpisode).length;
  return node('div',{class:'row wrap',style:'gap:10px'},episodePicker('镜头工作台集数'),node('div',{class:'view-switch',role:'group','aria-label':'镜头工作台视图'},
    [['list','▤ 镜头列表'],['table','▦ 分镜表'],['boards','◫ 故事板'],['preview','▶ 粗剪预览']].map(([key,label])=>button(label,()=>setShotView(key),'',{'aria-pressed':shotView===key,id:'shot-view-'+key}))),
    shotView==='boards'?button('＋ 创建故事板',()=>showCreateStoryboard(),'small'):null,
    shotView==='boards'?button('⇥ 从这一镜自动成组',()=>showAutoGroups(),'small',{id:'auto-groups'}):null,
    button('▶ 顺序自动生成视频',()=>showAutoRun(),'small',{id:'auto-run'}),
    badge(`${count('shot')} 个镜头${boards?' · '+boards+' 个故事板':''}`));
}
function setShotView(next) {
  if(shotView===next)return;
  stopPreviewPlayback();shotView=next;previewPlaying=false;
  if((next==='boards'&&selected()?.type!=='storyboard')||(next==='list'&&selected()?.type==='storyboard'))resetSelection(null);
  if(next==='preview'){const items=previewItems();const at=items.findIndex(item=>item.shot.id===selectedId);previewIndex=at>=0?at:Math.min(Math.max(previewIndex,0),Math.max(0,items.length-1));previewRemainingMs=-1;previewStripScroll=0;}
  renderApp();
}
function openShotEditor(shot) {stopPreviewPlayback();view='shot';shotView=shot.type==='storyboard'?'boards':'list';resetSelection(shot.id);renderApp();}
function previewStage(entry,hold) {
  // 故事板的标题行已经写了组名，说明行不再重复，窄舞台（竖幅）下才放得下。
  const sceneLabel=entry.shot.type==='storyboard'?'故事板':entry.scene.split('：')[0];
  // 元数据里没记尺寸的旧素材，等元素自己报出真实尺寸后再校正一次舞台比例，避免出现黑边。
  const fitRatio = element => {
    const width = Number(element.naturalWidth || element.videoWidth), height = Number(element.naturalHeight || element.videoHeight);
    const stage = $('#preview-stage');
    if (!stage || !(width > 0) || !(height > 0)) return;
    stage.style.setProperty('--stage-ratio', `${width} / ${height}`);
    stage.style.setProperty('--stage-ar', (width / height).toFixed(4));
  };
  // 视频段由下面的 mountPreviewPlayer 挂 Plyr 控件；静帧段没有播放器，进度条由粗剪自己画。
  const media=entry.kind==='video'
    ? node('video',{src:mediaUrl(entry.media),playsinline:true,preload:'auto',muted:previewMuted,onLoadedMetadata:event=>fitRatio(event.target),onEnded:()=>{if(previewPlaying)advancePreview();},'aria-label':`正在预览 ${entry.shot.code} ${entry.shot.name}`})
    : node('img',{src:mediaUrl(entry.media),alt:`${entry.shot.code} ${entry.shot.name}`,onLoad:event=>fitRatio(event.target)});
  return node('div',{class:'preview-stage',id:'preview-stage',tabindex:'0',style:`--stage-ratio:${previewRatio(entry)};--stage-ar:${previewRatioValue(entry).toFixed(4)}`,'data-hold':String(hold),'data-kind':entry.kind,
    role:'group','aria-label':`粗剪预览播放区，当前 ${entry.shot.code} ${entry.shot.name}`,onKeydown:previewKeys},
    media,
    node('div',{class:'preview-overlay'},node('div',{class:'preview-caption'},node('strong',{},`${entry.shot.code} · ${entry.shot.name}`),node('small',{},`${sceneLabel} · ${entry.kind==='video'?'采用视频':'采用静帧'} · 计划 ${entry.plan>0?entry.plan+'″':'未设定'}`)),
      node('div',{class:'row wrap',style:'gap:6px'},badge(`${previewIndex+1} / ${previewItems().length}`,'good'),node('span',{class:'badge good',id:'preview-state-badge'},previewPlaying?'播放中':'已暂停'))),
    // 进度条放在画面内部，保证它与画面同宽（外部再放一条会跟居中的画面对不齐）。视频段改用播放器自己的进度条，这条不显示。
    node('div',{class:'preview-progress','aria-hidden':true},node('div',{class:'preview-progress-fill',id:'preview-progress-fill'})));
}
function previewStrip(items) {
  const strip=node('div',{class:'preview-strip',onScroll:event=>{previewStripScroll=event.target.scrollTop;}});
  let lastScene=null;
  // 序列只列条目本身（序号 / 镜号 / 时长与类型），不放缩略图：一列图片太重，也会把列表撑得很长。
  items.forEach((item,index)=>{
    if(item.scene!==lastScene){lastScene=item.scene;strip.append(node('div',{class:'strip-scene',title:item.scene},item.scene.split('：')[0]));}
    strip.append(node('button',{type:'button',class:'strip-item','aria-current':index===previewIndex?'true':null,onClick:()=>jumpPreview(index)},
      node('span',{class:'strip-index'},String(index+1).padStart(2,'0')),
      node('span',{class:'strip-meta'},node('strong',{},item.shot.code),node('small',{},`${previewSeconds(previewHoldMs(item))} · ${item.kind==='video'?'视频':'静帧'}`))));
  });
  return strip;
}
// 序列上方的搜索与集数筛选。输入框每次重画都会重建，所以 reapplyPreviewFilter 要负责把焦点和光标放回去。
function previewFilterBar() {
  const search=node('input',{type:'search',class:'preview-search','data-preview-search':'1',placeholder:'搜索镜号、标题…',value:previewQuery,'aria-label':'搜索粗剪序列',onInput:event=>{previewQuery=event.target.value;reapplyPreviewFilter();}});
  return node('div',{class:'preview-filter'},search,episodePicker('粗剪序列集数'));
}
function renderPreview(container) {
  // 整块 DOM 每次都会换掉，焦点会跟着旧舞台一起消失（按一次方向键后就没反应了）；先记下来，画完再还回去。
  const stageHadFocus=document.activeElement?.id==='preview-stage';
  destroyPreviewPlayer();
  const boardsOnly=previewScope==='storyboards',unit=boardsOnly?'组':'镜';
  const scopeSwitch=node('div',{class:'view-switch',style:'grid-column:1 / -1;justify-self:start',role:'group','aria-label':'粗剪预览范围'},
    [['all','镜头与故事板'],['storyboards','故事板']].map(([scope,label])=>button(label,()=>{
      if(previewScope===scope)return;
      stopPreviewPlayback();previewScope=scope;
      previewIndex=0;rerenderPreview(false);
    },'',{'aria-pressed':previewScope===scope})));
  const items=previewItems();
  if(!items.length){
    const filtering=[currentEpisode!=='all'?episodeLabel(currentEpisode):'',previewQuery.trim()?`「${previewQuery.trim()}」`:''].filter(Boolean).join(' · ');
    const hidden=previewEntries().length>0;
    // 没有可粗剪的素材：只有范围切换 + 一句引导。
    if(!hidden){
      container.replaceChildren(scopeSwitch,node('div',{class:'empty panel'},node('span',{class:'empty-icon'},'▶'),
        node('h3',{},boardsOnly?'还没有可以粗剪的故事板':'还没有可以粗剪的镜头'),
        node('p',{},boardsOnly?'先在故事板的「媒体」里采用一版四宫格或视频，再回到这里。':'粗剪预览只收录已有采用素材的镜头。先在镜头的「媒体」里采用一版图片或视频，再回到这里。'),
        button(boardsOnly?'返回故事板':'返回镜头列表',()=>setShotView(boardsOnly?'boards':'list'),'primary')));
      return;
    }
    // 有素材、但被筛掉了：筛选条要留着，否则搜索框一消失就没法删字，只能点清除。
    container.replaceChildren(scopeSwitch,node('div',{class:'preview-shell'},
      node('div',{class:'preview-main'},node('div',{class:'empty panel'},node('span',{class:'empty-icon'},'▣'),
        node('h3',{},`没有符合筛选的${boardsOnly?'故事板':'镜头'}`),node('p',{},`当前筛选：${filtering}`),
        button('清除筛选',()=>{previewQuery='';changeEpisode('all');},'primary'))),
      node('aside',{class:'preview-side'},node('div',{class:'preview-side-top'},
        node('div',{class:'preview-side-head'},node('strong',{},'粗剪序列'),node('small',{id:'preview-strip-count'},`0 / ${previewEntries().length} ${boardsOnly?'组':'镜'}`)),
        previewFilterBar()))));
    return;
  }
  if(previewIndex<0||previewIndex>=items.length)previewIndex=0;
  const entry=items[previewIndex],hold=previewHoldMs(entry);
  if(previewRemainingMs<0||previewRemainingMs>hold)previewRemainingMs=hold;
  const total=items.reduce((sum,item)=>sum+previewHoldMs(item),0);
  const all=previewEntries();
  const countText=(items.length===all.length?`${items.length} ${boardsOnly?'个故事板':'个镜头'}`:`${items.length} / ${all.length} ${boardsOnly?'组':'镜'}`)+` · 合计 ${previewSeconds(total)}`;
  const main=node('div',{class:'preview-main'},
    node('div',{class:'preview-head'},node('div',{class:'grow'},node('h3',{},boardsOnly?'故事板粗剪预览':'粗剪预览'),node('p',{},boardsOnly?'按组内起始镜头顺序连续播放，优先采用视频；没有视频时展示采用四宫格，驻留时长取组内计划合计。空格播放/暂停，左右方向键换组。':'只收录已有采用素材的镜头，按镜头顺序连续播放。视频用自身时长，静帧按计划剪辑时长驻留；空格播放/暂停，左右方向键换镜。'))),
    previewStage(entry,hold),
    node('div',{class:'preview-controls'},
      button('⏮ 上一'+unit,()=>stepPreview(-1),'small',{id:'preview-prev'}),
      button('▶ 播放',()=>setPreviewPlaying(!previewPlaying),'primary',{id:'preview-toggle'}),
      button('⏭ 下一'+unit,()=>stepPreview(1),'small',{id:'preview-next'}),
      button('↺ 从头播放',()=>restartPreview(),'small',{id:'preview-restart'}),
      button('静音',togglePreviewMute,'quiet small',{id:'preview-mute'}),
      node('span',{class:'preview-time',id:'preview-time',role:'status','aria-live':'off'},'0.0″ / '+previewSeconds(hold)),
      node('span',{class:'grow'}),
      button('在编辑器中打开',()=>openShotEditor(entry.shot),'small',{id:'preview-open'})));
  const side=node('aside',{class:'preview-side'},
    node('div',{class:'preview-side-top'},
      node('div',{class:'preview-side-head'},node('strong',{},'粗剪序列'),node('small',{id:'preview-strip-count'},countText)),
      previewFilterBar()),
    previewStrip(items));
  container.replaceChildren(scopeSwitch,node('div',{class:'preview-shell'},main,side));
  // 整块 DOM 被换掉了，序列的滚动位置要按上次的还原；否则点一下序列就弹回顶部。
  const strip=$('.preview-strip');
  if(strip)strip.scrollTop=previewStripScroll;
  mountPreviewPlayer();
  if(stageHadFocus)$('#preview-stage')?.focus({preventScroll:true});
  const video=$('#preview-stage video');if(video)video.muted=previewMuted;
  updatePreviewProgress(previewRemainingMs,hold);syncPreviewControls();
  if(previewPlaying){
    previewRunRemainingMs=previewRemainingFromVideo()??previewRemainingMs;previewSlotStart=performance.now();previewRemainingMs=previewRunRemainingMs;
    if(video){const offset=(hold-previewRemainingMs)/1000;try{if(offset>0.05)video.currentTime=offset;}catch{}video.play().catch(()=>{});}
    if(previewRaf)cancelAnimationFrame(previewRaf);
    previewRaf=requestAnimationFrame(previewTick);
  }
}
// 视频段用 Plyr 提供控件；图标指向本地 sprite，播放器本身不上网。
const previewPlayerOptions = {
  controls:['play-large','play','progress','current-time','duration','mute','volume','pip','fullscreen'],
  iconUrl:'/vendor/plyr/plyr.svg',
  clickToPlay:true,hideControls:true,resetOnEnd:false,
  // 空格与方向键统一由粗剪预览处理（.preview-stage 的 keydown），不让播放器再抢一套键位。
  keyboard:{focused:false,global:false},
  storage:{enabled:false},
  i18n:{play:'播放',pause:'暂停',mute:'静音',unmute:'取消静音',enterFullscreen:'全屏',exitFullscreen:'退出全屏',pip:'画中画',restart:'重播',currentTime:'当前时间',duration:'总时长',volume:'音量',settings:'设置'},
};
function destroyPreviewPlayer() {
  const player=previewPlayer;previewPlayer=null;
  if(!player)return;
  try{player.off('play','pause','timeupdate','seeking','seeked','volumechange');player.destroy();}catch{}
}
function previewRemainingFromVideo() {
  const video=$('#preview-stage video');
  const total=Number(video?.duration);
  if(!video||!Number.isFinite(total)||total<=0)return null;
  return Math.max(0,(total-Number(video.currentTime||0))*1000);
}
function mountPreviewPlayer() {
  const video=$('#preview-stage video');
  if(!video)return;
  if(typeof window.Plyr!=='function'){notify('播放器脚本没加载到，本段先用浏览器的基本播放。',true);return;}
  try{previewPlayer=new window.Plyr(video,previewPlayerOptions);}catch{previewPlayer=null;notify('播放器初始化失败，本段先用浏览器的基本播放。',true);return;}
  previewPlayer.muted=previewMuted;
  // 播放器上的操作要回流到粗剪：用户在这里暂停、拖动进度，序列状态与进度必须跟着变。
  previewPlayer.on('play',()=>{
    if(previewPlaying)return;
    previewPlaying=true;previewRunRemainingMs=previewRemainingFromVideo()??previewHold();previewRemainingMs=previewRunRemainingMs;previewSlotStart=performance.now();
    if(previewRaf)cancelAnimationFrame(previewRaf);
    previewRaf=requestAnimationFrame(previewTick);syncPreviewControls();
  });
  previewPlayer.on('pause',()=>{
    const video=$('#preview-stage video');
    // 播到末尾时浏览器会先派 pause 再派 ended；这一下不算用户暂停，否则序列会在换段前停住。
    if(!video)return;
    if(video.ended||(Number(video.duration)>0&&video.currentTime>=video.duration-0.05))return;
    if(!previewPlaying)return;
    previewRemainingMs=previewRemainingFromVideo()??Math.max(0,previewRunRemainingMs-(performance.now()-previewSlotStart));
    previewPlaying=false;
    if(previewRaf){cancelAnimationFrame(previewRaf);previewRaf=null;}
    syncPreviewControls();
  });
  previewPlayer.on('timeupdate',syncVideoProgress);
  previewPlayer.on('seeking',syncVideoProgress);
  previewPlayer.on('seeked',syncVideoProgress);
  previewPlayer.on('volumechange',()=>{const next=!!previewPlayer?.muted;if(next!==previewMuted){previewMuted=next;syncPreviewControls();}});
}
function syncVideoProgress() {
  if(!previewPlaying)return;
  const remaining=previewRemainingFromVideo();if(remaining==null)return;
  previewRemainingMs=remaining;updatePreviewProgress(remaining,previewHold());
}
function updatePreviewProgress(remainingMs,holdMs) {
  const ratio=holdMs>0?Math.min(1,Math.max(0,(holdMs-remainingMs)/holdMs)):0;
  const fill=$('#preview-progress-fill');if(fill)fill.style.width=(ratio*100).toFixed(2)+'%';
  const label=$('#preview-time');if(label)label.textContent=previewSeconds(Math.max(0,holdMs-remainingMs))+' / '+previewSeconds(holdMs);
}
function syncPreviewControls() {
  const toggle=$('#preview-toggle');if(toggle){toggle.textContent=previewPlaying?'⏸ 暂停':'▶ 播放';toggle.setAttribute('aria-pressed',previewPlaying?'true':'false');}
  // 画面上的状态标签只在整段重绘时生成，播放/暂停要在这里补一次，否则它会一直写着「已暂停」。
  const stateBadge=$('#preview-state-badge');if(stateBadge)stateBadge.textContent=previewPlaying?'播放中':'已暂停';
  const mute=$('#preview-mute');if(mute)mute.textContent=previewMuted?'取消静音':'静音';
  const prev=$('#preview-prev');if(prev)prev.disabled=previewIndex<=0;
  const next=$('#preview-next');if(next)next.disabled=previewIndex>=previewItems().length-1;
  updatePreviewProgress(previewRemainingMs<0?previewHold():previewRemainingMs,previewHold());
}
function previewTick() {
  previewRaf=null;
  if(!previewPlaying)return;
  const hold=previewHold();
  const video=$('#preview-stage video'),fromVideo=previewRemainingFromVideo();
  const remaining=fromVideo==null?previewRunRemainingMs-(performance.now()-previewSlotStart):fromVideo;
  // 视频段等它真正播完（ended 事件）再切段；时长未知的段落仍按粗剪时钟走。
  if(remaining<=0&&!(video&&fromVideo!=null&&!video.ended)){previewRemainingMs=0;updatePreviewProgress(0,hold);advancePreview();return;}
  previewRemainingMs=Math.max(0,remaining);
  updatePreviewProgress(previewRemainingMs,hold);
  previewRaf=requestAnimationFrame(previewTick);
}
function setPreviewPlaying(next) {
  const video=$('#preview-stage video');
  if(next&&!previewPlaying){
    previewPlaying=true;
    previewRunRemainingMs=previewRemainingMs<=0?previewHold():previewRemainingMs;
    previewRemainingMs=previewRunRemainingMs;previewSlotStart=performance.now();
    if(video){const offset=(previewHold()-previewRemainingMs)/1000;try{if(offset>0.05)video.currentTime=offset;}catch{}video.muted=previewMuted;video.play().catch(()=>{});}
    if(previewRaf)cancelAnimationFrame(previewRaf);
    previewRaf=requestAnimationFrame(previewTick);
  } else if(!next&&previewPlaying){
    previewRemainingMs=previewRemainingFromVideo()??Math.max(0,previewRunRemainingMs-(performance.now()-previewSlotStart));
    previewPlaying=false;
    if(previewRaf){cancelAnimationFrame(previewRaf);previewRaf=null;}
    if(video)video.pause();
  }
  syncPreviewControls();
}
function stopPreviewPlayback() {
  // 先把状态落定再暂停：暂停会触发播放器的 pause 回流，这里不需要它再改一次状态。
  previewPlaying=false;previewRemainingMs=-1;
  if(previewRaf){cancelAnimationFrame(previewRaf);previewRaf=null;}
  const video=$('#preview-stage video');if(video&&!video.paused)video.pause();
}
function togglePreviewMute() {previewMuted=!previewMuted;if(previewPlayer)previewPlayer.muted=previewMuted;const video=$('#preview-stage video');if(video)video.muted=previewMuted;syncPreviewControls();$('#preview-stage')?.focus({preventScroll:true});}
// 重画前先把序列的滚动位置抓下来（滚动事件是异步的，不能只靠 onScroll）；换筛选时传 false 回到顶部。
function rerenderPreview(keepScroll=true) {
  const strip=$('.preview-strip');
  if(strip)previewStripScroll=keepScroll?strip.scrollTop:0;
  const area=$('.preview-workspace');if(area)renderPreview(area);
}
/* 只滚序列自己：scrollIntoView 会连文档一起滚，按一次「下一镜」整页就弹一下，所以手算位移。 */
function revealStripCurrent() {
  const strip=$('.preview-strip');if(!strip)return;
  const item=strip.querySelector('.strip-item[aria-current="true"]');if(!item)return;
  const stripBox=strip.getBoundingClientRect(),itemBox=item.getBoundingClientRect();
  if(itemBox.top<stripBox.top)strip.scrollTop-=(stripBox.top-itemBox.top);
  else if(itemBox.bottom>stripBox.bottom)strip.scrollTop+=(itemBox.bottom-stripBox.bottom);
  previewStripScroll=strip.scrollTop;
}
/* 改筛选：当前这段还在结果里就留在原位，否则回到第一段；暂停播放，避免索引换了画面还在跑。 */
function reapplyPreviewFilter() {
  const active=document.activeElement;
  const typingSearch=!!(active&&active.matches&&active.matches('[data-preview-search="1"]'));
  const caret=typingSearch?active.selectionStart:null;
  stopPreviewPlayback();
  const previous=previewEntries()[previewIndex];
  const items=previewItems();
  const at=previous?items.findIndex(item=>item.shot.id===previous.shot.id):-1;
  previewIndex=at>=0?at:0;
  previewRemainingMs=-1;
  rerenderPreview(false);
  if(typingSearch){
    const input=$('[data-preview-search="1"]');
    if(input){input.focus({preventScroll:true});const position=caret??input.value.length;try{input.setSelectionRange(position,position);}catch{}}
  }
}
function advancePreview() {
  // 视频的 ended 与粗剪时钟常常在同一瞬间到点；250ms 内只推进一段，避免连跳两组。
  const now=performance.now();if(now-previewAdvanceAt<250)return;previewAdvanceAt=now;
  const items=previewItems();
  if(previewIndex>=items.length-1){previewPlaying=false;previewRemainingMs=0;const video=$('#preview-stage video');if(video)video.pause();syncPreviewControls();return;}
  previewIndex+=1;previewRemainingMs=-1;rerenderPreview();
  revealStripCurrent();
}
function stepPreview(delta) {
  const items=previewItems();if(!items.length)return;
  const next=Math.min(items.length-1,Math.max(0,previewIndex+delta));
  if(next===previewIndex)return;
  previewIndex=next;previewRemainingMs=-1;rerenderPreview();
  revealStripCurrent();
}
function jumpPreview(index) {const items=previewItems();if(index<0||index>=items.length)return;previewIndex=index;previewRemainingMs=-1;rerenderPreview();}
function restartPreview() {const items=previewItems();if(!items.length)return;previewIndex=0;previewRemainingMs=-1;previewPlaying=true;rerenderPreview();}
function previewKeys(event) {
  if(event.key===' '||event.key==='Spacebar'){event.preventDefault();setPreviewPlaying(!previewPlaying);}
  else if(event.key==='ArrowRight'){event.preventDefault();stepPreview(1);}
  else if(event.key==='ArrowLeft'){event.preventDefault();stepPreview(-1);}
}
function getDraft(entity) {if(!draft||draft.id!==entity.id)draft={id:entity.id,name:entity.name,code:entity.code||'',data:structuredClone(entity.data||{}),baseVersion:currentVersion(entity)};return draft;}
function hasStoryboardDrafts(board){return [board.id,...board.data.shotIds].some(id=>drafts.has(id));}
function showCreateStoryboard(board){
  if(dirty){notify('请先保存或撤销当前条目的修改，再调整分组。',true);return;}
  const ordered=state.project.shots.filter(inCurrentEpisode).sort((a,b)=>a.order-b.order);
  const planningProject=board?{...state.project,storyboards:state.project.storyboards.filter(item=>item.id!==board.id)}:state.project;
  const plans=ordered.map(shot=>({shot,plan:planStoryboardGroups(planningProject,{startShotId:shot.id,limit:1,episodeNumber:currentEpisode==='all'?undefined:currentEpisode})}));
  const starts=plans.filter(({shot,plan})=>plan.groups[0]?.[0]===shot.id&&!plan.blockers.length).map(({shot})=>shot);
  const first=board&&ordered.find(shot=>board.data.shotIds.includes(shot.id));
  if(first&&!starts.some(shot=>shot.id===first.id))starts.unshift(first);
  if(!starts.length){notify('没有可成组的连续镜头；单镜超过3个说话角色时请先拆分。',true);return;}
  const start=node('select',{'aria-label':'故事板起始镜头'},starts.map(shot=>node('option',{value:shot.id,selected:shot.id===first?.id},`${shot.code} · ${shot.name}`)));
  const name=node('input',{value:board?.name||'',placeholder:'留空则使用组内镜头标题','aria-label':'故事板名称'});
  const members=node('div',{class:'note'});
  const chosen=()=>board?.data.shotIds.length>4&&start.value===first?.id?board.data.shotIds.map(id=>ordered.find(shot=>shot.id===id)):plans.find(item=>item.shot.id===start.value).plan.groups[0].map(id=>ordered.find(shot=>shot.id===id));
  const show=()=>members.replaceChildren(node('strong',{},`${chosen().length>4?'六格顺序：左上 → 中上 → 右上 → 左下 → 中下 → 右下':'四格顺序：左上 → 右上 → 左下 → 右下'}；本组 ${chosen().length} 镜，余格留白`),...chosen().map(shot=>node('p',{},`${shot.code} · ${shot.name} · ${shot.data.duration} 秒`)));
  start.addEventListener('change',show);show();
  openModal(board?'调整故事板成员':'创建故事板',node('form',{class:'stack',onSubmit:async event=>{
    event.preventDefault();
    const shotIds=chosen().map(shot=>shot.id);
    const groupName=name.value.trim()||storyboardSummary(state.project,{data:{shotIds}});
    const result=await perform(()=>board?api(`/api/entities/${encodeURIComponent(board.id)}`,{method:'PATCH',body:{projectId:state.project.id,baseVersion:board.currentVersion,name:groupName,data:{shotIds}}}):api('/api/storyboards',{method:'POST',body:{projectId:state.project.id,name:groupName,shotIds}}),board?'成员已调整，历史素材保留。':'故事板已创建；剧情仍保存在原镜头中。');
    if(result){modal.close();await loadState(false);view='shot';shotView='boards';resetSelection(result.entity.id);editorTab='edit';renderApp();}
  }},node('p',{},'选择起始镜头，每组最多4个连续镜头、3个不同说话角色；第四个说话角色所在镜头留给下一组，未用格子留白。不自动调整其他已有组。'),node('label',{class:'field'},'名称',name),node('label',{class:'field'},'起始镜头',start),members,node('button',{type:'submit',class:'primary'},board?'保存成员调整':'创建故事板')));
}
/* —— 自动成组 + 顺序自动生成视频 ——
   成组计划与后端共用 planStoryboardGroups，两边算出的组一致；
   队列跑在本机后端：按账号并发上限依次提交，页面只负责查看与暂停/继续/取消。 */
function concurrencyLimits(){return state.capabilities?.runninghub?.videoControls?.concurrency||{min:1,max:32,default:1};}
function videoConcurrency(){const limits=concurrencyLimits();const value=Number(state.settings?.videoConcurrency);return Number.isInteger(value)&&value>=limits.min?value:limits.default;}
function accountSummary(account){
  if(!account)return '尚未读取账号并发上限；本机默认同时只跑 1 个任务。';
  if(account.error)return `读取失败：${account.error}（可手动填写并发数）`;
  return `账号上限 ${account.concurrentLimit??'未知'} · Key 类型 ${account.apiKeyType||'未知'} · 运行中 ${account.runningCount??'—'} · 排队 ${account.queuedCount??'—'}`;
}
function latestAutoRun(projectId=state.project?.id){return (state.autoRuns||[]).filter(run=>run.projectId===projectId).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0]||null;}
function boardStartOrder(board){return Math.min(...(board.data?.shotIds||[]).map(id=>state.project.shots.find(shot=>shot.id===id)?.order??0),Number.MAX_SAFE_INTEGER);}
function orderedBoards(){return (state.project?.storyboards||[]).filter(inCurrentEpisode).sort((a,b)=>boardStartOrder(a)-boardStartOrder(b));}
function showAutoGroups(){
  if(dirty){notify('请先保存或撤销当前条目的修改，再自动成组。',true);return;}
  const ordered=state.project.shots.filter(inCurrentEpisode).sort((a,b)=>a.order-b.order);
  if(!ordered.length){notify('本集还没有镜头，请先导入分镜。',true);return;}
  const grouped=new Set((state.project.storyboards||[]).flatMap(board=>board.data.shotIds));
  const defaultStart=selected()?.type==='shot'?selected():ordered.find(shot=>!grouped.has(shot.id));
  const start=node('select',{'aria-label':'起始镜头'},ordered.map(shot=>node('option',{value:shot.id,selected:shot.id===defaultStart?.id},`${shot.code} · ${shot.name}${grouped.has(shot.id)?'（已在其他组）':''}`)));
  const prefix=node('input',{value:'',placeholder:'可选，留空则使用组内镜头标题','aria-label':'名称前缀'});
  const plan=node('div',{class:'note'});
  const planNow=()=>planStoryboardGroups(state.project,{startShotId:start.value,episodeNumber:currentEpisode==='all'?undefined:currentEpisode});
  const show=()=>{const result=planNow();plan.replaceChildren(node('strong',{},`将新建 ${result.groups.length} 个故事板`),
    ...result.groups.map((ids,index)=>node('p',{},`${index+1}. ${storyboardSummary(state.project,{data:{shotIds:ids}})}（${ids.map(id=>state.project.shots.find(shot=>shot.id===id)?.code).join(' → ')}）`)),
    ...(result.blockers||[]).map(reason=>node('p',{class:'error'},reason)),
    result.remaining?node('p',{},`还有 ${result.remaining} 个镜头未成组，请检查起始位置或超限提示。`):null);};
  start.addEventListener('change',show);show();
  openModal('从这一镜自动创建故事板',node('form',{class:'stack',onSubmit:async event=>{
    event.preventDefault();
    if(planNow().blockers.length){notify(planNow().blockers.join('\n'),true);return;}
    const result=await perform(()=>api('/api/storyboards/auto',{method:'POST',body:{projectId:state.project.id,startShotId:start.value,namePrefix:prefix.value.trim(),episodeNumber:currentEpisode==='all'?undefined:currentEpisode}}),'自动成组完成');
    if(!result)return;
    modal.close();await loadState(false);view='shot';shotView='boards';
    const first=result.boards?.[0];resetSelection(first?first.id:null);renderApp();
    notify(`已新建 ${result.created} 个故事板${result.remaining?`；剩余 ${result.remaining} 个镜头未成组`:''}。`);
  }},node('p',{},'从所选镜头往后自动成组：每组最多4镜、3个不同说话角色，遇到第四个说话角色时从该镜开始下一组。未用格子留白，片尾不重复补镜。其他已有组不会被拆散。'),
    node('label',{class:'field'},'名称前缀',prefix),node('label',{class:'field'},'起始镜头',start),plan,
    node('div',{class:'row end'},button('取消',()=>modal.close()),node('button',{type:'submit',class:'primary'},'创建故事板'))));
}
function showAutoRun(){
  if(dirty){notify('请先保存或撤销当前条目的修改，再排队生成。',true);return;}
  const rh=state.capabilities?.runninghub||{};
  if(!rh.configured){notify(rh.error?`本机 RunningHub 密钥读不出来（${rh.error}）；请在“接口与工作流设置”里重新保存一次。`:'尚未配置 RunningHub API Key：视频只由本机后端直连提交，请先在“接口与工作流设置”里保存 Key。',true);return;}
  const shots=shotView!=='boards';
  const boards=shots?state.project.shots.filter(inCurrentEpisode).sort((a,b)=>a.order-b.order):orderedBoards();
  const unit=shots?'镜头':'故事板',imageLabel=shots?'画面参考图':'四宫格';
  if(!boards.length){notify(`还没有${unit}。`,true);return;}
  const withGrid=boards.filter(board=>shots?referenceGroups(state.project,board).some(group=>group.media.some(media=>media.kind==='image'&&media.adopted)):Boolean(adoptedMedia(board,'image')));
  const gridIds=new Set(withGrid.map(board=>board.id));
  if(!withGrid.length){notify(`还没有可生成的${unit}：先生成${imageLabel}并在“媒体”页采用。`,true);return;}
  const current=selected()?.type===(shots?'shot':'storyboard')?selected():null;
  const pending=withGrid.filter(board=>!adoptedId(board,'video'));
  const scopes=[];
  if(current&&gridIds.has(current.id))scopes.push(['current',`仅当前${unit} ${current.code} · ${current.name}`]);
  if(current&&gridIds.has(current.id))scopes.push(['from',`从当前${unit}开始往后（含已生成视频的）`]);
  scopes.push(['pending',`所有已采用${imageLabel}、还没有视频的${unit}（${pending.length} 个）`]);
  scopes.push(['all',`所有已采用${imageLabel}的${unit}（${withGrid.length} 个，含已生成视频的）`]);
  const preferred=scopes.find(([value])=>value==='pending')?'pending':scopes[0][0];
  const scope=node('select',{'aria-label':'生成范围'},scopes.map(([value,label])=>node('option',{value,selected:value===preferred},label)));
  const limits=concurrencyLimits();
  const concurrency=node('input',{type:'number',min:String(limits.min),max:String(limits.max),step:'1',value:String(videoConcurrency()),'aria-label':'账号并发数'});
  const accountLine=node('small',{class:'muted'},accountSummary(state.settings?.accountConcurrency));
  const detect=button('读取账号并发数',async()=>{
    const result=await perform(()=>api('/api/settings/video-concurrency/detect',{method:'POST',body:{}}));
    if(!result)return;
    state.settings=result.settings;accountLine.textContent=accountSummary(result.settings.accountConcurrency);
    const detected=result.account?.concurrentLimit;
    if(detected&&detected>=limits.min&&detected<=limits.max)concurrency.value=String(detected);
    notify(detected?`账号并发上限 ${detected}，已填入。`:'没有读到账号并发上限，请手动填写。',!detected);
    refresh();
  },'small');
  const base=shots?defaultVideoConfig:isFrameMode()?videoProfile('reference'):videoConfig;
  const aspect=node('select',{'aria-label':'画面比例'},videoAspectOptions.map(([value,label])=>node('option',{value,selected:value===(base.aspectRatio||defaultVideoConfig.aspectRatio)},label)));
  const resolution=node('select',{'aria-label':'原生生成清晰度'},[['native','自定像素 · 保留原片'],['480p','原生 480p'],['720p','原生 720p'],['1080p','原生 1080p']].map(([value,label])=>node('option',{value,selected:value===(base.outputResolution||'native')},label)));
  const pixels=node('input',{'aria-label':'生成像素/百万',type:'number',min:'0.2',max:'2',step:'0.01',value:base.pixels??'0.4',disabled:resolution.value!=='native'});
  const syncPixels=()=>{pixels.disabled=resolution.value!=='native';if(pixels.disabled){try{pixels.value=planVideoOutput(resolution.value,aspect.value).pixels;}catch{}}};
  resolution.addEventListener('change',syncPixels);aspect.addEventListener('change',syncPixels);syncPixels();
  const instance=node('select',{'aria-label':'实例规格'},videoInstanceOptions.map(([value,label])=>node('option',{value,selected:value===(base.instanceType||defaultInstanceType)},label)));
  const durationMode=node('select',{'aria-label':'时长口径'},[['plan',shots?'各镜头计划时长（默认）':'各组有效镜头计划合计（默认）'],['fixed','统一指定']].map(([value,label])=>node('option',{value,selected:value==='plan'},label)));
  const duration=node('input',{type:'number',min:'1',max:'30',step:'1',value:String(Number(base.duration)>0?Number(base.duration):10),disabled:true,'aria-label':'统一时长'});
  durationMode.addEventListener('change',()=>{duration.disabled=durationMode.value!=='fixed';refresh();});
  const wanted=()=>{
    if(scope.value==='current')return current?[current.id]:[];
    if(scope.value==='from')return current?boards.slice(boards.findIndex(board=>board.id===current.id)).map(board=>board.id):[];
    if(scope.value==='all')return withGrid.map(board=>board.id);
    return pending.map(board=>board.id);
  };
  const targetIds=()=>wanted().filter(id=>gridIds.has(id));
  const summary=()=>{
    const chosen=wanted(), usable=targetIds().length, excluded=chosen.length-usable;
    const parallel=Math.max(1,Number(concurrency.value)||1);
    const head=usable
      ? `将按顺序提交 ${usable} 个付费视频任务（RunningHub 按实际运行计费）；始终保持 ${parallel} 个在跑，某个完成后立刻提交下一个，直到全部结束。`
      : `当前范围没有可提交的${unit}：还没有采用${imageLabel}，或已经全部生成过视频。`;
    return head+(excluded?` 另有 ${excluded} 个${unit}因还没采用${imageLabel}被跳过。`:'');
  };
  const estimate=node('div',{class:'note'});
  const refresh=()=>estimate.textContent=summary();
  scope.addEventListener('change',refresh);concurrency.addEventListener('input',refresh);refresh();
  openModal('顺序自动生成视频',node('form',{class:'stack',onSubmit:async event=>{
    event.preventDefault();
    const entityIds=targetIds();
    if(!entityIds.length){notify(`当前范围没有可提交的${unit}。`,true);return;}
    if(shots&&entityIds.some(id=>Object.keys(videoBlockEdits.get(id)||{}).length)){notify('待排队镜头有会话内提示词修改；请先将需要的内容保存到镜头设定，或点击“从当前设定组合全文”清除临时修改。',true);return;}
    if(concurrency.value!==''&&!concurrency.checkValidity()){concurrency.reportValidity();return;}
    if(durationMode.value==='fixed'&&!duration.checkValidity()){duration.reportValidity();return;}
    if(resolution.value==='native'&&!pixels.checkValidity()){pixels.reportValidity();return;}
    const result=await perform(()=>api('/api/auto-runs',{method:'POST',body:{projectId:state.project.id,entityIds,includeGenerated:scope.value!=='pending',template:{duration:durationMode.value==='fixed'?duration.value:'',aspectRatio:aspect.value,outputResolution:resolution.value,...(resolution.value==='native'?{pixels:pixels.value}:{}),instanceType:instance.value},concurrency:Number(concurrency.value)}}),'已加入顺序生成队列');
    if(!result)return;
    modal.close();await loadState(false);view='shot';renderApp();
  }},node('p',{},shots?'按镜头列表逐镜生成，每镜单独提交，默认原生 720p。使用已保存的镜头设定、已勾选的提示词区域和已采用素材；音频仅作角色音色参考，不复制样本台词或时间线。会话内提示词修改和手动素材选择请使用单镜生成。':'点一次就持续生成：每组用本组已采用的四宫格作参考图 1，优先使用已保存的最终提示词，空白时使用组合提示词。始终保持“并发上限”个任务在跑，某个下载完成后立刻补上下一个，直到这一批全部结束。'),
    node('div',{class:'note'},`队列只收录已经采用${imageLabel}的${unit}；缺少图片的条目会先跳过。出现“提交结果不明”时队列暂停等你核对，不会自动重提收费任务。时长默认${shots?'使用每镜计划':'取各组有效镜头计划合计'}，超出工作流范围会阻塞，不会静默截短。`),
    node('label',{class:'field'},'账号并发数（同时最多几个任务在跑）',node('div',{class:'row'},concurrency,detect),accountLine),
    node('label',{class:'field'},'生成范围',scope),
    node('div',{class:'video-parameter-grid'},node('label',{class:'field'},'时长口径',durationMode),node('label',{class:'field'},'统一时长（秒，仅统一指定时生效）',duration),node('label',{class:'field'},'画面比例',aspect),node('label',{class:'field'},'原生生成清晰度',resolution),node('label',{class:'field'},'生成像素/百万',pixels),node('label',{class:'field'},'实例规格',instance)),
    node('p',{class:'muted'},'清晰度会写入云端生成像素；保留返回原片，尺寸不足会报未达标，不进行本机放大。'),
    estimate,node('div',{class:'row end'},button('取消',()=>modal.close()),node('button',{type:'submit',class:'primary'},'开始顺序生成'))));
}
function autoRunAction(run,action,label){return perform(()=>api(`/api/auto-runs/${encodeURIComponent(run.id)}/${action}`,{method:'POST',body:{}}),label).then(async result=>{if(result){await loadState(false);renderApp();}});}
function autoRunPanel(run){
  const items=run.items||[];
  const tally=value=>items.filter(item=>item.status===value).length;
  const active=['preparing','submitted','generating'].reduce((sum,value)=>sum+tally(value),0);
  const running=run.status==='running';
  const statusLabel={running:'执行中',paused:'已暂停',completed:'已结束',cancelled:'已取消'}[run.status]||run.status;
  const tone=running?'warn':run.status==='completed'?(tally('failed')||tally('blocked')?'warn':'good'):'';
  const labels={pending:'待提交',preparing:'准备中',submitted:'已提交',generating:'远端生成中',ready:'已完成',failed:'失败',blocked:'阻塞',skipped:'已跳过'};
  // 工作台是一屏两栏布局，队列明细一直摊开会把右栏挤小：明细默认折叠，跑到一半时默认展开。用户手动开合过就按用户的来。
  const open=autoRunOpen ?? (running && active>0);
  const summaryLine=`并发 ${videoConcurrency()} · 在跑 ${active} · 待提交 ${tally('pending')} · 已完成 ${tally('ready')}/${items.length}`+(tally('failed')?` · 失败 ${tally('failed')}`:'')+(tally('blocked')?` · 阻塞 ${tally('blocked')}`:'');
  return node('section',{class:'panel panel-pad auto-run-panel',id:'auto-run-panel','aria-label':'顺序自动生成视频队列'},
    node('div',{class:'row between wrap'},node('div',{},node('h2',{},'顺序自动生成视频'),node('p',{class:'muted'},`${date(run.createdAt)} · ${run.id}`)),badge(`${statusLabel} · 完成 ${tally('ready')}/${items.length}`,tone)),
    node('details',{class:'auto-run-details',open,onToggle:event=>{autoRunOpen=event.target.open;}},
      node('summary',{},summaryLine),
      node('div',{class:'auto-run-summary'},badge(`并发上限 ${videoConcurrency()}`),badge(state.settings?.accountConcurrency?.concurrentLimit?`账号上限 ${state.settings.accountConcurrency.concurrentLimit}`:'账号并发未读取'),badge(`在跑 ${active}`),tally('failed')?badge(`失败 ${tally('failed')}`,'bad'):null,tally('blocked')?badge(`阻塞 ${tally('blocked')}`,'warn'):null,badge(`待提交 ${tally('pending')}`)),
      node('p',{class:'muted',style:'font-size:12px'},'队列由本机后端持续推进：始终保持“并发上限”个任务在跑，某个下载完成后立刻提交下一个，直到这一批全部结束；点“刷新状态”看最新进度（页面不自动轮询）。'),
      run.skipped?.length?node('div',{class:'note'},`有 ${run.skipped.length} 个组没有加入队列：`+run.skipped.map(item=>`${item.code}（${item.reason}）`).join('、')):null,
      run.note?node('div',{class:'note'},text(run.note)):null,
      node('div',{class:'auto-run-items'},items.map(item=>node('div',{class:'auto-run-item','data-state':item.status},
        node('span',{class:'auto-run-index'},String(item.index+1).padStart(2,'0')),
        node('div',{class:'grow'},node('strong',{},`${item.code} · ${item.name}`),
          item.blockers?.length?node('div',{},item.blockers.map(line=>node('p',{class:'auto-run-error'},line))):null,
          item.note?node('small',{},item.note):null,
          item.error?node('p',{class:'auto-run-error'},text(item.error)):null,
          item.jobId?node('small',{},'任务 ',node('code',{},item.jobId)):null),
        badge(labels[item.status]||item.status,item.status==='ready'?'good':['failed','blocked'].includes(item.status)?'bad':''))))),
    node('div',{class:'row wrap'},button('刷新状态',async()=>{await perform(async()=>{await loadState(false);renderApp();});},'small',{id:'auto-run-refresh'}),
      running?button('暂停队列',()=>autoRunAction(run,'pause','队列已暂停'),'small'):null,
      run.status==='paused'?button('继续队列',()=>autoRunAction(run,'resume','队列已继续'),'primary small'):null,
      ['running','paused'].includes(run.status)?button('取消队列',()=>autoRunAction(run,'cancel','队列已取消，未提交的组不再提交'),'small danger'):null,
      button('查看生成任务',goToJobs,'small')));
}
function renderStoryboardEdit(container,board){
  const d=getDraft(board);
  container.append(node('p',{class:'note'},'下面直接编辑本组原镜头。保存后，四宫格与视频提示词都会更新。两者使用画面、动作等结构字段；导入的视频提示词原文保留在原镜头，不重复拼入。'));
  container.append(button('调整组内镜头',()=>showCreateStoryboard(board),'small'));
  const set=(key,value)=>{d.data[key]=value;markDirty();};
  const order=node('div',{class:'stack'});
  d.data.shotIds.forEach((id,index)=>{const shot=state.project.shots.find(item=>item.id===id);order.append(node('div',{class:'row between'},node('span',{},`${['左上','右上','左下','右下'][index]} · ${shot.code} · ${shot.name}`),node('div',{class:'row'},button('↑',()=>{[d.data.shotIds[index-1],d.data.shotIds[index]]=[d.data.shotIds[index],d.data.shotIds[index-1]];markDirty();renderEditor($('#editor'));},'small',{disabled:index===0,'aria-label':'前移 '+shot.code}),button('↓',()=>{[d.data.shotIds[index+1],d.data.shotIds[index]]=[d.data.shotIds[index],d.data.shotIds[index+1]];markDirty();renderEditor($('#editor'));},'small',{disabled:index===d.data.shotIds.length-1,'aria-label':'后移 '+shot.code}))));});
  container.append(node('form',{class:'stack',onSubmit:event=>{event.preventDefault();saveEntity();}},
    field('故事板名称',d.name,value=>{d.name=value;markDirty();}),order,
    field('额外生图要求（风格与画面要求；剧情在下方修改）',d.data.imageRequirements,v=>set('imageRequirements',v),{multiline:true}),
    field('额外视频要求（运动与声音要求；剧情在下方修改）',d.data.videoRequirements,v=>set('videoRequirements',v),{multiline:true}),
    node('div',{class:'row between'},node('small',{id:'dirty-label'},dirty?'有未保存的修改':'所有修改已保存'),node('div',{class:'row'},button('撤销组设置',()=>{drafts.delete(board.id);draft=null;dirty=hasStoryboardDrafts(board);renderEditor($('#editor'));},'small'),node('button',{type:'submit',class:'primary',id:'save-entity',disabled:!drafts.has(board.id)},'保存组设置')))));
  for(const shot of storyboardShots(state.project,board)){
    const local=drafts.get(shot.id)||{id:shot.id,name:shot.name,code:shot.code,data:structuredClone(shot.data),baseVersion:shot.currentVersion};
    const save=node('button',{type:'submit',class:'primary small',disabled:!drafts.has(shot.id)},'保存这个镜头');
    const setShot=(key,value)=>{local.data[key]=value;drafts.set(shot.id,local);dirty=true;save.disabled=false;invalidatePreview();};
    const form=node('form',{class:'storyboard-shot-editor',onSubmit:async event=>{
      event.preventDefault();
      const result=await perform(()=>api(`/api/entities/${encodeURIComponent(shot.id)}`,{method:'PATCH',body:{projectId:state.project.id,baseVersion:local.baseVersion,data:local.data}}),'原镜头已保存；两种提示词已更新。');
      if(result){drafts.delete(shot.id);await loadState(false);dirty=hasStoryboardDrafts(selected());videoEditorKey=null;invalidatePreview();renderApp();}
    }},node('h3',{},`${shot.code} · ${shot.name}`));
    const fields=node('div',{class:'field-grid'});
    for(const [key,label] of [['action','画面与动作'],['shotSize','景别'],['composition','构图'],['camera','运镜'],['dialogue','对白 / 屏幕文字'],['mood','情绪'],['transition','转场']])fields.append(field(label,local.data[key],v=>setShot(key,v),{multiline:true,rows:key==='action'?4:2,full:key==='action'||key==='dialogue'}));
    fields.append(field('计划剪辑时长（秒）',local.data.duration,v=>setShot('duration',v===''?'':Number(v)),{type:'number'}));
    for(const [type,key,label] of [['character','characterIds','关联角色'],['location','locationIds','关联地点'],['prop','propIds','关联道具']])fields.append(node('fieldset',{class:'full'},node('legend',{},label),node('div',{class:'row wrap'},state.project.assets.filter(asset=>asset.type===type).map(asset=>node('label',{class:'row'},node('input',{type:'checkbox',checked:(local.data[key]||[]).includes(asset.id),onChange:event=>{const ids=new Set(local.data[key]||[]);event.target.checked?ids.add(asset.id):ids.delete(asset.id);setShot(key,[...ids]);}}),asset.name)))));
    form.append(fields,node('div',{class:'row between'},node('small',{},drafts.has(shot.id)?'此镜头有未保存修改':'编辑会同步到原镜头'),node('div',{class:'row'},button('撤销此镜修改',()=>{drafts.delete(shot.id);dirty=hasStoryboardDrafts(board);renderEditor($('#editor'));},'small'),save)));
    container.append(form);
  }
}
function renderEditor(container) {
  const entity=selected();
  if(!entity){container.replaceChildren(node('div',{class:'empty editor-placeholder'},node('span',{class:'empty-icon'},'✦'),node('h3',{},'选一个条目，开始制作'),node('p',{},'设定、图片版本与发送预览会在这里展开。')));return;}
  const tabs=[['edit',entity.type==='storyboard'?'镜头与设置':'设定编辑'],['generate',entity.type==='storyboard'?'生成四宫格':'生成图片'],...(['shot','storyboard'].includes(entity.type)?[['video','生成视频']]:[]),['media',`媒体 ${entity.media?.length||0}`],['versions',`版本 ${entity.versions?.length||1}`],...(entity.type==='storyboard'?[]:[['raw','原文片段']])];
  // 镜头 / 故事板：右上角腾出半栏只显示对白；原来右上角的版本显示下移，顶到组内镜头那一行。
  const workbench=['shot','storyboard'].includes(entity.type);
  const versionText=`版本 ${entity.versions?.length||1}`;
  const sourceText=`原文 ${entity.sourceLines?.join('–')||'—'} 行 · ${(adoptedId(entity,'image')||adoptedId(entity,'video')||adoptedId(entity,'audio'))?'已有采用素材':'尚未采用素材'}`;
  const dialogueLines=workbench?(entity.type==='storyboard'
    ?storyboardShots(state.project,entity).map(shot=>({code:shot.code||'',value:String(shot.data?.dialogue??'').trim()}))
    :[{code:'',value:String(entity.data?.dialogue??'').trim()}]).filter(line=>line.value):[];
  const dialogueText=dialogueLines.map(line=>line.code?`${line.code} ${line.value}`:line.value).join(' / ');
  const dialogueNode=node('div',{class:'editor-head-dialogue',title:dialogueText||'暂无对白','aria-label':'对白'},
    node('span',{class:'editor-head-dialogue-label'},'对白'),
    node('div',{class:'editor-head-dialogue-body'},dialogueLines.length
      ?dialogueLines.map(line=>node('p',{},line.code?node('span',{class:'editor-head-dialogue-code'},line.code):null,line.value))
      :node('p',{class:'muted'},'暂无对白')));
  const header=node('div',{class:'editor-header'},
    node('div',{class:'editor-head-top'},row(badge(typeNames[entity.type]),badge(entity.code||'无编号')),workbench?dialogueNode:node('span',{class:'grow'}),workbench?null:node('small',{},versionText)),
    node('h2',{},entity.name),
    node('div',{class:'editor-head-meta'},
      workbench?node('span',{class:'editor-version'},versionText):null,
      node('small',{class:'editor-head-source'},sourceText),
      entity.type==='storyboard'?node('div',{class:'storyboard-members','aria-label':'组内镜头'},storyboardShots(state.project,entity).map((shot,index)=>[index?node('span',{class:'member-sep'},'·'):null,node('p',{},`${shot.code} · ${storyboardSummary(state.project,{data:{shotIds:[shot.id]}})}`)])):null,
      entity.type==='shot'?node('div',{class:'row wrap editor-head-actions'},button('↑ 上移',()=>reorderShot('up'),'quiet small'),button('↓ 下移',()=>reorderShot('down'),'quiet small')):null));
  const tabsNode=node('div',{class:'editor-tabs',role:'tablist','aria-label':'条目详情'},tabs.map(([key,title])=>button(title,()=>switchEditorTab(key),'',{role:'tab','aria-selected':editorTab===key})));
  const body=node('div',{class:'editor-body',role:'tabpanel'});
  container.replaceChildren(header,tabsNode,body);
  if(editorTab==='edit')renderEditForm(body,entity);
  if(editorTab==='generate'||editorTab==='video')renderGeneration(body,entity);
  if(editorTab==='media')renderMedia(body,entity);
  if(editorTab==='versions')renderVersions(body,entity);
  if(editorTab==='raw')body.append(node('div',{class:'row between',style:'margin-bottom:10px'},node('small',{},'这是导入原文，编辑设定不会改写这里。'),button('复制',()=>copy(entity.raw),'small')),node('pre',{class:'prompt-box'},entity.raw||'该条目由分镜推断生成，未提供独立原文。'));
}
function field(label,value,onInput,{multiline=false,rows=3,type='text',full=false,id,placeholder}={}){const control=node(multiline?'textarea':'input',{value:text(value),rows:multiline?rows:null,type:multiline?null:type,id,placeholder,onInput:event=>onInput(event.target.value)});return node('label',{class:`field ${full?'full':''}`},label,control);}
function renderEditForm(container,entity) {
  if(entity.type==='storyboard'){renderStoryboardEdit(container,entity);return;}
  const d=getDraft(entity);
  const form=node('form',{onSubmit:e=>{e.preventDefault();saveEntity();}});
  const fields=node('div',{class:'field-grid'},field('名称',d.name,value=>{d.name=value;markDirty();}),field('原编号 / 代号',d.code,value=>{d.code=value;markDirty();}));
  const set=(key,value)=>{d.data[key]=value;markDirty();};
  if(entity.type==='shot'){
    fields.append(node('label',{class:'field'},'所属集数',node('select',{'aria-label':'镜头所属集数',onChange:event=>set('episodeNumber',Number(event.target.value))},(state.project.episodes||[1]).map(number=>node('option',{value:String(number),selected:number===(d.data.episodeNumber||1)},episodeLabel(number))))));
    const sceneSelect=node('select',{onChange:e=>set('sceneId',e.target.value)},node('option',{value:'',selected:!d.data.sceneId},'未归属场次'),(state.project.storyScenes||[]).map(s=>node('option',{value:s.id,selected:s.id===d.data.sceneId},s.title)));
    fields.append(node('label',{class:'field full'},'剧情场次',sceneSelect),field('景别',d.data.shotSize,v=>set('shotSize',v)),field('计划剪辑时长（秒）',d.data.duration,v=>set('duration',v===''?'':Number(v)),{type:'number'}),... [['composition','构图'],['camera','运镜'],['action','画面与动作'],['dialogue','对白 / 屏幕文字（保留原文分类）'],['mood','情绪氛围'],['transition','转场'],['videoPrompt','视频提示词全文']].map(([key,label])=>field(label,d.data[key],v=>set(key,v),{multiline:true,rows:key==='videoPrompt'?8:3,full:true})));
    for(const [kind,key,title] of [['character','characterIds','关联角色'],['location','locationIds','关联地点']]){
      const checks=node('fieldset',{class:'full'},node('legend',{},title),node('div',{class:'row wrap'},(state.project.assets||[]).filter(a=>a.type===kind).map(a=>node('label',{class:'row',style:'font-size:12px;cursor:pointer'},node('input',{type:'checkbox',checked:(d.data[key]||[]).includes(a.id),onChange:e=>{const ids=new Set(d.data[key]||[]);e.target.checked?ids.add(a.id):ids.delete(a.id);set(key,[...ids]);}}),a.name))));fields.append(checks);
    }
  } else {
    if(entity.type==='character'){
      const presets=state.voicePresets||[];const current=d.data.voicePresetId||'';
      const select=node('select',{onChange:e=>set('voicePresetId',e.target.value)},node('option',{value:'',selected:!current},'未指定音色'),presets.map(p=>node('option',{value:p.id,selected:p.id===current},`${p.name} · ${p.voiceId}`)));
      const resolved=presets.find(p=>p.id===current);
      fields.append(node('label',{class:'field full'},'音色（关联全局设定）',select,node('small',{class:'muted'},resolved?'解析为音色 ID：'+resolved.voiceId:'在“接口与工作流设置”里维护全局音色库，这里只做关联。')));
      fields.append(renderVoicePreview(()=>presets.find(p=>p.id===select.value)?.voiceId||''),node('div',{class:'row end full',style:'margin-top:-6px'},button('＋ 新增音色',()=>showAddVoice(),'quiet small')));
    }
    fields.append(field('设定描述',d.data.description,v=>set('description',v),{multiline:true,rows:5,full:true}),field('视觉提示词全文',d.data.visualPrompt,v=>set('visualPrompt',v),{multiline:true,rows:7,full:true}),field('一致性种子词',d.data.seedPrompt,v=>set('seedPrompt',v),{multiline:true,rows:3,full:true}),field('补充备注',d.data.notes,v=>set('notes',v),{multiline:true,rows:3,full:true}));
    const detailsValue=text(d.data.details);
    if(detailsValue)fields.append(node('details',{class:'full'},node('summary',{},'原始设定字段（保留）'),node('pre',{class:'prompt-box'},detailsValue)));
    if(entity.type==='prop')fields.append(node('label',{class:'row full',style:'font-size:12px'},node('input',{type:'checkbox',checked:!!d.data.confirmed,onChange:e=>set('confirmed',e.target.checked)}),'已确认这个道具进入作品'));
  }
  form.append(fields,node('div',{class:'editor-actions'},node('span',{class:'dirty-label',id:'dirty-label'},dirty?'有未保存的修改':'所有修改已保存'),node('div',{class:'row'},button('撤销未保存',()=>{drafts.delete(entity.id);draft=null;dirty=false;renderEditor($('#editor'));},'small'),node('button',{type:'submit',class:'primary',id:'save-entity',disabled:!dirty},'保存新版本'))));
  container.append(form);
}
async function saveEntity(){
  const entity=selected();if(!entity||!draft)return;
  const references=entity.type==='storyboard'&&editorTab==='video'?{ids:new Set(referenceIds),config:structuredClone(videoConfig)}:null;
  const result=await perform(()=>api(`/api/entities/${encodeURIComponent(entity.id)}`,{method:'PATCH',body:{projectId:state.project.id,baseVersion:draft.baseVersion,name:draft.name,code:draft.code,data:draft.data}}),'已保存为新版本');
  if(result){
    const id=entity.id;await loadState(false);drafts.delete(id);draft=null;dirty=selected()?.type==='storyboard'&&hasStoryboardDrafts(selected());preview=null;finalPrompt='';promptLoadedKey=null;promptEdited=false;selectedId=id;
    if(entity.type==='shot'&&currentEpisode!=='all')currentEpisode=episodeNumber(selected());
    if(references){initializeStoryboardGeneration(selected());referenceIds=references.ids;videoConfig=references.config;}
    renderApp();
    return true;
  }
}
async function reorderShot(direction){const entity=selected();if(!entity)return;if(dirty){notify('先保存当前镜头的修改，再调整顺序。',true);return;}const result=await perform(()=>api('/api/shots/reorder',{method:'POST',body:{projectId:state.project.id,entityId:entity.id,baseVersion:currentVersion(entity),direction}}),'镜头顺序已保存');if(result){draft=null;preview=null;await loadState(false);renderApp();}}

function renderMedia(container,entity){
  const uploadInput=node('input',{type:'file',accept:'image/png,image/jpeg,image/webp,video/mp4,audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3',hidden:true,onChange:e=>{if(e.target.files[0])uploadMedia(e.target.files[0],entity);}});
  container.append(node('div',{class:'row between',style:'margin-bottom:14px'},node('small',{},'图片支持 JPG / JPEG、PNG、WebP，单张须小于 30 MB；视频与 WAV / MP3 音频本地上传上限 60 MB，各自采用。'),button('＋ 绑定本地素材',()=>uploadInput.click(),'small')),uploadInput);
  if(!(entity.media||[]).length){container.append(node('div',{class:'empty'},node('span',{class:'empty-icon'},'▧'),node('h3',{},'还没有图片、视频或参考音频'),node('p',{},'创建 Codex 生图任务，或绑定你已有的素材。'),button('创建生图任务',()=>switchEditorTab('generate'),'primary')));return;}
  container.append(node('div',{class:'media-grid'},[...(entity.media||[])].reverse().map(media=>node('article',{class:'media-card'},mediaElement(entity,media),mediaCaption(media),node('div',{class:'row between'},badge(isAdopted(entity,media)?'已采用':'候选',isAdopted(entity,media)?'good':''),button(isAdopted(entity,media)?'正在使用':'采用这版',async()=>{const r=await perform(()=>api('/api/adopt',{method:'POST',body:{projectId:state.project.id,entityId:entity.id,mediaId:media.id}}),'已采用该素材');if(r){await loadState(false);renderApp();}},'small',{disabled:isAdopted(entity,media)})),node('small',{},date(media.at)),node('small',{},media.stale?'基于旧剧情或旧设定，请复查。':'对应当前设定'),node('details',{},node('summary',{},'提示词与文件位置'),node('pre',{class:'prompt-box'},media.prompt||'上传素材，无生成提示词'),node('code',{},media.file||'')),node('div',{class:'row wrap'},button('打开本地文件位置',()=>perform(()=>api(`/api/media/${encodeURIComponent(media.id)}/reveal`,{method:'POST',body:{}}),'已请求在资源管理器中显示文件'),'quiet small'),node('a',{href:mediaUrl(media),target:'_blank',rel:'noopener',style:'font-size:11px'},'打开原始素材'))))));
}
async function uploadMedia(file,entity){const problem=mediaUploadProblem(file.size,file.type.startsWith('image/')||/\.(jpe?g|png|webp)$/i.test(file.name));if(problem){notify(problem,true);return;}await perform(async()=>{const buffer=await file.arrayBuffer();const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));await api('/api/media-upload',{method:'POST',body:{projectId:state.project.id,entityId:entity.id,baseVersion:currentVersion(entity),filename:file.name,contentBase64:btoa(binary)}});await loadState(false);renderApp();},'素材已绑定，尚未采用');}
function renderVersions(container,entity){container.append(node('p',{class:'note',style:'margin-bottom:18px'},'旧版始终保留。“恢复为新版本”会复制旧设定，当前的媒体采用选择不随之改变。'),[...(entity.versions||[])].reverse().map((revision,index)=>node('article',{class:'revision'},node('div',{class:'row between'},node('h4',{},`设定版本 ${entity.versions.length-index}`),badge(revision.id===currentVersion(entity)?'当前':'历史',revision.id===currentVersion(entity)?'good':'')),node('p',{},date(revision.at)),node('details',{},node('summary',{},'查看完整内容'),node('pre',{class:'prompt-box'},json(revision.data))),revision.id!==currentVersion(entity)?button('恢复为新版本',async()=>{const r=await perform(()=>api(`/api/entities/${encodeURIComponent(entity.id)}`,{method:'PATCH',body:{projectId:state.project.id,baseVersion:currentVersion(entity),name:revision.name||entity.name,code:revision.code||entity.code,data:revision.data}}),'历史设定已恢复为新版本');if(r){drafts.delete(entity.id);draft=null;dirty=false;preview=null;promptLoadedKey=null;promptEdited=false;await loadState(false);renderApp();}},'small'):null)));}

function allReferenceMedia(){return selected()?referenceGroups(state.project,selected()).flatMap(g=>g.media):[];}
// 首尾帧档（FL2VA）只吃图片关键帧：既没有音频槽，也没有参考视频槽。
function allowedReferenceMedia(kind=generationKind){
  const all=allReferenceMedia();
  if(kind!=='video')return all.filter(media=>media.kind==='image');
  // 故事板采用了本组音频后，音频参数只传这一条（Audio 1），角色音色不再出现在可选素材里。
  if(selected()?.type==='storyboard'){
    const boardAudio=adoptedId(selected(),'audio');
    return all.filter(media=>media.entityType!=='shot'&&media.kind!=='video'
      &&(media.entityId!==selectedId||media.id===adoptedId(selected(),'image'))
      &&(media.kind!=='audio'||!boardAudio||media.id===boardAudio));
  }
  return isFrameMode()?all.filter(media=>media.kind==='image'):all.filter(media=>media.kind!=='video');
}
function switchEditorTab(key) {
  if(key==='video'||key==='generate') {
    const kind=key==='video'?'video':'image';
    if(generationKind!==kind){generationKind=kind;videoEditorKey=null;finalPrompt='';promptLoadedKey=null;promptEdited=false;promptLoading=false;invalidatePreview();}
  }
  editorTab=key;rememberEditorTab(key);renderEditor($('#editor'));
}
/* 右栏记住上一次看的是哪个标签：换条目时回到那个标签，不再每次都强制跳到「生成视频」。
   记的是标签 key，所以「生成视频 / 媒体 / 镜头与设置」都能被记住；换了条目没有这个标签（例如故事板没有「原文片段」）才退回默认。 */
function editorTabKeys(entity) {
  if(!entity) return ['edit'];
  return ['edit','generate',...(['shot','storyboard'].includes(entity.type)?['video']:[]),'media','versions',...(entity.type==='storyboard'?[]:['raw'])];
}
function rememberedEditorTab() {try {return localStorage.getItem('studio.editorTab') || '';} catch {return '';}}
function rememberEditorTab(key) {try {localStorage.setItem('studio.editorTab',key);} catch {}}
function defaultEditorTab(entity) {
  const keys = editorTabKeys(entity);
  const last = rememberedEditorTab();
  if(last && keys.includes(last)) return last;
  return ['shot','storyboard'].includes(entity?.type) ? 'video' : 'edit';
}
function syncVideoConfigText() {const textarea=$('#video-config');if(textarea)textarea.value=json(videoConfig);}
function setVideoParameter(key,value) {
  videoConfig[key]=value;
  if(key==='duration')rememberDuration(selected(),value);
  // 同一个参数在两档里的节点号不同（时长 186 / 135、比例 115、像素 多参考147 / 首尾帧142）；找不到的节点直接跳过，
  // 真正生效以服务端按档位写入的请求为准；这里只是让高级 JSON 面板显示同步。
  syncConfigValue(key,value);
  syncNativePixels(videoConfig,isFrameMode()?frameAspectPair(videoConfig):null);
  // 时长与比例都出现在「时长与比例」提示词区块里，改了要重建；否则区块里还是旧值。
  if(generationKind==='video'&&(key==='aspectRatio'||key==='duration'))rebuildVideoBlocks();invalidatePreview();syncVideoControls();syncVideoConfigText();persistConfig();
}
// 切换生成方式＝换一套工作流：节点模板、槽位含义、参数范围全部跟着换，旧槽位不保留。
function setVideoMode(mode){
  if(selected()?.type==='storyboard'&&mode!=='reference'){notify('四宫格故事板使用多参考模式，不能当作普通首帧。',true);return;}
  if(mode===videoConfig.mode)return;
  const defaults=structuredClone(videoProfile(mode));
  defaults.mode=mode;defaults.outputResolution=videoConfig.outputResolution||defaults.outputResolution;
  defaults.instanceType=videoConfig.instanceType||defaults.instanceType;
  if(mode==='frames')defaults.frameBindings={first:null,last:null};
  videoConfig=defaults;
  applyDurationDefault(selected());
  referenceIds=new Set(automaticReferences(state.project,selected()));
  autoBindReferences();videoBlockEdits.delete(selectedId);
  rebuildVideoBlocks(true);syncVideoConfigText();persistConfig();renderGenerationTab();
}
function syncVideoControls() {
  syncNativePixels(videoConfig,isFrameMode()?frameAspectPair(videoConfig):null);
  const duration=$('#video-duration');if(duration)duration.value=videoConfig.duration||'';
  const durationHintElement=$('#video-duration-hint');if(durationHintElement)durationHintElement.textContent=durationHint(selected());
  const aspect=$('#video-aspect');if(aspect)aspect.value=videoConfig.aspectRatio||'';
  const pixels=$('#video-pixels');if(pixels){pixels.value=videoConfig.pixels??'';pixels.disabled=(videoConfig.outputResolution||'native')!=='native';}
  const resolution=$('#video-output-resolution');if(resolution)resolution.value=videoConfig.outputResolution||'native';
  const instance=$('#video-instance');if(instance)instance.value=videoConfig.instanceType||defaultInstanceType;
  const output=$('#video-output-size');if(output)output.textContent=videoOutputDescription(videoConfig);
  const difference=$('#video-source-difference');if(difference){difference.textContent=videoSourceDifference(selected(),videoConfig);difference.hidden=!difference.textContent;}
  syncVideoSummary();
}
function syncVideoSummary(){
  const refs=orderedVideoReferences();
  const set=(id,value)=>{const element=$('#'+id);if(element)element.textContent=value;};
  set('verify-prompt-value',finalPrompt.trim()?finalPrompt.trim().length+' 字 · 已拼接':'尚未勾选任何提示词区域');
  set('verify-refs-value',refs.length?refs.length+' 个':'无');
  set('verify-params-value',[`${videoConfig.duration||'—'} 秒`,isFrameMode()?'比例跟随首帧':((videoConfig.aspectRatio||'比例未配置').split(' ')[0]||'比例未配置'),`${videoConfig.pixels||'—'} 像素/百万`,(videoConfig.outputResolution||'native')==='native'?'保留云端原片':'原生 '+videoConfig.outputResolution,`${videoConfig.instanceType||defaultInstanceType} 实例`].filter(Boolean).join(' · '));
  const uniqueRefs=[...new Map(refs.map(media=>[media.id,media])).values()];
  const tags=$('#verify-refs-tags');if(tags)tags.replaceChildren(...(uniqueRefs.length?uniqueRefs.map(media=>badge(`${typeNames[media.kind]||media.kind} · ${media.entityName}${referenceTag(media)}`)):[node('small',{class:'muted'},'本次不发送参考素材。')]));
  if(isFrameMode())set('reference-slot-count','首帧、尾帧各 1 张 · 展开调整');
  else set('reference-slot-count','已自动分配 '+(videoConfig.referenceBindings||[]).filter(binding=>referenceIds.has(binding.mediaId)).length+' 个槽位 · 展开调整');
  const promptBox=$('#assembled-video-prompt');if(promptBox)promptBox.textContent=finalPrompt||'请勾选至少一个有内容的提示词区域。';
  const difference=$('#video-source-difference');if(difference){const note=videoSourceDifference(selected(),videoConfig);difference.textContent=note;difference.hidden=!note;}
}
// 首尾帧档没有比例节点，原生生成尺寸跟随首帧比例。
function frameAspectPair(config=videoConfig){
  const media=allReferenceMedia().find(item=>item.id===(config.frameBindings||{}).first);
  const width=Number(media?.metadata?.width),height=Number(media?.metadata?.height);
  return width>0&&height>0?[width,height]:null;
}
function videoSourceDifference(entity,config) {
  const notes=[];
  const originalRatio=(state.project?.aspectRatio||'').match(/\d+:\d+/)?.[0];
  if(isFrameConfig(config)){
    const pair=frameAspectPair(config);
    if(pair&&originalRatio){const [ratioWidth,ratioHeight]=originalRatio.split(':').map(Number);
      if(ratioWidth&&ratioHeight&&Math.abs(pair[0]/pair[1]-ratioWidth/ratioHeight)>0.02)notes.push(`首尾帧模式的输出比例跟随首帧（${pair[0]}:${pair[1]}），与原稿 ${originalRatio} 不同，请核对首帧。`);}
  } else {
    const chosenRatio=(config.aspectRatio||'').split(' ')[0];
    if(originalRatio&&chosenRatio&&originalRatio!==chosenRatio)notes.push('生成比例 '+chosenRatio+' 与原稿 '+originalRatio+' 不同，请核对下方提示词中的比例描述。');
  }
  const planned=Number(plannedDuration(entity)),generated=Number(config.duration);
  if(planned>0&&generated>0&&planned!==generated)notes.push('生成 '+generated+' 秒与本镜计划 '+planned+' 秒不同；只影响本次生成，计划剪辑时长不变。');
  return notes.join(' ');
}
function videoOutputDescription(config) {
  const conflict=nativePixelConflict(config);if(conflict)return conflict;
  const frame=isFrameConfig(config),pair=frame?frameAspectPair(config):null;
  try{return planVideoOutput(config.outputResolution||'native',frame?{width:pair?.[0]??0,height:pair?.[1]??0}:config.aspectRatio,config.pixels??'0.4').note;}
  catch(error){return error.message;}
}
// 首尾帧档的自动选择：首帧优先用本镜采用图，尾帧不自动填（相邻镜头接力由用户自己挑）。
// 图片槽可以选候选图，所以这里不能用「只认 referenceIds」的旧过滤；反过来把帧槽并回 referenceIds 保持一致。
function autoBindReferences(){
  if(isFrameMode()){
    const images=allowedReferenceMedia('video').filter(m=>m.kind==='image');
    const frames=videoConfig.frameBindings||(videoConfig.frameBindings={first:null,last:null});
    const usable=id=>Boolean(id)&&images.some(media=>media.id===id);
    const adopted=adoptedId(selected(),'image');
    if(!usable(frames.first))frames.first=usable(adopted)?adopted:images[0]?.id||null;
    if(!usable(frames.last))frames.last=null;
    videoConfig.useLastFrame=Boolean(frames.last);
    syncConfigValue('useLastFrame',videoConfig.useLastFrame);
    referenceIds=new Set([...referenceIds,...[frames.first,frames.last].filter(Boolean)]);
    return;
  }
  const refs=allowedReferenceMedia('video').filter(m=>referenceIds.has(m.id));
  if(selected()?.type==='storyboard'){
    const automatic=automaticReferences(state.project,selected());
    const order=media=>media.entityId===selectedId?-1:automatic.includes(media.id)?automatic.indexOf(media.id):999;
    refs.sort((a,b)=>order(a)-order(b));
  }
  videoConfig.referenceBindings=automaticBindings(refs);
}
function frameReferenceIds(){const frames=videoConfig.frameBindings||{};return new Set([frames.first,videoConfig.useLastFrame!==false?frames.last:null].filter(Boolean));}
function orderedVideoReferences(){
  const refs=allowedReferenceMedia('video').filter(m=>referenceIds.has(m.id));
  if(isFrameMode()){
    const order=[...frameReferenceIds()];
    const images=allReferenceMedia().filter(media=>media.kind==='image');
    return order.map(id=>images.find(media=>media.id===id)).filter(Boolean);
  }
  const bindings=[...(videoConfig.referenceBindings||[])].sort((a,b)=>{const slots=['141','142','143','161','175','176','144','160','189'];return slots.indexOf(a.nodeId)-slots.indexOf(b.nodeId);});
  return [...refs].sort((a,b)=>{const index=m=>{const i=bindings.findIndex(x=>x.mediaId===m.id);return i<0?999:i;};return index(a)-index(b);});
}
function referenceTag(media){
  if(generationKind!=='video')return '';
  if(isFrameMode()){
    const role=frameRole(media.id,videoConfig.frameBindings||{},videoConfig.useLastFrame!==false);
    return role?' · '+role:'';
  }
  if(!referenceIds.has(media.id))return '';
  const tag=referenceToken(media,videoConfig.referenceBindings||[]);return tag?' · '+tag:' · 未分配槽位';
}
function syncReferenceLabels(){
  const refs=allowedReferenceMedia();
  for(const label of document.querySelectorAll('[data-reference-tag]')){const m=refs.find(m=>m.id===label.dataset.referenceTag);if(m)label.textContent=referenceTag(m);}
  for(const checkbox of document.querySelectorAll('[data-role-reference]')){const pair=refs.filter(m=>m.entityId===checkbox.dataset.roleReference&&m.adopted&&(m.kind==='image'||m.kind==='audio'));checkbox.checked=pair.length>0&&pair.every(m=>referenceIds.has(m.id));checkbox.indeterminate=pair.some(m=>referenceIds.has(m.id))&&!checkbox.checked;}
}
function initializeVideoEditor(entity){
  if(entity.type==='storyboard'){initializeStoryboardGeneration(entity);return;}
  const key=entity.id+':'+currentVersion(entity)+':'+(videoConfig.mode||'reference')+':'+automaticReferences(state.project,entity).join(',');
  if(videoEditorKey===key)return;
  videoEditorKey=key;promptLoading=false;promptEdited=true;
  applyDurationDefault(entity);
  referenceIds=new Set(automaticReferences(state.project,entity));autoBindReferences();rebuildVideoBlocks();
}
function refreshVideoPrompt(){
  const board=selected();
  finalPrompt=board?.type==='storyboard'?storyboardFinalPrompt(state.project,{...board,data:boardPromptData(board)},videoConfig):assembleVideoPrompt(videoBlocks,state.promptPreferences||{});
  const combination=$('#storyboard-combination-prompt');if(combination)combination.textContent=composeStoryboardPrompt(state.project,board,'video',videoConfig);
  const editor=$('#storyboard-final-prompt');if(editor&&editor.value!==finalPrompt)editor.value=finalPrompt;
  const output=$('#assembled-video-prompt');if(output)output.textContent=finalPrompt||'请勾选至少一个有内容的提示词区域。';
  syncVideoSummary();syncGenerationActions();
}
function rebuildVideoBlocks(reset=false){
  if(!selected())return;
  if(selected().type==='storyboard'){refreshVideoPrompt();invalidatePreview();return;}
  if(reset)videoBlockEdits.delete(selectedId);
  const edits=videoBlockEdits.get(selectedId)||{};
  videoBlocks=videoPromptBlocks(state.project,selected(),orderedVideoReferences(),videoConfig).map(b=>({...b,text:Object.hasOwn(edits,b.id)?edits[b.id]:b.text}));
  refreshVideoPrompt();invalidatePreview();
  const panel=$('#video-prompt-blocks');if(panel)panel.replaceWith(renderVideoBlocks());
}
function renderVideoBlocks(){
  return node('section',{id:'video-prompt-blocks',class:'video-section'},node('div',{class:'section-head'},node('div',{class:'row between wrap'},node('h3',{},'提示词区域'),button('从当前设定组合全文',()=>rebuildVideoBlocks(true),'quiet small',{disabled:dirty})),node('p',{},'默认全部不选。勾选偏好保存到工作台，全作品共用；仅拼接已勾选且非空的内容。文字修改仅保留在当前会话的本镜中。')),
    node('div',{class:'stack'},videoBlocks.map(block=>node('details',{class:'prompt-section'},node('summary',{},node('input',{type:'checkbox','aria-label':'包含 '+block.label,checked:state.promptPreferences?.[block.id]===true,onClick:e=>e.stopPropagation(),onChange:async e=>{
      const enabled=e.target.checked;const checkbox=e.target;checkbox.disabled=true;
      try{const result=await api('/api/settings/prompt-preferences',{method:'PATCH',body:{id:block.id,enabled}});state.promptPreferences=result.promptPreferences;refreshVideoPrompt();invalidatePreview();}
      catch(error){checkbox.checked=state.promptPreferences?.[block.id]===true;notify(error.message,true);}finally{checkbox.disabled=false;}
    }}),' '+block.label+' · '+block.id+(block.text.trim()?'':'（暂无内容）')),node('textarea',{rows:5,value:block.text,'aria-label':block.label+'编辑',onInput:e=>{
      block.text=e.target.value;const edits=videoBlockEdits.get(selectedId)||{};edits[block.id]=block.text;videoBlockEdits.set(selectedId,edits);refreshVideoPrompt();invalidatePreview();
    }})))));
}
function renderVideoParameters(entity) {
  const frameMode=isFrameMode();
  syncNativePixels(videoConfig,frameMode?frameAspectPair(videoConfig):null);
  const {min,max}=durationRange();
  const modeSwitch=node('div',{class:'filter-chips',role:'tablist','aria-label':'生成方式'},(entity.type==='storyboard'?['reference']:['reference','frames']).map(mode=>button(`${videoProfileLabels[mode]} · ${mode==='frames'?'图1 → 图2':'最多 6 图 + 3 音色'}`,()=>setVideoMode(mode),videoConfig.mode===mode?'active':'')));
  const duration=node('input',{id:'video-duration',type:'number',min:String(min),max:String(max),step:'1',required:true,value:videoConfig.duration??'',onInput:e=>setVideoParameter('duration',e.target.value)});
  const aspect=frameMode?null:node('select',{id:'video-aspect',onChange:e=>setVideoParameter('aspectRatio',e.target.value)},node('option',{value:'',disabled:true,selected:!videoAspectOptions.some(([value])=>value===videoConfig.aspectRatio)},'请选择支持的比例'),videoAspectOptions.map(([value,label])=>node('option',{value,selected:value===videoConfig.aspectRatio},label)));
  const pixels=node('input',{id:'video-pixels',type:'number',min:'0.2',max:'2',step:'0.01',value:videoConfig.pixels??'0.4',disabled:(videoConfig.outputResolution||'native')!=='native',onInput:e=>setVideoParameter('pixels',e.target.value)});
  const resolution=node('select',{id:'video-output-resolution',onChange:e=>setVideoParameter('outputResolution',e.target.value)},[['native','自定像素 · 保留原片'],['480p','原生 480p'],['720p','原生 720p'],['1080p','原生 1080p']].map(([value,label])=>node('option',{value,selected:value===(videoConfig.outputResolution||'native')},label)));
  const instance=node('select',{id:'video-instance',onChange:e=>setVideoParameter('instanceType',e.target.value)},videoInstanceOptions.map(([value,label])=>node('option',{value,selected:value===(videoConfig.instanceType||defaultInstanceType)},label)));
  return node('section',{class:'video-section video-parameters'},node('div',{class:'section-head'},entity.type==='storyboard'?null:node('h3',{},'生成参数'),
    node('p',{},frameMode?'首尾帧模式：图1 是开场画面，图2 是结束画面，模型补中间的运动。':'多参考模式：最多 6 张参考图 + 3 段音色参考，参考素材按顺序编号。')),
    modeSwitch,
    node('div',{class:'video-parameter-grid'},node('label',{class:'field'},'生成时长（秒）',duration,node('small',{class:'muted',id:'video-duration-hint'},durationHint(entity))),
      aspect?node('label',{class:'field'},'画面比例',aspect):null,
      node('label',{class:'field'},'原生生成清晰度',resolution),
      node('label',{class:'field'},'生成像素/百万',pixels),
      node('label',{class:'field'},'实例规格',instance,node('small',{class:'muted'},'规格越高单价越高，按需选择。'))),
    node('p',{id:'video-output-size',class:'muted',style:'font-size:11px'},videoOutputDescription(videoConfig)),
    node('p',{class:'muted',style:'font-size:11px'},`当前档位按工作流作者标注支持 ${min}–${max} 整数秒。原生像素为0.2–2.0，尺寸按32像素网格取整；较高像素会增加云端耗时与费用。保留回片原尺寸，不进行本机放大。`+(frameMode?'首尾帧工作流没有比例节点，输出比例跟随首帧。':(entity.type==='storyboard'?'组内有效镜头的时间分配与提示词会跟随这里的时长和比例更新。':'勾选「时长与比例」区块时，其中的 Target duration 与比例会跟随这里的取值。'))));
}
function syncGenerationActions() {
  for(const id of ['prepare-preview','prepare-preview-top']){const control=$('#'+id);if(control)control.disabled=busy||dirty||promptLoading||!finalPrompt.trim();}
  const submit=$('#submit-preview-top');if(submit)submit.disabled=!preview||(preview.blockers||[]).length>0||busy;
  const jump=$('#jump-preview');if(jump)jump.disabled=busy||!preview;
  const unsaved=dirty&&!storyboardFinalPromptOnlyDraft(selected());
  const videoSubmit=$('#submit-video');if(videoSubmit)videoSubmit.disabled=busy||unsaved||promptLoading||!finalPrompt.trim()||Boolean(preview&&(preview.blockers||[]).length);
  const hint=$('#video-unsaved-hint');if(hint){hint.hidden=!dirty;hint.textContent=unsaved?'请先到“镜头与设置”保存组设置或镜头修改。':'点击生成将先保存最终提示词，再提交视频任务。';}
  const summary=$('#generation-blockers');
  if(summary){const blockers=preview?.blockers||[];summary.hidden=!blockers.length;summary.replaceChildren(node('strong',{},'还有 '+blockers.length+' 项需要处理'),node('ul',{},blockers.map(item=>node('li',{},typeof item==='string'?item:item.message||json(item)))));}
}
function scrollToPreview() {const target=$('#preview-content');if(target){target.scrollIntoView({block:'start',behavior:'auto'});target.focus({preventScroll:true});}}
function generationToolbar() {
  return node('div',{class:'generation-toolbar'},node('div',{},node('strong',{},'制作图片资产'),node('small',{},'检查内容 → 准备完整预览 → 创建任务')),
    node('div',{class:'row wrap'},button('准备发送预览',preparePreview,'primary',{id:'prepare-preview-top',disabled:dirty||promptLoading}),button('查看预览 ↓',scrollToPreview,'small',{id:'jump-preview',disabled:!preview}),button('创建生图任务',submitPreview,'primary',{id:'submit-preview-top',disabled:!preview||(preview.blockers||[]).length>0})));
}
function videoVerifySection(entity){
  const difference=videoSourceDifference(entity,videoConfig);
  return node('section',{class:'video-section video-verify'},node('div',{class:'section-head'},node('h3',{},entity.type==='storyboard'?'最终提示词 · 实际发送内容':'核对提示词'),node('p',{},'下面是本次实际发送的提示词与引用，确认无误后点击生成。')),
    entity.type==='storyboard'?renderStoryboardFinalPrompt(entity):node('details',{class:'final-prompt-details',open:true},node('summary',{},'最终发送提示词 · 实时拼接'),node('pre',{id:'assembled-video-prompt',class:'prompt-box'},finalPrompt||'请勾选至少一个有内容的提示词区域。')),
    node('div',{class:'verify-summary'},node('div',{class:'verify-item'},node('span',{class:'verify-label'},'提示词'),node('strong',{id:'verify-prompt-value'},'—')),node('div',{class:'verify-item'},node('span',{class:'verify-label'},isFrameMode()?'关键帧':'参考素材'),node('strong',{id:'verify-refs-value'},'—'),node('div',{class:'row wrap verify-tags',id:'verify-refs-tags'})),node('div',{class:'verify-item'},node('span',{class:'verify-label'},'生成参数'),node('strong',{id:'verify-params-value'},'—'))),
    node('p',{id:'video-source-difference',class:'note',hidden:!difference},difference));
}
function videoActionBar(){
  const scope=selected()?.type==='storyboard'?'本组':'本镜';
  return node('div',{class:'video-action-bar'},node('div',{class:'grow'},node('strong',{},'生成视频'),node('small',{},`点击即向 RunningHub 提交收费任务；提交后留在本页，状态见下方“${scope}最近一次视频任务”。`),node('small',{id:'video-unsaved-hint',hidden:true,role:'status'})),button('生成视频',submitVideo,'primary',{id:'submit-video'}));
}
async function submitVideo(){
  let entity=selected();if(!entity||busy||promptLoading)return;
  if(dirty){
    if(!storyboardFinalPromptOnlyDraft(entity)){notify('请先保存组设置或镜头修改，再生成视频。',true);return;}
    if(!await saveEntity())return;
    entity=selected();
  }
  refreshVideoPrompt();
  const durationControl=$('#video-duration');
  if(durationControl&&!durationControl.checkValidity()){durationControl.reportValidity();return;}
  if(!finalPrompt.trim()){notify('请先勾选至少一个有内容的提示词区域。',true);return;}
  const epoch=previewEpoch,entityId=entity.id;
  const result=await perform(async()=>{
    const config=requestConfigFromEditor();
    const prepared=await api('/api/previews',{method:'POST',body:{projectId:state.project.id,entityId:entity.id,kind:'video',prompt:finalPrompt,referenceMediaIds:orderedVideoReferences().map(media=>media.id),videoConfig:config}});
    if(epoch!==previewEpoch||selectedId!==entityId){notify('核对期间内容已变化，请重新核对后再生成。',true);return null;}
    preview=prepared.preview;operationId=crypto.randomUUID();
    if((preview.blockers||[]).length)return {blocked:preview.blockers.length};
    return {job:await api('/api/jobs',{method:'POST',body:{previewId:preview.id,operationId}})};
  });
  if(!result)return;
  if(result.blocked){const box=$('#generation-blockers');if(box)box.scrollIntoView({block:'nearest',behavior:'smooth'});notify('还有 '+result.blocked+' 项需要处理，请查看上方提示。',true);return;}
  preview=null;await loadState(false);renderApp();
  notify(`视频任务已创建，状态见本页“${entity.type==='storyboard'?'本组':'本镜'}最近一次视频任务”。`);
}
// 提交后不再跳到“生成任务”：留在本页，用这一条状态区交代结果与去向。
// 注意不要用 changeView('jobs')——它会 resetSelection(null)，回到镜头时选中项就丢了。
function goToJobs(){stopPreviewPlayback();view='jobs';renderApp();}
function videoTaskSection(entity){
  const scope=entity.type==='storyboard'?'本组':'本镜';
  const job=(state.jobs||[]).filter(item=>item.projectId===state.project?.id&&item.kind==='video'&&item.entityId===entity.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];
  if(!job)return null;
  const success=['ready','completed','succeeded'].includes(job.status);
  const failed=['failed','query_failed','delivery_invalid','submission_unknown','blocked'].includes(job.status);
  const running=['submitting','submitted','preparing','waiting_delivery','queued','running','downloading'].includes(job.status);
  const resumable=['failed','query_failed','downloading','submission_unknown','running','queued'].includes(job.status);
  return node('section',{class:'video-section video-task',id:'video-task-strip'},
    node('div',{class:'section-head row between wrap'},node('div',{},node('h3',{},scope+'最近一次视频任务'),node('p',{},`${date(job.createdAt)} · ${job.id}`)),badge(statusNames[job.status]||job.status,success?'good':failed?'bad':'warn')),
    job.taskId?node('p',{class:'muted',style:'font-size:12px;margin-top:8px'},'RunningHub taskId：',node('code',{},job.taskId)):null,
    job.error?node('div',{class:'note error',style:'margin-top:10px'},text(job.error)):null,
    job.outputs?.length?node('div',{class:'row wrap',style:'margin-top:10px'},job.outputs.map((output,index)=>{const id=typeof output==='string'?output:output.mediaId||output.id;const media=(entity.media||[]).find(item=>item.id===id);return media?node('a',{href:mediaUrl(media),target:'_blank',rel:'noopener'},`打开结果 ${index+1}`):node('span',{class:'badge'},`结果 ${index+1}`);})):null,
    node('p',{class:'muted',style:'font-size:12px;margin-top:10px'},running?'后端已接管查询与下载，本页不自动刷新；需要看最新进度就点“刷新状态”或去“生成任务”。':success?`结果已登记到${scope}媒体，可在“媒体”页采用。`:'可到“生成任务”查看日志、重查或重下载。'),
    node('div',{class:'row wrap',style:'margin-top:10px'},button('刷新状态',async()=>{const r=await perform(async()=>{await loadState(false);renderApp();});if(!r)return;},'small',{id:'video-task-refresh'}),button('查看生成任务',goToJobs,'small',{id:'video-task-open'}),resumable?button('重查 / 重下载',async()=>{const r=await perform(()=>api(`/api/jobs/${encodeURIComponent(job.id)}/retry`,{method:'POST',body:{}}),'已请求恢复；不会重新提交收费任务。');if(r){await loadState(false);renderApp();}},'small',{id:'video-task-retry'}):null));
}
function renderReferenceControls(entity){
  const refs=allowedReferenceMedia();
  const allowedIds=new Set(refs.map(media=>media.id));
  referenceIds=new Set([...referenceIds].filter(id=>allowedIds.has(id)));
  const referenceControls=node('div',{},node('div',{class:'row between'},node('h4',{},'本次参考素材'),button('绑定本地素材',()=>switchEditorTab('media'),'quiet small')),node('p',{class:'reference-selected',id:'reference-count'},'已选择 '+referenceIds.size+' 个。仅自动选用已有采用版，可手动调整。'+(entity.type==='shot'&&!adoptedId(entity,'image')?' 本镜暂无采用图，未自动选择候选图。':'')));
  if(!refs.length)referenceControls.append(node('p',{class:'muted',style:'font-size:12px'},generationKind==='video'?'暂无已绑定素材。请先在本镜或角色的“媒体”中上传参考图与音频。':'暂无参考图片。可以先生成无参考资产图，或绑定已有图片。'));
  else {
    for(const group of referenceGroups(state.project,entity)){
      const items=group.media.filter(m=>refs.some(r=>r.id===m.id));if(!items.length)continue;
      const adoptedRoleMedia=items.filter(m=>m.adopted&&(m.kind==='image'||m.kind==='audio'));
      const missingRoleKinds=group.type==='character'?['image','audio'].filter(kind=>refs.some(m=>m.entityId===group.id&&m.kind===kind)&&!adoptedRoleMedia.some(m=>m.kind===kind)):[];
      referenceControls.append(node('section',{class:'reference-category'},node('h4',{},(typeNames[group.type]||group.type)+' · '+group.name+(group.type==='character'?'（形象 + 音色）':'')),group.type==='character'?node('label',{class:'row'},node('input',{type:'checkbox','aria-label':'引用角色形象与音色 '+group.name,'data-role-reference':group.id,disabled:!adoptedRoleMedia.length,checked:adoptedRoleMedia.length>0&&adoptedRoleMedia.every(m=>referenceIds.has(m.id)),onChange:e=>{for(const m of adoptedRoleMedia){if(e.target.checked)referenceIds.add(m.id);else referenceIds.delete(m.id);}if(generationKind==='video'){autoBindReferences();rebuildVideoBlocks();}invalidatePreview();renderGenerationTab();}}),'一起引用采用的形象与音色'):null,missingRoleKinds.length?node('div',{class:'row'},node('small',{class:'muted'},'尚未采用'+missingRoleKinds.map(kind=>kind==='image'?'形象':'音色').join('与')+'，请先在角色媒体中采用素材。'),button('前往角色媒体',()=>{view='character';search='';resetSelection(group.id);editorTab='media';renderApp();},'quiet small')):null,node('div',{class:'reference-grid'},items.map(m=>node('label',{class:'reference-option'},
        node('input',{type:'checkbox',checked:referenceIds.has(m.id),'aria-label':'引用'+m.entityName+' '+mediaFilename(m),onChange:e=>{
          if(e.target.checked)referenceIds.add(m.id);else referenceIds.delete(m.id);
          if(generationKind==='video'){autoBindReferences();rebuildVideoBlocks();}
          invalidatePreview();syncVideoConfigText();const count=$('#reference-count');if(count)count.textContent='已选择 '+referenceIds.size+' 个。';renderBindings($('#reference-bindings'));syncReferenceLabels();syncVideoSummary();
        }}),node('span',{},m.kind==='image'?node('img',{class:'reference-thumb',src:mediaUrl(m),alt:'',loading:'lazy'}):node('span',{},m.kind==='audio'?'♫ 音色':'▻ 视频'),node('strong',{},m.kind==='audio'?'音色':typeNames[m.kind],node('span',{'data-reference-tag':m.id},referenceTag(m))),node('span',{class:'reference-filename'},mediaFilename(m)),node('span',{},m.adopted?'采用版':'候选')))))));
    }
  }
  if(generationKind==='video'&&refs.some(media=>media.kind==='audio'))referenceControls.append(node('p',{class:'note',style:'margin-top:10px'},'WAV / MP3 可作为参考音频绑定；144 / 160 / 189 节点作用与音色克隆效果尚未验证。'));
  return referenceControls;
}
// 首尾帧档的槽位界面：两个明确的图片槽（137 首帧 / 143 尾帧），没有音频与视频参考。
function renderFrameSlots(entity){
  const images=allReferenceMedia().filter(media=>media.kind==='image');
  const frames=videoConfig.frameBindings||(videoConfig.frameBindings={first:null,last:null});
  const useLast=videoConfig.useLastFrame!==false;
  const select=(key,label,placeholder,enabled)=>{
    const current=frames[key]||'';
    const mapped=images.some(media=>media.id===current);
    return node('select',{'aria-label':label,disabled:!enabled||!images.length,onChange:e=>{
      frames[key]=e.target.value||null;
      // 选了尾帧就默认启用；不在这里做整体自动绑定，免得把用户刚选的另一帧重置掉。
      if(key==='last'&&frames.last)videoConfig.useLastFrame=true;
      syncConfigValue('useLastFrame',videoConfig.useLastFrame);
      rebuildVideoBlocks();invalidatePreview();syncVideoConfigText();persistConfig();renderGenerationTab();
    }},node('option',{value:'',selected:!mapped},images.length?placeholder:'先准备图片'),images.map(media=>node('option',{value:media.id,selected:media.id===current},media.entityName+' · '+mediaFilename(media))));
  };
  const toggle=node('input',{type:'checkbox','aria-label':'使用尾帧',checked:useLast,onChange:e=>{
    videoConfig.useLastFrame=e.target.checked;if(!e.target.checked)frames.last=null;
    syncConfigValue('useLastFrame',videoConfig.useLastFrame);
    rebuildVideoBlocks();invalidatePreview();syncVideoConfigText();persistConfig();renderGenerationTab();}});
  const firstConfigured=Boolean(frames.first)&&images.some(media=>media.id===frames.first);
  const lastConfigured=Boolean(frames.last)&&images.some(media=>media.id===frames.last);
  return node('section',{class:'video-section'},node('div',{class:'section-head'},node('h3',{},'首帧与尾帧'),node('p',{},'首帧必填、决定开场画面；尾帧决定收尾画面。关掉开关就是单图生视频——该工作流的图2 不能为空，此时会把首帧复用给图2，同一份文件只上传一次。')),
    node('div',{class:'row between'},node('div',{class:'reference-selected',id:'reference-count'},'首帧、尾帧各占一个图片槽（137 / 143）；本档没有音频或视频参考。'),button('绑定本地素材',()=>switchEditorTab('media'),'quiet small')),
    node('label',{class:'row',style:'font-size:12px'},toggle,'使用尾帧（关闭＝只用首帧生成，图2 复用首帧）'),
    useLast&&!lastConfigured?node('p',{class:'note',style:'margin:0'},'已打开尾帧开关但还没选图：仍会按单图生视频提交（图2 复用首帧）。想真正用尾帧就选一张图。'):null,
    node('div',{class:'video-parameter-grid frame-slots'},
      node('label',{class:'field'},node('span',{class:'row between'},'首帧（图1）',badge(firstConfigured?'已配置':'必需 · 未配置',firstConfigured?'':'warn')),select('first','首帧','未配置 · 请选择图片',true)),
      node('label',{class:'field'},node('span',{class:'row between'},'尾帧（图2）',badge(lastConfigured?'已配置':'未选 · 复用首帧','')),select('last','尾帧','未选择 → 复用首帧',useLast))),
    images.length?null:node('p',{class:'note',style:'margin-top:10px'},'暂无可用图片：请在“媒体”里上传，或先生成一张可作为首帧的镜头图。'));
}
function renderFrameSection(entity){
  return renderFrameSlots(entity);
}
// 提交前从编辑器取配置：首尾帧档只认首帧/尾帧两个绑定，多参考档继续按勾选的素材过滤槽位。
function requestConfigFromEditor(){
  const textarea=$('#video-config');
  const config=textarea?JSON.parse(textarea.value):structuredClone(videoConfig);
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('工作流配置必须是 JSON 对象');
  if(/"(?:api[_-]?key|authorization|token)"\s*:/i.test(json(config)))throw new Error('请将密钥放到接口设置，不要写入工作流配置');
  syncNativePixels(config,isFrameConfig(config)?frameAspectPair(config):null);
  if(isFrameConfig(config)){
    const frames=config.frameBindings&&typeof config.frameBindings==='object'?config.frameBindings:{};
    config.frameBindings={first:frames.first||null,last:config.useLastFrame===false?null:(frames.last||null)};
  }else if(Array.isArray(config.referenceBindings))config.referenceBindings=config.referenceBindings.filter(binding=>referenceIds.has(binding.mediaId));
  if(textarea)textarea.value=json(config);
  return config;
}
function videoConfigTextarea(entity){
  return node('textarea',{id:'video-config',rows:13,class:'mono',value:json(videoConfig),'aria-label':'RunningHub完整工作流配置',onInput:e=>{
    invalidatePreview();
    try{
      const config=JSON.parse(e.target.value);
      if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('配置必须是对象');
      videoConfig=config;
      syncNativePixels(config,isFrameMode()?frameAspectPair(config):null);
      e.target.value=json(config);
      if(!isFrameMode()&&Array.isArray(config.referenceBindings))referenceIds=new Set(config.referenceBindings.map(binding=>binding.mediaId));
      persistConfig();syncVideoControls();rebuildVideoBlocks();syncReferenceLabels();
      const conflict=nativePixelConflict(config);
      $('#config-status').textContent=conflict||'JSON 可读取；角色音频引用已同步，请核对最终提示词。';$('#config-status').classList[conflict?'add':'remove']('error-text');
    }catch{$('#config-status').textContent='JSON 格式不完整，请修正后再生成。';$('#config-status').classList.add('error-text');}
  }});
}
function renderGeneration(container,entity){
  if(entity.type==='storyboard'){renderStoryboardGeneration(container,entity);return;}
  if(generationKind==='video')initializeVideoEditor(entity);
  const isVideo=generationKind==='video';
  const promptKey=entity.id+':'+currentVersion(entity)+':'+generationKind+':'+(state.project.versions?.at(-1)?.id||'');
  const needsPrompt=!isVideo&&promptLoadedKey!==promptKey&&!promptEdited;
  const generation=node('div',{class:'stack'},isVideo?null:generationToolbar(),
    dirty?node('div',{class:'note error'},'镜头设定有未保存修改，请先保存再生成。',draft?button('保存镜头修改',saveEntity,'small'):null):null,
    node('div',{id:'generation-blockers',class:'note error',hidden:true,role:'status'}));
  if(isVideo){
    generation.append(renderVideoParameters(entity));
    generation.append(isFrameMode()?renderFrameSection(entity):node('section',{class:'video-section'},node('div',{class:'section-head'},node('h3',{},'参考素材'),node('p',{},'默认勾选本镜与关联角色的采用素材；槽位按顺序自动分配，需要时可展开调整。')),renderReferenceControls(entity),node('div',{id:'reference-bindings'})));
    generation.append(renderVideoBlocks());
    generation.append(videoVerifySection(entity));
    generation.append(node('details',{class:'advanced-video-config'},node('summary',{},'高级工作流配置 · JSON（通常无需展开）'),node('div',{class:'note',style:'margin-bottom:10px'},'不含测试示例媒体与 LoRA。常用参数在上方直接修改；其余节点按实际工作流配置。不要在这里填写 API Key。'),videoConfigTextarea(entity),node('p',{class:'status-line',id:'config-status'},'JSON 可读取；完整性由生成前核对检查。')));
    generation.append(videoActionBar());
    const taskSection=videoTaskSection(entity);if(taskSection)generation.append(taskSection);
  } else {
    generation.append(node('p',{class:'note'},'使用当前 Codex 会话生成图片。创建文件任务，交给 Codex 执行，图片落盘后刷新登记。'),
      field('最终提示词（可编辑；原样进入发送预览）',finalPrompt,v=>{finalPrompt=v;promptEdited=true;invalidatePreview();},{multiline:true,rows:9,full:true,id:'final-prompt'}),
      node('div',{class:'row between wrap'},node('small',{id:'prompt-status'},needsPrompt?'正在组合完整设定…':'包含全局风格与关联设定，发送前可直接编辑。'),button('从当前设定组合全文',()=>loadComposedPrompt(true),'small',{disabled:dirty})),
      renderReferenceControls(entity),
      node('div',{class:'row between wrap'},node('small',{},'检查参数与参考素材后，准备完整发送预览。'),button('准备发送预览',preparePreview,'primary',{disabled:dirty||needsPrompt||promptLoading,id:'prepare-preview'})),
      node('div',{id:'preview-content',tabindex:'-1'},preview?previewView(preview):previewEmpty()));
  }
  container.replaceChildren(generation);
  if(isVideo){renderBindings($('#reference-bindings'));syncVideoSummary();}
  syncGenerationActions();
  if(needsPrompt&&!promptLoading)loadComposedPrompt(false);
}
function initializeStoryboardGeneration(board){
  const key=board.id+':'+board.currentVersion+':'+generationKind+':'+json(storyboardSource(state.project,board))+':'+automaticReferences(state.project,board,generationKind).join(',');
  if(videoEditorKey===key)return;
  videoEditorKey=key;promptLoading=false;promptEdited=false;dirty=hasStoryboardDrafts(board);
  if(generationKind==='video'){
    if(isFrameMode())videoConfig=structuredClone(videoProfile('reference'));
    applyDurationDefault(board);
  }
  referenceIds=new Set(automaticReferences(state.project,board,generationKind));
  if(generationKind==='video')autoBindReferences();
  finalPrompt=generationKind==='video'?storyboardFinalPrompt(state.project,{...board,data:boardPromptData(board)},videoConfig):composeStoryboardPrompt(state.project,board,generationKind,videoConfig);
  invalidatePreview();
}
function boardPromptData(board){return drafts.get(board.id)?.data||board.data;}
function storyboardFinalPromptOnlyDraft(board){
  if(board?.type!=='storyboard')return false;
  const d=drafts.get(board.id);
  return Boolean(d)&&!board.data.shotIds.some(id=>drafts.has(id))&&d.name===board.name&&d.code===(board.code||'')&&
    Object.keys({...board.data,...d.data}).every(key=>key==='finalPrompt'||JSON.stringify(d.data[key])===JSON.stringify(board.data[key]));
}
function renderStoryboardFinalPrompt(board){
  const set=value=>{const d=getDraft(board);d.data.finalPrompt=value;markDirty();refreshVideoPrompt();};
  return node('div',{class:'stack'},
    node('p',{class:'muted'},'此处全文即实际发送内容；没有最终提示词时显示组合提示词。可粘贴 AI 生成版本，点击生成会先保存修改。带 Subject / S 说话人标签的角色音色引用随音频槽位自动同步；取消音频后改用独立音色。镜头或时长变化后，请重新核对。'),
    field('最终提示词全文（实际发送）',finalPrompt,set,{multiline:true,rows:14,full:true,id:'storyboard-final-prompt'}),
    node('p',{class:'muted'},'H3 草稿保留正式英文标签并补充运镜，原有中文设定不自动翻译；可交给 AI 整理为英文描述，中文对白保持原文。'),
    node('div',{class:'row wrap'},button('生成 H3 结构与运镜草稿',()=>{try{set(formatStoryboardFinalPrompt(state.project,board,videoConfig));}catch(error){notify(error.message,true);}},'small'),
      button('清空并回退组合提示词',()=>set(''),'quiet small'),
      button('保存最终提示词',saveEntity,'primary small',{id:'save-entity',disabled:!drafts.has(board.id)})),
    node('small',{id:'dirty-label'},drafts.has(board.id)?'有未保存的修改':'已保存；空白时自动回退'));
}
function renderStoryboardGeneration(container,board){
  initializeStoryboardGeneration(board);
  const isVideo=generationKind==='video';
  finalPrompt=isVideo?storyboardFinalPrompt(state.project,{...board,data:boardPromptData(board)},videoConfig):composeStoryboardPrompt(state.project,board,generationKind,videoConfig);
  const image=adoptedMedia(board,'image');
  const generation=node('div',{class:'stack'},isVideo?null:generationToolbar(),
    node('p',{class:'note'},'剧情来自本组原镜头，组合提示词自动联动。需要修改剧情、格位或额外要求，请到“镜头与设置”。',button('编辑镜头与设置',()=>switchEditorTab('edit'),'quiet small')),
    dirty&&!storyboardFinalPromptOnlyDraft(board)?node('p',{class:'note error'},'有未保存的组设置或镜头修改，请先逐项保存。'):null,
    node('div',{id:'generation-blockers',class:'note error',hidden:true,role:'status'}));
  if(isVideo){
    generation.append(node('details',{class:'video-section',open:true},node('summary',{},'生成参数'),renderVideoParameters(board)),
      storyboardAudioSection(board),
      !image?node('p',{class:'note error'},'请先生成或绑定四宫格，并在本组“媒体”中采用。'):
        node('p',{class:'note'},'使用本组已采用四宫格，不校验图片的剧情版本或镜头顺序。视频按当前提示词生成。'),
      node('details',{class:'video-section',open:true},node('summary',{},'本次参考素材'),node('p',{class:'muted'},'本组已采用四宫格固定为参考图1，并默认勾选相关角色的已采用图片。只自动选择有明确对白角色的已采用音色，按首次发声排序。本组已采用音频时，音频参数只传这一条（Audio 1），角色音色不再传入。转述与配文不自动关联音色；可手动调整，超出槽位上限会阻止提交。'),renderReferenceControls(board),node('div',{id:'reference-bindings'})),
      node('details',{open:true},node('summary',{},'组合提示词 · 自动组合，不可修改'),node('pre',{id:'storyboard-combination-prompt',class:'prompt-box'},composeStoryboardPrompt(state.project,board,'video',videoConfig))),
      videoVerifySection(board),videoActionBar());
    const task=videoTaskSection(board);if(task)generation.append(task);
  }else{
    generation.append(node('details',{open:true},node('summary',{},'四宫格提示词 · 自动生成'),node('pre',{class:'prompt-box',id:'storyboard-image-prompt'},finalPrompt)),renderReferenceControls(board),node('div',{id:'preview-content',tabindex:'-1'},preview?previewView(preview):previewEmpty()));
  }
  container.replaceChildren(generation);
  if(isVideo){renderBindings($('#reference-bindings'));syncVideoSummary();}
  syncGenerationActions();
}
/* 本组音频：传了本集音频就切这条，没传才切原视频音轨；按本组镜头的打标时间点切一段。
   切点前后留白、起点向下对齐到整帧、终点向上对齐到整帧——宁可多切，不可少切。
   采用后本组视频只传这一条音频（144.audio / Audio 1），不再传各角色音色。 */
let audioCutOptions={before:2,after:3,range:''};
function storyboardAudioSection(board){
  const project=state.project,shots=storyboardShots(project,board),episode=shots[0]?.data.episodeNumber??1;
  const annotations=project.sourceAnnotations?.[episode],audio=adoptedMedia(board,'audio');
  const source=annotations?.audioPath?`已传本集音频${annotations.audioName?'：'+annotations.audioName:''}，切这条`
    :annotations?.videoPath?'没传音频，切原视频音轨':annotations?'没传音频，也没有可用原视频路径':'还没记录镜头，也没传音频';
  const canCut=Boolean(annotations?.audioPath||annotations?.videoPath);
  // 传音频＝写这一集的那一条音频（每集只留一条，再传直接覆盖），和「原视频打标」页共用同一条记录。
  const upload=node('input',{type:'file',accept:'audio/*,.wav,.mp3,.m4a',hidden:true,'aria-label':'传本集音频',onChange:event=>uploadAudio(event.target.files[0])});
  const uploadAudio=async file=>{
    if(!file)return;
    if(file.size>SOURCE_AUDIO_UPLOAD_MAX_BYTES){notify('音频上传上限为 500 MB。',true);return;}
    const result=await perform(async()=>{
      const query=new URLSearchParams({episodeNumber:String(episode),baseVersion:annotations?.currentVersion||'',filename:file.name});
      const response=await fetch(`/api/projects/${encodeURIComponent(project.id)}/source-audio?${query}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Studio-Token':state.csrfToken||''},body:file});
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'音频导入失败，请重试。');
      return payload;
    },'本集音频已传入；再传一次会覆盖这一条');
    if(result){await loadState(false);renderApp();}
  };
  const cut=async()=>{
    const result=await perform(()=>api(`/api/projects/${encodeURIComponent(project.id)}/storyboards/${encodeURIComponent(board.id)}/cut-audio`,{method:'POST',body:{before:Number(audioCutOptions.before),after:Number(audioCutOptions.after),range:audioCutOptions.range,adopt:true}}),'已切出本组音频并采用');
    if(result){videoEditorKey=null;preview=null;await loadState(false);renderApp();}
  };
  return node('details',{class:'video-section',open:true,id:'storyboard-audio-section'},node('summary',{},'本组音频'),
    node('p',{},'按本组镜头的时间点切一段给本组：传了本集音频就切这条，没传才切原视频音轨；前后多留、切点对齐原视频帧。采用后本组视频只传这一条音频（Audio 1），不再传各角色音色。'),
    node('p',{class:'muted',style:'font-size:11px'},`切音来源：${source}。切的是已保存的镜头时间点，先保存再切。`),
    node('div',{class:'video-parameter-grid frame-slots'},
      node('label',{class:'field'},'起点前留（秒）',node('input',{type:'number',min:'0',max:'30',step:'0.5',value:audioCutOptions.before,onInput:event=>{audioCutOptions.before=event.target.value;}})),
      node('label',{class:'field'},'终点后留（秒）',node('input',{type:'number',min:'0',max:'30',step:'0.5',value:audioCutOptions.after,onInput:event=>{audioCutOptions.after=event.target.value;}})),
      node('label',{class:'field'},'指定起止（可留空）',node('input',{value:audioCutOptions.range,placeholder:'例如 00:08-00:15',onInput:event=>{audioCutOptions.range=event.target.value;}}))),
    node('div',{class:'row wrap'},button(annotations?.audioPath?'重传音频（覆盖）':'传音频',()=>upload.click(),'small',{id:'upload-storyboard-audio',disabled:busy}),upload,
      button('切出本组音频',cut,'primary',{id:'cut-storyboard-audio',disabled:busy||!canCut}),
      audio?badge('已采用本组音频','good'):node('small',{class:'muted'},'切出的文件会登记到本组媒体并直接采用')),
    audio?node('audio',{class:'preview-audio',src:mediaUrl(audio),controls:true,preload:'metadata','aria-label':'本组音频试听'}):null);
}
async function loadComposedPrompt(force=false){const entity=selected();if(!entity)return;const entityId=entity.id;const kind=generationKind;const key=`${entity.id}:${currentVersion(entity)}:${kind}:${state.project.versions?.at(-1)?.id||''}`;promptLoading=true;syncGenerationActions();if(force){promptEdited=false;invalidatePreview();}const status=$('#prompt-status');if(status)status.textContent='正在组合全局风格、关联设定和镜头内容…';const prepare=$('#prepare-preview');if(prepare)prepare.disabled=true;try{const result=await api(`/api/entities/${encodeURIComponent(entity.id)}/prompt?projectId=${encodeURIComponent(state.project.id)}&kind=${encodeURIComponent(kind)}`);if(selectedId!==entityId||generationKind!==kind)return;promptLoadedKey=key;if(!promptEdited){finalPrompt=result.prompt;invalidatePreview();const textarea=$('#final-prompt');if(textarea)textarea.value=finalPrompt;}const status=$('#prompt-status');if(status)status.textContent='已组合完整设定。可编辑，准备后原样进入发送预览。';}catch(error){if(selectedId===entityId&&generationKind===kind){const status=$('#prompt-status');if(status)status.textContent='组合失败。请重试，或手动填写完整提示词。';notify(error.message,true);}}finally{if(selectedId===entityId&&generationKind===kind){promptLoading=false;const prepare=$('#prepare-preview');if(prepare)prepare.disabled=dirty;syncGenerationActions();}}}
function renderGenerationTab(){const editor=$('#editor');if(editor)renderEditor(editor);}
function renderBindings(container){
  if(!container)return;
  const refs=allowedReferenceMedia('video').filter(media=>referenceIds.has(media.id));
  const bindings=videoConfig.referenceBindings||[];
  const slots=[
    ['141','image','参考图 1',false],['142','image','参考图 2',false],['143','image','参考图 3',false],
    ['161','image','参考图 4',false],['175','image','参考图 5',false],['176','image','参考图 6',false],
    ['144','audio','参考音频 · 144',false],['160','audio','参考音频 · 160',false],['189','audio','参考音频 · 189',false]
  ];
  container.replaceChildren(node('details',{class:'reference-slots'},node('summary',{},node('span',{class:'grow'},'参考素材槽位'),node('small',{id:'reference-slot-count'},'已自动分配 '+(videoConfig.referenceBindings||[]).length+' 个槽位 · 展开调整')),
    node('p',{class:'muted',style:'font-size:11px'},'已按所选素材自动分配槽位：最多 6 张图、3 段音频。超出时请取消部分素材；不会静默丢弃。空槽不发送素材。'),
    node('div',{class:'reference-slot-grid'},slots.map(([nodeId,fieldName,title,required])=>{
      const choices=refs.filter(media=>media.kind===fieldName);
      const binding=bindings.find(item=>item.nodeId===nodeId&&item.fieldName===fieldName);
      const current=binding?.mediaId||'';
      const mapped=choices.some(media=>media.id===current);
      const select=node('select',{disabled:!choices.length,'aria-label':title,onChange:e=>{
        const next=(videoConfig.referenceBindings||[]).filter(item=>!(item.nodeId===nodeId&&item.fieldName===fieldName));
        if(e.target.value)next.push({nodeId,fieldName,mediaId:e.target.value});
        videoConfig.referenceBindings=next;rebuildVideoBlocks();invalidatePreview();syncVideoConfigText();persistConfig();
        renderBindings(container);
      }},node('option',{value:'',selected:!mapped},choices.length?(required?'未配置 · 请选择图片':'不使用'):'先勾选'+(typeNames[fieldName]||'素材')),choices.map(media=>node('option',{value:media.id,selected:media.id===current},media.entityName+' · '+mediaFilename(media))));
      return node('label',{class:'field'},node('span',{class:'row between'},title,badge(required?(mapped?'已配置':'必需 · 未配置'):'可选',required&&!mapped?'warn':'')),select);
    }))));
  syncReferenceLabels();
}
function previewEmpty(){return node('div',{class:'empty',style:'padding:23px 12px;border:1px dashed var(--line);border-radius:8px'},node('span',{class:'empty-icon',style:'font-size:25px'},'◫'),node('p',{},'完整发送预览将在这里显示'),node('small',{},'修改提示词、参考选择或参数后，需要重新准备。'));}
function previewReference(ref) {
  return node('div',{class:'note'},row(node('strong',{},ref.name||ref.mediaId),badge(typeNames[ref.kind]||ref.kind||'素材')),ref.originalFilename?node('div',{class:'media-filename'},ref.originalFilename):null,
    ref.kind==='audio'?node('audio',{class:'preview-audio',src:mediaUrl({id:ref.mediaId,sha256:ref.sha256}),controls:true,preload:'metadata','aria-label':(ref.originalFilename||ref.name||'参考音频')+'试听'}):null,
    ref.note?node('p',{},ref.note):ref.kind==='audio'?node('p',{},'音色参考；节点作用与克隆效果尚未验证。'):null,
    ref.mime?node('small',{},ref.mime):null,node('div',{},node('code',{},ref.file||'')),node('div',{},node('code',{},'SHA-256 '+(ref.sha256||'未提供'))));
}
async function preparePreview(){const entity=selected();if(!entity||dirty||promptLoading)return;if(generationKind==='video'){refreshVideoPrompt();}const durationControl=$('#video-duration');if(generationKind==='video'&&durationControl&&!durationControl.checkValidity()){durationControl.reportValidity();return;}const epoch=previewEpoch;const entityId=entity.id;const kind=generationKind;const result=await perform(async()=>{const config=generationKind==='video'?requestConfigFromEditor():undefined;return api('/api/previews',{method:'POST',body:{projectId:state.project.id,entityId:entity.id,kind:generationKind,prompt:finalPrompt,referenceMediaIds:(generationKind==='video'?orderedVideoReferences():allowedReferenceMedia().filter(media=>referenceIds.has(media.id))).map(media=>media.id),...(config?{videoConfig:config}:{})}});});if(result){if(epoch!==previewEpoch||selectedId!==entityId||generationKind!==kind){notify('准备期间内容已变化，请重新准备发送预览。');return;}preview=result.preview;operationId=crypto.randomUUID();const content=$('#preview-content');if(content)content.replaceChildren(previewView(preview));syncGenerationActions();if(!(preview.blockers||[]).length)scrollToPreview();}}
function previewView(p){const blockers=p.blockers||[];const content=node('div',{class:'preview-block'},node('div',{class:'row between'},node('h3',{},'发送前完整预览'),button('复制全部预览',()=>copy(p),'small')),node('p',{class:'preview-hash'},`快照 ${p.id} · ${p.hash||''}`),node('div',{class:'preview-block'},node('div',{class:'row between'},node('h4',{},'最终提示词全文'),button('复制提示词',()=>copy(p.prompt),'quiet small')),node('pre',{class:'prompt-box'},p.prompt||'（空）')));
  if(p.agentInstructions)content.append(node('div',{class:'preview-block'},node('h4',{},'发送给 Codex 的任务说明'),node('pre',{class:'prompt-box'},text(p.agentInstructions))));
  if(p.kind==='video')content.append(node('section',{class:'video-output-preview'},node('h4',{},'本次原生生成参数'),node('div',{class:'row wrap'},badge((p.config?.duration||'—')+' 秒'),badge(p.config?.aspectRatio||'比例跟随首帧'),badge((p.output?.resolution||p.config?.outputResolution||'native')==='native'?'保留云端原片':'原生 '+(p.output?.resolution||p.config?.outputResolution)),badge((p.config?.pixels||'—')+' 像素/百万'),p.output?.width&&p.output?.height?badge('目标至少 '+p.output.width+' × '+p.output.height+' px'):null,p.output?.expectedWidth&&p.output?.expectedHeight?badge('预计 '+p.output.expectedWidth+' × '+p.output.expectedHeight+' px'):null),node('p',{class:'muted',style:'font-size:11px'},p.output?.note||'保留云端原片，不进行本机放大；尺寸不足目标会报告未达标。')));
  content.append(node('div',{class:'preview-block'},node('h4',{},`实际引用 · ${p.references?.length||0} 个`),(p.references||[]).length?node('div',{class:'stack'},p.references.map(previewReference)):node('p',{class:'muted',style:'font-size:12px'},'本次不发送参考素材。')),node('div',{class:'preview-block'},node('div',{class:'row between'},node('h4',{},'实际请求与全部参数（不含认证）'),button('复制请求',()=>copy(p.request),'quiet small')),node('pre',{class:'prompt-box'},json(p.request??p.config??{}))));
  if(blockers.length)content.append(node('div',{class:'note error',style:'margin-top:14px'},node('strong',{},'请先解决以下项目'),node('ul',{},blockers.map(item=>node('li',{},typeof item==='string'?item:item.message||json(item))))));
  content.append(node('div',{class:'generation-footer'},node('div',{class:'row between wrap'},node('div',{class:'grow'},node('strong',{},p.kind==='video'?'直接提交 RunningHub':'交给当前 Codex 会话'),node('div',{class:'muted',style:'font-size:11px'},p.kind==='video'?'可能产生 RH 币消耗；仅提交当前镜头。':'创建文件任务，执行后刷新网页登记图片。')),button(p.kind==='video'?'生成镜头视频':'创建 Codex 生图任务',submitPreview,'primary',{disabled:!!blockers.length})),node('small',{},'点击后发送此快照。新结果作为候选，不覆盖已采用版本。')));
  return content;
}
async function submitPreview(){if(!preview||(preview.blockers||[]).length)return;const p=preview;const result=await perform(()=>api('/api/jobs',{method:'POST',body:{previewId:p.id,operationId:operationId||(operationId=crypto.randomUUID()),...(p.kind==='video'?{}:{mode:'desktop'})}}));if(result){await loadState(false);view='jobs';renderApp();notify(p.kind==='video'?'视频任务已创建，请查看状态。':'Codex 文件任务已创建，请复制任务全文交给当前会话。');}}

function sourceAnnotationsText(project, episode, annotations) {
  return [`作品：${project.title}`,`集数：第${episode}集`,`原视频：${annotations.videoPath}`,...(annotations.audioPath?[`本集音频：${annotations.audioName||annotations.audioPath}`]:[]),
    '以下为用户记录的镜头，保留填写顺序、时间点、运镜和画面原文。一个镜头的多个时间标记点分别对应一张原帧与一张生成图，不拆成额外镜头。',
    ...annotations.marks.map((mark,index)=>`\n镜头 ${index+1}${mark.title?`\n标题：${mark.title}`:''}${mark.shotCode?`\n镜号：${mark.shotCode}`:''}\n时间点：${mark.time}\n运镜：${mark.camera}\n画面内容：${mark.content}${mark.comparisons?.length?`\n图片对照记录：${JSON.stringify(mark.comparisons)}`:''}`)].join('\n');
}
function sourceComparisonTaskText(project,episode,annotations) {
  return `${sourceAnnotationsText(project,episode,annotations)}\n\n逐时间点图片任务交接（不代表已授权付费生成）：\n每个有效时间点保留独立原帧和对应生成图；按本作品已采用资产与原帧制作。先查已有结果与在跑任务，缺失项才列入待生成清单。图片按对应镜头和时间点登记，保留旧媒体与候选，不自动采用。\n交付时通过正常 source-annotations 接口和当前 baseVersion 保存 comparisons：time 为秒数字符串，sourceMediaId 为已登记原帧（可选），generatedMediaId 为对应生成图，sourceVideoPath 为本次原视频路径。逐对对照后记录 status（unreviewed / pass / note / needs_review）和 note（检查方法、范围、偏差与未完成项）；未检查保留 unreviewed。`;
}
function sourceAnnotationTime(seconds) {
  const ms=Math.max(0,Math.round((Number(seconds)||0)*1000));
  return `${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}
function sourceAnnotationTimePoints(value) {
  const points=value.split(/[,，]/).map(point=>point.trim()).filter(Boolean);
  return (points.length?points:['']).map(label=>{
    const start=label.split(/[–—~～→-]|至/,1)[0].trim().replaceAll('：',':').replace(/(?:秒|s)$/i,'').trim();
    const parts=start.split(':').map(Number);
    const valid=/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(start)&&parts.slice(1).every(part=>part<60);
    const seconds=parts.reduce((total,part)=>total*60+part,0);
    return {label,seconds:valid&&Number.isFinite(seconds)?seconds:null};
  });
}
function renderSourceComparison(container,project,episode,entry,getSaved,changed,jumpToTime,scheduleAutoSave) {
  let filter='all';
  let timelinePoints=[],cards=[],activePoint=null,sourceFrames=[];
  const opened=new Set();
  const statuses=[['unreviewed','待检查'],['pass','未发现明显问题'],['note','轻微偏差'],['needs_review','需复核']];
  const timeline=node('div',{class:'source-comparison-timeline',role:'group','aria-label':'比对时间点'});
  const list=node('div',{class:'stack source-comparison-list'});
  const summary=node('p',{class:'muted','aria-live':'polite'});
  const sync=(seconds,target=null)=>{
    if(!timelinePoints.length)return;
    let current=null;
    for(const item of timelinePoints){
      if(item.seconds<=seconds&&(!current||item.seconds>current.seconds))current=item;
    }
    current??=timelinePoints.reduce((first,item)=>item.seconds<first.seconds?item:first);
    current=target||(activePoint?.seconds===current.seconds?activePoint:current);
    if(current===activePoint&&!target)return;
    activePoint=current;
    for(const card of cards)card.hidden=card!==current.card;
    for(const item of timelinePoints){item.section.hidden=item!==current;item.button.setAttribute('aria-pressed',String(item===current));}
    timeline.scrollLeft=current.button.offsetLeft-(timeline.clientWidth-current.button.offsetWidth)/2;
  };
  const draw=()=>{
    const saved=getSaved();
    list.replaceChildren();timeline.replaceChildren();timelinePoints=[];cards=[];activePoint=null;sourceFrames=[];
    let total=0,paired=0,visible=0;
    entry.marks.forEach((mark,index)=>{
      const {shot,images}=sourceComparisonContext(project,episode,mark,index,entry.marks.length);
      const points=sourceAnnotationTimePoints(mark.time).filter(point=>point.seconds!==null);
      const title=sourceComparisonTitle(mark,shot,index),code=mark.shotCode||`镜头 ${index+1}`;
      const pairs=points.map(point=>{
        const comparison=sourceComparisonFor(mark,point.seconds)||{};
        const source=images.find(media=>media.id===comparison.sourceMediaId);
        const generated=images.find(media=>media.id===comparison.generatedMediaId);
        const outdated=!!comparison.sourceVideoPath&&comparison.sourceVideoPath!==entry.videoPath;
        const status=outdated||comparison.generatedMediaId&&!generated||comparison.sourceMediaId&&!source?'needs_review':!generated?'unreviewed':comparison.status||'unreviewed';
        total++;if(generated&&!outdated&&(!comparison.sourceMediaId||source))paired++;
        return {point,comparison,source,generated,outdated,status};
      });
      const matches=filter==='all'||pairs.some(pair=>filter==='missing'?!pair.generated:pair.status===filter);
      if(!matches)return;visible++;
      const editable=(key,label,value)=>{
        let composing=false;
        return node('label',{class:`source-comparison-${key}`},node('strong',{},label),node('textarea',{
          value,rows:key==='camera'?3:5,maxlength:20000,placeholder:`待填写${label}`,'aria-label':`${code} ${label}`,
          onInput:event=>{mark[key]=event.target.value;changed();if(!composing&&!event.isComposing)scheduleAutoSave();},
          onCompositionstart:()=>{composing=true;clearTimeout(entry.autoSaveTimer);},
          onCompositionend:()=>{composing=false;scheduleAutoSave();},
          onBlur:()=>{if(!composing&&entry.dirty)scheduleAutoSave(0);}
        }),node('small',{},'修改后自动保存'));
      };
      const card=node('article',{class:'panel panel-pad source-comparison-card stack','data-source-shot':index});
      cards.push(card);
      for(const {point,comparison,source,generated,outdated,status} of pairs){
        const update=(key,value)=>{
          let record=sourceComparisonFor(mark,point.seconds);
          if(!record){record={time:String(point.seconds)};(mark.comparisons??=[]).push(record);}
          record[key]=value;
          if(key==='generatedMediaId'||key==='sourceMediaId'){
            if(outdated)delete record[key==='generatedMediaId'?'sourceMediaId':'generatedMediaId'];
            record.status='unreviewed';record.sourceVideoPath=entry.videoPath;
          }
          changed();
        };
        const sourceUrl=source?mediaUrl(source):!comparison.sourceMediaId&&saved?.videoPath&&saved.videoPath===entry.videoPath?`/api/projects/${encodeURIComponent(project.id)}/source-frame?${new URLSearchParams({episodeNumber:episode,time:point.seconds,version:saved.currentVersion})}`:null;
        const image=(url,label,empty)=>{
          const picture=url?node('img',{src:url,alt:`${title} · ${point.label} · ${label}`,loading:'lazy',onError:event=>event.target.replaceWith(node('span',{class:'muted'},'图片暂不可用，请检查原视频、时间点或媒体文件。'))}):null;
          const link=url?node('a',{href:url,target:'_blank',rel:'noopener','aria-label':`放大${label}`},picture):null;
          if(url?.includes('/source-frame?'))sourceFrames.push({picture,link,url,version:saved.currentVersion});
          return node('figure',{},node('div',{class:'source-comparison-image'},link||node('span',{class:'muted'},empty)),node('figcaption',{},label));
        };
        const selectImage=(key,label,current)=>node('label',{class:'field'},label,node('select',{'aria-label':`${title} ${point.label} ${label}`,onChange:event=>{update(key,event.target.value);draw();}},
          node('option',{value:'',selected:!current},key==='sourceMediaId'?'从原视频提取原帧':'待生成 / 选择对应图片'),
          current&&!images.some(media=>media.id===current)?node('option',{value:current,selected:true},'原关联图片不可用，请重新选择'):null,
          images.map(media=>node('option',{value:media.id,selected:media.id===current},`${media.entityName} · ${mediaFilename(media)}`))));
        const section=node('section',{class:'source-comparison-point stack'},
          node('div',{class:'source-comparison-pair'},image(generated?mediaUrl(generated):null,'AI 生成画面',comparison.generatedMediaId?'原关联图片不可用，请重新选择':'等待此时间点的生成图')),
          node('div',{class:'row between wrap'},node('h3',{},`时间点 ${point.label}`),node('span',{class:`badge ${status==='needs_review'?'bad':status==='pass'?'good':status==='note'?'warn':''}`},statuses.find(item=>item[0]===status)?.[1]||'待检查')),
          outdated?node('p',{class:'note error'},'原视频已更换：这组图片来自旧原视频，请重新配对并检查。'):null,
          node('details',{class:'source-comparison-details',open:opened.has(`${index}:${point.seconds}`),onToggle:event=>{const key=`${index}:${point.seconds}`;if(event.target.open)opened.add(key);else opened.delete(key);}},node('summary',{},'配图与检查记录'),node('div',{class:'stack'},
            node('div',{class:'source-comparison-pair'},image(sourceUrl,'原视频画面',comparison.sourceMediaId?'原关联图片不可用，请重新选择':'保存原视频路径后显示原帧')),
            shot?null:node('p',{class:'note'},'请在“镜头编辑”中指定本集对应镜号，生成图登记到该镜头或所属故事板后可在这里选择。'),
            node('div',{class:'source-mark-fields'},selectImage('sourceMediaId','原图来源',comparison.sourceMediaId),selectImage('generatedMediaId','对应生成图',comparison.generatedMediaId)),
            node('label',{class:'field'},'检查状态',node('select',{'aria-label':`${title} ${point.label} 检查状态`,onChange:event=>{update('status',event.target.value);draw();}},statuses.map(([value,label])=>node('option',{value,selected:value===status,disabled:value!=='unreviewed'&&(!sourceUrl||!generated||outdated)},label)))),
            field('检查说明',comparison.note||'',value=>update('note',value),{multiline:true,rows:3,placeholder:'记录检查方法、范围、偏差与未完成项；尚未检查请留待检查。'}),
            generated?node('details',{},node('summary',{},'生成图实际提示词'),node('pre',{class:'prompt-box'},generated.prompt||'此图片未记录生成提示词')):null)));
        const item={seconds:point.seconds,section,card};
        const timeButton=button(`${code} · ${point.label}`,()=>{
          if(jumpToTime(point.seconds)===false)return;
          entry.videoTime=point.seconds;sync(point.seconds,item);
        },'small',{'aria-label':`跳转 ${code} ${point.label}`,'aria-pressed':false});
        item.button=timeButton;timelinePoints.push(item);timeline.append(timeButton);
        card.append(section);
      }
      if(!points.length)card.append(node('p',{class:'note'},'填写有效时间标记后显示图片对照；暂定文字仍可原样保存。'));
      card.append(node('div',{class:'row between wrap source-comparison-heading'},node('h2',{},code===title?title:`${code} · ${title}`),node('span',{class:'badge'},`${points.length} 个时间点`)),
        editable('camera','运镜',mark.camera?.trim()?mark.camera:shot?.data.camera||''),editable('content','详情',mark.content||''),
        node('small',{class:'muted'},`时间标记：${mark.time||'待填写'}${shot?` · 对应 ${shot.code}`:' · 尚未关联工作台镜头'}`),
        node('details',{class:'source-comparison-details'},node('summary',{},'关联信息'),node('small',{},shot?`工作台：${shot.code} · ${shot.name}`:'尚未指定对应镜头')));
      list.append(card);
    });
    summary.textContent=`${entry.marks.length} 个镜头 · ${total} 个有效时间点 · ${paired} 组已配生成图`;
    if(!visible)list.append(node('div',{class:'empty panel'},entry.marks.length?'此筛选下暂无镜头。':'还没有镜头，请先在“镜头编辑”中添加。'));
    sync(entry.videoTime);
  };
  container.replaceChildren(timeline,list,node('div',{class:'source-comparison-toolbar panel panel-pad'},node('div',{class:'stack'},node('h2',{},'逐时间点比对分析'),summary),
    node('select',{'aria-label':'筛选图片对照',onChange:event=>{filter=event.target.value;draw();}},[['all','全部镜头'],['missing','待配生成图'],['needs_review','需复核']].map(([value,label])=>node('option',{value},label))),
    button('复制逐时间点生图任务',()=>{
      const saved=getSaved();
      if(entry.dirty||!saved){notify('请先保存镜头，再复制当前已保存的任务。',true);return;}
      copy(sourceComparisonTaskText(project,episode,saved));
    },'small')),node('p',{class:'muted source-comparison-hint'},'点击时间点定位原视频；播放和拖动进度条时，右侧自动切换到最近经过的时间点。'));
  draw();
  return {sync,refreshSaved:()=>{
    const saved=getSaved();
    for(const frame of sourceFrames){
      if(frame.version===saved?.currentVersion)continue;
      frame.version=saved.currentVersion;
      const url=frame.url.replace(/version=[^&]*/,`version=${encodeURIComponent(saved.currentVersion)}`);
      frame.picture.setAttribute('src',url);frame.link.setAttribute('href',url);
    }
  }};
}
function destroySourceAnnotationPlayer() {
  const player=sourceAnnotationPlayer;sourceAnnotationPlayer=null;
  if(player)try{player.destroy();}catch{}
}
async function uploadSourceVideo(file) {
  if(!file)return;
  if(file.size>SOURCE_VIDEO_UPLOAD_MAX_BYTES){notify('原视频上传上限为 1 GB。',true);return;}
  const projectId=state.project.id,episodeNumber=currentEpisode,entry=sourceAnnotationsDraft(),previousPath=entry.videoPath;
  const result=await perform(async()=>{
    entry.uploading=true;renderApp();
    try {
      const query=new URLSearchParams({episodeNumber,baseVersion:entry.baseVersion||'',filename:file.name});
      const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/source-video?${query}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Studio-Token':state.csrfToken||''},body:file});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'原视频上传失败，请重试。');
      return result;
    } finally {entry.uploading=false;}
  },'原视频已上传，可直接记录镜头');
  if(result){
    entry.baseVersion=result.annotations.currentVersion;
    if(entry.videoPath===previousPath)entry.videoPath=result.annotations.videoPath;
    entry.dirty=JSON.stringify({videoPath:entry.videoPath,audioPath:entry.audioPath||'',marks:entry.marks})!==JSON.stringify({videoPath:result.annotations.videoPath,audioPath:result.annotations.audioPath||'',marks:result.annotations.marks});
    if(state.project?.id===projectId)(state.project.sourceAnnotations??={})[episodeNumber]=result.annotations;
  }
  if(state.project?.id===projectId&&currentEpisode===episodeNumber&&view==='annotations')renderApp();
}
async function uploadSourceAudio(file) {
  if(!file)return;
  if(file.size>SOURCE_AUDIO_UPLOAD_MAX_BYTES){notify('音频上传上限为 500 MB。',true);return;}
  const projectId=state.project.id,episodeNumber=currentEpisode,entry=sourceAnnotationsDraft();
  const result=await perform(async()=>{
    entry.uploadingAudio=true;renderApp();
    try {
      const query=new URLSearchParams({episodeNumber,baseVersion:entry.baseVersion||'',filename:file.name});
      const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/source-audio?${query}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Studio-Token':state.csrfToken||''},body:file});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'音频导入失败，请重试。');
      return result;
    } finally {entry.uploadingAudio=false;}
  },'本集音频已导入；再导一次会覆盖这一条');
  if(result){
    entry.baseVersion=result.annotations.currentVersion;
    entry.audioPath=result.annotations.audioPath||'';
    entry.audioName=result.annotations.audioName||'';
    entry.audioDuration=result.annotations.audioDuration??null;
    entry.dirty=JSON.stringify({videoPath:entry.videoPath,audioPath:entry.audioPath,marks:entry.marks})!==JSON.stringify({videoPath:result.annotations.videoPath,audioPath:result.annotations.audioPath,marks:result.annotations.marks});
    if(state.project?.id===projectId)(state.project.sourceAnnotations??={})[episodeNumber]=result.annotations;
  }
  if(state.project?.id===projectId&&currentEpisode===episodeNumber&&view==='annotations')renderApp();
}
function sourceAnnotationsDraft() {
  const key=`${state.project.id}:${currentEpisode}`,saved=state.project.sourceAnnotations?.[currentEpisode];
  let entry=sourceAnnotationDrafts.get(key);
  if(!entry||(!entry.dirty&&entry.baseVersion!==(saved?.currentVersion||null))){
    entry={baseVersion:saved?.currentVersion||null,videoPath:saved?.videoPath||'',audioPath:saved?.audioPath||'',audioName:saved?.audioName||'',audioDuration:saved?.audioDuration??null,marks:structuredClone(saved?.marks||[]),dirty:false,videoTime:entry?.videoTime||0};
    sourceAnnotationDrafts.set(key,entry);
  }
  return entry;
}
async function saveSourceAnnotations(project=state.project,episodeNumber=currentEpisode,entry=sourceAnnotationsDraft(),automatic=false) {
  const projectId=project.id;
  const data={videoPath:entry.videoPath,audioPath:entry.audioPath||'',audioName:entry.audioName||'',audioDuration:entry.audioDuration??null,marks:structuredClone(entry.marks)},snapshot=JSON.stringify({videoPath:data.videoPath,audioPath:data.audioPath,marks:data.marks});
  const result=await perform(()=>api(`/api/projects/${encodeURIComponent(projectId)}/source-annotations`,{method:'PUT',body:{episodeNumber,baseVersion:entry.baseVersion,...data}}),automatic?null:'镜头已原样保存');
  if(!result)return;
  entry.baseVersion=result.annotations.currentVersion;
  if(JSON.stringify({videoPath:entry.videoPath,audioPath:entry.audioPath||'',marks:entry.marks})===snapshot)entry.dirty=false;
  (project.sourceAnnotations??={})[episodeNumber]=result.annotations;
  if(state.project?.id===projectId){
    (state.project.sourceAnnotations??={})[episodeNumber]=result.annotations;
  }
  return result;
}
function renderSourceAnnotations(container) {
  const project=state.project,episodeNumber=currentEpisode;
  container.append(heading('原视频镜头','一个镜头可包含多个时间标记，保存后逐点查看原图与生成图的比对分析。'));
  if(currentEpisode==='all'){
    container.append(node('section',{class:'panel panel-pad stack'},node('p',{},'请选择要记录镜头的集数。'),node('div',{class:'row wrap'},(project.episodes||[1]).map(number=>button(episodeLabel(number),()=>changeEpisode(String(number)))))));
    return;
  }
  const entry=sourceAnnotationsDraft();
  let saved=project.sourceAnnotations?.[episodeNumber];
  const status=node('span',{class:'dirty-label',role:'status'},entry.dirty?'有未保存修改':saved?'已保存':'尚未保存');
  const changed=()=>{entry.dirty=true;entry.saveFailed=false;status.textContent='有未保存修改';};
  const playerNote=node('p',{class:'muted'},'拖动时间轴定位，可新建镜头，或把当前时间加入已有镜头。单个视频上限 1 GB。');
  const clock=node('span',{class:'source-video-clock',role:'timer'},sourceAnnotationTime(entry.videoTime));
  let comparisonView={sync:()=>{},refreshSaved:()=>{}};
  let frameVideo=null,frameRequest=null;
  const stopFrameSync=()=>{if(frameRequest!==null)frameVideo.cancelVideoFrameCallback(frameRequest);frameRequest=null;frameVideo=null;};
  const syncFrame=(_,metadata)=>{
    frameRequest=null;
    if(!frameVideo||frameVideo!==player||!frameVideo.isConnected||frameVideo.paused||frameVideo.ended)return;
    if(entry.tab==='comparison')comparisonView.sync(metadata.mediaTime);
    frameRequest=frameVideo.requestVideoFrameCallback(syncFrame);
  };
  const startFrameSync=event=>{stopFrameSync();frameVideo=event.target;if(frameVideo.requestVideoFrameCallback)frameRequest=frameVideo.requestVideoFrameCallback(syncFrame);};
  const updatePlayback=event=>{entry.videoTime=event.target.currentTime;clock.textContent=sourceAnnotationTime(entry.videoTime);if(entry.tab==='comparison')comparisonView.sync(entry.videoTime);};
  const makePlayer=annotations=>annotations?.videoPath?node('video',{id:'source-annotation-player',src:`/api/projects/${encodeURIComponent(project.id)}/source-video?episodeNumber=${episodeNumber}&v=${encodeURIComponent(annotations.currentVersion)}`,controls:true,playsinline:true,preload:'metadata','aria-label':'原视频镜头预览',onPlay:startFrameSync,onPause:stopFrameSync,onEnded:stopFrameSync,onTimeupdate:updatePlayback,onSeeked:updatePlayback,onLoadedmetadata:event=>{
    const video=event.target;
    if(entry.videoTime)video.currentTime=entry.videoTime;
    if(video.videoWidth&&video.videoHeight){layout.style.setProperty('--stage-ratio',`${video.videoWidth} / ${video.videoHeight}`);layout.style.setProperty('--stage-ar',video.videoWidth/video.videoHeight);}
  },onError:()=>{playerNote.textContent='浏览器暂时无法播放这个原文件；你仍可保存镜头，或选择浏览器支持的 MP4 / WebM 视频。';}}):null;
  let player=makePlayer(saved);
  const emptyVideo=()=>node('div',{class:'source-video-empty'},node('strong',{},'上传原视频，边看边记录镜头'),node('span',{},'点击“上传原视频”选择文件'));
  const stage=node('div',{class:'preview-stage source-video-stage','data-kind':'video'},player||emptyVideo());
  const mountPlayer=()=>{if(player&&typeof window.Plyr==='function')try{sourceAnnotationPlayer=new window.Plyr(player,{...previewPlayerOptions,hideControls:false,keyboard:{focused:true,global:false}});}catch{}};
  const upload=node('input',{type:'file',accept:'video/*,.mp4,.webm,.mov,.mkv,.m4v',hidden:true,disabled:!!entry.uploading,'aria-label':'上传原视频',onChange:event=>uploadSourceVideo(event.target.files[0])});
  const jumpToTime=seconds=>{
    if(!player)return true;
    if(seconds===null){notify('请填写秒数或分:秒，例如 00:04.267；多个关键帧用逗号分隔。',true);return false;}
    if(Number.isFinite(player.duration)&&seconds>player.duration){notify('这个时间点超出了视频时长，镜头内容仍可原样保存。',true);return false;}
    try{player.currentTime=seconds;updatePlayback({target:player});return true;}
    catch{notify('视频暂时无法跳转，请等视频载入后重试。',true);return false;}
  };
  const marks=node('div',{class:'source-mark-list stack'});
  // 切音频靠「打标 ↔ 镜头」的对应关系：这里给出的镜号优先，留空时按本集镜头顺序对应。
  const episodeCodes=(state.project.shots||[]).filter(shot=>(shot.data.episodeNumber??1)===Number(currentEpisode)).sort((a,b)=>a.order-b.order).map(shot=>shot.code).filter(Boolean);
  const drawMarks=()=>{
    marks.replaceChildren();
    entry.marks.forEach((mark,index)=>{
    const jumps=node('div',{class:'row wrap'});
    const refreshJumps=()=>{
      const points=sourceAnnotationTimePoints(mark.time);
      jumps.replaceChildren(...points.map(point=>button(points.length>1?`跳转 ${point.label}`:'跳转到时间点',()=>jumpToTime(point.seconds),'small',{disabled:!player})),button('＋ 加入当前时间点',()=>{
        const time=sourceAnnotationTime(player.currentTime);mark.time=mark.time?`${mark.time}，${time}`:time;changed();drawMarks();
      },'small',{disabled:!player}));
    };
    const timeField=field('时间标记点 / 范围',mark.time,value=>{mark.time=value;changed();refreshJumps();},{placeholder:'例如 00:01.800，00:02.500；多个时间点仍属于同一个镜头'});
    refreshJumps();
    const codes=[...(mark.shotCode&&!episodeCodes.includes(mark.shotCode)?[mark.shotCode]:[]),...episodeCodes];
    const codeField=node('label',{class:'field'},'对应工作台镜号（配图与切音频）',node('select',{'aria-label':`镜头 ${index+1} 对应镜号`,onChange:event=>{mark.shotCode=event.target.value;changed();}},
      node('option',{value:'',selected:!mark.shotCode},codes.length?'未指定（按本集顺序对应）':'未指定'),codes.map(code=>node('option',{value:code,selected:code===mark.shotCode},code))));
    marks.append(node('section',{class:'panel panel-pad stack','data-source-mark':index},
      node('div',{class:'row between'},node('h3',{},`镜头 ${index+1}`),button('删除此镜头',()=>{entry.marks.splice(index,1);changed();drawMarks();},'quiet small danger')),
      field('标题',mark.title||'',value=>{mark.title=value;changed();},{placeholder:'例如 巨蛙与露洁对峙'}),
      node('div',{class:'source-mark-fields'},node('div',{class:'stack'},timeField,jumps),
        field('运镜',mark.camera,value=>{mark.camera=value;changed();},{multiline:true,rows:2,placeholder:'按你的描述填写，可留空'})),
      node('details',{class:'source-comparison-details'},node('summary',{},'画面内容与镜头关联'),node('div',{class:'stack'},codeField,field('画面内容',mark.content,value=>{mark.content=value;changed();},{multiline:true,rows:4,placeholder:'人物、站位、动作、构图等，可先记一部分'})))));
    });
    if(!entry.marks.length)marks.append(node('div',{class:'empty panel'},'暂无镜头，可在当前时间新建镜头，或直接新增空白镜头。'));
  };
  drawMarks();
  const addMark=atCurrentTime=>{entry.marks.push({time:atCurrentTime?sourceAnnotationTime(player.currentTime):'',shotCode:'',camera:'',content:''});changed();drawMarks();};
  const copyMarks=button('复制已保存镜头',()=>copy(sourceAnnotationsText(project,currentEpisode,project.sourceAnnotations[currentEpisode])),'small',{disabled:!saved});
  const addAtTime=button('在当前时间新建镜头',()=>addMark(true),'primary',{disabled:!player});
  const uploadButton=button(entry.uploading?'正在上传…':saved?.videoPath?'更换原视频':'上传原视频',()=>upload.click(),'primary',{disabled:busy||!!entry.uploading});
  // 本集音频：只保留一条，重新导入直接覆盖；故事板切音频时优先用它，没有才退回原视频音轨。
  const audioUpload=node('input',{type:'file',accept:'audio/*,.wav,.mp3,.m4a',hidden:true,disabled:!!entry.uploadingAudio,'aria-label':'导入本集音频',onChange:event=>uploadSourceAudio(event.target.files[0])});
  const audioButton=button(entry.uploadingAudio?'正在导入…':saved?.audioPath?'重新导入（覆盖）':'导入音频',()=>audioUpload.click(),'small',{disabled:busy||!!entry.uploadingAudio,id:'source-audio-upload'});
  const audioPanel=node('div',{class:'stack',style:'margin-top:12px;border-top:1px solid var(--line);padding-top:12px'},
    node('div',{class:'row between wrap'},node('h3',{},'本集音频'),audioButton),audioUpload,
    node('p',{class:'muted',style:'font-size:11px'},'只放一条：再导一次直接覆盖上一条。故事板切音频时，有这条就切这条，没有才切原视频音轨。'),
    saved?.audioPath?node('audio',{class:'preview-audio',src:`/api/projects/${encodeURIComponent(project.id)}/source-audio?episodeNumber=${currentEpisode}&v=${encodeURIComponent(saved.currentVersion)}`,controls:true,preload:'metadata','aria-label':'本集音频试听'}):node('small',{class:'muted'},'尚未导入音频'),
    saved?.audioPath?node('small',{class:'muted'},`${saved.audioName||'已导入音频'}${Number(saved.audioDuration)>0?` · ${Number(saved.audioDuration).toFixed(2)} 秒`:''}`):null);
  const saveButton=node('button',{type:'submit',class:'primary',disabled:busy},'保存镜头');
  const comparisonPanel=node('div',{class:'stack',id:'source-comparison-panel',hidden:true});
  const scheduleAutoSave=(delay=600)=>{clearTimeout(entry.autoSaveTimer);entry.autoSaveTimer=setTimeout(()=>save(true),delay);};
  entry.syncSaveStatus=()=>{
    saved=project.sourceAnnotations?.[episodeNumber];copyMarks.disabled=!saved;
    comparisonView.refreshSaved();
    status.textContent=entry.saving?'正在保存…':entry.saveFailed?'保存未完成，请重试':entry.dirty?'有未保存修改':saved?'已保存':'尚未保存';
    saveButton.disabled=!!entry.saving||busy;saveButton.textContent=entry.saving?'保存中…':'保存镜头';
  };
  const save=async(automatic=false)=>{
    if(entry.saving||busy||entry.uploading||entry.uploadingAudio){if(automatic)scheduleAutoSave();return;}
    clearTimeout(entry.autoSaveTimer);entry.autoSaveTimer=null;
    entry.saving=true;entry.saveFailed=false;entry.syncSaveStatus();
    try {
      const result=await saveSourceAnnotations(project,episodeNumber,entry,automatic);
      entry.saveFailed=!result;
      if(!result)return;
      const videoChanged=(saved?.videoPath||'')!==result.annotations.videoPath;
      saved=result.annotations;copyMarks.disabled=false;
      if(videoChanged&&$('#source-annotation-form')===form){
        destroySourceAnnotationPlayer();
        entry.videoTime=0;clock.textContent=sourceAnnotationTime(0);
        player=makePlayer(saved);stage.replaceChildren(player||emptyVideo());mountPlayer();
        addAtTime.disabled=!player;uploadButton.textContent=player?'更换原视频':'上传原视频';drawMarks();
      }
      if(!automatic&&entry.tab==='comparison')comparisonView=renderSourceComparison(comparisonPanel,project,episodeNumber,entry,()=>saved,changed,jumpToTime,scheduleAutoSave);
    } finally {entry.saving=false;entry.syncSaveStatus();}
  };
  const layout=node('div',{class:'source-annotations-layout',style:'--stage-ratio:16 / 9;--stage-ar:1.7778'},
      node('section',{class:'panel panel-pad stack source-annotation-video'},
        node('div',{class:'row between wrap'},node('h2',{},'原视频'),uploadButton),upload,
        stage,
        node('div',{class:'preview-controls'},node('span',{class:'muted'},'当前时间'),clock,addAtTime),playerNote,audioPanel,
        node('details',{},node('summary',{},'已有本机路径？也可直接引用'),field('原视频本机路径（可留空）',entry.videoPath,value=>{entry.videoPath=value;changed();},{placeholder:'例如 E:\\素材\\原视频.mp4'}))),
      node('div',{class:'stack',id:'source-annotations-editor'},node('div',{class:'row between wrap'},
        button('＋ 新增镜头',()=>addMark(false)),
        copyMarks),marks),comparisonPanel);
  const form=node('form',{id:'source-annotation-form',class:'stack',noValidate:true,onSubmit:event=>{event.preventDefault();return save();}},layout,
    node('div',{class:'row between source-annotation-save'},status,saveButton));
  const showTab=tab=>{
    entry.tab=tab;
    $('#source-annotations-editor',form).hidden=tab==='comparison';comparisonPanel.hidden=tab!=='comparison';
    editTab.setAttribute('aria-pressed',String(tab!=='comparison'));compareTab.setAttribute('aria-pressed',String(tab==='comparison'));
    if(tab==='comparison')comparisonView=renderSourceComparison(comparisonPanel,project,episodeNumber,entry,()=>saved,changed,jumpToTime,scheduleAutoSave);
    else drawMarks();
  };
  const editTab=button('镜头编辑',()=>showTab('edit'),'source-tab',{'aria-pressed':true});
  const compareTab=button('比对分析',()=>showTab('comparison'),'source-tab',{'aria-pressed':false});
  container.append(node('div',{class:'source-annotation-tabs view-switch',role:'group','aria-label':'原视频镜头视图'},editTab,compareTab),form);
  mountPlayer();
  entry.syncSaveStatus();
  if(entry.autoSaveTimer)scheduleAutoSave();
  if(entry.tab==='comparison')showTab('comparison');
}

function renderVideoReferences(container) {
  const draft=videoReferenceDraft;
  const fileInput=node('input',{type:'file',accept:'.mp4,video/mp4','aria-label':'选择要转换的 MP4 视频',onChange:event=>{
    draft.file=event.target.files?.[0]||null;draft.operationId=null;renderVideoReferences(container);
  }});
  const choices=[['depth','深度参考'],['pose','骨骼参考'],['mixed','深度与骨骼混合参考']];
  const submit=node('button',{type:'submit',class:'primary',disabled:busy||!draft.file||!draft.outputs.length||!state.capabilities?.runninghub?.configured},'开始转换');
  const form=node('form',{class:'panel stack',onSubmit:async event=>{
    event.preventDefault();
    if(!draft.file||!draft.outputs.length)return;
    if(draft.file.size>=VIDEO_REFERENCE_UPLOAD_MAX_BYTES){notify('参考视频须小于 30 MB。',true);return;}
    const file=draft.file,outputs=[...draft.outputs],operationId=draft.operationId||(draft.operationId=crypto.randomUUID());
    submit.disabled=true;
    try {
      const result=await perform(async()=>{
        const query=new URLSearchParams({filename:file.name,operationId,outputs:outputs.join(',')});
        const response=await fetch(`/api/video-references?${query}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Studio-Token':state.csrfToken||''},body:file});
        const result=await response.json();if(!response.ok)throw new Error(result.error||'视频转参考提交失败');return result;
      });
      if(result){await loadState(false);if(view==='references')renderVideoReferences(container);notify(result.job.error||'已保存转换任务，可在下方查看进度。',!!result.job.error);}
    } finally {submit.disabled=busy||!draft.file||!draft.outputs.length||!state.capabilities?.runninghub?.configured;}
  }},node('h3',{},'选择视频与参考类型'),fileInput,draft.file?node('p',{},`${draft.file.name} · ${(draft.file.size/1000000).toFixed(2)} MB`):null,
  node('div',{class:'row wrap'},choices.map(([value,label])=>node('label',{class:'row'},node('input',{type:'checkbox',checked:draft.outputs.includes(value),onChange:event=>{
    draft.outputs=event.target.checked?[...draft.outputs,value]:draft.outputs.filter(item=>item!==value);draft.operationId=null;submit.disabled=busy||!draft.file||!draft.outputs.length||!state.capabilities?.runninghub?.configured;
  }}),label))),
  node('small',{class:'muted'},'MP4 须小于 30 MB；使用标准实例。可一次选择多种参考，同一素材与参数沿用已有任务。'),
  !state.capabilities?.runninghub?.configured?node('p',{class:'note error'},'请先在“接口与工作流设置”保存 RunningHub 密钥。'):null,submit);
  const jobs=(state.jobs||[]).filter(job=>job.purpose==='video_reference').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  container.replaceChildren(heading('视频转参考','生成深度、骨骼或混合参考，文件独立保存。',button('刷新进度',async()=>{await perform(async()=>{await loadState(false);renderVideoReferences(container);});})),form,
    node('div',{class:'note'},'转换会使用 RunningHub 额度。结果保留原生文件，等待你审看后选用。'),
    jobs.length?node('div',{class:'task-list'},jobs.map(renderTask)):node('div',{class:'empty panel'},'还没有视频转参考任务'));
}
function renderJobs(container){const jobs=(state.jobs||[]).filter(j=>!j.projectId||!state.project||j.projectId===state.project.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));const filtered=jobs.filter(j=>taskFilter==='all'||j.kind===taskFilter);
  const autoRun=latestAutoRun();
  container.replaceChildren(heading('生成任务','图片由当前 Codex 会话交付；视频由本机后端查询并下载。',button('刷新任务',async()=>{await perform(async()=>{await loadState(false);renderJobs(container);});},'')),...autoRun?[autoRunPanel(autoRun)]:[],node('div',{class:'filter-chips'},[['all','全部'],['image','Codex 图片'],['video','RunningHub 视频'],['prompt','提示词']].map(([value,label])=>button(`${label} ${value==='all'?jobs.length:jobs.filter(j=>j.kind===value).length}`,()=>{taskFilter=value;renderJobs(container);},taskFilter===value?'active':''))));
  if(!filtered.length){container.append(node('div',{class:'empty panel'},node('span',{class:'empty-icon'},'◷'),node('h3',{},'还没有生成任务'),node('p',{},'选中资产或镜头，准备发送预览后创建任务。'),button('去角色资产',()=>changeView('character'),'primary')));return;}
  container.append(node('div',{class:'task-list'},filtered.map(job=>renderTask(job))));
}
function renderTask(job){const entity=entities().find(e=>e.id===job.entityId);const status=statusNames[job.status]||job.status||'未知状态';const success=['ready','completed','succeeded'].includes(job.status);const fail=['failed','query_failed','delivery_invalid','submission_unknown','blocked'].includes(job.status);const instruction=job.instruction||job.instructions||job.snapshot?.agentInstructions;const directory=job.deliveryDirectory||job.stagingDirectory;
  const card=node('article',{class:'panel task-card'},node('div',{class:'row between wrap'},node('div',{},node('h3',{},job.purpose==='video_reference'?`视频转参考 · ${job.snapshot.source.filename}`:`${typeNames[job.kind]||job.kind} · ${entity?.name||job.entityId}`),node('small',{},`${date(job.createdAt)} · ${job.id}`)),badge(status,success?'good':fail?'bad':'warn')),job.error?node('div',{class:'note error',style:'margin-top:12px'},text(job.error)):null);
  if(job.kind==='image'&&instruction){card.append(node('div',{class:'note',style:'margin-top:13px'},'复制下面的任务，发送给当前 Codex 会话。完成交付后点击“刷新资产”；不会自动采用新图。'),directory?node('div',{class:'task-command'},node('div',{class:'row between'},node('h4',{},'图片交付目录'),button('复制位置',()=>copy(directory),'small')),node('code',{},directory)):null,node('details',{open:true},node('summary',{},'交给 Codex 的完整任务'),node('div',{class:'row end'},button('复制任务全文',()=>copy(instruction),'primary small')),node('pre',{class:'task-command'},text(instruction))));}
  if(job.taskId)card.append(node('div',{class:'note',style:'margin-top:12px'},'RunningHub taskId：',node('code',{},job.taskId)));
  if(job.outputs?.length)card.append(node('div',{class:'row wrap',style:'margin-top:12px'},job.outputs.map((output,i)=>{if(job.purpose==='video_reference')return node('a',{href:`/api/video-references/${encodeURIComponent(job.id)}/files/${encodeURIComponent(output.kind)}`,download:''},`下载${output.label}`);const mediaId=typeof output==='string'?output:output.mediaId||output.id;const media=entity?.media?.find(m=>m.id===mediaId);return media?node('a',{href:mediaUrl(media),target:'_blank',rel:'noopener'},`打开结果 ${i+1}`):node('span',{class:'badge'},typeof output==='string'?output:output.file||`结果 ${i+1}`);} )));
  card.append(node('div',{class:'row wrap',style:'margin-top:13px'},entity?button('查看条目与候选',()=>{if(entity.type==='storyboard'){view='shot';shotView='boards';}else{view=entity.type;if(entity.type==='shot')shotView='list';}resetSelection(entity.id);editorTab='media';renderApp();},'small'):null,job.kind==='image'?button('刷新资产',refreshAssets,'small'):null,job.kind==='video'&&['failed','query_failed','downloading','submission_unknown','running','queued'].includes(job.status)?button('重查 / 重下载',async()=>{const r=await perform(()=>api(`/api/jobs/${encodeURIComponent(job.id)}/retry`,{method:'POST',body:{}}),'已请求恢复；不会重新提交收费任务。');if(r){await loadState(false);renderApp();}},'small'):null));
  if(job.kind==='video'&&job.status==='submission_unknown')card.append(node('div',{class:'stack',style:'gap:7px;margin-top:9px'},node('small',{},'请先到 RunningHub 核对是否已创建任务。'),node('div',{class:'row wrap'},button('补录 taskId',()=>showAttachTask(job),'small'),!job.taskId?button('核对后关闭不明状态',()=>showResolveUnknown(job),'quiet small'):null)));
  card.append(node('details',{},node('summary',{},'本次发送快照'),node('div',{class:'row end'},button('复制快照',()=>copy(job.snapshot),'small')),node('pre',{class:'prompt-box'},json(job.snapshot||{}))));
  if(job.log?.length)card.append(node('details',{},node('summary',{},'任务日志'),node('div',{class:'task-log'},job.log.map(item=>typeof item==='string'?item:json(item)).join('\n'))));
  return card;
}
function showAttachTask(job){const input=node('input',{inputmode:'numeric',pattern:'[1-9][0-9]*',required:true,placeholder:'填写 RunningHub 后台实际 taskId','aria-label':'RunningHub taskId'});const form=node('form',{class:'stack',onSubmit:async e=>{e.preventDefault();const taskId=input.value.trim();if(!/^[1-9]\d*$/.test(taskId)){notify('taskId 必须为正整数数字串。',true);return;}const result=await perform(()=>api(`/api/jobs/${encodeURIComponent(job.id)}/attach-task`,{method:'POST',body:{taskId}}),'已补录 taskId，继续查询原任务。');if(result){modal.close();await loadState(false);renderApp();}}},node('p',{},'仅在 RunningHub 后台确认原请求已创建任务后，补录对应 taskId。请核对它与本镜头的提示词和提交时间一致。'),node('div',{class:'note'},'补录后查询并下载已有任务；不会重新提交生成，也不会自动猜测 taskId。'),input,node('div',{class:'row end'},button('取消',()=>modal.close()),node('button',{type:'submit',class:'primary'},'补录并查询')));openModal('恢复提交结果不明的任务',form);}
function showResolveUnknown(job){const checked=node('input',{type:'checkbox',required:true});const form=node('form',{class:'stack',onSubmit:async e=>{e.preventDefault();if(!checked.checked)return;const result=await perform(()=>api(`/api/jobs/${encodeURIComponent(job.id)}/resolve-unknown`,{method:'POST',body:{confirmedNotSubmitted:true}}),'不明状态已关闭；没有重新提交生成。');if(result){modal.close();await loadState(false);renderApp();}}},node('p',{},'先在 RunningHub 后台核对本次提交时间、提示词与任务列表。只有确认本次请求没有创建远端任务时，才关闭不明状态。'),node('div',{class:'note'},'如果已有任务，请使用“补录 taskId”。错误地关闭并再次生成，可能导致重复任务和费用。'),node('label',{class:'row',style:'font-size:13px'},checked,'我已核对没有本次任务'),node('p',{class:'muted',style:'font-size:12px'},'关闭后任务标为失败并释放本机提交锁；不会自动重新生成。'),node('div',{class:'row end'},button('取消',()=>modal.close()),node('button',{type:'submit',class:'primary'},'关闭不明状态')));openModal('核对后关闭不明状态',form);}
async function refreshAssets(){await perform(async()=>{const result=await api('/api/refresh',{method:'POST',body:{projectId:state.project?.id}});await loadState(false);renderApp();const errors=result.errors||[];notify(`刷新完成，登记 ${Array.isArray(result.imported)?result.imported.length:result.imported||0} 个结果${errors.length?`；${errors.length} 项交付需要检查`:''}`,!!errors.length);if(errors.length)openModal('图片交付问题',node('div',{class:'stack'},errors.map(error=>node('div',{class:'note error'},text(error)))));});}

function showSource(){if(!state.project)return;const p=state.project;openModal('原始分镜文件',node('div',{},node('div',{class:'source-toolbar'},node('div',{},node('h3',{},p.source?.filename||'分镜原文'),node('small',{},'完整保留的导入版本')),row(button('复制全文',()=>copy(p.source?.text||''),'small'),node('a',{href:`/api/source/${encodeURIComponent(p.id)}`,download:''},'下载原文'))),node('pre',{class:'source-content'},p.source?.text||'原文未载入')));}
function showProjectSettings(){const p=state.project;if(!p)return;const values={title:p.title,aspectRatio:p.aspectRatio||'9:16',style:text(p.style),targetDuration:text(p.targetDuration),baseVersion:p.versions?.at(-1)?.id};const form=node('form',{class:'stack',onSubmit:async e=>{e.preventDefault();const r=await perform(()=>api(`/api/projects/${encodeURIComponent(p.id)}`,{method:'PATCH',body:values}),'项目设定已保存');if(r){modal.close();preview=null;await loadState();}}},field('作品名称',values.title,v=>values.title=v),field('画幅',values.aspectRatio,v=>values.aspectRatio=v),field('目标时长（保留原始描述）',values.targetDuration,v=>values.targetDuration=v),field('全局风格全文',values.style,v=>values.style=v,{multiline:true,rows:10}),node('div',{class:'note'},'修改全局风格后，请复查已有镜头与图片。旧素材仍然保留。'),node('div',{class:'row end'},node('button',{type:'submit',class:'primary'},'保存项目设定')));openModal('项目设定',form);}
function renderVoicePreview(getVoiceId){
  const input=node('input',{value:'你在叫我吗？',maxlength:8000,'aria-label':'试听文本'});
  const audio=node('audio',{class:'preview-audio',controls:true,hidden:true,'aria-label':'音色试听播放器',onPlay:()=>document.querySelectorAll('.voice-preview audio').forEach(other=>{if(other!==audio)other.pause();})});
  let pending=false,clipKey='',url='';
  const dispose=()=>{audio.pause();audio.removeAttribute('src');audio.hidden=true;if(url)URL.revokeObjectURL(url);url='';clipKey='';observer.disconnect();modal.removeEventListener('close',onClose);};
  const onClose=()=>{if(modal.contains(container))dispose();};
  const observer=new MutationObserver(()=>{if(!container.isConnected)dispose();});
  const play=async()=>{try{await audio.play();}catch{notify('音频已生成，请点击播放器播放。');}};
  const audition=button('试听',async()=>{
    if(pending||busy)return;
    const referenceId=String(getVoiceId()||'').trim(),text=input.value.trim();
    if(!/^[a-zA-Z0-9_-]{8,64}$/.test(referenceId)){notify('请先填写或选择有效的音色 ID（8–64 位字母、数字、下划线或连字符）。',true);return;}
    if(!text||text.length>8000){notify('试听文本不能为空，且不能超过 8000 字。',true);return;}
    const key=referenceId+'\n'+text;
    if(clipKey===key&&url){audio.currentTime=0;await play();return;}
    pending=true;audition.disabled=true;audition.textContent='生成中…';
    try{await perform(async()=>{
      dispose();
      const response=await fetch('/api/fish-audio/synthesize',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':state.csrfToken||''},body:JSON.stringify({text,referenceId,format:'mp3',download:true})});
      if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(typeof result.error==='string'?result.error:`试听失败（${response.status}）`);}
      const blob=await response.blob();
      if(!container.isConnected||(modal.contains(container)&&!modal.open))return;
      url=URL.createObjectURL(blob);clipKey=key;audio.src=url;audio.hidden=false;audio.setAttribute('aria-label',`音色 ${referenceId} 试听：${text}`);
      observer.observe(document.body,{childList:true,subtree:true});modal.addEventListener('close',onClose);
      await play();
    });}finally{pending=false;audition.disabled=false;audition.textContent='试听';}
  },'small');
  const container=node('div',{class:'voice-preview stack full'},node('div',{class:'row'},node('label',{class:'field grow'},'试听文本',input),audition),node('small',{class:'muted'},'首次试听会调用 Fish Audio 生成语音；相同内容可直接重播。'),audio);
  return container;
}
function showAddVoice(){
  const nameInput=node('input',{placeholder:'音色名称，如「俏皮少女」','aria-label':'音色名称'});
  const idInput=node('input',{placeholder:'Fish Audio 音色 ID（8–64 位字母/数字/_/-）','aria-label':'音色 ID'});
  const noteInput=node('input',{placeholder:'备注（可选），如「女主」','aria-label':'备注'});
  const form=node('form',{class:'stack',onSubmit:async e=>{
    e.preventDefault();
    const name=nameInput.value.trim(),voiceId=idInput.value.trim(),note=noteInput.value.trim();
    if(!name){notify('请填写音色名称',true);return;}
    if(!/^[a-zA-Z0-9_-]{8,64}$/.test(voiceId)){notify('音色 ID 格式不对：需 8–64 位字母、数字、下划线或连字符',true);return;}
    if((state.voicePresets||[]).some(p=>p.voiceId===voiceId)){notify('这个音色 ID 已经在库里了',true);return;}
    const id='voice_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    const next=[...(state.voicePresets||[]),{id,name,voiceId,note}];
    const r=await perform(()=>api('/api/fish-audio/settings',{method:'POST',body:{voicePresets:next}}),'已新增音色');
    if(r){state.voicePresets=r.voicePresets;modal.close();if($('#editor')&&selected())renderEditor($('#editor'));}
  }},node('label',{class:'field'},'音色名称',nameInput),node('label',{class:'field'},'音色 ID',idInput),renderVoicePreview(()=>idInput.value),node('label',{class:'field'},'备注（可选）',noteInput),node('div',{class:'row end'},button('取消',()=>modal.close(),'small'),node('button',{type:'submit',class:'primary'},'新增音色')));
  openModal('新增音色 · 全局音色库',node('div',{class:'stack'},node('p',{class:'muted',style:'font-size:12px'},'音色会加入全局音色库，所有角色的「音色」下拉都能选到；新增后会刷新当前角色的下拉。'),form));
}
function showSettings(){const c=state.capabilities?.codex||{};const rh=state.capabilities?.runninghub||{};
  const limits=concurrencyLimits();
  const concurrencyInput=node('input',{type:'number',min:String(limits.min),max:String(limits.max),step:'1',value:String(videoConcurrency()),'aria-label':'视频并发上限'});
  const accountLine=node('small',{class:'muted'},accountSummary(state.settings?.accountConcurrency));
  const detectConcurrency=node('button',{type:'button',onClick:async()=>{const result=await perform(()=>api('/api/settings/video-concurrency/detect',{method:'POST',body:{}}));if(!result)return;state.settings=result.settings;accountLine.textContent=accountSummary(result.settings.accountConcurrency);const detected=result.account?.concurrentLimit;if(detected)concurrencyInput.value=String(detected);notify(detected?`账号并发上限 ${detected}，点“保存”生效。`:'没有读到账号并发上限，可手动填写。',!detected);}},'读取账号并发数');
  const saveConcurrency=node('button',{type:'button',class:'primary',onClick:async()=>{const value=Number(concurrencyInput.value);if(!Number.isInteger(value)||value<limits.min||value>limits.max){notify(`并发上限必须是 ${limits.min}–${limits.max} 的整数。`,true);return;}const result=await perform(()=>api('/api/settings/video-concurrency',{method:'PATCH',body:{value}}),'并发上限已保存');if(result)state.settings=result.settings;}},'保存并发上限');const keyInput=node('input',{type:'password',autocomplete:'new-password',placeholder:rh.configured?'已配置；填写新 Key 可替换':'输入 RunningHub API Key','aria-label':'RunningHub API Key'});const keyForm=node('form',{class:'stack',onSubmit:async e=>{e.preventDefault();const key=keyInput.value.trim();if(!key)return;try{const result=await api('/api/settings/runninghub',{method:'POST',body:{key}});keyInput.value='';state.capabilities.runninghub={...rh,configured:result.configured??true};$('#key-status').textContent='已配置 · Key 只交给本机后端';notify('RunningHub Key 已保存到本机后端');}catch(error){keyInput.value='';notify(error.message,true);}}},node('div',{class:'row'},keyInput,node('button',{type:'submit',class:'primary'},'保存 Key')),node('small',{id:'key-status'},rh.configured?'已配置 · 浏览器不读取已保存的 Key':rh.error?`读取本机密钥失败：${rh.error}`:'尚未配置'),rh.configured?null:rh.error?node('div',{class:'note error',style:'margin-top:8px'},'本机保存的密钥解不开（常见于换了 Windows 账户、或密钥文件被改动）。重新填写并保存一次 Key 即可恢复，旧文件会被覆盖。'):null,node('p',{class:'note'},'密钥不保存在浏览器 localStorage，不进入 Agent 提示词、发送预览或导出。保存后输入框会清空。'));
  const configArea=node('textarea',{rows:17,class:'mono settings-config',value:json(videoConfig),'aria-label':'全局工作流配置',spellcheck:false});
  const voiceSection=(()=>{
    const listEl=node('div',{class:'voice-lib'});
    const voiceSelect=node('select',{'aria-label':'选择试听音色 ID'});
    const nameInput=node('input',{placeholder:'音色名称，如「俏皮少女」','aria-label':'音色名称'});
    const idInput=node('input',{placeholder:'Fish Audio 音色 ID（8–64 位）','aria-label':'音色 ID'});
    const noteInput=node('input',{placeholder:'备注（可选），如「女主」','aria-label':'备注'});
    const paint=()=>{
      const presets=state.voicePresets||[],selectedVoice=voiceSelect.value;
      voiceSelect.replaceChildren(node('option',{value:'',selected:!presets.some(p=>p.voiceId===selectedVoice)},presets.length?'请选择音色 ID':'请先新增音色'),...presets.map(p=>node('option',{value:p.voiceId,selected:p.voiceId===selectedVoice},`${p.name} · ${p.voiceId}`)));
      const rows=presets.map(p=>node('div',{class:'voice-lib-row'},node('div',{class:'voice-lib-info'},node('strong',{},p.name),node('code',{},p.voiceId),p.note?node('small',{class:'muted'},p.note):null),button('删除',async()=>{const next=(state.voicePresets||[]).filter(x=>x.id!==p.id);const r=await perform(()=>api('/api/fish-audio/settings',{method:'POST',body:{voicePresets:next}}),'已删除音色');if(r){state.voicePresets=r.voicePresets;paint();}},'quiet small',{'aria-label':`删除音色 ${p.name}`})));
      listEl.replaceChildren(...rows.length?rows:[node('p',{class:'muted'},'还没有音色，先添加一个。')]);
    };
    paint();
    const add=async()=>{const name=nameInput.value.trim(),voiceId=idInput.value.trim(),note=noteInput.value.trim();if(!name){notify('请填写音色名称',true);return;}if(!/^[a-zA-Z0-9_-]{8,64}$/.test(voiceId)){notify('音色 ID 格式不对：需 8–64 位字母、数字、下划线或连字符',true);return;}if((state.voicePresets||[]).some(p=>p.voiceId===voiceId)){notify('这个音色 ID 已经在库里了',true);return;}const id='voice_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);const next=[...(state.voicePresets||[]),{id,name,voiceId,note}];const r=await perform(()=>api('/api/fish-audio/settings',{method:'POST',body:{voicePresets:next}}),'已新增音色');if(r){state.voicePresets=r.voicePresets;nameInput.value='';idInput.value='';noteInput.value='';paint();}};
    const form=node('form',{class:'field-grid',onSubmit:async e=>{e.preventDefault();await add();}},node('label',{class:'field'},'音色名称',nameInput),node('label',{class:'field'},'音色 ID',idInput),node('label',{class:'field full'},'备注（可选）',noteInput),node('div',{class:'row end full'},node('button',{type:'submit',class:'primary'},'新增音色')));
    return node('div',{class:'settings-grid'},
      node('section',{class:'settings-section settings-wide'},node('h3',{},'音色试听'),node('p',{class:'muted'},'先选择音色 ID，再点击试听发送。切换音色不会自动生成。'),node('label',{class:'field'},'试听音色 ID',voiceSelect),renderVoicePreview(()=>voiceSelect.value)),
      node('section',{class:'settings-section settings-wide'},node('div',{class:'row between'},node('h3',{},'全局音色库'),badge('Fish Audio')),node('p',{class:'muted'},'音色供所有作品共用，在角色设定中关联。删除正在使用的音色后，对应角色会变回“未指定音色”。'),listEl,node('details',{class:'settings-add-voice'},node('summary',{},'＋ 新增音色'),form)));
  })();
  const connections=node('div',{class:'settings-grid'},
    node('section',{class:'settings-section settings-wide'},node('div',{class:'row between'},node('h3',{},'RunningHub'),badge('视频直连')),node('p',{class:'muted'},'视频任务由本机后端直连提交。'),keyForm),
    node('section',{class:'settings-section'},node('h3',{},'视频并发上限'),node('p',{class:'muted'},'同时提交的视频任务数，默认 1 个。实际并发不会超过账号上限。'),node('label',{class:'field'},'同时运行的任务数',concurrencyInput),node('div',{class:'row wrap settings-actions'},detectConcurrency,saveConcurrency),accountLine),
    node('section',{class:'settings-section'},node('h3',{},'Codex · 当前会话生图'),row(badge('文件交付可用','good'),badge(c.loggedIn?'CLI 已登录':'CLI 未登录',c.loggedIn?'good':'warn')),node('p',{class:'muted'},'创建文件任务后，交给当前 Codex 会话生成图片。CLI 登录不阻断文件交付。')));
  const workflow=node('section',{class:'settings-section'},node('h3',{},'RunningHub 工作流配置'),node('p',{class:'muted'},'工作流参数仅保存在本浏览器。参考素材在生成页逐一绑定；保存后原发送预览会失效。'),configArea,node('div',{class:'row end settings-actions'},button('保存工作流配置',()=>{try{const parsed=JSON.parse(configArea.value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('配置必须是 JSON 对象');if(/"(?:api[_-]?key|authorization|token)"\s*:/i.test(json(parsed)))throw new Error('不要把密钥写入工作流配置');videoConfig=parsed;persistConfig();invalidatePreview();notify('工作流配置已保存；旧预览已失效');if(editorTab==='generate'||editorTab==='video')renderGenerationTab();}catch(error){notify(error.message,true);}},'primary')));
  const sections=[['connections','接口连接','管理视频连接与任务并发',connections],['voices','音色与试听','选择音色，统一试听',voiceSection],['workflow','视频工作流','编辑与保存工作流参数',workflow]];
  const panels=sections.map(([id,title,description,content],index)=>node('section',{id:`settings-${id}`,class:'settings-panel',hidden:index!==0,'aria-labelledby':`settings-heading-${id}`},node('div',{class:'settings-panel-heading'},node('h2',{id:`settings-heading-${id}`},title),node('p',{class:'muted'},description)),content));
  const navigation=sections.map(([id,title],index)=>button([node('span',{class:'settings-nav-number'},`0${index+1}`),title],()=>{
    panels.forEach((panel,i)=>{panel.hidden=i!==index;if(i!==index)panel.querySelectorAll('audio').forEach(audio=>audio.pause());});
    navigation.forEach((item,i)=>item.setAttribute('aria-pressed',String(i===index)));
  },'',{'aria-pressed':index===0,'aria-controls':`settings-${id}`}));
  openModal('接口与工作流设置',node('div',{class:'settings-layout'},node('nav',{class:'settings-nav','aria-label':'设置分类'},navigation),node('div',{class:'settings-content'},panels)),'settings-dialog');
}
async function importFile(file,asNewProject=false,destination){
  if(file.size>2*1024*1024){notify('分镜文件超过 2 MB，请检查文件。',true);return;}
  if(dirty&&selected()?.type==='storyboard'){notify('请先保存或撤销故事板的修改，再导入分镜。',true);return;}
  if(state.project&&!asNewProject&&destination===undefined){
    const target=node('select',{'aria-label':'分镜导入位置'},node('option',{value:'new',selected:currentEpisode==='all'},'作为新作品导入'),
      (state.project.episodes||[1]).map(number=>node('option',{value:String(number),selected:currentEpisode===number},`追加到当前作品 · ${episodeLabel(number)}`)));
    openModal('导入分镜',node('form',{class:'stack',onSubmit:event=>{event.preventDefault();importFile(file,false,target.value);}},node('p',{},file.name),node('label',{class:'field'},'导入位置',target),node('p',{class:'muted'},'追加按名称复用角色、地点和道具，保留已有编辑与素材。同一集内镜头编号不能重复。'),node('button',{type:'submit',class:'primary'},'导入')));
    return;
  }
  const append=destination!==undefined&&destination!=='new';
  const projectId=state.project?.id;
  try{
    const source=await file.text();
    const result=await api(append?`/api/projects/${encodeURIComponent(projectId)}/append-import`:'/api/imports',{method:'POST',body:{text:source,filename:file.name,asNewProject,...(append?{episodeNumber:Number(destination)}:{})}});
    resetSelection(null);state.project=result.project;currentEpisode=append?Number(destination):1;view=append?'shot':'overview';
    await loadState();notify('分镜已导入，原文已完整保留');if(modal.open)modal.close();
  }catch(error){
    if(error.status===409&&!asNewProject&&!append){openModal('这份文件有新的内容',node('div',{class:'stack'},node('p',{},'已有同名文件，但内容发生变化。为保护已有编辑，可以将它导入为独立作品。'),node('pre',{class:'prompt-box'},json(error.details)),node('div',{class:'row end'},button('取消',()=>modal.close()),button('导入为独立作品',()=>importFile(file,true),'primary'))));}
    else notify(error.message,true);
  }
}
$('#import-file').addEventListener('change',event=>{const file=event.target.files[0];if(file)importFile(file);event.target.value='';});
window.addEventListener('beforeunload',event=>{if(dirty||drafts.size||[...sourceAnnotationDrafts.values()].some(entry=>entry.dirty)){event.preventDefault();event.returnValue='';}});
modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();}});
modal.addEventListener('close',()=>$('#shot-sheet-player',modal)?.pause?.());
setInterval(async()=>{if(!['jobs','references'].includes(view)||modal.open||busy)return;try{await loadState(false);if(view==='references')renderVideoReferences($('#main-content'));else renderJobs($('#main-content'));}catch{/* shortcut: background polling errors stay quiet; manual refresh reports the actionable error. */}},10000);
try{await loadState();}catch(error){app.replaceChildren(node('div',{class:'loading-screen'},node('span',{class:'brand-mark'},'分'),node('h2',{},'工作台暂时无法连接'),node('p',{class:'error-text'},error.message),button('重新连接',()=>location.reload(),'primary')));}
