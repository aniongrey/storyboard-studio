import test from 'node:test';
import assert from 'node:assert/strict';
import {composeStoryboardPrompt} from '../public/storyboard.mjs';

test('storyboard images use a saved opening frame while videos retain the full movement', () => {
  const shot={id:'s',code:'1',name:'推门',data:{duration:3,firstFramePrompt:'手刚碰到门把，门完全闭合。',action:'推开门走到窗边。',composition:'结束时人到窗边。',shotSize:'中景'}};
  const project={assets:[],shots:[shot]},board={data:{shotIds:['s']}};
  const original=structuredClone(shot);
  const image=composeStoryboardPrompt(project,board,'image');
  assert.ok(image.includes(shot.data.firstFramePrompt));
  assert.ok(!image.includes(shot.data.action));
  assert.ok(!image.includes(shot.data.composition));
  const video=composeStoryboardPrompt(project,board,'video');
  assert.ok(video.includes(shot.data.action));
  assert.ok(video.includes(shot.data.composition));
  assert.deepEqual(shot,original);
  shot.data.firstFramePrompt='  ';
  assert.ok(composeStoryboardPrompt(project,board,'image').includes(shot.data.action));
  shot.data.firstFramePrompt=42;
  assert.ok(composeStoryboardPrompt(project,board,'image').includes(shot.data.action));
});
