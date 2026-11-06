import { test } from 'node:test';
import assert from 'node:assert';
import {
  classifyLinePunctuation, buildEmotionTag, emotionDirection, buildDialogueScript,
} from '../server/fish-audio.mjs';

test('疑问句保留问号，不误改成感叹或撒娇', () => {
  assert.equal(classifyLinePunctuation('你真喜欢他？').ending, '？');
  assert.equal(classifyLinePunctuation('肠的事，说清楚了？').ending, '？');
});

test('句首命令词触发感叹号', () => {
  assert.equal(classifyLinePunctuation('别来了。').ending, '！');
  assert.equal(classifyLinePunctuation('快躲开。').ending, '！');
});

test('句中「别」「快」「给我」不误判为命令', () => {
  assert.equal(classifyLinePunctuation('可惜现在，你已经要嫁给别人了。').ending, '');
  assert.equal(classifyLinePunctuation('我下去拿个东西，很快。').ending, '');
  assert.equal(classifyLinePunctuation('给我10分钟，不耽误你婚礼。').ending, '');
});

test('强烈质问升级为 ？！', () => {
  assert.equal(classifyLinePunctuation('你还敢回来？', { cue: '强烈质问' }).ending, '？！');
});

test('撒娇/俏皮线索句尾加波浪号', () => {
  assert.equal(classifyLinePunctuation('夸夸我。', { mood: '撒娇' }).ending, '～');
});

test('愤怒/喊叫线索句尾加感叹号', () => {
  assert.equal(classifyLinePunctuation('这次不让了。婚，不结了。', { mood: '愤怒与失望' }).ending, '！');
});

test('已有叹号/波浪号保留不重复追加', () => {
  const a = classifyLinePunctuation('面加肠，常见面！');
  assert.equal(a.ending, '！');
  assert.ok(!a.line.endsWith('！！'));
});

test('情感标签覆盖实际出现的情绪词', () => {
  assert.ok(emotionDirection('愤怒与失望').includes('angry'));
  assert.ok(emotionDirection('决绝与落寞').includes('lonely') || emotionDirection('决绝与落寞').includes('resolute'));
  assert.ok(emotionDirection('犹豫与怀旧').length > 0);
  assert.ok(emotionDirection('急切与克制').length > 0);
});

test('buildDialogueScript 生成带 speaker 标签与情感标签的脚本', () => {
  const lines = [
    { speaker: '袋装方便面', text: '先把婚结了，这件事明天再说好吗？', mood: '急切与克制' },
    { speaker: '豪华海鲜面', text: '这次不让了。婚，不结了。', mood: '愤怒与失望' },
  ];
  const voiceMap = { '袋装方便面': 0, '豪华海鲜面': 1 };
  const { script, entries } = buildDialogueScript(lines, voiceMap);
  assert.ok(script.includes('<|speaker:0|>'));
  assert.ok(script.includes('<|speaker:1|>'));
  assert.equal(entries.length, 2);
  assert.equal(entries[1].ending, '！');
});

test('已有标点不被 buildDialogueScript 破坏', () => {
  const lines = [{ speaker: '工作人员', text: '新郎，婚礼马上开始了！' }];
  const { entries } = buildDialogueScript(lines, { '工作人员': 0 });
  assert.ok(entries[0].line.endsWith('！'));
  assert.ok(!entries[0].line.endsWith('！！'));
});
