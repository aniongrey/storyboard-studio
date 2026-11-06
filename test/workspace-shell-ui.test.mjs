import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const walk = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(walk)] : [];
const textOf = tree => tree && typeof tree === 'object' ? tree.children.map(textOf).join('') : String(tree);
function node(tag, attrs = {}, ...children) {
  return { tag, attrs: { ...attrs }, children: children.flat(Infinity).filter(item => item != null && item !== false),
    append(...items) { this.children.push(...items.flat(Infinity)); },
    replaceChildren(...items) { this.children = items.flat(Infinity); },
    setAttribute(key, value) { this.attrs[key] = value; },
    querySelector() { return walk(this).find(item => item.attrs['aria-current'] === 'page'); },
    scrollIntoView() { this.scrolled = true; },
    focus() { this.focused = true; },
    set textContent(value) { this.children = [value]; },
    classList: { toggle() {} },
  };
}
function setup({ narrow = false } = {}) {
  const app = node('div'), saved = new Map();
  const labels = { overview:'作品概览', annotations:'原视频打标', references:'视频转参考', character:'角色资产', location:'地点资产', prop:'道具资产', shot:'镜头工作台', jobs:'生成任务', forge:'因果剧本' };
  const context = {
    app, node, labels, view:'annotations', shotView:'list', sidebarCollapsed:false, busy:false,
    state:{ projects:[{ id:'project_1', title:'作品一' }], project:{ id:'project_1', title:'作品一' }, jobs:[], capabilities:{} },
    document:{ title:'' }, window:{ matchMedia:() => ({ matches:narrow }) },
    localStorage:{ getItem:key => saved.get(key) ?? null, setItem:(key,value) => saved.set(key,value) }, saved,
    icon:name => node('svg', { 'data-icon':name }),
    button:(label,action,className='',attrs={}) => node('button', { type:'button', class:className, onClick:action, ...attrs }, label),
    $:selector => walk(app).find(item => selector.startsWith('#') ? item.attrs.id === selector.slice(1) : String(item.attrs.class || '').split(' ').includes(selector.slice(1))),
    count:() => 3, episodePicker:() => node('select', { 'aria-label':'选择当前作品集数' }),
    destroySourceAnnotationPlayer() {}, stopPreviewPlayback() {},
    showAddEpisode() {}, showSource() {}, showSettings() {}, refreshAssets() {},
    renderSourceAnnotations:container => container.append(node('video', { id:'player' }), node('textarea', { id:'draft', value:'尚未保存的输入' })),
    renderWorkspace:container => container.append(node('section', { id:'editor' })),
    renderJobs() {}, renderVideoReferences() {}, renderOverview() {},
    changeView(next) { context.view=next;context.renderApp(); },
  };
  runInNewContext(source.slice(source.indexOf('function setSidebarCollapsed('), source.indexOf('// 因果剧本模块')), context);
  context.renderApp();
  return context;
}
const findButton = (context,label) => walk(context.app).find(item => item.tag === 'button' && item.attrs['aria-label'] === label);
const initializeView = source.slice(source.indexOf('let view ='),source.indexOf('let sidebarCollapsed ='))+'\nview;';

test('every sidebar selection restores after a reload with matching content and active navigation', () => {
  const c=setup();
  Object.assign(c, { selected:() => null, resetSelection() {}, renderForgeView() {}, forgeHelpers:() => ({}) });
  c.document.body={ classList:{ remove() {} } };
  runInNewContext(source.slice(source.indexOf('function changeView('),source.indexOf('function invalidatePreview(')),c);
  for (const [key,label] of Object.entries(c.labels)) {
    findButton(c,label).attrs.onClick();
    assert.equal(c.saved.get('studio.view'),key);
    c.view=runInNewContext(initializeView,{ labels:c.labels, localStorage:c.localStorage });
    c.renderApp();
    assert.equal(c.$('#main-content').attrs['aria-label'],label);
    assert.equal(walk(c.app).find(item => item.attrs['aria-current']==='page').attrs['aria-label'],label);
  }
});

test('missing or invalid saved navigation and blocked storage fall back to the overview', () => {
  const c=setup();
  for (const saved of [null,'','removed-view','toString','__proto__']) {
    assert.equal(runInNewContext(initializeView,{ labels:c.labels, localStorage:{getItem:() => saved} }),'overview');
  }
  c.localStorage.getItem=c.localStorage.setItem=() => {throw new Error('storage unavailable');};
  assert.equal(runInNewContext(initializeView,{ labels:c.labels, localStorage:c.localStorage }),'overview');
  findButton(c,'角色资产').attrs.onClick();
  assert.equal(c.view,'character');
});

test('project, episode and all former top-bar actions live in the shared sidebar', () => {
  const c=setup(), sidebar=c.$('#workspace-sidebar');
  for (const label of ['选择作品','选择当前作品集数','原文','设置','刷新资产','导入分镜']) {
    assert.ok(walk(sidebar).some(item => item.attrs['aria-label'] === label), label);
  }
  assert.equal(walk(sidebar).filter(item => item.attrs['aria-current'] === 'page').length, 1);
  assert.equal(walk(sidebar).find(item => item.attrs['aria-current'] === 'page').scrolled, true);
  assert.doesNotMatch(textOf(c.app), /STORYBOARD STUDIO|YOUR CREATIVE WORKSPACE/);
  assert.equal(c.$('.topbar'), undefined);
});

test('collapsing keeps the mounted player and unsaved editor, and persists across navigation', () => {
  const c=setup(), content=c.$('#main-content'), video=c.$('#player'), draft=c.$('#draft');
  const shell=c.$('.shell'), changes=[];
  shell.classList.toggle=(name,value) => changes.push([name,value]);
  findButton(c,'收起侧栏').attrs.onClick();
  assert.equal(c.sidebarCollapsed, true);
  assert.deepEqual(changes,[['sidebar-collapsed',true]]);
  assert.equal(c.saved.get('studio.sidebarCollapsed'),'true');
  assert.equal(findButton(c,'展开侧栏').attrs['aria-expanded'],'false');
  assert.equal(c.$('#main-content'),content);
  assert.equal(c.$('#player'),video);
  assert.equal(c.$('#draft'),draft);
  assert.equal(draft.attrs.value,'尚未保存的输入');
  findButton(c,'角色资产').attrs.onClick();
  assert.match(c.$('.shell').attrs.class,/sidebar-collapsed/);
  assert.ok(c.$('#editor'));
  findButton(c,'切换作品与集数').attrs.onClick();
  assert.equal(c.sidebarCollapsed,false);
  assert.equal(c.$('#project-select').focused,true);
});

test('narrow-screen navigation closes the drawer and unavailable storage does not break the toggle', () => {
  const c=setup({ narrow:true });
  c.localStorage.setItem=() => {throw new Error('storage unavailable');};
  findButton(c,'角色资产').attrs.onClick();
  assert.equal(c.sidebarCollapsed,true);
  findButton(c,'展开侧栏').attrs.onClick();
  assert.equal(c.sidebarCollapsed,false);
  findButton(c,'关闭侧栏遮罩').attrs.onClick();
  assert.equal(c.sidebarCollapsed,true);
});

test('sidebar preference restores on load and defaults to a rail on narrow screens', () => {
  const initialize=source.slice(source.indexOf('let sidebarCollapsed ='),source.indexOf('let selectedId ='))+'\nsidebarCollapsed;';
  for (const [narrow,saved,expected] of [[false,null,false],[true,null,true],[false,'true',true],[true,'false',false]]) {
    assert.equal(runInNewContext(initialize,{ window:{matchMedia:() => ({matches:narrow})}, localStorage:{getItem:() => saved} }),expected);
  }
  assert.equal(runInNewContext(initialize,{ window:{matchMedia:() => ({matches:true})}, localStorage:{getItem:() => {throw new Error('unavailable');}} }),true);
});

test('sidebar and screenplay project switches both open the selected project at its latest episode', async () => {
  const c=setup(), requests=[];
  Object.assign(c, { currentEpisode:1, selectedId:null, hasCustomVideoConfig:true,
    perform:action => action(), resetSelection() {}, notify() {}, copy() {}, openModal() {},
    api:async (path,options) => {
      requests.push({path,options});
      return path==='/api/projects/select'?{project:{id:options.body.projectId}}:
        {projects:[],project:{id:c.state.project.id,episodes:[1,12,3]},capabilities:{}};
    },
  });
  runInNewContext(source.slice(source.indexOf('async function loadState('),source.indexOf('function resetSelection(')),c);
  runInNewContext(source.slice(source.indexOf('function forgeHelpers('),source.indexOf('function heading(')),c);
  await c.$('#project-select').attrs.onChange({target:{value:'project_2'}});
  assert.equal(c.state.project.id,'project_2');
  assert.equal(c.currentEpisode,12);
  assert.equal(c.view,'overview');
  assert.equal(c.saved.get('studio.view'),'overview');
  c.currentEpisode='all';
  await c.forgeHelpers().openStudioProject('project_3');
  assert.equal(c.state.project.id,'project_3');
  assert.equal(c.currentEpisode,12);
  assert.equal(c.saved.get('studio.view'),'overview');
  assert.equal(requests.filter(request=>request.path==='/api/projects/select').length,2);
});
