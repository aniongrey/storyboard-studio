import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseMarkdown } from '../server/importer.mjs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const node = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(Boolean), append(...items) { this.children.push(...items.flat()); } });
const walk = tree => typeof tree === 'object' && tree ? [tree, ...tree.children.flatMap(walk)] : [];

const filterSlice = app.slice(app.indexOf('function cjkNumber('), app.indexOf('function renderPreview('));
const optionsIn = tree => walk(tree).filter(item => item.tag === 'option');
const searchIn = tree => walk(tree).find(item => item.tag === 'input' && item.attrs['data-preview-search'] === '1');

function contextFor(entries) {
  const context = {
    node,
    button: (label, onClick, className, attrs) => node('button', { onClick, class: className, ...attrs }, label),
    state: { project: { episodes: [1, 2, 3], storyScenes: [
      { id: 'scene-1', title: '第一场：出生禁令' },
      { id: 'scene-2', title: '第一场：第2集·雷声打破预言' },
      { id: 'scene-3', title: '第3集·结局' },
    ] } },
    storyboardShots: () => [],
    sceneTitleOf: entity => context.state.project.storyScenes.find(scene => scene.id === entity?.data?.sceneId)?.title || '未归属场次',
    previewEntries: () => entries,
    previewQuery: '',
    currentEpisode: 'all',
    previewStripScroll: 0,
    reapplyPreviewFilter() { context.filterApplied = (context.filterApplied || 0) + 1; },
    rerenderPreview() {},
  };
  runInNewContext(filterSlice, context);
  return context;
}

const entries = [
  { shot: { id: 'a', type: 'shot', code: '01-A', name: '出生警告', data: { sceneId: 'scene-1' } }, scene: '第一场：出生禁令' },
  { shot: { id: 'b', type: 'shot', code: '60-B', name: '雷声', data: { sceneId: 'scene-2' } }, scene: '第一场：第2集·雷声打破预言' },
  { shot: { id: 'c', type: 'storyboard', code: 'SB-19', name: '第2集·故事板1｜60-B—63-E', data: {} }, scene: '故事板 · 第2集·故事板1｜60-B—63-E' },
  { shot: { id: 'd', type: 'storyboard', code: 'SB-1', name: '故事板01｜01-A、02-A', data: {} }, scene: '故事板 · 故事板01｜01-A、02-A' },
];

test('episode numbers come from the name or the scene title, with 第1集 as the fallback', () => {
  const context = contextFor(entries);
  assert.equal(context.episodeNumber(entries[2].shot), 2);
  assert.equal(context.episodeNumber(entries[3].shot), 1);
  assert.equal(context.episodeNumber(entries[0].shot), 1);
  assert.equal(context.episodeNumber({ id: 'e', type: 'shot', data: { sceneId: 'scene-3' } }), 3);
  assert.equal(context.episodeNumber(null), 1);
  assert.equal(context.cjkNumber('十'), 10);
  assert.equal(context.cjkNumber('十二'), 12);
  assert.equal(context.cjkNumber('3'), 3);
});

test('preview list filters by episode and search term, keeping 全部 as the unfiltered state', () => {
  const context = contextFor(entries);
  assert.equal(context.previewItems().length, 4);
  context.currentEpisode = 2;
  assert.deepEqual(Array.from(context.previewItems(), entry => entry.shot.id), ['b', 'c']);
  context.previewQuery = 'sb-1';
  assert.deepEqual(Array.from(context.previewItems(), entry => entry.shot.id), ['c'], '组号前缀命中 SB-19');
  context.previewQuery = 'zzz';
  assert.deepEqual(Array.from(context.previewItems(), entry => entry.shot.id), []);
  context.previewQuery = '60-b';
  assert.deepEqual(Array.from(context.previewItems(), entry => entry.shot.id), ['b', 'c']);
  context.previewQuery = '第2集';
  assert.deepEqual(Array.from(context.previewItems(), entry => entry.shot.id), ['b', 'c']);
});

test('filter bar offers saved episodes, including empty episodes, and shares the workspace selection', () => {
  const context = contextFor(entries);
  const bar = context.previewFilterBar();
  const search = searchIn(bar);
  assert.ok(search, '搜索框应当存在');
  assert.equal(search.attrs.value, '');
  search.attrs.onInput({ target: { value: '60' } });
  assert.equal(context.previewQuery, '60');
  assert.equal(context.filterApplied, 1);
  const labels = optionsIn(bar).map(option => option.children.join(''));
  assert.deepEqual(labels, ['全部集数', '第1集', '第2集', '第3集']);
  assert.equal(optionsIn(bar)[0].attrs.selected, true);
  context.currentEpisode = 2;
  const refreshed = optionsIn(context.previewFilterBar());
  assert.equal(refreshed[2].attrs.selected, true);
  assert.equal(refreshed[0].attrs.selected, false);
  context.currentEpisode = 3;
  assert.equal(context.previewItems().length, 0);
});

test('saved episode membership overrides title guesses and boards inherit their first shot', () => {
  const context = contextFor(entries);
  const shot = { type: 'shot', name: '第2集镜头', data: { sceneId: 'scene-2', episodeNumber: 1 } };
  assert.equal(context.episodeNumber(shot), 1);
  context.storyboardShots = () => [shot];
  assert.equal(context.episodeNumber(entries[2].shot), 1);
});

test('changing the episode stops playback, resets scene/sequence selection and retains drafts through resetSelection', () => {
  const context = contextFor(entries);
  const calls = [];
  Object.assign(context, { dirty: false, selected: () => null, stopPreviewPlayback: () => calls.push('stop'),
    resetSelection: id => calls.push(id), renderApp: () => calls.push('render'), previewIndex: 8, shotSheetScene: 'scene-2' });
  const picker = context.episodePicker('集数');
  picker.attrs.onChange({ target: { value: '3' } });
  assert.equal(context.currentEpisode, 3);
  assert.equal(context.shotSheetScene, 'all');
  assert.equal(context.previewIndex, 0);
  assert.deepEqual(calls, ['stop', null, 'render']);
});
