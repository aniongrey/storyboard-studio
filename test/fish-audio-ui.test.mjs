import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function renderVoicePreview('), app.indexOf('function showAddVoice('));
const walk = tree => typeof tree === 'object' && tree ? [tree, ...tree.children.flatMap(walk)] : [];

function fixture() {
  const requests = [], notices = [], created = [], revoked = [], observers = [], modalListeners = new Map();
  const context = {
    state: { csrfToken: 'test-csrf' }, busy: false, Headers,
    node(tag, attrs = {}, ...children) {
      return {
        tag, attrs, children: children.flat(Infinity).filter(item => item != null && item !== false),
        value: attrs.value ?? '', hidden: !!attrs.hidden, disabled: !!attrs.disabled,
        isConnected: true, src: attrs.src || '', playCount: 0, pauseCount: 0,
        append(...items) { this.children.push(...items.flat(Infinity)); },
        replaceChildren(...items) { assert.ok(items.every(item=>!Array.isArray(item)), 'DOM replaceChildren requires individual nodes'); this.children = items; },
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = ''; },
        contains(element) { return walk(this).includes(element); },
        querySelectorAll(tag) { return walk(this).filter(element => element.tag === tag); },
        async play() { this.playCount++; if (context.playError) throw context.playError; },
        pause() { this.pauseCount++; }, load() {},
        addEventListener(name, action) { this.attrs['on' + name] = action; },
        removeEventListener(name) { delete this.attrs['on' + name]; },
      };
    },
    button(label, action, className, attrs = {}) { return context.node('button', { onClick: action, class: className, ...attrs }, label); },
    notify(message, error) { notices.push({ message, error }); },
    async perform(action) {
      if (context.busy) return;
      context.busy = true;
      try { return await action(); }
      catch (error) { context.notify(error.message, true); return null; }
      finally { context.busy = false; }
    },
    async fetch(path, options) {
      requests.push({ path, options });
      return context.response;
    },
    response: { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'audio/mpeg' }), async blob() { return { type: 'audio/mpeg', size: 12 }; } },
    URL: {
      createObjectURL(blob) { created.push(blob); return 'blob:preview-' + created.length; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    },
    document: { body: {}, querySelectorAll: () => [] },
    modal: {
      open: true, contains: () => context.inModal,
      addEventListener(name, action) { modalListeners.set(name, action); },
      removeEventListener(name, action) { if (modalListeners.get(name) === action) modalListeners.delete(name); },
    },
    inModal: false,
  };
  runInNewContext(source, context);
  let voiceId = 'voice_1234';
  const tree = context.renderVoicePreview(() => voiceId);
  const input = walk(tree).find(element => element.tag === 'input' || element.tag === 'textarea');
  const audition = walk(tree).find(element => element.tag === 'button');
  const audio = walk(tree).find(element => element.tag === 'audio');
  const click = () => audition.attrs.onClick({ target: audition, currentTarget: audition });
  return {
    context, tree, input, audition, audio, click, requests, notices, created, revoked,
    voice(value) { voiceId = value; },
    disconnect() { tree.isConnected = false; for (const observer of observers) observer.callback([]); },
    closeModal() { context.modal.open = false; modalListeners.get('close')?.(); },
  };
}

test('voice audition uses default text, the current unsaved voice ID, CSRF and browser-playable MP3', async () => {
  const f = fixture();
  assert.equal(f.input.value, '你在叫我吗？');
  assert.equal(f.audio.hidden, true);
  assert.equal(f.audio.attrs.controls, true);
  f.voice('  changed_voice  ');
  await f.click();
  assert.equal(f.requests.length, 1);
  const { path, options } = f.requests[0];
  assert.equal(path, '/api/fish-audio/synthesize');
  assert.equal(options.method, 'POST');
  assert.equal(new Headers(options.headers).get('X-Studio-Token'), 'test-csrf');
  assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(options.body), { text: '你在叫我吗？', referenceId: 'changed_voice', format: 'mp3', download: true });
  assert.equal(f.audio.src, 'blob:preview-1');
  assert.equal(f.audio.hidden, false);
  assert.equal(f.audio.playCount, 1);
  assert.match(f.audio.attrs['aria-label'], /changed_voice.*你在叫我吗？/);
});

test('voice audition replays the same sample and regenerates when its text or voice ID changes', async () => {
  const f = fixture();
  await f.click();
  await f.click();
  assert.equal(f.requests.length, 1);
  assert.equal(f.audio.playCount, 2);
  f.input.value = '再叫我一次。';
  await f.click();
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.parse(f.requests[1].options.body).text, '再叫我一次。');
  assert.ok(f.revoked.includes('blob:preview-1'));
  f.voice('another_voice');
  await f.click();
  assert.equal(f.requests.length, 3);
  assert.equal(JSON.parse(f.requests[2].options.body).referenceId, 'another_voice');
});

test('invalid audition IDs and empty or oversized text never call Fish Audio', async () => {
  for (const value of ['', 'short', 'bad voice ID', 'a'.repeat(65)]) {
    const f = fixture();
    f.voice(value);
    await f.click();
    assert.equal(f.requests.length, 0);
    assert.ok(f.notices.length);
    assert.equal(f.audition.disabled, false);
  }
  for (const text of ['', '   ', '字'.repeat(8001)]) {
    const f = fixture();
    f.input.value = text;
    await f.click();
    assert.equal(f.requests.length, 0);
    assert.ok(f.notices.length);
  }
});

test('an audition in progress ignores repeated clicks and releases the button after completion', async () => {
  const f = fixture();
  let finish;
  const response = f.context.response;
  f.context.response = new Promise(resolve => { finish = resolve; });
  const first = f.click();
  assert.equal(f.audition.disabled, true);
  await f.click();
  assert.equal(f.requests.length, 1);
  finish(response);
  await first;
  assert.equal(f.audition.disabled, false);
});

test('provider errors are visible and the next audition can retry', async () => {
  const f = fixture();
  const successful = f.context.response;
  f.context.response = { ok: false, status: 409, async json() { return { error: '未配置 Fish Audio API Key。' }; } };
  await f.click();
  assert.ok(f.notices.some(notice => /未配置 Fish Audio API Key/.test(notice.message)));
  assert.equal(f.audition.disabled, false);
  assert.equal(f.created.length, 0);
  f.context.response = successful;
  await f.click();
  assert.equal(f.requests.length, 2);
  assert.equal(f.audio.hidden, false);
});

test('blocked autoplay leaves controls available for manual playback', async () => {
  const f = fixture();
  f.context.playError = new Error('Autoplay denied');
  await f.click();
  assert.equal(f.audio.hidden, false);
  assert.equal(f.audio.src, 'blob:preview-1');
  assert.ok(f.notices.some(notice => /播放|试听/.test(notice.message)));
  assert.equal(f.audition.disabled, false);
});

test('playing an audition pauses other audition players', () => {
  const f = fixture();
  const other = f.context.node('audio');
  f.context.document.querySelectorAll = () => [f.audio, other];
  f.audio.attrs.onPlay();
  assert.equal(f.audio.pauseCount, 0);
  assert.equal(other.pauseCount, 1);
});

test('removing an audition or closing its containing modal releases its sample', async () => {
  for (const inModal of [false, true]) {
    const f = fixture();
    f.context.inModal = inModal;
    await f.click();
    const before = f.audio.pauseCount;
    if (inModal) f.closeModal(); else f.disconnect();
    assert.deepEqual(f.revoked, ['blob:preview-1']);
    assert.equal(f.audio.pauseCount, before + 1);
    f.disconnect();
    assert.deepEqual(f.revoked, ['blob:preview-1']);
  }
});

test('an audition response arriving after removal or modal close never starts playback', async () => {
  for (const inModal of [false, true]) {
    const f = fixture();
    f.context.inModal = inModal;
    let finish;
    const response = f.context.response;
    f.context.response = new Promise(resolve => { finish = resolve; });
    const request = f.click();
    if (inModal) f.closeModal(); else f.disconnect();
    finish(response);
    await request;
    assert.equal(f.created.length, 0);
    assert.equal(f.audio.playCount, 0);
  }
});

function settingsFixture(presets = [
  { id:'one',name:'音色一',voiceId:'voice_one' },
  { id:'two',name:'音色二',voiceId:'voice_two',note:'旁白' },
]) {
  const f=fixture(), c=f.context;
  Object.assign(c, { videoConfig:{workflowId:'test-workflow'}, editorTab:'edit',
    concurrencyLimits:()=>({min:1,max:10}),videoConcurrency:()=>1,accountSummary:()=>'',
    json:JSON.stringify, row:(...children)=>c.node('div',{},children), badge:label=>c.node('span',{},label),
    openModal(title,body,className) { f.dialog={title,body,className}; },
    async api(path,options) { return {voicePresets:options.body.voicePresets}; },
  });
  Object.assign(c.state,{capabilities:{},settings:{},voicePresets:presets});
  runInNewContext(app.slice(app.indexOf('function showSettings('),app.indexOf('async function importFile(')),c);
  c.showSettings();
  f.find=label=>walk(f.dialog.body).find(element=>element.attrs['aria-label']===label);
  return f;
}

test('settings share one audition field and only send the selected voice ID after a click', async () => {
  const f=settingsFixture(), nodes=walk(f.dialog.body);
  assert.equal(nodes.filter(element=>element.attrs['aria-label']==='试听文本').length,1);
  assert.equal(nodes.filter(element=>element.tag==='audio').length,1);
  assert.equal(nodes.filter(element=>element.attrs.class==='voice-lib-row').length,2);
  const select=f.find('选择试听音色 ID'), audition=nodes.find(element=>element.tag==='button'&&element.children.includes('试听'));
  await audition.attrs.onClick();
  assert.equal(f.requests.length,0);
  select.value='voice_two';
  assert.equal(f.requests.length,0);
  await audition.attrs.onClick();
  assert.equal(f.requests.length,1);
  assert.equal(JSON.parse(f.requests[0].options.body).referenceId,'voice_two');
  select.value='voice_one';
  assert.equal(f.requests.length,1);
  await audition.attrs.onClick();
  assert.equal(JSON.parse(f.requests[1].options.body).referenceId,'voice_one');
});

test('settings navigation preserves unsaved inputs and pauses a hidden audition', () => {
  const f=settingsFixture(), nodes=walk(f.dialog.body);
  const panels=nodes.filter(element=>element.attrs.class==='settings-panel');
  const navigation=nodes.find(element=>element.attrs.class==='settings-nav').children;
  const config=f.find('全局工作流配置'), text=f.find('试听文本');
  const audio=nodes.find(element=>element.tag==='audio');
  config.value='尚未保存的工作流';text.value='尚未发送的台词';
  assert.deepEqual(panels.map(panel=>panel.hidden),[false,true,true]);
  navigation[1].attrs.onClick();
  assert.deepEqual(panels.map(panel=>panel.hidden),[true,false,true]);
  navigation[2].attrs.onClick();
  assert.deepEqual(panels.map(panel=>panel.hidden),[true,true,false]);
  assert.equal(audio.pauseCount,1);
  assert.equal(config.value,'尚未保存的工作流');
  assert.equal(text.value,'尚未发送的台词');
  assert.equal(navigation[2].attrs['aria-pressed'],'true');
  assert.equal(f.requests.length,0);
});

test('an empty voice library has a visible placeholder and cannot send an audition', async () => {
  const f=settingsFixture([]), select=f.find('选择试听音色 ID');
  assert.ok(select.children.some(option=>option.children.includes('请先新增音色')));
  const audition=walk(f.dialog.body).find(element=>element.tag==='button'&&element.children.includes('试听'));
  await audition.attrs.onClick();
  assert.equal(f.requests.length,0);
});
