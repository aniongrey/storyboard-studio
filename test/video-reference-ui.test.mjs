import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function renderVideoReferences('), app.indexOf('function renderJobs('));
const node = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(item => item != null && item !== false),
  replaceChildren(...items) { this.children = items.flat(Infinity); } });
const walk = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(walk)] : [];
const textOf = tree => tree && typeof tree === 'object' ? tree.children.map(textOf).join('') : String(tree);
function fixture() {
  const c = { node, state: { project: null, jobs: [], csrfToken: 'csrf-test', capabilities: { runninghub: { configured: true } } },
    videoReferenceDraft: { file: null, outputs: ['mixed'], operationId: null }, busy: false, view: 'references',
    VIDEO_REFERENCE_UPLOAD_MAX_BYTES: 30000000, URLSearchParams, crypto: { randomUUID: () => 'operation-id-1234' },
    button: (label, onClick, cls) => node('button', { onClick, class: cls }, label),
    heading: (title, subtitle, actions) => node('header', {}, title, subtitle, actions),
    renderTask: job => node('article', {}, job.id), notify: (...args) => { c.notice = args; },
    perform: action => action(), loadState: async () => {},
    fetch: async (url, options) => { c.requests.push({ url, options }); return { ok: true, json: async () => ({ job: { id: 'job-1' } }) }; }, requests: [],
  };
  runInNewContext(source, c); c.container = node('main'); c.renderVideoReferences(c.container);
  return c;
}
test('reference tool works without a project, preserves file choices on refresh and sends the selected source once', async () => {
  const c = fixture(), file = { name: '中文.mp4', size: 1000 };
  const picker = walk(c.container).find(item => item.attrs.type === 'file');
  picker.attrs.onChange({ target: { files: [file] } });
  c.renderVideoReferences(c.container);
  assert.match(textOf(c.container), /中文.mp4/);
  assert.ok(!walk(c.container).some(item => item.tag === 'video'), 'does not load or play any video automatically');
  const checkboxes = walk(c.container).filter(item => item.attrs.type === 'checkbox');
  checkboxes[0].attrs.onChange({ target: { checked: true } });
  checkboxes[1].attrs.onChange({ target: { checked: true } });
  await walk(c.container).find(item => item.tag === 'form').attrs.onSubmit({ preventDefault() {} });
  assert.equal(c.requests.length, 1);
  const { url, options } = c.requests[0], query = new URL(url, 'http://localhost').searchParams;
  assert.equal(query.get('filename'), file.name);
  assert.deepEqual(query.get('outputs').split(',').sort(), ['depth', 'mixed', 'pose']);
  assert.equal(query.get('operationId'), 'operation-id-1234');
  assert.equal(options.headers['X-Studio-Token'], 'csrf-test'); assert.equal(options.body, file);
  assert.equal(c.videoReferenceDraft.file, file); assert.equal(c.state.project, null);
});
test('oversized source files and an empty output selection do not submit a task', async () => {
  const c = fixture(); c.videoReferenceDraft.file = { name: 'large.mp4', size: 30000000 }; c.renderVideoReferences(c.container);
  await walk(c.container).find(item => item.tag === 'form').attrs.onSubmit({ preventDefault() {} });
  assert.match(c.notice[0], /30 MB/); assert.equal(c.requests.length, 0);
  c.videoReferenceDraft.file.size = 100; c.videoReferenceDraft.outputs = []; c.renderVideoReferences(c.container);
  assert.equal(walk(c.container).find(item => item.attrs.type === 'submit').attrs.disabled, true);
});
