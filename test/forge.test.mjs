import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze, analyzeImpact, buildExport, createProject, fingerprint, localPlans, nodeDuration, normalizeProject, scriptScenes, seedFromStudio,
} from '../server/forge.mjs';
import { parseMarkdown } from '../server/importer.mjs';

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = path.join(appRoot, 'examples', 'storyforge-龙娘部落.json');

// 一份最小可用的因果图：第1集建前提 → 第2集用前提 → 第3集回收伏笔。
function fixture() {
  const project = normalizeProject({
    id: 'forge_test',
    title: '测试剧本',
    episodeCount: 6,
    cast: [
      { id: 'cas1', name: '甲', desire: '活下去', fear: '被驱逐' },
      { id: 'cas2', name: '乙', desire: '掌权', fear: '失控' },
    ],
    locations: [{ id: 'loc1', code: 'A', name: '营地' }],
    outcomes: [{ id: 'out1', episode: 3, title: '乙当众接管', lock: 'hard' }],
    nodes: [
      {
        id: 'nod1', episode: 1, title: '甲藏起半袋粮', actors: ['cas1'], goal: '保住口粮', motive: '怕被抢',
        action: '把粮袋藏在柴堆后面', result: '营地里少了一袋粮', preconditions: ['营地按人头分饭'],
        beats: ['哨声响起', '柴堆被翻开'], dialogue: [{ characterId: 'cas1', line: '别吭声。', tone: '压低' }],
        stateChanges: ['甲手里有私粮'], order: 1,
      },
      {
        id: 'nod2', episode: 2, title: '乙搜出私粮', actors: ['cas2'], goal: '立威', motive: '想拿住把柄',
        action: '当众翻开柴堆', result: '甲被指认偷粮', preconditions: ['营地里少了一袋粮'],
        beats: ['甲后退', '乙举起粮袋'], dialogue: [{ characterId: 'cas2', line: '谁藏的都一样。', tone: '平静' }],
        stateChanges: ['甲失去口粮'], order: 1,
      },
      {
        id: 'nod3', episode: 3, title: '乙当众接管', actors: ['cas2'], goal: '接管分配权', motive: '要一个公开的由头',
        action: '宣布改由自己分饭', result: '乙拿到分配权', preconditions: ['甲被指认偷粮'],
        beats: ['账本被收走'], dialogue: [{ characterId: 'cas2', line: '从今天起按我记的算。', tone: '平稳' }],
        stateChanges: ['分配权转移'], order: 1,
      },
    ],
    edges: [
      { id: 'edg1', from: 'nod1', to: 'nod2', type: 'cause' },
      { id: 'edg2', from: 'nod2', to: 'nod3', type: 'cause' },
    ],
    debts: [{ id: 'dbt1', question: '甲藏粮是为了谁', planted: ['nod1'], payoff: ['nod3'], status: 'open' }],
  });
  // 把第3集事件挂到固定结果上。
  const last = project.nodes.find(node => node.id === 'nod3');
  last.outcomeId = 'out1';
  const outcome = project.outcomes.find(item => item.id === 'out1');
  outcome.nodeId = 'nod3';
  return project;
}

test('forge: 规范化会修正非法枚举、越界集数并丢掉指向不存在对象的引用', () => {
  const project = normalizeProject({
    title: '  带空格的标题  ',
    episodeCount: 999,
    aspectRatio: '4:3',
    outcomes: [{ id: 'out1', episode: 500, title: '终点', lock: '乱写', nodeId: 'ghost' }],
    nodes: [{ id: 'nod1', episode: 0, title: '事件', actors: ['ghost'], locationId: 'ghost', debtIds: ['ghost'], outcomeId: 'ghost' }],
    edges: [{ id: 'edg1', from: 'nod1', to: 'ghost', type: '???' }, { id: 'edg2', from: 'nod1', to: 'nod1', type: 'cause' }],
    cast: [{ id: 'cas1', name: '甲' }],
    debts: [{ id: 'dbt1', question: '问题', planted: ['ghost'] }],
  });
  assert.equal(project.title, '带空格的标题');
  assert.ok(project.episodeCount <= 120 && project.episodeCount >= 1);
  assert.equal(project.outcomes[0].lock, 'soft');
  // 越界集数会夹到合法范围，指向不存在事件的 nodeId 不会保留（同集有事件时会自动挂上去）。
  assert.ok(project.outcomes[0].episode <= project.episodeCount);
  assert.notEqual(project.outcomes[0].nodeId, 'ghost');
  assert.deepEqual(project.nodes[0].actors, []);
  assert.equal(project.nodes[0].locationId, '');
  // 非法 outcomeId 不会保留（同集有事件时会被自动挂上去）。
  assert.notEqual(project.nodes[0].outcomeId, 'ghost');
  assert.ok(project.nodes[0].episode >= 1);
  // 悬空边和自环都要被清掉。
  assert.equal(project.edges.length, 0);
  assert.deepEqual(project.debts[0].planted, []);
});

test('forge: 指纹只随实质内容变化', () => {
  const project = fixture();
  const before = fingerprint(project);
  assert.equal(fingerprint(structuredClone(project)), before);
  project.nodes[0].title = '甲藏起整袋粮';
  assert.notEqual(fingerprint(project), before);
  const withScript = structuredClone(fixture());
  withScript.script = { fingerprint: before, scenes: [], model: 'test' };
  assert.equal(fingerprint(withScript), before);
});

test('forge: 校验能发现债务顺序、孤立事件与缺目标', () => {
  const project = fixture();
  project.debts[0].planted = ['nod3'];
  project.debts[0].payoff = ['nod1'];
  const report = analyze(project);
  const codes = report.issues.map(issue => issue.code);
  assert.ok(codes.includes('DEBT_ORDER'));
  assert.ok(report.issues.some(issue => issue.code === 'DEBT_ORDER' && issue.level === 'error'));
  assert.equal(report.stats.errors, report.issues.filter(issue => issue.level === 'error').length);
  assert.equal(report.stats.coverage, 50); // 6 集里有 3 集有事件
  assert.equal(report.episodePlan.length, project.episodeCount);

  // 完全没有连线时只报「孤立事件」；PRECONDITION_NO_EDGE 是「上游存在但没有入边」才报，两者不重复。
  const lonely = fixture();
  lonely.edges = [];
  lonely.nodes[0].outcomeId = '';
  lonely.nodes[0].preconditions = ['营地按人头分饭'];
  const lonelyCodes = analyze(lonely).issues.map(issue => issue.code);
  assert.ok(lonelyCodes.includes('NODE_UNLINKED'));
  assert.ok(!lonelyCodes.includes('PRECONDITION_NO_EDGE'));
});

test('forge: 删除上游事件的影响分析会指出波及范围与失效前提', () => {
  const project = fixture();
  const impact = analyzeImpact(project, 'nod1', null);
  assert.equal(impact.deleted, true);
  assert.ok(impact.affected.length >= 2);
  assert.ok(impact.affected.some(item => item.title.includes('乙搜出私粮')));
  assert.ok(impact.missing.some(item => item.items.some(line => line.includes('少了一袋粮'))));
  assert.ok(impact.debts.some(item => item.question.includes('甲藏粮')));
  assert.ok(Array.isArray(impact.suggestions) && impact.suggestions.length > 0);

  // 改动而不是删除：next 是「改动后的字段」，只改标题时不应报前提失效。
  const edit = analyzeImpact(project, 'nod2', { title: '乙当众搜粮', result: '甲被指认偷粮' });
  assert.equal(edit.deleted, false);
  assert.deepEqual(edit.missing, []);
  assert.ok(edit.suggestions.some(line => line.includes('可以保留本次修改')));
  // 改了直接结果，下游的前提就该失效。
  const broken = analyzeImpact(project, 'nod2', { result: '没有人被指认' });
  assert.ok(broken.missing.some(item => item.nodeId === 'nod3'));
});

test('forge: 导出的是工作台能导入的 Markdown', () => {
  const project = fixture();
  const { markdown, scenes, stats } = buildExport(project, { from: 1, to: 3 });
  for (const heading of ['## 一、项目元数据', '## 二、风格总设定', '## 三、角色设定库', '## 四、场景设定库', '## 五、完整分镜提示词']) {
    assert.ok(markdown.includes(heading), `缺少段：${heading}`);
  }
  assert.equal(scenes.length, 3);
  assert.equal(stats.episodes, 3);
  assert.ok(markdown.includes('### 角色1：甲'));
  assert.ok(markdown.includes('#### 镜头 001-A'));
  assert.ok(markdown.includes('别吭声'));

  const parsed = parseMarkdown(markdown, 'forge-export.md');
  assert.equal(parsed.storyScenes.length, 3);
  assert.equal(parsed.shots.length, stats.shots);
  assert.equal(parsed.assets.filter(asset => asset.type === 'character').length, 2);
  assert.equal(parsed.assets.filter(asset => asset.type === 'location').length, 1);

  // 范围导出只包含范围内的集。
  const clipped = buildExport(project, { from: 2, to: 2 });
  assert.equal(clipped.scenes.length, 1);
  assert.ok(!clipped.markdown.includes('甲藏起半袋粮'));

  // 没有模型分镜稿时用确定性模板，两次导出必须一致（除时间戳行）。
  const again = buildExport(project, { from: 1, to: 3 }).markdown;
  assert.equal(stripStamp(markdown), stripStamp(again));
});

function stripStamp(markdown) {
  return markdown.split('\n').filter(line => !line.startsWith('> 版本：')).join('\n');
}

test('forge: 模型分镜稿在指纹一致时优先使用', () => {
  const project = fixture();
  const baseline = scriptScenes(project, { from: 1, to: 3 });
  assert.equal(baseline.length, 3);
  project.script = {
    model: 'test-model',
    fingerprint: fingerprint(project),
    scenes: baseline.map((scene, index) => ({
      episode: scene.episode,
      title: scene.title,
      shots: scene.shots.map(shot => ({ ...shot, action: [`模型改写 ${index + 1}`] })),
    })),
  };
  const rewritten = buildExport(project, { from: 1, to: 3 });
  assert.equal(rewritten.usedScript, true);
  assert.ok(rewritten.markdown.includes('模型改写 1'));
  // 图改了以后模型稿失效，退回模板。
  project.nodes[0].title = '甲藏起整袋粮';
  const stale = buildExport(project, { from: 1, to: 3 });
  assert.equal(stale.usedScript, false);
  assert.ok(!stale.markdown.includes('模型改写 1'));
});

test('forge: 本地方案在未配置模型时也能给出三条可选链', () => {
  const project = fixture();
  const outcome = { id: 'out1', episode: 3, title: '乙当众接管', lock: 'hard' };
  const plans = localPlans(project, outcome);
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    assert.ok(plan.name);
    assert.ok(Array.isArray(plan.events) && plan.events.length >= 3);
    assert.ok(plan.events.every(event => event.episode >= 1 && event.episode <= project.episodeCount));
    assert.ok(plan.events.every(event => event.title && event.result));
  }
});

test('forge: 示例工程可直接校验并导出，且没有错误级问题', () => {
  const seeded = createProject(JSON.parse(readFileSync(examplePath, 'utf8')));
  const report = analyze(seeded);
  assert.equal(report.stats.errors, 0, report.issues.filter(issue => issue.level === 'error').map(issue => issue.title).join(' / '));
  assert.ok(report.stats.nodes >= 18);
  assert.ok(report.stats.hardOutcomes >= 3);
  assert.ok(report.stats.debts >= 3);
  const exported = buildExport(seeded, { from: 1, to: seeded.episodeCount });
  const parsed = parseMarkdown(exported.markdown, 'example.md');
  assert.ok(parsed.storyScenes.length >= 15);
  assert.ok(parsed.shots.length >= 80);
  assert.ok(exported.stats.duration > 0);
  // 每集时长都落在计划剪辑时长附近，避免出现 0 秒场次。
  for (const scene of exported.scenes) {
    const total = scene.shots.reduce((sum, shot) => sum + shot.duration, 0);
    assert.ok(total > 0, `${scene.title} 时长为 0`);
  }
  assert.equal(nodeDuration(seeded.nodes[0]) >= 8, true);
});

test('forge: 从分镜作品带入只取角色与地点', () => {
  const studioProject = {
    id: 'studio_1',
    title: '分镜作品',
    aspectRatio: '9:16',
    style: '冷色调',
    assets: [
      { id: 'a1', type: 'character', name: '甲', data: { description: '短发', visualPrompt: '短发少女' } },
      { id: 'a2', type: 'location', name: '营地', code: 'A', data: { description: '木栅栏', visualPrompt: '木栅栏营地' } },
    ],
    shots: [{ id: 's1', type: 'shot', data: { title: '镜头' } }],
  };
  const seeded = seedFromStudio(studioProject, { title: '带入测试' });
  const project = createProject(seeded);
  assert.equal(project.cast.length, 1);
  assert.equal(project.cast[0].name, '甲');
  assert.equal(project.locations.length, 1);
  assert.equal(project.nodes.length, 0);
  assert.equal(project.title, '带入测试');
});
