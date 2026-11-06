import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {sourceComparisonContext,sourceComparisonFor,sourceComparisonTitle} from '../public/source-comparison.mjs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function sourceAnnotationsText('), app.indexOf('function renderJobs('));
const node = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null && x !== false), value: attrs.value || '',
  get textContent() { return this.children.map(textOf).join(''); },
  set textContent(value) { this.children=[value]; },
  append(...items) { this.children.push(...items.flat(Infinity)); },
  setAttribute(key,value) { this.attrs[key]=value; },
  replaceChildren(...items) { this.children = items.flat(Infinity); } });
const walk = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(walk)] : [];
const textOf = tree => tree && typeof tree === 'object' ? tree.children.map(textOf).join('') : String(tree);
const findButton = (tree, label) => walk(tree).find(x => x.tag === 'button' && textOf(x) === label);
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const timers=new Map();let timerId=0;
  const context = {
    state: { project: { id: 'project_1', title: '作品', episodes: [1, 2] } },
    view: 'annotations', currentEpisode: 1, sourceAnnotationDrafts: new Map(), structuredClone, busy: false,
    sourceAnnotationPlayer: null, window: {}, previewPlayerOptions: { controls: ['play', 'progress', 'current-time', 'fullscreen'], iconUrl: '/vendor/plyr/plyr.svg' },
    SOURCE_VIDEO_UPLOAD_MAX_BYTES: 1024 ** 3, URLSearchParams, notify: () => {},
    sourceComparisonContext,sourceComparisonFor,sourceComparisonTitle,
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),timers,
    flushAutoSave:async()=>{const pending=[...timers.values()];timers.clear();for(const timer of pending)await timer.callback();},
    mediaUrl:media=>`/api/media/${media.id}`,mediaFilename:media=>media.file,
    node, field: (label, value, onInput, options = {}) => node('label', {}, label, node(options.multiline ? 'textarea' : 'input', { value, onInput: e => onInput(e.target.value) })),
    heading: (title, subtitle) => node('header', {}, title, subtitle),
    button: (label, onClick, className, attrs) => node('button', { onClick, ...attrs }, label),
    $: (selector, root) => walk(root || context.container).find(x => selector === 'input' ? x.tag === 'input' : x.attrs.id === selector.slice(1)),
    perform: action => action(), requests: [], copy: value => { context.copied = value; },
    api: async (path, options) => { context.requests.push({ path, ...plain(options) }); return { annotations: { ...options.body, currentVersion: 'revision_1' } }; },
    episodeLabel: number => `第${number}集`, changeEpisode: value => { context.currentEpisode = Number(value); },
    renderApp: () => { context.container = node('main'); context.renderSourceAnnotations(context.container); },
  };
  runInNewContext(source, context);
  context.renderApp();
  return context;
}

test('manual labels save empty, unordered and arbitrary time text without generation or validation gates', async () => {
  const c = fixture();
  findButton(c.container, '＋ 新增镜头').attrs.onClick();
  const form = walk(c.container).find(x => x.tag === 'form');
  assert.equal(form.attrs.noValidate, true);
  assert.ok(walk(form).filter(x => ['input','textarea'].includes(x.tag)).every(x => !x.attrs.required));
  const entry = c.sourceAnnotationsDraft();
  entry.marks[0].time = ' 9秒—2秒（稍后补） ';
  entry.marks[0].content = '<原样保留>\n';
  await c.saveSourceAnnotations();
  assert.deepEqual(c.requests, [{ path: '/api/projects/project_1/source-annotations', method: 'PUT', body: {
    episodeNumber: 1, baseVersion: null, videoPath: '', audioPath: '', audioName: '', audioDuration: null, marks: [{ time: ' 9秒—2秒（稍后补） ', camera: '', content: '<原样保留>\n', shotCode: '' }],
  } }]);
  findButton(c.container, '复制已保存镜头').attrs.onClick();
  assert.match(c.copied, /9秒—2秒（稍后补）/);
  assert.match(c.copied, /<原样保留>\n/);
  assert.equal(entry.dirty, false);
  assert.equal(c.state.project.shots, undefined);
});

test('drafts stay with the selected project and episode, and all-episodes view cannot save into episode one', () => {
  const c = fixture();
  const first = c.sourceAnnotationsDraft();
  first.marks.push({ time: 'draft', camera: '', content: '' });
  first.dirty = true;
  c.currentEpisode = 2;
  assert.equal(c.sourceAnnotationsDraft().marks.length, 0);
  c.currentEpisode = 1;
  assert.equal(c.sourceAnnotationsDraft(), first);
  c.state.project = { id: 'project_2', title: '另一作品', episodes: [1] };
  assert.equal(c.sourceAnnotationsDraft().marks.length, 0);
  c.currentEpisode = 'all';
  c.renderApp();
  assert.match(textOf(c.container), /请选择要记录镜头的集数/);
  assert.equal(findButton(c.container, '保存镜头'), undefined);
  assert.deepEqual(c.requests, []);
});

test('edits typed while saving and failed/conflicting saves retain the unsaved draft', async () => {
  const c = fixture(), entry = c.sourceAnnotationsDraft();
  entry.marks.push({ time: '', camera: '原运镜', content: '' });entry.dirty = true;
  let finish;
  c.api = () => new Promise(resolve => { finish = resolve; });
  const saving = c.saveSourceAnnotations();
  entry.marks[0].camera = '请求途中继续输入';
  finish({ annotations: { videoPath: '', marks: [{ time: '', camera: '原运镜', content: '' }], currentVersion: 'revision_1' } });
  await saving;
  assert.equal(entry.dirty, true);
  assert.equal(entry.baseVersion, 'revision_1');
  assert.equal(entry.marks[0].camera, '请求途中继续输入');
  c.perform = async () => null;
  await c.saveSourceAnnotations();
  assert.equal(entry.marks[0].camera, '请求途中继续输入');
  assert.equal(entry.dirty, true);
});

test('async form saves keep the player and editor mounted, prevent duplicate submission and copy the saved snapshot', async () => {
  const c = fixture();
  c.state.project.sourceAnnotations = { 1: { currentVersion: 'saved', videoPath: 'E:/source.mp4', marks: [{ time: '00:01', camera: '推进', content: '' }] } };
  c.window.Plyr = function () { this.destroy = () => { throw new Error('保存不应销毁播放器'); }; };
  c.renderApp();
  const container = c.container, form = walk(container).find(x => x.tag === 'form');
  const video = walk(container).find(x => x.tag === 'video'), player = c.sourceAnnotationPlayer;
  const editor = walk(container).find(x => x.tag === 'textarea'), save = findButton(container, '保存镜头');
  const status = walk(container).find(x => x.attrs.role === 'status');
  video.currentTime = 7.125;
  let finish, calls = 0;
  c.api = async (path, options) => { calls++; return new Promise(resolve => { finish = () => resolve({ annotations: { ...plain(options.body), currentVersion: 'revision_2' } }); }); };
  const saving = form.attrs.onSubmit({ preventDefault() {} });
  assert.equal(save.disabled, true);
  assert.equal(status.textContent, '正在保存…');
  await form.attrs.onSubmit({ preventDefault() {} });
  assert.equal(calls, 1);
  editor.attrs.onInput({ target: { value: '保存中继续修改' } });
  finish();await saving;
  assert.equal(c.container, container);
  assert.equal(walk(container).find(x => x.tag === 'video'), video);
  assert.equal(walk(container).find(x => x.tag === 'textarea'), editor);
  assert.equal(c.sourceAnnotationPlayer, player);
  assert.equal(video.currentTime, 7.125);
  assert.equal(save.disabled, false);
  assert.equal(status.textContent, '有未保存修改');
  assert.equal(c.sourceAnnotationsDraft().marks[0].camera, '保存中继续修改');
  findButton(container, '复制已保存镜头').attrs.onClick();
  assert.match(c.copied, /运镜：推进/);
  assert.doesNotMatch(c.copied, /保存中继续修改/);
  c.api = async (path, options) => ({ annotations: { ...plain(options.body), currentVersion: 'revision_3' } });
  await form.attrs.onSubmit({ preventDefault() {} });
  assert.equal(status.textContent, '已保存');
  assert.equal(c.container, container);
  findButton(container, '复制已保存镜头').attrs.onClick();
  assert.match(c.copied, /保存中继续修改/);
  c.perform = async () => null;
  editor.attrs.onInput({ target: { value: '失败后保留' } });
  await form.attrs.onSubmit({ preventDefault() {} });
  assert.equal(status.textContent, '保存未完成，请重试');
  assert.equal(c.sourceAnnotationsDraft().marks[0].camera, '失败后保留');
  assert.equal(save.disabled, false);
  assert.equal(c.container, container);
});

test('saving a local video path mounts only its viewing area without replacing the form', async () => {
  const c = fixture();
  const container = c.container, form = walk(container).find(x => x.tag === 'form');
  c.sourceAnnotationsDraft().videoPath = 'E:/new-source.mp4';
  await form.attrs.onSubmit({ preventDefault() {} });
  assert.equal(c.container, container);
  assert.equal(walk(container).find(x => x.tag === 'form'), form);
  assert.ok(walk(container).some(x => x.tag === 'video'));
  assert.equal(findButton(container, '在当前时间新建镜头').disabled, false);
  assert.equal(findButton(container, '复制已保存镜头').disabled, false);
});

test('jumping seeks to the marker without rewriting it, saving or remounting the passive video', () => {
  const c = fixture();
  c.state.project.sourceAnnotations = { 1: { currentVersion: 'saved', videoPath: 'E:/source.mp4', marks: [{ time: '00:04.267', camera: '', content: '' }] } };
  c.renderApp();
  const container = c.container;
  const video = walk(c.container).find(x => x.tag === 'video');
  assert.equal(video.attrs.controls, true);
  assert.equal(video.attrs.autoplay, undefined);
  video.currentTime = 1;
  findButton(c.container, '跳转到时间点').attrs.onClick();
  assert.equal(video.currentTime, 4.267);
  assert.equal(c.sourceAnnotationsDraft().marks[0].time, '00:04.267');
  assert.equal(c.sourceAnnotationsDraft().dirty, false);
  assert.equal(c.container, container);
  assert.equal(findButton(c.container, '取当前播放时间'), undefined);
  assert.deepEqual(c.requests, []);
});

test('comma-separated keyframes each jump in input order and update while editing without replacing the input', () => {
  const c = fixture(), raw = ' 00:04.267，1:02.500,00:00.000 ';
  c.state.project.sourceAnnotations = { 1: { currentVersion: 'saved', videoPath: 'E:/source.mp4', marks: [{ time: raw, camera: '', content: '' }] } };
  c.renderApp();
  const video = walk(c.container).find(x => x.tag === 'video');
  const timeInput = walk(c.container).find(x => x.tag === 'input' && x.attrs.value === raw);
  for (const [label, seconds] of [['00:04.267', 4.267], ['1:02.500', 62.5], ['00:00.000', 0]]) {
    findButton(c.container, `跳转 ${label}`).attrs.onClick();
    assert.equal(video.currentTime, seconds);
  }
  assert.equal(c.sourceAnnotationsDraft().marks[0].time, raw);
  assert.equal(c.sourceAnnotationsDraft().dirty, false);
  timeInput.attrs.onInput({ target: { value: '00:09.125' } });
  findButton(c.container, '跳转到时间点').attrs.onClick();
  assert.equal(video.currentTime, 9.125);
  assert.ok(walk(c.container).includes(timeInput));
  assert.equal(c.sourceAnnotationsDraft().marks[0].time, '00:09.125');
  assert.deepEqual(c.requests, []);
});

test('time parsing supports seconds, minute/hour timecodes and range starts; invalid or out-of-range jumps leave labels saveable', async () => {
  const c = fixture();
  for (const [value, seconds] of [['0', 0], ['4.267秒', 4.267], ['4.267s', 4.267], ['01:02:03.125', 3723.125], ['00：09.125', 9.125], ['00:01.800–00:04.267', 1.8], ['00:02 至 00:07', 2]]) {
    assert.equal(c.sourceAnnotationTimePoints(value)[0].seconds, seconds, value);
  }
  for (const value of ['', '暂定', '-4', '1:60', '1:02:99', '1:2:3:4']) assert.equal(c.sourceAnnotationTimePoints(value)[0].seconds, null, value);
  c.state.project.sourceAnnotations = { 1: { currentVersion: 'saved', videoPath: 'E:/source.mp4', marks: [{ time: '暂定', camera: '', content: '' }] } };
  c.renderApp();
  const messages = [];
  c.notify = message => messages.push(message);
  const video = walk(c.container).find(x => x.tag === 'video');video.currentTime = 1;video.duration = 10;
  findButton(c.container, '跳转到时间点').attrs.onClick();
  const timeInput = walk(c.container).find(x => x.tag === 'input' && x.attrs.value === '暂定');
  timeInput.attrs.onInput({ target: { value: '20' } });
  findButton(c.container, '跳转到时间点').attrs.onClick();
  assert.equal(video.currentTime, 1);
  assert.equal(messages.length, 2);
  await c.saveSourceAnnotations();
  assert.equal(c.requests[0].body.marks[0].time, '20');
  const empty = fixture();
  findButton(empty.container, '＋ 新增镜头').attrs.onClick();
  assert.equal(findButton(empty.container, '跳转到时间点').attrs.disabled, true);
});

test('source viewing reuses rough-cut Plyr controls and adding timestamped marks keeps its video mounted', () => {
  const c = fixture();
  c.state.project.sourceAnnotations = { 1: { currentVersion: 'saved', videoPath: 'E:/source.mp4', marks: [] } };
  let destroyed = false, options;
  c.window.Plyr = function (video, config) { this.video = video; options = config; this.destroy = () => { destroyed = true; }; };
  c.renderApp();
  const video = walk(c.container).find(x => x.tag === 'video'), instance = c.sourceAnnotationPlayer;
  assert.equal(options.controls, c.previewPlayerOptions.controls);
  assert.equal(options.iconUrl, '/vendor/plyr/plyr.svg');
  assert.equal(options.hideControls, false);
  video.currentTime = 12.345;
  findButton(c.container, '在当前时间新建镜头').attrs.onClick();
  assert.equal(c.sourceAnnotationsDraft().marks[0].time, '00:12.345');
  assert.equal(walk(c.container).find(x => x.tag === 'video'), video);
  assert.equal(c.sourceAnnotationPlayer, instance);
  findButton(c.container, '删除此镜头').attrs.onClick();
  assert.equal(walk(c.container).find(x => x.tag === 'video'), video);
  c.destroySourceAnnotationPlayer();
  assert.equal(destroyed, true);
  assert.equal(c.sourceAnnotationPlayer, null);
});

test('upload sends the original file to its captured project/episode, preserving unsaved marks and failures', async () => {
  const c = fixture(), entry = c.sourceAnnotationsDraft();
  entry.marks.push({ time: '未定', camera: '用户运镜', content: '' }); entry.dirty = true;
  const file = { name: '原视频.mp4', size: 123 }, uploads = [];
  c.state.csrfToken = 'test-token';
  c.fetch = async (url, options) => {
    uploads.push({ url, options });
    entry.marks[0].content = '上传期间输入';
    c.state.project = { id: 'project_2', title: '另一个作品', episodes: [1] };
    return { ok: true, json: async () => ({ annotations: { currentVersion: 'uploaded', videoPath: 'E:/data/original.mp4', marks: [] } }) };
  };
  await c.uploadSourceVideo(file);
  assert.match(uploads[0].url, /^\/api\/projects\/project_1\/source-video\?/);
  assert.equal(new URL(uploads[0].url, 'http://localhost').searchParams.get('episodeNumber'), '1');
  assert.equal(uploads[0].options.body, file);
  assert.equal(uploads[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(uploads[0].options.headers['X-Studio-Token'], 'test-token');
  assert.equal(entry.videoPath, 'E:/data/original.mp4');
  assert.equal(entry.baseVersion, 'uploaded');
  assert.equal(entry.marks[0].content, '上传期间输入');
  assert.equal(entry.dirty, true);
  assert.equal(entry.uploading, false);
  assert.equal(c.state.project.sourceAnnotations, undefined);
  c.state.project = { id: 'project_1', title: '作品', episodes: [1] };
  c.perform = async action => { try { return await action(); } catch { return null; } };
  c.fetch = async () => { throw new Error('断开'); };
  await c.uploadSourceVideo(file);
  assert.equal(entry.uploading, false);
  assert.equal(entry.baseVersion, 'uploaded');
  assert.equal(entry.marks[0].camera, '用户运镜');
});

function comparisonFixture() {
  const c=fixture();
  c.state.project.shots=[{id:'shot_1',code:'02-G',name:'工作台标题',order:0,data:{episodeNumber:1},media:[
    {id:'image_1',kind:'image',file:'frame-1.png',prompt:'实际提示词一'},
    {id:'image_2',kind:'image',file:'frame-2.png',prompt:'实际提示词二'},
  ]}];
  c.state.project.sourceAnnotations={1:{currentVersion:'saved',videoPath:'E:/source.mp4',marks:[{
    title:'巨蛙与露洁对峙',time:'00:01.800，00:02.500',camera:'低机位缓推',content:'画面说明原文',shotCode:'02-G',
    comparisons:[{time:'1.8',generatedMediaId:'image_1',status:'needs_review',note:'朝向偏差',sourceVideoPath:'E:/source.mp4'}],
  }]}};
  c.renderApp();return c;
}

test('adding a time point keeps one shot and tab switching preserves its player and draft', () => {
  const c=comparisonFixture(),video=walk(c.container).find(item=>item.tag==='video');
  video.currentTime=3.125;
  findButton(c.container,'＋ 加入当前时间点').attrs.onClick();
  const entry=c.sourceAnnotationsDraft();
  assert.equal(entry.marks.length,1);
  assert.equal(entry.marks[0].time,'00:01.800，00:02.500，00:03.125');
  findButton(c.container,'比对分析').attrs.onClick();
  assert.equal(c.$('#source-annotations-editor').hidden,true);
  assert.equal(c.$('#source-comparison-panel').hidden,false);
  assert.equal(walk(c.$('#source-comparison-panel')).filter(item=>item.tag==='figure').length,6);
  findButton(c.container,'镜头编辑').attrs.onClick();
  assert.equal(walk(c.container).find(item=>item.tag==='video'),video);
  assert.equal(c.$('#source-annotations-editor').hidden,false);
  assert.equal(entry.dirty,true);
  assert.deepEqual(c.requests,[]);
});

test('comparison puts the shot title and editable camera and details below its time-point images', async () => {
  const c=comparisonFixture();
  findButton(c.container,'比对分析').attrs.onClick();
  let panel=c.$('#source-comparison-panel');
  assert.ok(walk(panel).some(item=>item.tag==='h2'&&textOf(item)==='02-G · 巨蛙与露洁对峙'));
  const card=walk(panel).find(item=>item.tag==='article'),header=card.children.find(item=>item.attrs.class==='row between wrap source-comparison-heading');
  assert.equal(header.children[0].tag,'h2');
  assert.equal(card.children[0].tag,'section');
  assert.ok(card.children.indexOf(header)>card.children.findLastIndex(item=>item.tag==='section'));
  for(const [key,value] of [['camera','低机位缓推'],['content','画面说明原文']]) {
    const input=card.children.find(item=>item.attrs.class===`source-comparison-${key}`);
    assert.ok(card.children.indexOf(input)>card.children.indexOf(header));
    assert.ok(walk(input).some(item=>item.tag==='textarea'&&item.value===value));
  }
  assert.equal(walk(card).filter(item=>item.attrs.class==='source-comparison-camera').length,1);
  assert.equal(walk(panel).filter(item=>item.tag==='figure').length,4);
  assert.equal(walk(panel).filter(item=>item.tag==='img').length,3);
  assert.match(textOf(panel),/2 个有效时间点 · 1 组已配生成图/);
  assert.ok(walk(panel).find(item=>item.tag==='img'&&item.attrs.src.includes('source-frame?')).attrs.src.includes('time=1.8'));
  const details=walk(panel).find(item=>item.tag==='details'&&textOf(item).startsWith('关联信息'));
  assert.equal(details.attrs.open,undefined);
  const select=walk(panel).find(item=>item.attrs['aria-label']==='巨蛙与露洁对峙 00:02.500 对应生成图');
  select.attrs.onChange({target:{value:'image_2'}});
  const entry=c.sourceAnnotationsDraft();
  assert.deepEqual(plain(entry.marks[0].comparisons[1]),{time:'2.5',generatedMediaId:'image_2',status:'unreviewed',sourceVideoPath:'E:/source.mp4'});
  assert.equal(entry.marks[0].comparisons[0].status,'needs_review');
  assert.equal(entry.dirty,true);
  findButton(panel,'复制逐时间点生图任务').attrs.onClick();
  assert.equal(c.copied,undefined,'未保存配图不得混入已保存任务');
  await walk(c.container).find(item=>item.tag==='form').attrs.onSubmit({preventDefault(){}});
  panel=c.$('#source-comparison-panel');
  findButton(panel,'复制逐时间点生图任务').attrs.onClick();
  assert.match(c.copied,/标题：巨蛙与露洁对峙/);
  assert.match(c.copied,/generatedMediaId.*image_2/);
  assert.match(c.copied,/不拆成额外镜头/);
  assert.equal(c.requests.length,1);
  assert.equal(c.requests[0].body.baseVersion,'saved');
});

test('comparison camera prefers the annotation, falls back to its linked shot and leaves drafts unchanged', () => {
  for(const [camera,shotCamera,shotCode,expected] of [
    ['低机位缓推','固定','02-G','低机位缓推'],
    ['  ','侧面跟随\n缓慢拉远','02-G','侧面跟随\n缓慢拉远'],
    ['','','02-G',''],
    ['','固定','missing',''],
  ]){
    const c=comparisonFixture(),entry=c.sourceAnnotationsDraft();
    Object.assign(entry.marks[0],{camera,shotCode});
    c.state.project.shots[0].data.camera=shotCamera;
    const before=plain(entry.marks);
    findButton(c.container,'比对分析').attrs.onClick();
    const label=walk(c.$('#source-comparison-panel')).find(item=>item.attrs.class==='source-comparison-camera');
    const input=walk(label).find(item=>item.tag==='textarea');
    assert.equal(input.value,expected);
    assert.equal(input.attrs.placeholder,'待填写运镜');
    assert.deepEqual(plain(entry.marks),before);
    assert.equal(entry.dirty,false);
    assert.deepEqual(c.requests,[]);
  }
});

const cameraInput=c=>walk(c.$('#source-comparison-panel')).find(item=>item.tag==='textarea'&&item.attrs['aria-label']==='02-G 运镜');
const contentInput=c=>walk(c.$('#source-comparison-panel')).find(item=>item.tag==='textarea'&&item.attrs['aria-label']==='02-G 详情');
const saveStatus=c=>walk(c.container).find(item=>item.attrs.role==='status').textContent;

test('comparison details share debounced autosave, preserve media and other fields, and update the editor and saved copy', async () => {
  const c=comparisonFixture(),entry=c.sourceAnnotationsDraft(),before=plain(entry.marks[0]);
  const video=c.$('#source-annotation-player');video.currentTime=2.1;
  findButton(c.container,'比对分析').attrs.onClick();
  const input=contentInput(c);
  assert.equal(input.attrs.maxlength,20000);
  input.attrs.onInput({target:{value:'人物站位'}});
  input.attrs.onInput({target:{value:'  人物站位\n与动作详情  '}});
  assert.equal(c.requests.length,0);
  assert.equal(c.timers.size,1);
  assert.equal([...c.timers.values()][0].delay,600);
  await c.flushAutoSave();
  assert.equal(c.requests.length,1);
  assert.equal(c.requests[0].body.baseVersion,'saved');
  assert.deepEqual(c.requests[0].body.marks,[{...before,content:'  人物站位\n与动作详情  '}]);
  assert.equal(entry.dirty,false);
  assert.equal(saveStatus(c),'已保存');
  assert.equal(contentInput(c),input);
  assert.equal(c.$('#source-annotation-player'),video);
  assert.equal(video.currentTime,2.1);
  findButton(c.$('#source-comparison-panel'),'复制逐时间点生图任务').attrs.onClick();
  assert.match(c.copied,/画面内容：  人物站位\n与动作详情  /);
  findButton(c.container,'镜头编辑').attrs.onClick();
  assert.ok(walk(c.$('#source-annotations-editor')).some(item=>item.tag==='textarea'&&item.value===entry.marks[0].content));
});

test('detail composition waits before saving, camera and detail edits coalesce, and a failed save preserves both for retry', async () => {
  const c=comparisonFixture();findButton(c.container,'比对分析').attrs.onClick();
  const input=contentInput(c),entry=c.sourceAnnotationsDraft();
  cameraInput(c).attrs.onInput({target:{value:'向左跟随'}});
  input.attrs.onCompositionstart();
  input.attrs.onInput({target:{value:'人物站在左侧'},isComposing:true});
  assert.equal(c.timers.size,0);
  input.attrs.onCompositionend();
  input.attrs.onBlur();
  assert.equal([...c.timers.values()][0].delay,0);
  c.perform=async()=>null;
  await c.flushAutoSave();
  assert.equal(saveStatus(c),'保存未完成，请重试');
  assert.equal(entry.dirty,true);
  assert.equal(entry.marks[0].content,'人物站在左侧');
  assert.equal(entry.marks[0].camera,'向左跟随');
  assert.equal(entry.baseVersion,'saved');
  assert.equal(c.timers.size,0);
  c.perform=action=>action();
  await c.$('#source-annotation-form').attrs.onSubmit({preventDefault(){}});
  assert.equal(c.requests.length,1);
  assert.equal(c.requests[0].body.baseVersion,'saved');
  assert.equal(c.requests[0].body.marks[0].content,'人物站在左侧');
  assert.equal(c.requests[0].body.marks[0].camera,'向左跟随');
  assert.equal(entry.dirty,false);
});

test('comparison camera debounces edits, preserves its player and input, and updates both views and copied saved tasks', async () => {
  const c=comparisonFixture(),entry=c.sourceAnnotationsDraft(),before=plain(entry.marks[0]);
  const video=c.$('#source-annotation-player');video.currentTime=2.1;
  findButton(c.container,'比对分析').attrs.onClick();
  const input=cameraInput(c);
  input.attrs.onInput({target:{value:'向左横移'}});
  input.attrs.onInput({target:{value:'  向左横移\n再缓慢推近  '}});
  assert.equal(c.requests.length,0);
  assert.equal(c.timers.size,1);
  assert.equal([...c.timers.values()][0].delay,600);
  await c.flushAutoSave();
  assert.equal(c.requests.length,1);
  assert.equal(c.requests[0].body.baseVersion,'saved');
  assert.deepEqual(c.requests[0].body.marks,[{...before,camera:'  向左横移\n再缓慢推近  '}]);
  assert.equal(entry.dirty,false);
  assert.equal(saveStatus(c),'已保存');
  assert.equal(cameraInput(c),input);
  assert.equal(c.$('#source-annotation-player'),video);
  assert.equal(video.currentTime,2.1);
  assert.ok(walk(c.$('#source-comparison-panel')).filter(item=>item.tag==='img'&&item.attrs.src.includes('source-frame?')).every(item=>item.attrs.src.includes('version=revision_1')));
  findButton(c.$('#source-comparison-panel'),'复制逐时间点生图任务').attrs.onClick();
  assert.match(c.copied,/运镜：  向左横移\n再缓慢推近  /);
  findButton(c.container,'镜头编辑').attrs.onClick();
  assert.ok(walk(c.$('#source-annotations-editor')).some(item=>item.tag==='textarea'&&item.value===entry.marks[0].camera));
  assert.equal(c.$('#source-annotation-player'),video);
});

test('camera autosave waits for composition, flushes on blur, and retains failures for manual retry', async () => {
  const c=comparisonFixture();findButton(c.container,'比对分析').attrs.onClick();
  const input=cameraInput(c),entry=c.sourceAnnotationsDraft();
  input.attrs.onInput({target:{value:'缓'}});
  input.attrs.onCompositionstart();
  input.attrs.onInput({target:{value:'缓慢'},isComposing:true});
  assert.equal(c.timers.size,0);
  input.attrs.onCompositionend();
  assert.equal(c.timers.size,1);
  input.attrs.onBlur();
  assert.equal([...c.timers.values()][0].delay,0);
  c.perform=async()=>null;
  await c.flushAutoSave();
  assert.equal(saveStatus(c),'保存未完成，请重试');
  assert.equal(entry.dirty,true);
  assert.equal(entry.marks[0].camera,'缓慢');
  assert.equal(entry.baseVersion,'saved');
  assert.equal(c.timers.size,0,'失败后不循环重试');
  c.perform=action=>action();
  await c.$('#source-annotation-form').attrs.onSubmit({preventDefault(){}});
  assert.equal(c.requests[0].body.baseVersion,'saved');
  assert.equal(entry.dirty,false);
  assert.equal(saveStatus(c),'已保存');
});

test('camera edits during autosave queue behind the first revision and manual saves do not race', async () => {
  const c=comparisonFixture();findButton(c.container,'比对分析').attrs.onClick();
  const input=cameraInput(c),entry=c.sourceAnnotationsDraft();let finish;
  c.api=(path,options)=>{c.requests.push({path,...plain(options)});return new Promise(resolve=>{finish=()=>resolve({annotations:{...plain(options.body),currentVersion:`revision_${c.requests.length}`}});});};
  input.attrs.onInput({target:{value:'第一次修改'}});
  const first=c.flushAutoSave();
  assert.equal(saveStatus(c),'正在保存…');
  input.attrs.onInput({target:{value:'请求途中继续修改'}});
  await c.$('#source-annotation-form').attrs.onSubmit({preventDefault(){}});
  assert.equal(c.requests.length,1);
  // 手动保存不能取消正在等待的自动保存。
  await c.flushAutoSave();
  assert.equal(c.requests.length,1);
  finish();await first;
  assert.equal(entry.dirty,true);
  const second=c.flushAutoSave();
  assert.equal(c.requests.length,2);
  assert.equal(c.requests[1].body.baseVersion,'revision_1');
  assert.equal(c.requests[1].body.marks[0].camera,'请求途中继续修改');
  finish();await second;
  assert.equal(entry.dirty,false);
  assert.equal(saveStatus(c),'已保存');
});

test('pending camera autosave keeps its captured project and episode across navigation and refreshes a remounted status', async () => {
  const c=comparisonFixture(),project=c.state.project;
  findButton(c.container,'比对分析').attrs.onClick();
  cameraInput(c).attrs.onInput({target:{value:'第一集的新运镜'}});
  c.currentEpisode=2;c.renderApp();
  await c.flushAutoSave();
  assert.equal(c.requests[0].body.episodeNumber,1);
  assert.equal(project.sourceAnnotations[2],undefined);
  c.currentEpisode=1;c.renderApp();
  assert.equal(cameraInput(c).value,'第一集的新运镜');
  let finish;
  c.api=(path,options)=>{c.requests.push({path,...plain(options)});return new Promise(resolve=>{finish=()=>resolve({annotations:{...plain(options.body),currentVersion:'revision_2'}});});};
  cameraInput(c).attrs.onInput({target:{value:'另一处修改'}});
  const saving=c.flushAutoSave();
  c.renderApp();
  assert.equal(saveStatus(c),'正在保存…');
  finish();await saving;
  assert.equal(saveStatus(c),'已保存');
  cameraInput(c).attrs.onInput({target:{value:'切换作品前的修改'}});
  c.state.project={id:'project_2',title:'另一作品',episodes:[1]};c.renderApp();
  const pending=c.flushAutoSave();finish();await pending;
  assert.equal(c.requests.at(-1).path,'/api/projects/project_1/source-annotations');
  assert.equal(project.sourceAnnotations[1].marks[0].camera,'切换作品前的修改');
  assert.equal(c.state.project.sourceAnnotations,undefined);
});

test('replacing the original flags old pairs and selecting another candidate resets review', () => {
  const c=comparisonFixture();
  c.sourceAnnotationsDraft().marks[0].comparisons[0].sourceMediaId='image_1';
  c.sourceAnnotationsDraft().videoPath='E:/replacement.mp4';
  findButton(c.container,'比对分析').attrs.onClick();
  const panel=c.$('#source-comparison-panel');
  assert.match(textOf(panel),/原视频已更换/);
  assert.match(textOf(panel),/0 组已配生成图/);
  const status=walk(panel).find(item=>item.attrs['aria-label']==='巨蛙与露洁对峙 00:01.800 检查状态');
  assert.ok(status.children.filter(item=>item.attrs.value!=='unreviewed').every(item=>item.attrs.disabled));
  walk(panel).find(item=>item.attrs['aria-label']==='巨蛙与露洁对峙 00:01.800 对应生成图').attrs.onChange({target:{value:'image_2'}});
  const record=c.sourceAnnotationsDraft().marks[0].comparisons[0];
  assert.equal(record.status,'unreviewed');
  assert.equal(record.note,'朝向偏差');
  assert.equal(record.sourceVideoPath,'E:/replacement.mp4');
  assert.equal(record.sourceMediaId,undefined,'重新配生成图时不能把旧原帧静默绑定到新原视频');
});

test('changing a shot association cannot present an unavailable old pair as passed', () => {
  const c=comparisonFixture(),mark=c.sourceAnnotationsDraft().marks[0];
  mark.comparisons[0].status='pass';mark.shotCode='missing';
  findButton(c.container,'比对分析').attrs.onClick();
  const panel=c.$('#source-comparison-panel');
  const point=walk(panel).find(item=>item.attrs.class==='source-comparison-point stack');
  assert.ok(walk(point).some(item=>item.attrs.class==='row between wrap'&&textOf(item)==='时间点 00:01.800需复核'));
  assert.match(textOf(point),/原关联图片不可用/);
  assert.equal(mark.comparisons[0].generatedMediaId,'image_1');
  assert.equal(mark.comparisons[0].status,'pass','显示校验不静默改写保存历史');
  walk(panel).find(item=>item.attrs['aria-label']==='筛选图片对照').attrs.onChange({target:{value:'needs_review'}});
  assert.equal(walk(panel).filter(item=>item.tag==='article').length,1);
});

const comparisonPoints = c => walk(c.$('#source-comparison-panel')).filter(item=>item.attrs.class==='source-comparison-point stack');
const visibleComparison = c => comparisonPoints(c).find(item=>!item.hidden);
const comparisonJump = (c,label) => walk(c.$('#source-comparison-panel')).find(item=>item.attrs['aria-label']===label);

test('clicking a comparison point reveals clickable neighbours at either visible edge and at the list ends', () => {
  const c=comparisonFixture(),entry=c.sourceAnnotationsDraft();
  entry.marks[0].time='1，2，3，4，5，6，7';
  findButton(c.container,'比对分析').attrs.onClick();
  const timeline=walk(c.container).find(item=>item.attrs.class==='source-comparison-timeline');
  const buttons=timeline.children;
  timeline.clientWidth=312;
  buttons.forEach((item,index)=>Object.assign(item,{offsetLeft:index*106,offsetWidth:100}));
  let scrollLeft=0;
  Object.defineProperty(timeline,'scrollLeft',{
    get:()=>scrollLeft,
    set:value=>{scrollLeft=Math.max(0,Math.min(value,buttons.at(-1).offsetLeft+100-timeline.clientWidth));},
  });
  for(const [start,index] of [[0,2],[424,4],[0,0],[424,6],[0,6]]) {
    timeline.scrollLeft=start;
    buttons[index].attrs.onClick();
    for(const neighbour of buttons.slice(Math.max(0,index-1),index+2)) {
      assert.ok(neighbour.offsetLeft>=timeline.scrollLeft,'previous point remains fully clickable');
      assert.ok(neighbour.offsetLeft+neighbour.offsetWidth<=timeline.scrollLeft+timeline.clientWidth,'next point remains fully clickable');
    }
    assert.equal(buttons[index].attrs['aria-pressed'],'true');
  }
  assert.equal(entry.dirty,false);
  assert.deepEqual(c.requests,[]);
});

test('comparison keeps the original video on the left and clicking a time selects its image and seeks the same player', () => {
  const c=comparisonFixture(),video=c.$('#source-annotation-player'),entry=c.sourceAnnotationsDraft();
  let paused=0;video.pause=()=>paused++;
  findButton(c.container,'比对分析').attrs.onClick();
  const layout=walk(c.container).find(item=>item.attrs.class==='source-annotations-layout');
  assert.ok(walk(layout.children[0]).includes(video));
  assert.equal(layout.children[2],c.$('#source-comparison-panel'));
  assert.equal(layout.hidden,undefined);
  assert.equal(paused,0);
  assert.equal(comparisonPoints(c).filter(item=>!item.hidden).length,1);
  comparisonJump(c,'跳转 02-G 00:02.500').attrs.onClick();
  assert.equal(video.currentTime,2.5);
  assert.equal(textOf(walk(visibleComparison(c)).find(item=>item.tag==='h3')),'时间点 00:02.500');
  assert.equal(comparisonJump(c,'跳转 02-G 00:02.500').attrs['aria-pressed'],'true');
  comparisonJump(c,'跳转 02-G 00:01.800').attrs.onClick();
  assert.equal(video.currentTime,1.8);
  assert.ok(walk(visibleComparison(c)).some(item=>item.tag==='img'&&item.attrs.src==='/api/media/image_1'));
  assert.equal(c.$('#source-annotation-player'),video);
  assert.equal(entry.dirty,false);
  assert.deepEqual(c.requests,[]);
});

test('playback and scrubbing switch images at each timestamp in both directions without seeking or dirtying the draft', () => {
  const c=comparisonFixture(),video=c.$('#source-annotation-player'),entry=c.sourceAnnotationsDraft();
  entry.marks[0].time='00:02.500，00:01.800';
  entry.marks.push({title:'后续镜头',time:'5',camera:'固定',content:'',shotCode:'03'});
  findButton(c.container,'比对分析').attrs.onClick();
  const before=plain(entry.marks);
  for(const [event,seconds,label,title] of [
    ['onTimeupdate',0,'00:01.800','巨蛙与露洁对峙'],
    ['onTimeupdate',1.8,'00:01.800','巨蛙与露洁对峙'],
    ['onTimeupdate',2.499,'00:01.800','巨蛙与露洁对峙'],
    ['onTimeupdate',2.5,'00:02.500','巨蛙与露洁对峙'],
    ['onTimeupdate',4.9,'00:02.500','巨蛙与露洁对峙'],
    ['onTimeupdate',5,'5','后续镜头'],
    ['onTimeupdate',20,'5','后续镜头'],
    ['onSeeked',1.9,'00:01.800','巨蛙与露洁对峙'],
  ]) {
    video.currentTime=seconds;video.attrs[event]({target:video});
    assert.equal(video.currentTime,seconds);
    assert.equal(textOf(walk(visibleComparison(c)).find(item=>item.tag==='h3')),`时间点 ${label}`);
    const card=walk(c.$('#source-comparison-panel')).find(item=>item.tag==='article'&&!item.hidden);
    assert.match(textOf(card),new RegExp(title));
    assert.equal(entry.videoTime,seconds);
  }
  assert.deepEqual(plain(entry.marks),before);
  assert.equal(entry.dirty,false);
  assert.deepEqual(c.requests,[]);
});

test('comparison handles duplicate times, invalid seeks, redraws and empty filters without losing the current player', () => {
  const c=comparisonFixture(),video=c.$('#source-annotation-player'),entry=c.sourceAnnotationsDraft();
  entry.marks.push({title:'同一时刻另一张图',time:'00:01.800',camera:'',content:'',shotCode:'03'});
  video.duration=2;
  findButton(c.container,'比对分析').attrs.onClick();
  comparisonJump(c,'跳转 03 00:01.800').attrs.onClick();
  video.attrs.onTimeupdate({target:video});
  const duplicate=walk(c.$('#source-comparison-panel')).find(item=>item.tag==='article'&&!item.hidden);
  assert.match(textOf(duplicate),/同一时刻另一张图/);
  comparisonJump(c,'跳转 02-G 00:02.500').attrs.onClick();
  assert.equal(video.currentTime,1.8);
  assert.equal(duplicate.hidden,false);
  comparisonJump(c,'跳转 02-G 00:01.800').attrs.onClick();
  comparisonJump(c,'巨蛙与露洁对峙 00:01.800 对应生成图').attrs.onChange({target:{value:'image_2'}});
  assert.ok(walk(visibleComparison(c)).some(item=>item.tag==='img'&&item.attrs.src==='/api/media/image_2'));
  comparisonJump(c,'筛选图片对照').attrs.onChange({target:{value:'needs_review'}});
  assert.equal(comparisonPoints(c).length,0);
  video.currentTime=0;video.attrs.onSeeked({target:video});
  assert.equal(c.$('#source-annotation-player'),video);
  assert.deepEqual(c.requests,[]);
});

test('time-point pictures remain browsable without an original video and invalid marker text remains editable', () => {
  const c=fixture(),entry=c.sourceAnnotationsDraft();
  entry.marks.push({title:'待配视频',time:'3，暂定，1',camera:'',content:''});
  c.renderApp();
  findButton(c.container,'比对分析').attrs.onClick();
  comparisonJump(c,'跳转 镜头 1 3').attrs.onClick();
  assert.equal(textOf(walk(visibleComparison(c)).find(item=>item.tag==='h3')),'时间点 3');
  assert.equal(entry.videoTime,3);
  assert.equal(entry.dirty,false);
  findButton(c.container,'镜头编辑').attrs.onClick();
  assert.match(textOf(c.$('#source-annotations-editor')),/时间标记点/);
  assert.equal(entry.marks[0].time,'3，暂定，1');
});

test('video frames advance closely spaced comparison points and pause, end or removal stops the callback loop', () => {
  const c=comparisonFixture(),video=c.$('#source-annotation-player'),pending=new Map();
  c.sourceAnnotationsDraft().marks[0].time='1.8，1.9，2';
  let next=0;
  Object.assign(video,{isConnected:true,paused:false,ended:false,
    requestVideoFrameCallback(callback){pending.set(++next,callback);return next;},
    cancelVideoFrameCallback(id){pending.delete(id);},
  });
  const frame=time=>{const [id,callback]=pending.entries().next().value;pending.delete(id);callback(0,{mediaTime:time});};
  findButton(c.container,'比对分析').attrs.onClick();
  video.attrs.onPlay({target:video});
  video.attrs.onPlay({target:video});
  assert.equal(pending.size,1);
  for(const seconds of [1.8,1.9,2]) {
    frame(seconds);
    assert.equal(textOf(walk(visibleComparison(c)).find(item=>item.tag==='h3')),`时间点 ${seconds}`);
    assert.equal(pending.size,1);
  }
  video.attrs.onPause();assert.equal(pending.size,0);
  video.attrs.onPlay({target:video});video.attrs.onEnded();assert.equal(pending.size,0);
  video.attrs.onPlay({target:video});video.isConnected=false;frame(2.1);assert.equal(pending.size,0);
  assert.equal(c.sourceAnnotationsDraft().dirty,false);
  assert.deepEqual(c.requests,[]);
});
