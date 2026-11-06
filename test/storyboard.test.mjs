import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StudioStore } from '../server/store.mjs';
import { GenerationService, DEFAULT_VIDEO_CONFIG, FRAME_VIDEO_CONFIG } from '../server/generation.mjs';
import { createStudio } from '../server/main.mjs';
import { referenceGroups } from '../public/video-editor.mjs';
import { storyboardSource, storyboardSummary, storyboardMediaFresh, storyboardDuration, composeStoryboardPrompt, storyboardFinalPrompt, formatStoryboardFinalPrompt, previewSequence, mediaRatio, ratioText, ratioValue, storyboardProblem } from '../public/storyboard.mjs';

const source = await readFile(new URL('../examples/奶油变心后_分镜提示词.md', import.meta.url), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-storyboard-'));
  const store = new StudioStore({ dataDir });
  const project = store.importMarkdown(source, 'sample.md');
  const board = store.createStoryboard(project.id, { name: '第一组', shotIds: project.shots.slice(0, 4).map(shot => shot.id) });
  const calls = [];
  const service = new GenerationService({ store, dataDir, appRoot: resolve('.'), getRunningHubKey: () => 'mock-test-credential', pollIntervalMs: 60000,
    inspectCodexImpl: async () => ({ available: true, loggedIn: false }),
    validateMedia: async (file, kind) => ({ sha256: digest(await readFile(file)), mime: `${kind}/${kind === 'image' ? 'png' : 'mp4'}`, extension: kind === 'image' ? '.png' : '.mp4', width: 100, height: 100, duration: kind === 'video' ? 12 : undefined }),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body instanceof FormData ? null : JSON.parse(options.body) });
      if (url.endsWith('/media/upload/binary')) return Response.json({ data: { fileName: 'openapi/storyboard.png' } });
      if (url.includes('/run/ai-app/')) return Response.json({ taskId: '88000001', status: 'RUNNING' });
      throw new Error(`Unexpected mock URL: ${url}`);
    } });
  return { dataDir, store, project, board, calls, service, async cleanup() { service.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
async function media(f, owner, kind = 'image', metadata = {}) {
  const file = `projects/${f.project.id}/${owner.id}-${owner.media.length}.${kind === 'image' ? 'png' : 'mp4'}`;
  const bytes = Buffer.from(`mock ${file}`);
  await mkdir(join(f.dataDir, 'projects', f.project.id), { recursive: true });
  await writeFile(join(f.dataDir, file), bytes);
  return f.store.addMedia(f.project.id, owner.id, { file, sha256: digest(bytes), kind, mime: `${kind}/${kind === 'image' ? 'png' : 'mp4'}`, baseVersion: owner.currentVersion, metadata });
}
async function boardImage(f) {
  const project = f.store.getProject(f.project.id), board = f.store.getEntity(project.id, f.board.id);
  const image = await media(f, board, 'image', { storyboardSource: storyboardSource(project, board) });
  f.store.adopt(project.id, board.id, image.id);
  return image;
}
const configFor = image => ({ ...structuredClone(DEFAULT_VIDEO_CONFIG), outputResolution: 'native', duration: '12', referenceBindings: [{ nodeId: '141', fieldName: 'image', mediaId: image.id }] });

test('explicit six-shot groups retain continuity checks and all six panel positions', () => {
  const shots=Array.from({length:7},(_,i)=>({id:`s${i}`,code:String(i+1),name:`镜头${i+1}`,order:i,data:{episodeNumber:1,duration:2,action:'人物走路',characterIds:[],locationIds:[]}}));
  const project={shots,assets:[],storyboards:[],aspectRatio:'16:9'},ids=shots.slice(0,6).map(s=>s.id),board={data:{shotIds:ids}};
  assert.equal(storyboardProblem(project,ids),'');
  assert.match(storyboardProblem(project,shots.map(s=>s.id)),/1至6/);
  assert.match(storyboardProblem(project,['s0','s2']),/连续/);
  shots[5].data.episodeNumber=2;
  assert.match(storyboardProblem(project,ids),/跨集/);
  shots[5].data.episodeNumber=1;
  for(const kind of ['image','video']){
    const prompt=composeStoryboardPrompt(project,board,kind);
    assert.match(prompt,/3×2/);assert.match(prompt,/six/);assert.doesNotMatch(prompt,/undefined/);
  }
  assert.match(formatStoryboardFinalPrompt(project,board),/\[Shot 6\].*bottom-right/);
});

test('storyboard accepts explicitly bound supporting pictures and video while retaining its primary image and sole audio', async () => {
  const f=await fixture();
  try {
    const primary=await boardImage(f),picture=await media(f,f.board),video=await media(f,f.board,'video'),audio=await media(f,f.board,'audio');
    f.store.adopt(f.project.id,f.board.id,audio.id);
    const config=configFor(primary);
    config.referenceBindings.push({nodeId:'142',fieldName:'image',mediaId:picture.id},{nodeId:'164',fieldName:'video',mediaId:video.id},{nodeId:'144',fieldName:'audio',mediaId:audio.id});
    const input={projectId:f.project.id,entityId:f.board.id,kind:'video',referenceMediaIds:[primary.id,picture.id,video.id,audio.id],videoConfig:config};
    const preview=await f.service.prepare(input);
    assert.deepEqual(preview.blockers,[]);
    assert.equal(preview.request.nodeInfoList.find(n=>n.nodeId==='163').fieldValue,'true');
    const noPrimary=await f.service.prepare({...input,referenceMediaIds:[picture.id,video.id,audio.id]});
    assert.ok(noPrimary.blockers.some(x=>x.includes('已采用故事板图片')));
    const candidate=await media(f,f.board,'audio');
    const extraAudio=await f.service.prepare({...input,referenceMediaIds:[...input.referenceMediaIds,candidate.id],videoConfig:{...config,referenceBindings:[...config.referenceBindings,{nodeId:'160',fieldName:'audio',mediaId:candidate.id}]}});
    assert.ok(extraAudio.blockers.some(x=>x.includes('唯一音频')));
    assert.ok(extraAudio.blockers.some(x=>x.includes('候选音频')));
    const withoutVideo=await f.service.prepare({...input,referenceMediaIds:input.referenceMediaIds.filter(id=>id!==video.id),videoConfig:{...config,referenceBindings:config.referenceBindings.filter(b=>b.mediaId!==video.id)}});
    assert.equal(withoutVideo.request.nodeInfoList.find(n=>n.nodeId==='163').fieldValue,'false');
    assert.ok(f.calls.every(call=>call.url.endsWith('/media/upload/binary')));
  } finally {await f.cleanup();}
});

test('saved final prompts override only storyboard video, persist, and empty values fall back', async () => {
  const f = await fixture();
  try {
    const image = await boardImage(f), config = configFor(image);
    let project = f.store.getProject(f.project.id), board = f.store.getEntity(project.id, f.board.id);
    const combination = composeStoryboardPrompt(project, board, 'video', config);
    assert.equal(storyboardFinalPrompt(project, board, config), combination);
    assert.throws(() => f.store.updateEntity(project.id, board.id, { baseVersion: board.currentVersion, data: { finalPrompt: 1 } }), { status: 400 });
    board = f.store.updateEntity(project.id, board.id, { baseVersion: board.currentVersion, data: { finalPrompt: '主体定义：\n<主体 1> 保持自己的音色。\n详细描述：\n角色对白不可互换。' } });
    assert.equal(composeStoryboardPrompt(project, board, 'video', config), combination);
    assert.ok(storyboardMediaFresh(project, board, image));
    const second = new StudioStore({ dataDir: f.dataDir });
    try { assert.equal(second.getEntity(project.id, board.id).data.finalPrompt, board.data.finalPrompt); } finally { second.close(); }
    const preview = await f.service.prepare({ projectId: project.id, entityId: board.id, kind: 'video', videoConfig: config, referenceMediaIds: [image.id] });
    assert.equal(preview.prompt, board.data.finalPrompt);
    assert.deepEqual(preview.blockers, []);
    await assert.rejects(f.service.prepare({ projectId: project.id, entityId: board.id, kind: 'video', prompt: combination, videoConfig: config, referenceMediaIds: [image.id] }), { status: 409 });
    board = f.store.updateEntity(project.id, board.id, { baseVersion: board.currentVersion, data: { finalPrompt: '  ' } });
    const fallback = await f.service.prepare({ projectId: project.id, entityId: board.id, kind: 'video', videoConfig: config, referenceMediaIds: [image.id] });
    assert.equal(fallback.prompt, combination);
    assert.ok(f.calls.every(call => call.url.endsWith('/media/upload/binary')));
  } finally { await f.cleanup(); }
});

test('H3 final prompt keeps official labels and assigns speakers by vocal order independently of subjects and audio slots', () => {
  const man = { id:'man', type:'character', name:'男人', data:{description:'黑色外套'}, media:[{id:'voice-man',kind:'audio'}] };
  const woman = { id:'woman', type:'character', name:'女人', data:{description:'米色外套'}, media:[{id:'voice-woman',kind:'audio'}] };
  const shots = [
    { id:'s1', code:'1', name:'问候', data:{duration:4,characterIds:['man','woman'],action:'男人走向女人',dialogue:'男人：“今天顺利吗？”\n女人："就等你了。"'} },
    { id:'s2', code:'2', name:'对视', data:{duration:4,characterIds:['woman','man'],action:'两人对视',dialogue:'女人（配文）：“字幕内容”\n女人：“回家吧！”'} },
  ];
  const project = { assets:[woman,man], shots, aspectRatio:'16:9', style:'暖色' }, board = { data:{shotIds:['s1','s2']} };
  const prompt = formatStoryboardFinalPrompt(project, board, { duration:'12', referenceBindings:[{nodeId:'160',fieldName:'audio',mediaId:'voice-man'},{nodeId:'144',fieldName:'audio',mediaId:'voice-woman'}] });
  assert.deepEqual([...prompt.matchAll(/^(\w+):$/gm)].map(match=>match[1]),['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music']);
  assert.match(prompt, /<Audio 2> is the voice-timbre reference for <Subject 2> \(S1\)/);
  assert.match(prompt, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S2\)/);
  assert.match(prompt, /<Subject 2> \(S1\) says using the voice timbre from <Audio 2>: <d>\[Chinese\] 今天顺利吗？<\/d>/);
  assert.match(prompt, /<Subject 1> \(S2\) says using the voice timbre from <Audio 1>: <d>\[Chinese\] 就等你了。<\/d>/);
  assert.match(prompt, /<Subject 1> \(S2\)[^\n]*<d>\[Chinese\] 回家吧！<\/d>/);
  assert.match(prompt, /Visible text: "字幕内容"/);
  assert.doesNotMatch(prompt, /<d>\[Chinese\] 字幕内容/);
  assert.match(prompt, /\[Shot 2\] At 00:06\.000/);
  assert.match(prompt, /ends at 12\.00 seconds/);
  assert.doesNotMatch(prompt.split('retention_analysis:')[1].split('detailed_description:')[0], /\(S\d+\)/);
  assert.doesNotMatch(prompt, /<主体|<图片|<音频|<对白>|\[中文\]|\[镜头/);
  shots[1].data.dialogue='陌生人：“不能猜测”';
  assert.throws(()=>formatStoryboardFinalPrompt(project,board),/说话人“陌生人”无法对应关联角色/);
});

test('saved voice instructions follow changed audio slots without rewriting dialogue or camera', () => {
  const assets = ['老爷','帕鲁','快乐','女王'].map((name,index)=>({id:String(index),name,type:'character',data:{visualPrompt:index===3?'mother queen':'man'},media:[{id:`a${index}`,kind:'audio'}]}));
  const shots = [2,1,0,3].map((index,i)=>({id:`s${i}`,data:{characterIds:[String(index)],dialogue:`${assets[index].name}：台词${i}`,duration:4}}));
  const project={assets,shots},board={data:{shotIds:shots.map(shot=>shot.id),finalPrompt:`subject_definitions:
<Subject 1> (S3) uses a distinct male Mandarin voice.
<Subject 2> (S2) uses the voice timbre from <Audio 2>.
<Subject 3> (S1) uses the voice timbre from <Audio 1>.
<Subject 4> (S4) uses the voice timbre from <Audio 3>.

retention_analysis:
<Audio 2>: reference - retain timbre for <Subject 2> (S2).
<Audio 3>: reference - retain timbre for <Subject 4> (S4).

detailed_description:
Camera: Keep my manually edited upward tilt.
<Subject 2> (S2) says using <Audio 2>: <d>[Chinese] 台词1</d> Other lips closed.
<Subject 1> (S3) says in the voice defined above: <d>[Chinese] 台词2</d>
<Subject 4> (S4) says using <Audio 3>: <d>[Chinese] 台词3</d>
`}};
  const original=board.data.finalPrompt;
  const config={referenceBindings:[{nodeId:'144',fieldName:'audio',mediaId:'a2'},{nodeId:'160',fieldName:'audio',mediaId:'a3'},{nodeId:'189',fieldName:'audio',mediaId:'a0'}]};
  const prompt=storyboardFinalPrompt(project,board,config);
  assert.match(prompt,/<Subject 4> \(S4\) says using the voice timbre from <Audio 2>: <d>\[Chinese\] 台词3<\/d>/);
  assert.match(prompt,/<Subject 1> \(S3\) says using the voice timbre from <Audio 3>/);
  assert.match(prompt,/<Subject 2> \(S2\) says using a distinct consistent Mandarin voice/);
  assert.match(prompt,/<Audio 2>: reference - retain the assigned voice timbre for <Subject 4> \(S4\)/);
  assert.match(prompt,/Camera: Keep my manually edited upward tilt\./);
  assert.equal(board.data.finalPrompt,original);
  assert.equal(storyboardFinalPrompt(project,{data:{...board.data,finalPrompt:prompt}},config),prompt);
  const removed=storyboardFinalPrompt(project,board,{referenceBindings:[]});
  assert.doesNotMatch(removed,/<Audio \d+>/);
  assert.match(removed,/<Subject 4> \(S4\) says using a distinct consistent female Mandarin voice/);
  const rebound=storyboardFinalPrompt(project,{data:{...board.data,finalPrompt:removed}},config);
  assert.equal(rebound,prompt);
});

test('adopted storyboard dialogue audio preserves saved prompts and makes drafts copy the complete track', () => {
  const character={id:'c',name:'角色',type:'character',data:{},media:[{id:'voice',kind:'audio'}],adoptedMediaIds:{audio:'voice'}};
  const project={assets:[character],shots:[{id:'s',code:'1',name:'对白',data:{duration:4,characterIds:['c'],dialogue:'角色：原台词。',sound:'脚步声',music:'背景音乐'}}]};
  const board={data:{shotIds:['s'],finalPrompt:'subject_definitions:\n<Audio 1> is the complete dialogue track.\nAudio reuse: fully_copy\ndetailed_description:\n<Subject 1> (S1) says using <Audio 1>: <d>[Chinese] 原台词。</d>'},media:[{id:'dialogue',kind:'audio'}],adoptedMediaIds:{audio:'dialogue'}};
  const config={referenceBindings:[{nodeId:'144',fieldName:'audio',mediaId:'dialogue'}]};
  assert.equal(storyboardFinalPrompt(project,board,config),board.data.finalPrompt);
  for (const prompt of [composeStoryboardPrompt(project,board,'video',config),formatStoryboardFinalPrompt(project,board,config)]) {
    assert.match(prompt,/Audio reuse: fully_copy/);
    assert.match(prompt,/matching segment in <Audio 1>/);
    assert.match(prompt,/<d>\[Chinese\] 原台词。<\/d>/);
    assert.doesNotMatch(prompt,/voice.timbre reference|without copying|never its original spoken words|脚步声|背景音乐/);
  }
  assert.doesNotMatch(composeStoryboardPrompt(project,board,'image',config),/Audio reuse|<Audio 1>/);
});

test('camera planning preserves explicit instructions and designs stable opening, tracking, reaction and ending shots', () => {
  const shots=Array.from({length:4},(_,i)=>({id:`s${i}`,code:String(i),name:'镜头',data:{duration:3,action:i===1?'角色走过房间':'角色停下'}}));
  const project={assets:[],shots,aspectRatio:'16:9'},board={data:{shotIds:shots.map(shot=>shot.id)}};
  const prompt=formatStoryboardFinalPrompt(project,board,{duration:'12'});
  assert.match(prompt,/Camera: The camera pushes in with small amplitude at slow speed from the storyboard composition/);
  assert.match(prompt,/Camera: The camera tracks the moving subject with small amplitude at a matching speed/);
  assert.match(prompt,/Camera: The camera holds a static shot/);
  assert.match(prompt,/eases to a stop before the shot ends/);
  assert.match(prompt,/Preserve the established camera axis, eyelines and character screen positions/);
  shots[1].data.camera='镜头沿桌面缓慢向右平移';
  const changed=formatStoryboardFinalPrompt(project,board);
  assert.match(changed,/Camera: 镜头沿桌面缓慢向右平移/);
  assert.doesNotMatch(changed,/Camera: The camera tracks/);
  assert.equal(shots[0].data.camera,undefined);
});

test('one and three-shot grids leave unused cells blank and generate only their valid shots and duration', () => {
  const shots=Array.from({length:3},(_,i)=>({id:`s${i}`,code:String(i),name:'镜头',order:i,data:{duration:3,action:'角色停下'}}));
  const project={assets:[],shots,aspectRatio:'16:9'};
  for (const count of [1,3]) {
    const board={data:{shotIds:shots.slice(0,count).map(s=>s.id)}};
    const image=composeStoryboardPrompt(project,board,'image');
    assert.match(image,/solid white/);
    assert.match(image,count===1?/one distinct shots/:/three distinct shots/);
    const video=formatStoryboardFinalPrompt(project,board);
    assert.match(video,new RegExp(`Generate ${count} full-screen shots`));
    assert.match(video,/ignore the empty/);
    assert.match(video,new RegExp(`Duration: ${count*3} seconds`));
    assert.equal([...video.matchAll(/^\[Shot \d\]/gm)].length,count);
    assert.doesNotMatch(video,/\[Shot 4\]|black.hole|deep space/i);
  }
});

test('legacy four-speaker groups remain readable but video preparation blocks overflow before upload', async () => {
  const f=await fixture();
  try {
    const image=await boardImage(f);
    const characters=f.project.assets.filter(a=>a.type==='character').slice(0,4);
    f.project.shots.slice(0,4).forEach((shot,i)=>f.store.updateEntity(f.project.id,shot.id,{baseVersion:shot.currentVersion,data:{characterIds:[characters[i].id],dialogue:`${characters[i].name}：发言。`}}));
    const project=f.store.getProject(f.project.id);
    assert.equal(previewSequence(project,'storyboards').length,1);
    const preview=await f.service.prepare({projectId:project.id,entityId:f.board.id,kind:'video',referenceMediaIds:[image.id],videoConfig:configFor(image)});
    assert.ok(preview.blockers.some(message=>/超过3个说话角色/.test(message)));
    assert.equal(f.calls.length,0);
  } finally {await f.cleanup();}
});

test('video preparation cannot omit an adopted voice belonging to a speaking character', async () => {
  const f=await fixture();
  try {
    const image=await boardImage(f);
    const character=f.project.assets.find(a=>a.type==='character' && f.project.shots.slice(0,4).some(s=>(s.data.dialogue||'').includes(a.name+'：')));
    const voice=await media(f,character,'audio');f.store.adopt(f.project.id,character.id,voice.id);
    const preview=await f.service.prepare({projectId:f.project.id,entityId:f.board.id,kind:'video',referenceMediaIds:[image.id],videoConfig:configFor(image)});
    assert.ok(preview.blockers.some(message=>message.includes(character.name)&&message.includes('音色未引用')));
    assert.equal(f.calls.length,0);
  } finally {await f.cleanup();}
});

test('storyboard full dialogue track requires Audio 1 only and retains image, speaker and adoption checks', async () => {
  const f=await fixture();
  try {
    const image=await boardImage(f);
    const character=f.project.assets.find(a=>a.type==='character' && f.project.shots.slice(0,4).some(s=>(s.data.dialogue||'').includes(a.name+'：')));
    const voice=await media(f,character,'audio');f.store.adopt(f.project.id,character.id,voice.id);
    let board=f.store.getEntity(f.project.id,f.board.id);
    const audio=await media(f,board,'audio');f.store.adopt(f.project.id,board.id,audio.id);
    const prompt='subject_definitions:\n<Audio 1> is the complete dialogue track.\nAudio reuse: fully_copy\ndetailed_description:\n<Subject 1> (S1) says using <Audio 1>: <d>[Chinese] 原台词。</d>';
    board=f.store.getEntity(f.project.id,board.id);
    f.store.updateEntity(f.project.id,board.id,{baseVersion:board.currentVersion,data:{finalPrompt:prompt}});
    const config=configFor(image);
    config.referenceBindings.push({nodeId:'144',fieldName:'audio',mediaId:audio.id});
    const input={projectId:f.project.id,entityId:board.id,kind:'video',referenceMediaIds:[image.id,audio.id],videoConfig:config,prompt};
    const invalid=[
      {...input,referenceMediaIds:[image.id]},
      {...input,videoConfig:{...config,referenceBindings:[config.referenceBindings[0],{nodeId:'160',fieldName:'audio',mediaId:audio.id}]}},
      {...input,referenceMediaIds:[image.id,audio.id,voice.id],videoConfig:{...config,referenceBindings:[...config.referenceBindings,{nodeId:'160',fieldName:'audio',mediaId:voice.id}]}},
    ];
    for (const request of invalid) {
      const preview=await f.service.prepare(request);
      assert.ok(preview.blockers.some(message=>message.includes('唯一音频')));
    }
    const wrongImage=await f.service.prepare({...input,videoConfig:{...config,referenceBindings:[{nodeId:'142',fieldName:'image',mediaId:image.id},config.referenceBindings[1]]}});
    assert.ok(wrongImage.blockers.some(message=>message.includes('参考图1')));
    assert.equal(f.calls.length,0);
    const preview=await f.service.prepare(input);
    assert.deepEqual(preview.blockers,[]);
    assert.equal(preview.prompt,prompt);
    assert.deepEqual(preview.references.filter(ref=>ref.kind==='audio').map(ref=>ref.mediaId),[audio.id]);
    assert.equal(preview.request.nodeInfoList.find(node=>node.nodeId==='144').fieldValue,'openapi/storyboard.png');
    for (const nodeId of ['160','189']) assert.equal(preview.request.nodeInfoList.find(node=>node.nodeId===nodeId).fieldValue,'None');
    assert.equal(f.calls.length,2);
    board=f.store.getEntity(f.project.id,board.id);
    const replacement=await media(f,board,'audio');f.store.adopt(f.project.id,board.id,replacement.id);
    await assert.rejects(f.service.submit({previewId:preview.id,operationId:'changed-dialogue-adoption'}),{code:'PREVIEW_STALE'});
    const characters=f.project.assets.filter(asset=>asset.type==='character').slice(0,4);
    f.project.shots.slice(0,4).forEach((shot,index)=>f.store.updateEntity(f.project.id,shot.id,{baseVersion:shot.currentVersion,data:{characterIds:[characters[index].id],dialogue:`${characters[index].name}：发言。`}}));
    const overflow=await f.service.prepare({...input,referenceMediaIds:[image.id,replacement.id],videoConfig:{...config,referenceBindings:[config.referenceBindings[0],{nodeId:'144',fieldName:'audio',mediaId:replacement.id}]}});
    assert.ok(overflow.blockers.some(message=>message.includes('超过3个说话角色')));
    assert.equal(f.calls.length,2);
  } finally {await f.cleanup();}
});

test('empty final prompt fallback includes real dialogue tags and excludes narration and screen copy', async () => {
  const f=await fixture();
  try {
    const prompt=storyboardFinalPrompt(f.project,f.board,{duration:'12'});
    assert.match(prompt,/<d>\[Chinese\] 明晚，把你喜欢的那套礼服穿来。<\/d>/);
    assert.match(prompt,/<d>\[Chinese\] 早分了。她还放不下。<\/d>/);
    assert.doesNotMatch(composeStoryboardPrompt(f.project,f.board,'image'),/<d>\[Chinese\]/);
    const board={data:{shotIds:f.project.shots.slice(-2).map(shot=>shot.id)}};
    const ending=storyboardFinalPrompt(f.project,board);
    assert.match(ending,/Visible text: "泡芙配红烧肉，你敢尝吗？"/);
    assert.doesNotMatch(ending,/<d>\[Chinese\]/);
    assert.equal(storyboardFinalPrompt(f.project,{...f.board,data:{...f.board.data,finalPrompt:'手动保存的文本'}}),'手动保存的文本');
  } finally {await f.cleanup();}
});

test('the final two shots can share a four-panel sheet with empty bottom panels', async () => {
  const f = await fixture();
  try {
    const ids = f.project.shots.map(shot => shot.id);
    assert.equal(f.store.createStoryboard(f.project.id, { shotIds: ids.slice(5, 7) }).data.shotIds.length, 2);
    assert.throws(() => f.store.createStoryboard(f.project.id, { shotIds: [ids.at(-1), ids.at(-1)] }), { status: 400 });
    const board = f.store.createStoryboard(f.project.id, { name: '片尾', shotIds: ids.slice(-2) });
    assert.equal(storyboardDuration(f.project, board), 9);
    const prompt = composeStoryboardPrompt(f.project, board, 'image');
    assert.match(prompt, /two distinct shots/);
    assert.match(prompt, /leave both bottom panels empty/);
    assert.match(prompt, /Panel 1 .*44-F/);
    assert.match(prompt, /Panel 2 .*45-F/);
    assert.doesNotMatch(prompt, /Panel 3|Panel 4/);
    const video = composeStoryboardPrompt(f.project, board, 'video');
    assert.match(video, /ignore the empty bottom panels/);
    assert.throws(() => f.store.createStoryboard(f.project.id, { shotIds: ids.slice(-2) }), { status: 400 });
    const image = await media(f, board, 'image', { storyboardSource: storyboardSource(f.store.getProject(f.project.id), board) });
    f.store.adopt(f.project.id, board.id, image.id);
    assert.ok(storyboardMediaFresh(f.store.getProject(f.project.id), f.store.getEntity(f.project.id, board.id), image));
  } finally { await f.cleanup(); }
});

test('storyboard summaries follow saved member order, prefer titles and fall back to visual content', () => {
  const project = { shots: [
    { id: 'a', code: '01-A', name: '  推门  ', data: { action: '不应盖过原标题' } },
    { id: 'b', code: '02-A', name: '', data: { action: '拾起纸条\n看清字迹' } },
    { id: 'c', code: '03-A', name: ' ', data: { composition: '窗边留下的背影' } },
    { id: 'd', code: '04-A', data: {} },
  ] };
  const before = JSON.stringify(project);
  assert.equal(storyboardSummary(project, { data: { shotIds: ['b', 'a', 'c', 'd'] } }), '拾起纸条 看清字迹 → 推门 → 窗边留下的背影 → 未命名镜头 04-A');
  project.shots[1].data.action = '长'.repeat(100);
  assert.equal(storyboardSummary(project, { data: { shotIds: ['b'] } }), '长'.repeat(48));
  project.shots[1].data.action = '拾起纸条\n看清字迹';
  assert.equal(JSON.stringify(project), before);
});

test('new storyboard names default to original shot titles and keep supplied names', async () => {
  const f = await fixture();
  try {
    const shots = f.project.shots.slice(4, 6);
    const board = f.store.createStoryboard(f.project.id, { shotIds: shots.map(shot => shot.id) });
    assert.equal(board.name, shots.map(shot => shot.name).join(' → '));
    assert.equal(board.versions[0].name, board.name);
    assert.equal(f.board.name, '第一组');
    assert.deepEqual(f.store.getProject(f.project.id).shots, f.project.shots);
  } finally { await f.cleanup(); }
});

test('storyboards persist four references, reject invalid/overlapping membership and protect original data', async () => {
  const f = await fixture();
  try {
    const ids = f.project.shots.map(shot => shot.id);
    assert.equal(f.store.getProject(f.project.id).shots.length, 45);
    assert.equal(f.store.getProject(f.project.id).summaryDuration, 160);
    for (const shotIds of [[], ids.slice(5, 12), [ids[5], ids[5], ids[6], ids[7]], [ids[5], ids[6], ids[7], 'missing'], [ids[5], ids[6], ids[7], ids[9]], ids.slice(1, 5)]) {
      assert.throws(() => f.store.createStoryboard(f.project.id, { shotIds }), { status: 400 });
    }
    assert.throws(() => f.store.updateEntity(f.project.id, f.board.id, { baseVersion: f.board.currentVersion, data: { action: '不能复制剧情' } }), { status: 400 });
    const changed = f.store.updateEntity(f.project.id, f.board.id, { baseVersion: f.board.currentVersion, data: { shotIds: [...f.board.data.shotIds].reverse() } });
    assert.deepEqual(changed.data.shotIds, [...f.board.data.shotIds].reverse());
    assert.throws(() => f.store.updateEntity(f.project.id, f.board.id, { baseVersion: f.board.currentVersion, name: '旧页覆盖' }), { status: 409 });
    const last = f.store.getEntity(f.project.id, ids[3]);
    assert.throws(() => f.store.reorderShot(f.project.id, last.id, 'down', last.currentVersion), { status: 409 });
    assert.equal(f.store.getEntity(f.project.id, last.id).order, last.order);
    const second = new StudioStore({ dataDir: f.dataDir });
    try { assert.deepEqual(second.getEntity(f.project.id, f.board.id).data.shotIds, changed.data.shotIds); } finally { second.close(); }
    assert.equal(f.store.getProject(f.project.id).source.text, source);
  } finally { await f.cleanup(); }
});

test('single-shot repairs preserve the original group and both remain usable for video', async () => {
  const f = await fixture();
  try {
    const image = await boardImage(f);
    const original = structuredClone(f.store.getEntity(f.project.id, f.board.id));
    const shotIds = [original.data.shotIds[0]];
    const repair = f.store.createStoryboard(f.project.id, { name: '首镜返修', shotIds });
    assert.deepEqual(f.store.getEntity(f.project.id, original.id), original);
    assert.throws(() => f.store.createStoryboard(f.project.id, { shotIds }), /已经组成/);
    assert.throws(() => f.store.createStoryboard(f.project.id, { shotIds: original.data.shotIds.slice(0, 2) }), /属于其他/);
    const repairImage = await boardImage({ ...f, board: repair });
    for (const [board, reference] of [[original, image], [repair, repairImage]]) {
      const preview = await f.service.prepare({ projectId: f.project.id, entityId: board.id, kind: 'video', referenceMediaIds: [reference.id], videoConfig: configFor(reference) });
      assert.deepEqual(preview.blockers, []);
    }
    assert.deepEqual(f.store.getProject(f.project.id).shots, f.project.shots);
    assert.ok(f.calls.every(call => call.url.endsWith('/media/upload/binary')));
  } finally { await f.cleanup(); }
});

test('original shot edits update prompts and allow the adopted grid from an older story version', async () => {
  const f = await fixture();
  try {
    const image = await boardImage(f);
    let project = f.store.getProject(f.project.id), board = f.store.getEntity(project.id, f.board.id);
    assert.ok(storyboardMediaFresh(project, board, image));
    const video = composeStoryboardPrompt(project, board, 'video', { duration: '12' });
    assert.match(video, /top-left, top-right, bottom-left, bottom-right/);
    assert.match(video, /Target duration: 12 seconds/);
    assert.match(video, /–12\.00 seconds/);
    assert.ok(video.includes(project.shots[0].data.dialogue));
    assert.ok(!video.includes(project.shots[0].data.videoPrompt));
    const shot = project.shots[1];
    f.store.updateEntity(project.id, shot.id, { baseVersion: shot.currentVersion, data: { action: '统一新剧情：角色跑到窗边' } });
    project = f.store.getProject(project.id);
    for (const kind of ['image', 'video']) assert.match(composeStoryboardPrompt(project, board, kind), /统一新剧情：角色跑到窗边/);
    assert.equal(storyboardMediaFresh(project, board, image), false);
    assert.equal(project.shots[1].raw, shot.raw);
    const config = configFor(image);
    const preview = await f.service.prepare({ projectId: project.id, entityId: board.id, kind: 'video', referenceMediaIds: [image.id], videoConfig: config });
    assert.deepEqual(preview.blockers, []);
    const job=await f.service.submit({ previewId: preview.id, operationId: 'old-grid-video' });
    assert.equal(job.status,'running');
  } finally { await f.cleanup(); }
});

test('storyboard image jobs freeze all four source versions and deliver old candidates without overwriting', async () => {
  const f = await fixture();
  try {
    const member = f.project.shots[0], other = f.project.shots[5];
    const memberImage = await media(f, member), otherImage = await media(f, other);
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.board.id, kind: 'image', referenceMediaIds: [memberImage.id] });
    assert.deepEqual(preview.blockers, []);
    for (const shot of f.project.shots.slice(0, 4)) assert.equal(preview.dependencyVersions[shot.id], shot.currentVersion);
    await assert.rejects(f.service.prepare({ projectId: f.project.id, entityId: f.board.id, kind: 'image', referenceMediaIds: [otherImage.id] }), /本组/);
    await assert.rejects(f.service.prepare({ projectId: f.project.id, entityId: member.id, kind: 'image', referenceMediaIds: [otherImage.id] }), /其他分镜/);
    const job = await f.service.submit({ previewId: preview.id, operationId: 'storyboard-image-job' });
    const request = JSON.parse(await readFile(join(job.deliveryDirectory, 'request.json'), 'utf8'));
    assert.deepEqual(request.storyboardSource, preview.storyboardSource);
    f.store.updateEntity(f.project.id, member.id, { baseVersion: member.currentVersion, data: { action: '交付前发生变化' } });
    await writeFile(join(job.deliveryDirectory, 'grid.png'), 'mock delivered grid');
    await writeFile(join(job.deliveryDirectory, 'result.json'), JSON.stringify({ schemaVersion: 1, jobId: job.id, projectId: job.projectId, entityId: job.entityId, baseVersion: preview.baseVersion, prompt: preview.prompt, files: [{ path: 'grid.png', kind: 'image' }] }));
    await f.service.refresh(f.project.id);
    const board = f.store.getEntity(f.project.id, f.board.id);
    assert.equal(board.media.length, 1);
    assert.equal(board.adoptedMediaIds.image, null);
    assert.deepEqual(board.media[0].metadata.storyboardSource, preview.storyboardSource);
    assert.equal(storyboardMediaFresh(f.store.getProject(f.project.id), board, board.media[0]), false);
    await f.service.refresh(f.project.id);
    assert.equal(f.store.getEntity(f.project.id, board.id).media.length, 1);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('single-shot storyboard accepts its own action images without relaxing group image or audio checks', async () => {
  const f = await fixture();
  try {
    const member = f.store.getEntity(f.project.id, f.board.data.shotIds[0]);
    const action = await media(f, member);
    const input = { projectId: f.project.id, entityId: f.board.id, kind: 'video', referenceMediaIds: [action.id] };
    await assert.rejects(f.service.prepare(input), /故事板只能引用/);
    f.store.updateEntity(f.project.id, f.board.id, { baseVersion: f.board.currentVersion, data: { shotIds: [member.id] } });
    const image = await boardImage(f), config = configFor(image);
    config.duration = String(member.data.duration);
    config.referenceBindings.push({ nodeId: '142', fieldName: 'image', mediaId: action.id });
    const request = { ...input, referenceMediaIds: [image.id, action.id], videoConfig: config };
    const preview = await f.service.prepare(request);
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual(preview.references.map(ref => ref.mediaId), [image.id, action.id]);
    const noPrimary = await f.service.prepare({ ...request, referenceMediaIds: [action.id] });
    assert.ok(noPrimary.blockers.some(message => message.includes('已采用故事板图片')));
    const outsider = f.store.getEntity(f.project.id, f.project.shots[4].id);
    const unrelated = await media(f, outsider);
    await assert.rejects(f.service.prepare({ ...request, referenceMediaIds: [image.id, unrelated.id] }), /故事板只能引用/);
    const audio = await media(f, member, 'audio');
    await assert.rejects(f.service.prepare({ ...request, referenceMediaIds: [image.id, audio.id] }), /故事板只能引用/);
    assert.ok(f.calls.every(call => call.url.endsWith('/media/upload/binary')));
  } finally { await f.cleanup(); }
});

test('fresh storyboard submits one board image once; adoption/source changes invalidate prepared video', async () => {
  const f = await fixture();
  try {
    const image = await boardImage(f), config = configFor(image);
    const input = { projectId: f.project.id, entityId: f.board.id, kind: 'video', referenceMediaIds: [image.id], videoConfig: config };
    await assert.rejects(f.service.prepare({ ...input, prompt: '独立改写剧情' }), { code: 'PREVIEW_STALE' });
    let preview = await f.service.prepare({ ...input, videoConfig: { ...config, mode: 'frames', workflowId: FRAME_VIDEO_CONFIG.workflowId } });
    assert.ok(preview.blockers.some(blocker => blocker.includes('普通首帧')));
    assert.equal(f.calls.length, 0);
    preview = await f.service.prepare({ ...input, videoConfig: { ...config, referenceBindings: [{ nodeId: '142', fieldName: 'image', mediaId: image.id }] } });
    assert.ok(preview.blockers.some(blocker => blocker.includes('参考图1')));
    assert.equal(f.calls.length, 0);
    preview = await f.service.prepare(input);
    assert.deepEqual(preview.blockers, []);
    assert.equal(f.calls.length, 1);
    const other = await boardImage(f);
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'adoption-changed' }), { code: 'PREVIEW_STALE' });
    f.store.adopt(f.project.id, f.board.id, image.id);
    preview = await f.service.prepare(input);
    const shot = f.store.getEntity(f.project.id, f.board.data.shotIds[3]);
    f.store.updateEntity(f.project.id, shot.id, { baseVersion: shot.currentVersion, data: { camera: '新的运镜' } });
    await assert.rejects(f.service.submit({ previewId: preview.id, operationId: 'member-changed' }), { code: 'PREVIEW_STALE' });
    assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 0);
    const fresh = await boardImage(f);
    preview = await f.service.prepare({ ...input, referenceMediaIds: [fresh.id], videoConfig: configFor(fresh) });
    const job = await f.service.submit({ previewId: preview.id, operationId: 'fresh-storyboard-video' });
    assert.equal(job.taskId, '88000001');
    assert.equal(job.entityId, f.board.id);
    assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 1);
    assert.deepEqual(job.snapshot.storyboardSource.shotIds, f.board.data.shotIds);
    assert.equal(job.snapshot.references.length, 1);
    const fetchMock = f.service.fetchImpl;
    f.service.fetchImpl = async (url, options) => String(url) === 'https://files.runninghub.ai/storyboard.mp4' ? new Response(Buffer.from('mock storyboard video')) : fetchMock(url, options);
    await f.service._download(job.id, { status: 'SUCCESS', results: [{ url: 'https://files.runninghub.ai/storyboard.mp4', outputType: 'mp4' }] });
    const output = f.store.getEntity(f.project.id, f.board.id).media.find(media => media.kind === 'video');
    assert.deepEqual(output.metadata.storyboardSource, job.snapshot.storyboardSource);
    assert.equal(f.store.getJob(job.id).status, 'ready');
    assert.equal(f.store.getEntity(f.project.id, f.board.id).adoptedMediaIds.video, null);
    assert.ok(other.id !== fresh.id);
  } finally { await f.cleanup(); }
});

test('image freshness follows adopted source images and image requirements, while video-only requirements preserve the board', async () => {
  const f = await fixture();
  try {
    const image = await boardImage(f);
    let board = f.store.updateEntity(f.project.id, f.board.id, { baseVersion: f.board.currentVersion, data: { videoRequirements: '节奏轻快' } });
    assert.ok(storyboardMediaFresh(f.store.getProject(f.project.id), board, image));
    const pending = await f.service.prepare({ projectId: f.project.id, entityId: board.id, kind: 'image' });
    const member = f.store.getEntity(f.project.id, board.data.shotIds[0]);
    const replacement = await media(f, member);
    f.store.adopt(f.project.id, member.id, replacement.id);
    assert.equal(storyboardMediaFresh(f.store.getProject(f.project.id), board, image), false);
    await assert.rejects(f.service.submit({ previewId: pending.id, operationId: 'source-image-adoption' }), { code: 'PREVIEW_STALE' });
    const fresh = await boardImage(f);
    board = f.store.updateEntity(f.project.id, board.id, { baseVersion: board.currentVersion, data: { imageRequirements: '改变灯光' } });
    assert.equal(storyboardMediaFresh(f.store.getProject(f.project.id), board, fresh), false);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('group references merge only member assets; group video covers four source shots once in rough cut', async () => {
  const f = await fixture();
  try {
    const project = f.store.getProject(f.project.id);
    const groups = referenceGroups(project, f.board);
    assert.ok(groups.some(group => group.id === f.board.id));
    for (const shot of project.shots.slice(0, 4)) assert.ok(groups.some(group => group.id === shot.id));
    assert.ok(!groups.some(group => group.id === project.shots[4].id));
    for (const shot of project.shots.slice(0, 5)) { const image = await media(f, shot); f.store.adopt(project.id, shot.id, image.id); }
    assert.equal(previewSequence(f.store.getProject(project.id)).length, 5);
    const video = await media(f, f.board, 'video', { duration: 12, storyboardSource: storyboardSource(project, f.board) });
    f.store.adopt(project.id, f.board.id, video.id);
    const entries = previewSequence(f.store.getProject(project.id));
    assert.deepEqual(entries.map(entry => entry.shot.id), [f.board.id, project.shots[4].id]);
    assert.equal(entries[0].media.id, video.id);
    assert.equal(entries[0].plan, storyboardDuration(project, f.board));
    assert.equal(f.store.getProject(project.id).shots[0].adoptedMediaIds.video, null);
  } finally { await f.cleanup(); }
});

test('storyboard-only rough cut orders overlapping groups once and uses only adopted group media', () => {
  const shots = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, order: i, data: { duration: 2 }, media: [{ id: `shot${i}`, kind: 'image' }], adoptedMediaId: `shot${i}` }));
  const board = (id, ids, adoptedMediaIds = {}) => ({ id, type: 'storyboard', data: { shotIds: ids.map(i => `s${i}`) }, media: [{ id: `${id}-image`, kind: 'image' }, { id: `${id}-video`, kind: 'video' }], adoptedMediaIds });
  const first = board('first', [0, 1, 2, 3], { image: 'first-image' });
  const middle = board('middle', [4, 5, 6, 7], { image: 'middle-image', video: 'middle-video' });
  const tail = board('tail', [6, 7, 8, 9], { image: 'tail-image' });
  const project = { shots: [...shots].reverse(), storyboards: [tail, middle, first] };
  const entries = previewSequence(project, 'storyboards');
  assert.deepEqual(entries.map(entry => [entry.shot.id, entry.media.id, entry.kind, entry.plan]), [
    ['first', 'first-image', 'image', 8], ['middle', 'middle-video', 'video', 8], ['tail', 'tail-image', 'image', 8]
  ]);
  middle.adoptedMediaIds = {};
  assert.deepEqual(previewSequence(project, 'storyboards').map(entry => entry.shot.id), ['first', 'tail']);
  first.data.shotIds = ['missing'];
  assert.deepEqual(previewSequence(project, 'storyboards').map(entry => entry.shot.id), ['tail']);
  assert.deepEqual(previewSequence({ shots, storyboards: [] }, 'storyboards'), []);
});

test('group duration uses the full planned total and blocks out-of-range requests before upload', async () => {
  const f = await fixture();
  try {
    for (const original of f.project.shots.slice(0, 4)) f.store.updateEntity(f.project.id, original.id, { baseVersion: original.currentVersion, data: { duration: 9 } });
    const image = await boardImage(f);
    const preview = await f.service.prepare({ projectId: f.project.id, entityId: f.board.id, kind: 'video', referenceMediaIds: [image.id],
      videoConfig: { referenceBindings: [{ nodeId: '141', fieldName: 'image', mediaId: image.id }] } });
    assert.equal(preview.config.duration, '36');
    assert.match(preview.prompt, /Target duration: 36 seconds/);
    assert.ok(preview.blockers.some(blocker => blocker.includes('1–30')));
    assert.equal(f.calls.length, 0);
    assert.equal(storyboardDuration(f.store.getProject(f.project.id), f.board), 36);
  } finally { await f.cleanup(); }
});

test('HTTP storyboards create with CSRF, derive fresh prompts, report stale media and export group sequence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-storyboard-http-'));
  const studio = createStudio({ dataDir, generationOptions: { getRunningHubKey: () => '', inspectCodexImpl: async () => ({ available: false, loggedIn: false }) } });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.project.storyboards, []);
    const body = { projectId: state.project.id, shotIds: state.project.shots.slice(0, 4).map(shot => shot.id) };
    assert.equal((await fetch(`${base}/api/storyboards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };
    const response = await fetch(`${base}/api/storyboards`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 201);
    const { entity: board } = await response.json();
    for (const kind of ['image', 'video']) {
      const result = await (await fetch(`${base}/api/entities/${board.id}/prompt?projectId=${body.projectId}&kind=${kind}`)).json();
      assert.match(result.prompt, /top-left, top-right, bottom-left, bottom-right/);
    }
    const exported = await (await fetch(`${base}/api/export/${body.projectId}`)).json();
    assert.equal(exported.storyboards[0].id, board.id);
    assert.equal(exported.shots.length, 45);
    assert.deepEqual(exported.sequence, []);
    const project = studio.store.getProject(body.projectId);
    const image = studio.store.addMedia(project.id, board.id, { kind: 'image', file: 'test-only.png', sha256: 'test-only', baseVersion: board.currentVersion, metadata: { storyboardSource: storyboardSource(project, board) } });
    const first = project.shots[0];
    studio.store.updateEntity(project.id, first.id, { baseVersion: first.currentVersion, data: { action: 'HTTP剧情更新' } });
    const latest = await (await fetch(`${base}/api/state`)).json();
    assert.equal(latest.project.storyboards[0].media.find(media => media.id === image.id).stale, false);
    assert.equal(latest.project.shots[0].data.action, 'HTTP剧情更新');
  } finally { await new Promise(resolve => server.close(resolve)); studio.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('粗剪预览的画面比例取媒体自身尺寸，取不到才退回作品比例', () => {
  assert.equal(mediaRatio({ metadata: { width: 480, height: 864 } }), '480 / 864');
  assert.equal(mediaRatio({ metadata: { width: 864, height: 480 } }), '864 / 480');
  assert.equal(mediaRatio({ metadata: {} }, '16:9'), '16 / 9');
  assert.equal(mediaRatio({ metadata: { width: 0, height: 864 } }, '16:9'), '16 / 9');
  assert.equal(mediaRatio(null, undefined), '9 / 16');
  assert.equal(mediaRatio({ metadata: { width: '941', height: '1672' } }), '941 / 1672');
  // 比例值直接喂给舞台的宽度计算，必须是能用的正数。
  assert.equal(ratioValue('480 / 864'), 480 / 864);
  assert.equal(ratioValue('乱写的'), 9 / 16);
  assert.equal(ratioText('16x9'), '16 / 9');
  assert.equal(ratioText(''), '9 / 16');
});
