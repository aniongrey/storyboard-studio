import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceComparisonContext, sourceComparisonFor, sourceComparisonTitle } from '../public/source-comparison.mjs';

const image = id => ({ id, kind: 'image', metadata: { originalFilename: '同名图片.png' } });
const shot = (id, code, episodeNumber, order = 0) => ({ id, code, name: `名称 ${id}`, order, data: { episodeNumber }, media: [image(id + '-image')] });
const board = (id, shotIds, media = [image(id + '-image')]) => ({ id, name: `故事板 ${id}`, data: { shotIds }, media });

test('comparison resolves explicit shot codes only within the selected episode', () => {
  const first = shot('first', '01', 1), second = shot('second', '01', 2);
  const project = { shots: [first, second] };
  const result = sourceComparisonContext(project, 2, { shotCode: '01' }, 0, 1);
  assert.equal(result.shot, second);
  assert.deepEqual(result.images.map(media => media.id), ['second-image']);
  assert.deepEqual(sourceComparisonContext(project, 2, { shotCode: 'unknown' }, 0, 1), { shot: null, images: [] });
  assert.equal(first.media[0].entityName, undefined, 'original media remains unchanged');
});

test('unbound annotations use episode order only when shot and annotation counts match', () => {
  const first = shot('first', '01', 1, 1), second = shot('second', '02', 1, 2), other = shot('other', '03', 2);
  const project = { shots: [second, other, first] };
  assert.equal(sourceComparisonContext(project, 1, {}, 0, 2).shot, first);
  assert.equal(sourceComparisonContext(project, 1, {}, 1, 2).shot, second);
  assert.deepEqual(sourceComparisonContext(project, 1, {}, 0, 1), { shot: null, images: [] });
  assert.deepEqual(sourceComparisonContext(project, 1, {}, 2, 2), { shot: null, images: [] });
  assert.deepEqual(project.shots, [second, other, first], 'display ordering does not reorder the project');
});

test('image choices include only the matching shot and its episode-safe boards, with distinct IDs', () => {
  const first = shot('first', '01', 1), sibling = shot('sibling', '02', 1), other = shot('other', '01', 2);
  first.media.push({ id: 'video', kind: 'video' });
  const project = { shots: [first, sibling, other], storyboards: [
    board('valid', ['first', 'sibling'], [image('first-image'), image('board-image')]),
    board('cross-episode', ['first', 'other']), board('missing-shot', ['first', 'missing']), board('unrelated', ['sibling']),
  ] };
  const result = sourceComparisonContext(project, 1, { shotCode: '01' }, 0, 2);
  assert.deepEqual(result.images.map(media => media.id), ['first-image', 'board-image']);
  assert.deepEqual(result.images.map(media => media.entityName), ['名称 first', '故事板 valid']);
  assert.ok(result.images.every(media => media.metadata.originalFilename === '同名图片.png'), 'filenames do not select or deduplicate images');
  assert.deepEqual(sourceComparisonContext({}, 1, {}, 0, 1), { shot: null, images: [] });
});

test('each timestamp retains its explicit comparison and the title prefers the annotation', () => {
  const mark = { title: '抬头', comparisons: [
    { time: '0.7', sourceMediaId: 'source-a', generatedMediaId: 'generated-a', status: 'needs_review', note: '朝向待复核' },
    { time: '1.8', sourceMediaId: 'source-b', generatedMediaId: 'generated-b', status: 'unreviewed' },
  ] };
  assert.equal(sourceComparisonFor(mark, 0.7), mark.comparisons[0]);
  assert.equal(sourceComparisonFor(mark, 1.8), mark.comparisons[1]);
  assert.equal(sourceComparisonFor(mark, 3), null);
  assert.equal(sourceComparisonFor({}, 0), null);
  assert.equal(sourceComparisonTitle(mark, { name: '镜头名' }, 0), '抬头');
  assert.equal(sourceComparisonTitle({}, { name: '镜头名' }, 0), '镜头名');
  assert.equal(sourceComparisonTitle({}, null, 2), '镜头 3');
});
