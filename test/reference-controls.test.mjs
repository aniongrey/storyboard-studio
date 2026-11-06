import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseMarkdown } from '../server/importer.mjs';
import { referenceGroups, automaticReferences, automaticBindings } from '../public/video-editor.mjs';
import { storyboardFinalPrompt, composeStoryboardPrompt, formatStoryboardFinalPrompt } from '../public/storyboard.mjs';
import { planVideoOutput } from '../public/video-resolution.mjs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const render = app.slice(app.indexOf('function renderReferenceControls('), app.indexOf('// 首尾帧档的槽位界面'));
const node = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(Boolean), append(...items) { this.children.push(...items.flat()); } });
const walk = tree => typeof tree === 'object' ? [tree, ...tree.children.flatMap(walk)] : [];

test('editing audio bindings in advanced JSON refreshes selected references and prompt immediately', () => {
  const status={classList:{remove(){},add(){}}},calls=[];
  const context={node,json:JSON.stringify,videoConfig:{},referenceIds:new Set(['old']),isFrameMode:()=>false,
    invalidatePreview:()=>calls.push('invalidate'),persistConfig:()=>calls.push('persist'),
    syncNativePixels(){},nativePixelConflict:()=>'',syncVideoControls:()=>calls.push('controls'),rebuildVideoBlocks:()=>calls.push('prompt'),syncReferenceLabels:()=>calls.push('labels'),$:()=>status};
  runInNewContext(app.slice(app.indexOf('function videoConfigTextarea('),app.indexOf('function renderGeneration(')),context);
  const input=context.videoConfigTextarea({});
  const config={referenceBindings:[{nodeId:'160',fieldName:'audio',mediaId:'queen'}]};
  input.attrs.onInput({target:{value:JSON.stringify(config)}});
  assert.deepEqual([...context.referenceIds],['queen']);
  assert.equal(context.videoConfig.referenceBindings[0].mediaId,'queen');
  assert.deepEqual(calls,['invalidate','persist','controls','prompt','labels']);
  assert.match(status.textContent,/角色音频引用已同步/);
  calls.length=0;
  input.attrs.onInput({target:{value:'{'}});
  assert.deepEqual(calls,['invalidate']);
  assert.match(status.textContent,/JSON 格式不完整/);
});

test('rough cut scope remains switchable when empty and switching resets playback', () => {
  let tree, stopped = 0;
  // 空序列提前返回，不会走到 mountPreviewPlayer；renderPreview 只会先销毁上一次的播放器实例。
  const context = { node, button: (label, action, className, attrs) => node('button', { onClick: action, ...attrs }, label),
    document: { activeElement: null },
    previewScope: 'all', previewIndex: 5, previewPlaying: true, previewEntries: () => [], previewItems: () => [], previewQuery: '', currentEpisode: 'all', previewPlayer: null,
    stopPreviewPlayback() { stopped++; context.previewPlaying = false; context.previewRemainingMs = -1; },
    rerenderPreview() { context.renderPreview(container); }, setShotView() {} };
  const container = { replaceChildren(...children) { tree = node('section', {}, ...children); } };
  runInNewContext(app.slice(app.indexOf('function renderPreview('), app.indexOf('function updatePreviewProgress(')), context);
  context.renderPreview(container);
  const scope = walk(tree).find(item => item.tag === 'button' && item.children.includes('故事板'));
  scope.attrs.onClick();
  assert.equal(context.previewScope, 'storyboards');
  assert.equal(context.previewIndex, 0);
  assert.equal(context.previewPlaying, false);
  assert.equal(context.previewRemainingMs, -1);
  assert.equal(stopped, 1);
  assert.ok(walk(tree).some(item => item.children.includes('还没有可以粗剪的故事板')));
  assert.equal(walk(tree).find(item => item.children.includes('故事板')).attrs['aria-pressed'], true);
});

test('storyboard page binding pins its own grid and matches automatic speaker order with manual images present',()=>{
 const characters=['甲','乙'].map((name,i)=>({id:`c${i}`,type:'character',name,data:{},media:[{id:`a${i}`,kind:'audio'}],adoptedMediaIds:{audio:`a${i}`}}));
 const board={id:'board',type:'storyboard',data:{shotIds:['shot']},media:[{id:'grid',kind:'image'}],adoptedMediaIds:{image:'grid'}};
 const project={assets:characters,shots:[{id:'shot',data:{characterIds:['c0','c1'],dialogue:'乙：“先说。”\n甲：“后说。”'}}]};
 const refs=[{id:'manual-image',kind:'image',entityId:'c0'},...referenceGroups(project,board).flatMap(g=>g.media)].reverse();
 const context={state:{project},videoConfig:{},referenceIds:new Set(refs.map(m=>m.id)),selectedId:board.id,selected:()=>board,isFrameMode:()=>false,allowedReferenceMedia:()=>refs,automaticReferences,automaticBindings};
 runInNewContext(app.slice(app.indexOf('function autoBindReferences('),app.indexOf('function frameReferenceIds(')),context);
 context.autoBindReferences();
 assert.equal(context.videoConfig.referenceBindings.find(b=>b.nodeId==='141').mediaId,'grid');
 assert.equal(context.videoConfig.referenceBindings.find(b=>b.nodeId==='144').mediaId,'a1');
 assert.equal(context.videoConfig.referenceBindings.find(b=>b.nodeId==='160').mediaId,'a0');
 assert.equal(context.videoConfig.referenceBindings.find(b=>b.nodeId==='142').mediaId,'manual-image');
});

test('shot and storyboard video editors check adopted character images once, including silent characters',()=>{
 const characters=['甲','乙','无关'].map((name,i)=>({id:`c${i}`,type:'character',name,data:{},media:[{id:`i${i}`,kind:'image'},{id:`candidate${i}`,kind:'image'}],adoptedMediaIds:{image:`i${i}`}}));
 const shot={id:'shot',type:'shot',currentVersion:'v1',data:{characterIds:['c0','c1'],dialogue:'甲：你好。'},media:[{id:'frame',kind:'image'}],adoptedMediaIds:{image:'frame'}};
 const board={id:'board',type:'storyboard',currentVersion:'v1',data:{shotIds:[shot.id]},media:[{id:'grid',kind:'image'}],adoptedMediaIds:{image:'grid'}};
 const project={assets:characters,shots:[shot]};
 const source=app.slice(app.indexOf('function allReferenceMedia('),app.indexOf('function switchEditorTab('))+
   app.slice(app.indexOf('function autoBindReferences('),app.indexOf('function frameReferenceIds('))+
   app.slice(app.indexOf('function initializeVideoEditor('),app.indexOf('function refreshVideoPrompt('))+
   app.slice(app.indexOf('function initializeStoryboardGeneration('),app.indexOf('function boardPromptData('))+render;
 for(const entity of [shot,board]){
   const context={state:{project},selectedId:entity.id,selected:()=>entity,generationKind:'video',videoConfig:{mode:'reference'},videoEditorKey:null,
     currentVersion:e=>e.currentVersion,referenceIds:new Set(),referenceGroups,automaticReferences,automaticBindings,isFrameMode:()=>false,
     adoptedId:(e,kind)=>e.adoptedMediaIds?.[kind],storyboardSource:()=>({}),json:JSON.stringify,hasStoryboardDrafts:()=>false,
     storyboardFinalPrompt:()=>'',boardPromptData:e=>e.data,applyDurationDefault(){},rebuildVideoBlocks(){},invalidatePreview(){},
     node,button:(label,onClick)=>node('button',{onClick},label),typeNames:{},mediaFilename:m=>m.id,mediaUrl:m=>m.id,referenceTag:()=>'',
     $:()=>null,syncVideoConfigText(){},renderBindings(){},syncReferenceLabels(){},syncVideoSummary(){}};
   runInNewContext(source,context);
   context.initializeVideoEditor(entity);
   assert.deepEqual([...context.referenceIds],[entity===shot?'frame':'grid','i0','i1']);
   assert.deepEqual(Array.from(context.videoConfig.referenceBindings,b=>[b.nodeId,b.mediaId]),[['141',entity===shot?'frame':'grid'],['142','i0'],['143','i1']]);
   const checkboxes=()=>walk(context.renderReferenceControls(entity)).filter(e=>e.tag==='input');
   const image=id=>checkboxes().find(e=>e.attrs['aria-label']==='引用'+characters.find(c=>c.media.some(m=>m.id===id)).name+' '+id);
   assert.equal(image('i0').attrs.checked,true);
   assert.equal(image('i1').attrs.checked,true);
   assert.equal(image('candidate0').attrs.checked,false);
   assert.ok(!checkboxes().some(e=>e.attrs['aria-label']?.includes('无关')));
   image('i1').attrs.onChange({target:{checked:false}});
   context.initializeVideoEditor(entity);
   assert.equal(context.referenceIds.has('i1'),false);
   assert.equal(image('i1').attrs.checked,false);
 }
});

test('six image slot controls and submitted reference order match despite reversed media and mixed audio',()=>{
 const imageSlots=['141','142','143','161','175','176'],audioSlots=['144','160','189'];
 const images=imageSlots.map((nodeId,i)=>({id:`i${i}`,kind:'image',entityName:'角色'}));
 const audio=audioSlots.map((nodeId,i)=>({id:`a${i}`,kind:'audio',entityName:'音轨'}));
 const refs=[images[5],audio[1],images[4],audio[2],images[3],audio[0],...images.slice(0,3).reverse()];
 const bindings=[...imageSlots.map((nodeId,i)=>({nodeId,fieldName:'image',mediaId:images[i].id})),...audioSlots.map((nodeId,i)=>({nodeId,fieldName:'audio',mediaId:audio[i].id}))].reverse();
 let tree;
 const container={replaceChildren(...children){tree=node('section',{},...children);}};
 const context={node,badge:title=>node('span',{},title),typeNames:{},mediaFilename:m=>m.id,isFrameMode:()=>false,
   allowedReferenceMedia:()=>refs,referenceIds:new Set(refs.map(m=>m.id)),videoConfig:{referenceBindings:bindings},
   syncReferenceLabels(){},rebuildVideoBlocks(){},invalidatePreview(){},syncVideoConfigText(){},persistConfig(){}};
 runInNewContext(app.slice(app.indexOf('function orderedVideoReferences('),app.indexOf('function referenceTag('))+
   app.slice(app.indexOf('function renderBindings('),app.indexOf('function previewEmpty(')),context);
 assert.deepEqual(Array.from(context.orderedVideoReferences(),m=>m.id),[...images,...audio].map(m=>m.id));
 context.renderBindings(container);
 const selects=walk(tree).filter(e=>e.tag==='select'&&e.attrs['aria-label'].startsWith('参考图'));
 assert.deepEqual(selects.map(e=>e.attrs['aria-label']),imageSlots.map((nodeId,i)=>`参考图 ${i+1}`));
 for(const [i,select] of selects.entries()){
   assert.equal(select.children.find(e=>e.attrs.selected).attrs.value,images[i].id);
   assert.deepEqual(select.children.filter(e=>e.attrs.value).map(e=>e.attrs.value).sort(),images.map(m=>m.id));
 }
 selects[5].attrs.onChange({target:{value:'i0'}});
 assert.equal(context.videoConfig.referenceBindings.find(b=>b.nodeId==='176').mediaId,'i0');
});

test('storyboard final prompt editor keeps custom text through refresh and clearing restores combination', () => {
  const board = { id:'board',type:'storyboard',data:{shotIds:['shot'],finalPrompt:'已保存的最终文本'} };
  const project = { assets:[],shots:[{id:'shot',name:'开场',data:{duration:5,action:'空镜'}}] };
  const controls = { '#storyboard-final-prompt':{value:''}, '#assembled-video-prompt':{}, '#storyboard-combination-prompt':{} };
  const drafts = new Map();
  const context = {
    state:{project},drafts,finalPrompt:board.data.finalPrompt,videoConfig:{duration:'8'},node,storyboardFinalPrompt,composeStoryboardPrompt,formatStoryboardFinalPrompt,
    $:id=>controls[id],selected:()=>board,getDraft:()=>context.draft||= {id:board.id,data:structuredClone(board.data)},
    markDirty(){drafts.set(board.id,context.draft);},invalidatePreview(){},syncVideoSummary(){},syncGenerationActions(){},saveEntity(){},
    button:(label,onClick)=>node('button',{onClick},label),
    field:(label,value,onInput)=>node('textarea',{value,onInput}),
  };
  runInNewContext(app.slice(app.indexOf('function boardPromptData('),app.indexOf('function renderStoryboardGeneration(')),context);
  runInNewContext(app.slice(app.indexOf('function refreshVideoPrompt('),app.indexOf('function rebuildVideoBlocks(')),context);
  const elements=walk(context.renderStoryboardFinalPrompt(board));
  const editor=elements.find(e=>e.tag==='textarea');
  assert.equal(editor.attrs.value,'已保存的最终文本');
  editor.attrs.onInput('人工核对后的最终文本');
  context.refreshVideoPrompt();
  assert.equal(controls['#assembled-video-prompt'].textContent,'人工核对后的最终文本');
  assert.equal(controls['#storyboard-combination-prompt'].textContent,composeStoryboardPrompt(project,board,'video',context.videoConfig));
  elements.find(e=>e.children.includes('生成 H3 结构与运镜草稿')).attrs.onClick();
  assert.match(drafts.get(board.id).data.finalPrompt,/subject_definitions:/);
  elements.find(e=>e.children.includes('清空并回退组合提示词')).attrs.onClick();
  assert.equal(drafts.get(board.id).data.finalPrompt,'');
  assert.equal(controls['#assembled-video-prompt'].textContent,composeStoryboardPrompt(project,board,'video',context.videoConfig));
  assert.equal(controls['#storyboard-final-prompt'].value,composeStoryboardPrompt(project,board,'video',context.videoConfig));
  assert.equal(board.data.finalPrompt,'已保存的最终文本');
});

test('video button permits prompt-only drafts, saves before submitting, and stops on save failure', async () => {
  const board={id:'board',type:'storyboard',name:'组',code:'SB-1',data:{shotIds:['shot'],imageRequirements:'',videoRequirements:'',finalPrompt:'旧文本'}};
  const draft={name:board.name,code:board.code,data:{...board.data,finalPrompt:'新文本'}};
  const drafts=new Map([[board.id,draft]]), calls=[], controls={'#submit-video':{},'#video-unsaved-hint':{}};
  const context={drafts,dirty:true,busy:false,promptLoading:false,preview:null,finalPrompt:'新文本',previewEpoch:1,selectedId:board.id,
    selected:()=>board,$:id=>controls[id],state:{project:{id:'project'}},crypto:{randomUUID:()=> 'operation'},
    async saveEntity(){calls.push('save');board.data={...draft.data};drafts.clear();context.dirty=false;return true;},
    refreshVideoPrompt(){},requestConfigFromEditor:()=>({}),orderedVideoReferences:()=>[],perform:action=>action(),
    async api(path){calls.push(path);return path==='/api/previews'?{preview:{id:'preview',blockers:[]}}:{job:{id:'job'}};},
    async loadState(){},renderApp(){},notify(){},node,
  };
  runInNewContext(app.slice(app.indexOf('function storyboardFinalPromptOnlyDraft('),app.indexOf('function renderStoryboardFinalPrompt(')),context);
  runInNewContext(app.slice(app.indexOf('function syncGenerationActions('),app.indexOf('function scrollToPreview(')),context);
  runInNewContext(app.slice(app.indexOf('async function submitVideo('),app.indexOf('// 提交后不再跳到')),context);
  context.syncGenerationActions();
  assert.equal(controls['#submit-video'].disabled,false);
  assert.match(controls['#video-unsaved-hint'].textContent,/先保存最终提示词/);
  draft.data.videoRequirements='未保存的要求';
  context.syncGenerationActions();
  assert.equal(controls['#submit-video'].disabled,true);
  await context.submitVideo();
  assert.deepEqual(calls,[]);
  draft.data.videoRequirements='';drafts.set('shot',{});
  assert.equal(context.storyboardFinalPromptOnlyDraft(board),false);
  drafts.delete('shot');
  await context.submitVideo();
  assert.deepEqual(calls,['save','/api/previews','/api/jobs']);
  context.dirty=true;drafts.set(board.id,draft);calls.length=0;
  context.saveEntity=async()=>{calls.push('failed save');return null;};
  await context.submitVideo();
  assert.deepEqual(calls,['failed save']);
});

test('frontend defaults to standard 24G and migrates old 48G defaults once while preserving later choices', () => {
  const defaults=app.slice(app.indexOf('const defaultInstanceType'),app.indexOf('const videoProfileLabels'));
  for(const saved of [null,{duration:'9'},{instanceType:'plus'},{instanceType:'ultra'},{instanceType:'default'}]){
    const values=new Map([['studio.videoConfig',JSON.stringify(saved)],['studio.instanceDefaultPlus48G','1']]);
    const context={structuredClone,planVideoOutput,localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)}};
    runInNewContext(defaults+app.slice(app.indexOf('function readConfig('),app.indexOf('function isFrameMode(')),context);
    assert.equal(context.readConfig().instanceType,saved?.instanceType==='ultra'?'ultra':'default');
    assert.equal(values.get('studio.instanceDefaultStandard24G'),'1');
    for(const instanceType of ['default','ultra','plus']){
      values.set('studio.videoConfig',JSON.stringify({instanceType}));
      assert.equal(context.readConfig().instanceType,instanceType);
    }
  }
});

test('switching video profiles preserves a manually selected instance and falls back to standard 24G only when unset', () => {
  for(const instanceType of ['default','plus','ultra',undefined]){
    const context={structuredClone,videoConfig:{mode:'reference',instanceType,outputResolution:'720p'},selected:()=>({id:'shot',type:'shot'}),selectedId:'shot',
      videoProfile:mode=>({mode,instanceType:'default',outputResolution:'1080p',frameBindings:{first:'old',last:'old'}}),
      state:{project:{}},automaticReferences:()=>[],referenceIds:new Set(),videoBlockEdits:new Map(),
      applyDurationDefault(){},autoBindReferences(){},rebuildVideoBlocks(){},syncVideoConfigText(){},persistConfig(){},renderGenerationTab(){},notify(){}};
    runInNewContext(app.slice(app.indexOf('function setVideoMode('),app.indexOf('function syncVideoControls(')),context);
    for(const mode of ['frames','reference']){
      context.setVideoMode(mode);
      assert.equal(context.videoConfig.instanceType,instanceType||'default');
      assert.equal(context.videoConfig.outputResolution,'720p');
    }
  }
});

test('frontend defaults to 720p, keeps saved resolution choices and synchronizes explicit 1080p pixels', () => {
  const defaults=app.slice(app.indexOf('const defaultInstanceType'),app.indexOf('const videoProfileLabels'));
  for(const saved of [null,{outputResolution:'native'},{outputResolution:'480p'},{outputResolution:'1080p'},{mode:'frames'},{mode:'frames',outputResolution:'720p'}]){
    const values=new Map([['studio.videoConfig',JSON.stringify(saved)]]);
    const context={structuredClone,planVideoOutput,localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)}};
    runInNewContext(defaults+app.slice(app.indexOf('function readConfig('),app.indexOf('function isFrameMode('))+"\nthis.frameResolution=frameVideoDefaults.outputResolution;",context);
    const config=context.readConfig();
    assert.equal(config.outputResolution,saved?.outputResolution||'720p');
    if(!saved){assert.equal(config.pixels,'0.9');assert.equal(config.nodeInfoList.find(item=>item.nodeId==='147').fieldValue,'0.9');}
    if(saved?.outputResolution==='native')assert.equal(context.readConfig().pixels,'0.4');
    assert.equal(context.frameResolution,'720p');
    values.set('studio.videoConfig',JSON.stringify({outputResolution:'720p'}));
    assert.equal(context.readConfig().outputResolution,'720p');
  }
  const saved={mode:'reference',outputResolution:'1080p',pixels:'0.4',nodeInfoList:[{nodeId:'147',fieldName:'value',fieldValue:'0.4'},{nodeId:'142',fieldName:'image',fieldValue:'keep.png'}]};
  const values=new Map([['studio.videoConfig',JSON.stringify(saved)],['studio.instanceDefaultPlus48G','1'],['studio.outputDefault1080p','1']]);
  const context={structuredClone,planVideoOutput,localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)}};
  runInNewContext(defaults+app.slice(app.indexOf('function readConfig('),app.indexOf('function isFrameMode(')),context);
  const migrated=context.readConfig();
  assert.equal(migrated.pixels,'2');
  assert.equal(migrated.nodeInfoList.find(item=>item.nodeId==='147').fieldValue,'2');
  assert.equal(migrated.nodeInfoList.find(item=>item.nodeId==='142').fieldValue,'keep.png');
  assert.equal(JSON.parse(values.get('studio.videoConfig')).pixels,'2');
});

test('both profiles expose native pixels and preset changes synchronize only the correct pixel node', () => {
  const helpers=app.slice(app.indexOf('function syncNativePixels('),app.indexOf('function isFrameMode('));
  const sync=app.slice(app.indexOf('function syncConfigValue('),app.indexOf('// 只在「本镜没手动改过」'));
  const parameter=app.slice(app.indexOf('function setVideoParameter('),app.indexOf('// 切换生成方式'));
  const renderer=app.slice(app.indexOf('function renderVideoParameters('),app.indexOf('function syncGenerationActions('));
  for(const mode of ['reference','frames']){
    const videoConfig={mode,aspectRatio:'9:16 (Portrait Widescreen)',outputResolution:'1080p',pixels:'0.4',nodeInfoList:[{nodeId:'147',fieldName:'value',fieldValue:'0.4'},{nodeId:'142',fieldName:'value',fieldValue:'0.4'},{nodeId:'142',fieldName:'image',fieldValue:'keep.png'}]};
    const context={node,planVideoOutput,videoConfig,defaultVideoConfig:{aspectRatio:videoConfig.aspectRatio},frameVideoDefaults:{workflowId:'2084282198664007682'},
      isFrameMode:()=>videoConfig.mode==='frames',frameAspectPair:()=>[9,16],durationRange:()=>({min:1,max:30}),durationHint:()=>'',videoOutputDescription:()=>'',videoProfileLabels:{reference:'多参考',frames:'首尾帧'},
      videoAspectOptions:[[videoConfig.aspectRatio,'9:16']],videoInstanceOptions:[['default','默认']],defaultInstanceType:'default',
      button:(label,onClick)=>node('button',{onClick},label),generationKind:'video',selected:()=>({type:'shot'}),rememberDuration(){},
      rebuildVideoBlocks(){},invalidatePreview(){},syncVideoControls(){},syncVideoConfigText(){},persistConfig(){}};
    runInNewContext(helpers+sync+parameter+renderer,context);
    let elements=walk(context.renderVideoParameters({type:'shot'}));
    assert.equal(Boolean(elements.find(item=>item.attrs.id==='video-aspect')),mode==='reference');
    let input=elements.find(item=>item.attrs.id==='video-pixels');
    assert.equal(input.attrs.value,'2');
    assert.equal(input.attrs.disabled,true);
    const mapped=mode==='frames'?'142':'147',other=mode==='frames'?'147':'142';
    assert.equal(videoConfig.nodeInfoList.find(item=>item.nodeId===mapped&&item.fieldName==='value').fieldValue,'2');
    assert.equal(videoConfig.nodeInfoList.find(item=>item.nodeId===other&&item.fieldName==='value').fieldValue,'0.4');
    assert.equal(videoConfig.nodeInfoList.find(item=>item.fieldName==='image').fieldValue,'keep.png');
    context.setVideoParameter('outputResolution','720p');
    assert.equal(videoConfig.pixels,'0.9');
    context.setVideoParameter('outputResolution','native');
    context.setVideoParameter('pixels','0.98');
    elements=walk(context.renderVideoParameters({type:'shot'}));
    input=elements.find(item=>item.attrs.id==='video-pixels');
    assert.equal(input.attrs.disabled,false);
    assert.equal(input.attrs.value,'0.98');
    if(mode==='reference'){
      context.setVideoParameter('outputResolution','1080p');
      context.setVideoParameter('aspectRatio','1:1 (Square)');
      assert.equal(videoConfig.pixels,'1.1');
      context.setVideoParameter('aspectRatio','9:16 (Portrait Widescreen)');
      assert.equal(videoConfig.pixels,'2');
    }
  }
});

test('advanced JSON and submitted configuration show the same corrected native pixel value',()=>{
  const helpers=app.slice(app.indexOf('function syncNativePixels('),app.indexOf('function isFrameMode('));
  const request=app.slice(app.indexOf('function requestConfigFromEditor('),app.indexOf('function videoConfigTextarea('));
  const original={mode:'reference',aspectRatio:'9:16 (Portrait Widescreen)',outputResolution:'1080p',pixels:'0.4',nodeInfoList:[{nodeId:'147',fieldName:'value',fieldValue:'0.4'}],referenceBindings:[]};
  const textarea={value:JSON.stringify(original)};
  const context={planVideoOutput,structuredClone,videoConfig:original,defaultVideoConfig:{aspectRatio:original.aspectRatio},frameVideoDefaults:{workflowId:'2084282198664007682'},
    $:()=>textarea,json:JSON.stringify,isFrameConfig:()=>false,referenceIds:new Set(),finalPrompt:'人工保存的原始台词'};
  runInNewContext(helpers+request,context);
  const sent=context.requestConfigFromEditor();
  assert.equal(sent.pixels,'2');
  assert.equal(sent.nodeInfoList[0].fieldValue,'2');
  assert.equal(JSON.parse(textarea.value).pixels,'2');
  assert.equal(context.finalPrompt,'人工保存的原始台词');
});

test('native custom JSON conflicts remain visible and are sent unchanged for backend blocking',()=>{
  const helpers=app.slice(app.indexOf('function syncNativePixels('),app.indexOf('function isFrameMode('));
  const requestAndEditor=app.slice(app.indexOf('function requestConfigFromEditor('),app.indexOf('function renderGeneration('));
  const description=app.slice(app.indexOf('function videoOutputDescription('),app.indexOf('// 首尾帧档的自动选择'));
  for(const mode of ['reference','frames']){
    const nodeId=mode==='frames'?'142':'147';
    const original={mode,aspectRatio:'9:16 (Portrait Widescreen)',outputResolution:'native',pixels:'2',nodeInfoList:[{nodeId,fieldName:'value',fieldValue:'0.7'}],referenceBindings:[]};
    const textarea={value:JSON.stringify(original)},status={classList:{add(){},remove(){}}};
    const context={node,planVideoOutput,structuredClone,videoConfig:original,defaultVideoConfig:{aspectRatio:original.aspectRatio},frameVideoDefaults:{workflowId:'2084282198664007682'},
      $:selector=>selector==='#video-config'?textarea:status,json:JSON.stringify,isFrameConfig:config=>config.mode==='frames',isFrameMode:()=>mode==='frames',frameAspectPair:()=>[9,16],
      referenceIds:new Set(),invalidatePreview(){},persistConfig(){},syncVideoControls(){},rebuildVideoBlocks(){},syncReferenceLabels(){}};
    runInNewContext(helpers+requestAndEditor+description,context);
    context.videoConfigTextarea({}).attrs.onInput({target:textarea});
    assert.equal(context.videoConfig.pixels,'2');
    assert.equal(context.videoConfig.nodeInfoList[0].fieldValue,'0.7');
    assert.match(status.textContent,new RegExp(nodeId+'\\.value=0.7'));
    assert.match(context.videoOutputDescription(context.videoConfig),/不一致，请先统一/);
    const sent=context.requestConfigFromEditor();
    assert.equal(sent.pixels,'2');
    assert.equal(sent.nodeInfoList[0].fieldValue,'0.7');
    assert.equal(JSON.parse(textarea.value).nodeInfoList[0].fieldValue,'0.7');
  }
});

test('saved native custom pixel conflicts survive reading instead of silently raising cloud pixels',()=>{
  const defaults=app.slice(app.indexOf('const defaultInstanceType'),app.indexOf('const videoProfileLabels'));
  const original={mode:'reference',outputResolution:'native',pixels:'2',nodeInfoList:[{nodeId:'147',fieldName:'value',fieldValue:'0.7'}]};
  const values=new Map([['studio.videoConfig',JSON.stringify(original)]]);
  const context={structuredClone,planVideoOutput,localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)}};
  runInNewContext(defaults+app.slice(app.indexOf('function readConfig('),app.indexOf('function isFrameMode(')),context);
  const config=context.readConfig();
  assert.equal(config.pixels,'2');
  assert.equal(config.nodeInfoList[0].fieldValue,'0.7');
  assert.match(context.nativePixelConflict(config),/不一致/);
  assert.equal(JSON.parse(values.get('studio.videoConfig')).nodeInfoList[0].fieldValue,'0.7');
});

test('10-B and 11-B explain unadopted pork media, navigate to adoption, and pair only adopted media', () => {
  const project = parseMarkdown(readFileSync(new URL('../examples/奶油变心后_分镜提示词.md', import.meta.url), 'utf8'));
  const pork = project.assets.find(a => a.name === '红烧肉先生');
  pork.media = [{ id: 'pork-image', kind: 'image' }, { id: 'pork-voice', kind: 'audio' }, { id: 'old-image', kind: 'image' }];
  for (const code of ['10-B', '11-B']) {
    const entity = project.shots.find(s => s.code === code);
    const context = {
      state: { project }, referenceGroups, node,
      button: (label, onClick) => node('button', { onClick }, label),
      allowedReferenceMedia: () => referenceGroups(project, entity).flatMap(g => g.media),
      referenceIds: new Set(), generationKind: 'video', typeNames: {}, adoptedId: () => null,
      mediaFilename: m => m.id, mediaUrl: m => m.id, referenceTag: () => '',
      autoBindReferences() {}, rebuildVideoBlocks() {}, invalidatePreview() {}, renderGenerationTab() {},
      resetSelection(id) { context.selectedId = id; }, renderApp() {},
    };
    runInNewContext(render, context);
    pork.adoptedMediaIds = {};
    let elements = walk(context.renderReferenceControls(entity));
    let checkbox = elements.find(e => e.attrs['data-role-reference'] === pork.id);
    assert.equal(checkbox.attrs.disabled, true);
    assert.ok(elements.some(e => e.children.includes('尚未采用形象与音色，请先在角色媒体中采用素材。')));
    elements.find(e => e.tag === 'button' && e.children.includes('前往角色媒体')).attrs.onClick();
    assert.equal(context.selectedId, pork.id);
    assert.equal(context.editorTab, 'media');
    assert.equal(context.view, 'character');
    assert.equal(context.referenceIds.size, 0);
    assert.deepEqual(pork.adoptedMediaIds, {});

    pork.adoptedMediaIds = { image: 'pork-image' };
    elements = walk(context.renderReferenceControls(entity));
    assert.ok(elements.some(e => e.children.includes('尚未采用音色，请先在角色媒体中采用素材。')));
    pork.adoptedMediaIds.audio = 'pork-voice';
    elements = walk(context.renderReferenceControls(entity));
    checkbox = elements.find(e => e.attrs['data-role-reference'] === pork.id);
    assert.equal(checkbox.attrs.disabled, false);
    checkbox.attrs.onChange({ target: { checked: true } });
    assert.deepEqual([...context.referenceIds], ['pork-image', 'pork-voice']);
    assert.equal(walk(context.renderReferenceControls(entity)).find(e => e.attrs['data-role-reference'] === pork.id).attrs.checked, true);
    checkbox.attrs.onChange({ target: { checked: false } });
    assert.equal(context.referenceIds.size, 0);
  }
});
