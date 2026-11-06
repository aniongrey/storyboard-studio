import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceGroups,automaticReferences,automaticBindings,frameBindings,frameRole,videoPromptBlocks,assembleVideoPrompt,referenceToken} from '../public/video-editor.mjs';
import {storyboardVideoReferences} from '../server/autoqueue.mjs';
import {composeStoryboardPrompt,formatStoryboardFinalPrompt} from '../public/storyboard.mjs';
const media=(id,kind)=>({id,kind});
const character={id:'c',type:'character',name:'奶油',data:{description:'白西装'},adoptedMediaIds:{image:'ci',audio:'ca'},media:[media('ci','image'),media('ca','audio'),media('old','image')]};
const shot={id:'s',type:'shot',name:'本镜',data:{duration:4,characterIds:['c'],action:'走入',dialogue:'你好',camera:'推进'},adoptedMediaIds:{image:'si'},media:[media('si','image')]};
const other={id:'other',type:'shot',data:{},media:[media('oi','image')]};
const project={assets:[character,{id:'unrelated',type:'character',data:{},media:[media('ui','image')]}],shots:[shot,other],style:'3D',aspectRatio:'9:16'};

test('unquoted dialogue retains every adopted voice and never drops overflow by speech weight',()=>{
 const assets=['甲','乙','丙','丁'].map((name,i)=>({id:String(i),type:'character',name,data:{},media:[media('v'+i,'audio')],adoptedMediaIds:{audio:'v'+i}}));
 const shots=assets.map((a,i)=>({id:'s'+i,code:String(i),data:{duration:3,characterIds:[a.id],dialogue:a.name+'：'+['短句','这是更长的一句台词','这是更长的第二句台词','这是最长的一句关键台词内容'][i]}}));
 const board={id:'b',type:'storyboard',data:{shotIds:shots.map(s=>s.id)},media:[media('grid','image')],adoptedMediaIds:{image:'grid'}};
 const p={assets,shots};
 assert.deepEqual(automaticReferences(p,board),['grid','v0','v1','v2','v3']);
 const prompt=composeStoryboardPrompt(p,board,'video');
 assert.match(prompt,/<d>\[Chinese\] 短句<\/d>/);
 assert.match(prompt,/<d>\[Chinese\] 这是最长的一句关键台词内容<\/d>/);
});

test('storyboard page and queue select adopted grid, related character images and speaking voices in vocal order',()=>{
 const characters=['甲','乙','丙','丁'].map((name,i)=>({id:`c${i}`,name,type:'character',data:{},adoptedMediaIds:{audio:`a${i}`,image:`i${i}`},media:[media(`old-a${i}`,'audio'),media(`a${i}`,'audio'),media(`old-i${i}`,'image'),media(`i${i}`,'image')]}));
 const shots=[{id:'s1',code:'1',name:'开场',data:{duration:4,characterIds:characters.map(c=>c.id),dialogue:'乙：“先说。”\n甲：“回答。”\n丙（配文）：“不能读。”'},media:[media('shot-image','image')],adoptedMediaIds:{image:'shot-image'}},
 {id:'s2',code:'2',name:'结束',data:{duration:4,characterIds:characters.map(c=>c.id),dialogue:'甲：“再说。”\n（转述：丁在解释）'},media:[]}];
 const board={id:'b',type:'storyboard',data:{shotIds:['s1','s2']},adoptedMediaIds:{image:'grid'},media:[media('grid-old','image'),media('grid','image'),media('board-audio','audio')]};
 const p={shots,assets:[...characters].reverse(),aspectRatio:'16:9'};
 assert.deepEqual(automaticReferences(p,board),['grid','i3','i2','i1','i0','a1','a0']);
 assert.deepEqual(automaticReferences(p,board,'image'),['shot-image','i3','i2','i1','i0']);
 let queued=storyboardVideoReferences(p,board);
 assert.deepEqual(queued.referenceMediaIds,automaticReferences(p,board));
 assert.deepEqual(queued.bindings,[{nodeId:'141',fieldName:'image',mediaId:'grid'},{nodeId:'142',fieldName:'image',mediaId:'i3'},{nodeId:'143',fieldName:'image',mediaId:'i2'},{nodeId:'161',fieldName:'image',mediaId:'i1'},{nodeId:'175',fieldName:'image',mediaId:'i0'},{nodeId:'144',fieldName:'audio',mediaId:'a1'},{nodeId:'160',fieldName:'audio',mediaId:'a0'}]);
 const prompt=composeStoryboardPrompt(p,board,'video',{referenceBindings:queued.bindings});
 assert.match(prompt,/<Audio 1> is the voice-timbre reference for <Subject 3> \(S1\)/);
 assert.match(prompt,/<Audio 2> is the voice-timbre reference for <Subject 4> \(S2\)/);
 characters[1].adoptedMediaIds.audio='missing';
 assert.deepEqual(automaticReferences(p,board),['grid','i3','i2','i1','i0','a0']);
 shots[0].data.dialogue='（无）';shots[1].data.dialogue='丁（配文）：“屏幕内容”';
 assert.deepEqual(automaticReferences(p,board),['grid','i3','i2','i1','i0']);
 characters[1].adoptedMediaIds.audio='a1';
 shots[0].data.dialogue=characters.map(c=>`${c.name}：“发言。”`).join('\n');
 queued=storyboardVideoReferences(p,board);
 assert.equal(queued.referenceMediaIds.length,9);
 assert.equal(queued.bindings.filter(b=>b.fieldName==='image').length,5);
 assert.ok(queued.referenceMediaIds.includes('i0'));
 assert.equal(queued.bindings.filter(b=>b.fieldName==='audio').length,3);
 assert.ok(queued.referenceMediaIds.includes('a3'));
});

test('storyboard page and queue retain adopted character images with the full dialogue track instead of character voices',()=>{
 const dialogueShot={...shot,data:{...shot.data,dialogue:'奶油：你好。'}};
 const board={id:'b',type:'storyboard',data:{shotIds:[shot.id]},adoptedMediaIds:{image:'grid',audio:'dialogue'},media:[media('grid','image'),media('old-dialogue','audio'),media('dialogue','audio')]};
 const p={...project,shots:[dialogueShot]};
 assert.deepEqual(automaticReferences(p,board),['grid','ci','dialogue']);
 const queued=storyboardVideoReferences(p,board);
 assert.deepEqual(queued.referenceMediaIds,['grid','ci','dialogue']);
 assert.deepEqual(queued.bindings,[{nodeId:'141',fieldName:'image',mediaId:'grid'},{nodeId:'142',fieldName:'image',mediaId:'ci'},{nodeId:'144',fieldName:'audio',mediaId:'dialogue'}]);
 assert.deepEqual(automaticReferences(p,board,'image'),['si','ci']);
 board.adoptedMediaIds.audio='missing';
 assert.deepEqual(automaticReferences(p,board),['grid','ci','ca']);
});
test('shot references exclude all other shots and unrelated assets; adopted frame and merged character image/voice default together',()=>{
 const groups=referenceGroups(project,shot);assert.deepEqual(groups.map(g=>g.id),['s','c']);assert.deepEqual(groups[1].media.map(m=>m.id),['ci','ca','old']);
 assert.deepEqual(automaticReferences(project,shot),['si','ci','ca']);
 const selected=groups.flatMap(g=>g.media).filter(m=>automaticReferences(project,shot).includes(m.id));
 assert.deepEqual(automaticBindings(selected),[{nodeId:'141',fieldName:'image',mediaId:'si'},{nodeId:'142',fieldName:'image',mediaId:'ci'},{nodeId:'144',fieldName:'audio',mediaId:'ca'}]);
 const blocks=videoPromptBlocks(project,shot,selected);
 const defs=blocks.find(b=>b.id==='subject_definitions').text;
 assert.match(defs,/<Subject 2> is 奶油/);assert.match(defs,/<Picture 2>.*<Audio 1>/);assert.doesNotMatch(defs,/Picture 3|Subject 3/);
 assert.equal(assembleVideoPrompt(blocks,{}),'');
 const prompt=assembleVideoPrompt(blocks,{subject_definitions:true,detailed_description:true,overall_soundscape:true,non_diegetic_music:true});
 assert.match(prompt,/subject_definitions:/);assert.match(prompt,/你好/);assert.doesNotMatch(prompt,/overall_soundscape:|non_diegetic_music:|global_style:/);
 assert.match(blocks.find(b=>b.id==='timing').text,/4 seconds/);
});
test('missing references add no subject or retention blocks and overflow is not silently bound',()=>{
 const blocks=videoPromptBlocks(project,shot,[]);assert.equal(assembleVideoPrompt(blocks,{subject_definitions:true,retention_analysis:true}),'');
 assert.equal(automaticBindings([1,2,3,4,5,6,7].map(i=>media(String(i),'image'))).length,6);
});

test('shot prompts use audio only for timbre and drop legacy reuse directives without changing source or dialogue',()=>{
 for(const directive of ['Audio reuse: fully_copy','  Audio reuse: full_copy  ']){
  const source={...shot,data:{...shot.data,videoPrompt:`原镜头描述\r\n${directive}\r\n结尾动作`,dialogue:'奶油：“原样保留。”'}};
  const refs=referenceGroups(project,source).flatMap(group=>group.media).filter(m=>automaticReferences(project,source).includes(m.id));
  const blocks=videoPromptBlocks(project,source,refs,{referenceBindings:automaticBindings(refs)});
  const prompt=assembleVideoPrompt(blocks,{subject_definitions:true,detailed_description:true});
  assert.match(prompt,/<Audio 1> \(voice timbre only; generate the written dialogue, do not copy/);
  assert.doesNotMatch(prompt,/Audio reuse:|fully_copy|full_copy/);
  assert.match(prompt,/奶油：“原样保留。”/);
  assert.ok(source.data.videoPrompt.includes(directive));
  assert.equal(assembleVideoPrompt(videoPromptBlocks(project,source,refs),{detailed_description:true}),assembleVideoPrompt(blocks,{detailed_description:true}));
 }
});

test('all six image slots bind and number consistently in shot prompts, storyboard prompts and the queue',()=>{
 const slots=['141','142','143','161','175','176'];
 const assets=Array.from({length:5},(_,i)=>({id:`c${i}`,name:`角色${i}`,type:'character',data:{},adoptedMediaIds:{image:`i${i}`},media:[media(`i${i}`,'image')]}));
 const shot={id:'s',type:'shot',data:{characterIds:assets.map(a=>a.id),duration:4}};
 const board={id:'b',type:'storyboard',data:{shotIds:['s']},adoptedMediaIds:{image:'grid'},media:[media('grid','image')]};
 const p={assets,shots:[shot]};
 const queued=storyboardVideoReferences(p,board);
 assert.deepEqual(queued.referenceMediaIds,['grid','i0','i1','i2','i3','i4']);
 assert.deepEqual(queued.bindings,queued.referenceMediaIds.map((mediaId,i)=>({nodeId:slots[i],fieldName:'image',mediaId})));
 const config={referenceBindings:queued.bindings};
 const refs=referenceGroups(p,board).flatMap(g=>g.media).filter(m=>queued.referenceMediaIds.includes(m.id));
 for(const [i,id] of queued.referenceMediaIds.entries())assert.equal(referenceToken(refs.find(m=>m.id===id),queued.bindings),`<Picture ${i+1}>`);
 const definitions=videoPromptBlocks(p,shot,refs,config).find(b=>b.id==='subject_definitions').text;
 const combined=composeStoryboardPrompt(p,board,'video',config),formatted=formatStoryboardFinalPrompt(p,board,config);
 for(let i=2;i<=6;i++){
   assert.ok(definitions.includes(`<Picture ${i}>`));
   assert.ok(combined.includes(`角色${i-2} reference: <Picture ${i}>.`));
   assert.ok(formatted.includes(`Additional visual reference: <Picture ${i}>.`));
 }
});
test('target duration follows the actual generation duration and only falls back to the planned cut length',()=>{
 const at=config=>videoPromptBlocks(project,shot,[],config).find(b=>b.id==='timing').text;
 assert.match(at({duration:'8'}),/Target duration: 8 seconds/);
 assert.match(at({duration:8}),/Target duration: 8 seconds/);
 assert.match(at({}),/Target duration: 4 seconds/);
 assert.match(at({duration:''}),/Target duration: 4 seconds/);
 assert.match(at({duration:'0'}),/Target duration: 4 seconds/);
});


test('placeholder numbers match real slots even when one image occupies multiple slots',()=>{
 const ci={...media('ci','image'),entityId:'c'};
 const bindings=[{nodeId:'141',fieldName:'image',mediaId:'si'},{nodeId:'142',fieldName:'image',mediaId:'si'},{nodeId:'143',fieldName:'image',mediaId:'ci'}];
 assert.equal(referenceToken(ci,bindings),'<Picture 3>');
 const blocks=videoPromptBlocks(project,shot,[{...media('si','image'),entityId:'s'},ci],{referenceBindings:bindings});
 const defs=blocks.find(b=>b.id==='subject_definitions').text;
 assert.match(defs,/<Picture 1> and <Picture 2>/);assert.match(defs,/<Subject 2> is 奶油.*<Picture 3>/);
});
test('first/last frame labels replace picture numbers and the timing block follows the first frame',()=>{
 const images=[{...media('f1','image'),entityId:'s'},{...media('f2','image'),entityId:'s'}];
 const config={mode:'frames',duration:'10',frameBindings:{first:'f1',last:'f2'},useLastFrame:true};
 const bindings=frameBindings(config.frameBindings,true);
 assert.deepEqual(bindings,[{nodeId:'137',fieldName:'image',mediaId:'f1'},{nodeId:'143',fieldName:'image',mediaId:'f2'}]);
 assert.equal(referenceToken(images[0],bindings,true),'<First frame>');
 assert.equal(referenceToken(images[1],bindings,true),'<Last frame>');
 assert.equal(frameRole('f1',config.frameBindings,true),'首帧');
 assert.equal(frameRole('f2',config.frameBindings,true),'尾帧');
 const blocks=videoPromptBlocks(project,shot,images,config);
 const defs=blocks.find(b=>b.id==='subject_definitions').text;
 assert.match(defs,/<First frame>/);assert.match(defs,/<Last frame>/);assert.doesNotMatch(defs,/<Picture/);
 assert.match(blocks.find(b=>b.id==='timing').text,/Output ratio follows the first frame/);
 assert.match(blocks.find(b=>b.id==='transition').text,/first frame to the last frame/);
 const single=videoPromptBlocks(project,shot,[images[0]],{...config,useLastFrame:false,frameBindings:{first:'f1',last:'f2'}});
 assert.doesNotMatch(single.find(b=>b.id==='subject_definitions').text,/<Last frame>/);
 assert.equal(frameBindings({first:'f1',last:'f2'},false).length,1);
 assert.equal(frameBindings({},true).length,0);
});
