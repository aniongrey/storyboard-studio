import { storyboardShots, storyboardAssets, storyboardSpeakingCharacters, storyboardAudio } from './storyboard.mjs';
const adopted=(e,k)=>(e.media||[]).find(m=>m.id===(e.adoptedMediaIds?.[k]||(e.media||[]).find(x=>x.id===e.adoptedMediaId&&x.kind===k)?.id)&&m.kind===k);
export function referenceGroups(project,entity){
 const linked=new Set([...(entity.data?.characterIds||[]),...(entity.data?.locationIds||[]),...(entity.data?.propIds||[])]);
 const owners=entity.type==='storyboard'?[entity,...storyboardShots(project,entity),...storyboardAssets(project,entity)]:entity.type==='shot'?[entity,...project.assets.filter(e=>linked.has(e.id))]:[entity,...project.assets.filter(e=>e.id!==entity.id)];
 return owners.map(e=>({id:e.id,name:e.name,type:e.type,description:e.data?.description||e.data?.visualPrompt||'',media:(e.media||[]).filter(m=>['image','video','audio'].includes(m.kind)).map(m=>({...m,entityName:e.name,entityId:e.id,entityType:e.type,adopted:adopted(e,m.kind)?.id===m.id}))}));
}
export function automaticReferences(project,entity,kind='video'){
 if(entity.type==='storyboard'){
   const speakers=storyboardSpeakingCharacters(project,entity).filter(asset=>adopted(asset,'audio'));
   const audio=storyboardAudio(entity);
   const media=kind==='video'
     ?[adopted(entity,'image'),...storyboardAssets(project,entity).filter(asset=>asset.type==='character').map(asset=>adopted(asset,'image')),...(audio?[audio]:speakers.map(asset=>adopted(asset,'audio')))]
     :[...storyboardShots(project,entity),...storyboardAssets(project,entity)].map(owner=>adopted(owner,'image'));
   return media.filter(Boolean).map(m=>m.id);
 }
 return referenceGroups(project,entity).flatMap(g=>g.media.filter(m=>m.adopted&&(g.type==='shot'?m.kind==='image':true))).map(m=>m.id);
}
export function automaticBindings(media){
 const slots={image:['141','142','143','161','175','176'],audio:['144','160','189'],video:['164']};const used={image:0,audio:0,video:0};
 return media.flatMap(m=>{const nodeId=slots[m.kind]?.[used[m.kind]++];return nodeId?[{nodeId,fieldName:m.kind,mediaId:m.id}]:[];});
}
// 首尾帧工作流（FL2VA）没有「参考图」概念，只有 137 图1/首帧 与 143 图2/尾帧 两个图片槽。
export const FRAME_SLOTS={first:'137',last:'143'};
const frameLabels={'137':'First frame','143':'Last frame'};
export function isFrameConfig(config={}){return config?.mode==='frames';}
export function frameBindings(frames={},useLastFrame=true){
 const bindings=[];
 if(frames.first)bindings.push({nodeId:FRAME_SLOTS.first,fieldName:'image',mediaId:frames.first});
 if(useLastFrame&&frames.last)bindings.push({nodeId:FRAME_SLOTS.last,fieldName:'image',mediaId:frames.last});
 return bindings;
}
export function frameRole(mediaId,frames={},useLastFrame=true){
 const first=frames.first===mediaId,last=useLastFrame&&frames.last===mediaId;
 return first&&last?'首帧 + 尾帧':first?'首帧':last?'尾帧':'';
}
// 节点号 143 在两档里含义不同（多参考=参考图3、首尾帧=尾帧），所以必须显式带上档位，不能靠节点号猜。
export function referenceToken(media,bindings=[],frames=false){
 if(frames){
  const frameTags=bindings.filter(b=>b.mediaId===media.id&&frameLabels[b.nodeId]);
  return frameTags.map(b=>`<${frameLabels[b.nodeId]}>`).join(' and ');
 }
 const slots={image:['141','142','143','161','175','176'],audio:['144','160','189'],video:['164']};
 const label={image:'Picture',audio:'Audio',video:'Video'}[media.kind];
 return bindings.filter(b=>b.mediaId===media.id&&b.fieldName===media.kind).map(b=>slots[media.kind]?.indexOf(b.nodeId)+1).filter(i=>i>0).sort((a,b)=>a-b).map(i=>`<${label} ${i}>`).join(' and ');
}
export const blockLabels={subject_definitions:'主体定义 · 角色、音色、场景与分镜',summary:'内容概述',retention_analysis:'一致性要求',detailed_description:'镜头动作与对白',overall_soundscape:'环境与音效',non_diegetic_music:'背景音乐',global_style:'全局视觉风格',composition:'构图与景别',camera:'运镜',mood:'情绪',transition:'转场',timing:'时长与比例'};
export function videoPromptBlocks(project,entity,media,config={}){
 const d=entity.data||{},groups=referenceGroups(project,entity);let image=0,audio=0,video=0,subject=0;
 // 首尾帧档（FL2VA）只用首帧/尾帧两张关键帧，素材标签与「比例」描述都跟多参考档不同。
 const frames=isFrameConfig(config);
 const bindings=frames?frameBindings(config.frameBindings||{},config.useLastFrame!==false):(config.referenceBindings||[]);
 // Target duration 用「本次生成时长」，只有它没设置时才退回本镜计划剪辑时长：
 // 生成时长是可改参数，写死计划值会让提示词与实际出片长度不一致。
 const target=Number(config.duration)>0?Number(config.duration):Number(d.duration)>0?Number(d.duration):0;
 const refs=media.map(m=>{const tag=referenceToken(m,bindings,frames);if(tag)return{...m,tag};
   return{...m,tag:m.kind==='image'?`<Picture ${++image}>`:frames?'<Reference>':m.kind==='audio'?`<Audio ${++audio}>`:`<Video ${++video}>`};});
 const subjects=groups.map(g=>{const selected=refs.filter(m=>m.entityId===g.id);if(!selected.length)return null;const id=`<Subject ${++subject}>`;return {id,g,selected};}).filter(Boolean);
 const join=values=>values.filter(v=>typeof v==='string'&&v.trim()).join('\n');
 const note=(m,g)=>frames?(frameRole(m.id,config.frameBindings||{},config.useLastFrame!==false)||'参考图')+'，首尾帧模式关键帧':(m.kind==='audio'?'voice timbre only; generate the written dialogue, do not copy the sample speech, timing or background sound':g.type==='shot'?'当前镜头画面参考':m.kind);
 const defs=subjects.map(({id,g,selected})=>`${id} is ${g.name}${g.description?' — '+g.description:''}. References: ${selected.map(m=>`${m.tag} (${note(m,g)})`).join(', ')}.`).join('\n');
 const shotPrompt=(d.videoPrompt||'').replace(/^[ \t]*Audio reuse:[ \t]*(?:fully_copy|full_copy)[ \t]*\r?$/gim,'').trim();
 const blocks={subject_definitions:defs,summary:d.action||'',retention_analysis:subjects.map(({id,g,selected})=>`${id}: preserve ${g.name} from ${selected.map(m=>m.tag).join(' and ')}${g.type==='character'?'，保持角色外观与对应音色一致':''}.`).join('\n'),detailed_description:join([shotPrompt,d.action?`Action: ${d.action}`:'',d.dialogue?`Dialogue (preserve exact wording): ${d.dialogue}`:'']),overall_soundscape:d.overall_soundscape||d.soundscape||d.sound||'',non_diegetic_music:d.non_diegetic_music||d.music||'',global_style:project.style||'',composition:join([d.shotSize,d.composition]),camera:d.camera||'',mood:d.mood||'',transition:join([d.transition,frames?'Frame transition: describe how the picture travels from the first frame to the last frame, what changes in between, and the ending state. Do not restate static elements already visible in the first frame.':'']),timing:join([target?`Target duration: ${target} seconds`:'',frames?'Output ratio follows the first frame.':config.aspectRatio||project.aspectRatio])};
 return Object.entries(blockLabels).map(([id,label])=>({id,label,text:blocks[id]||''}));
}
export function assembleVideoPrompt(blocks,enabled){return blocks.filter(b=>enabled[b.id]===true&&b.text?.trim()).map(b=>`${b.id}:\n${b.text.trim()}`).join('\n\n');}
