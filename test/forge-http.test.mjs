import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server/main.mjs';

test('forge HTTP: CSRF、建项目、改事件、校验、导出、发布与未配置模型', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'studio-forge-'));
  const dataDir = path.join(temp, 'data');
  const studio = createStudio({
    dataDir,
    generationOptions: { codexPath: path.join(temp, 'missing-codex.exe'), getRunningHubKey: () => '' },
    llmOptions: { env: {} },
  });
  const server = studio.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': state.csrfToken };

    // 首启带一份示例工程
    const forge = await (await fetch(`${base}/api/forge/state`)).json();
    assert.equal(forge.projects.length, 1);
    assert.ok(forge.project.nodes.length >= 18);
    assert.ok(forge.analysis.stats.nodes >= 18);
    assert.equal(forge.analysis.stats.errors, 0);
    // 默认是本地 ollama（不需要 Key），所以 configured 为真，但服务商列表要完整。
    assert.ok(forge.llm.providers.length >= 5);
    assert.ok(forge.llm.settings.model);

    // 写请求必须带 token 与同源
    assert.equal((await fetch(`${base}/api/forge/projects`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await fetch(`${base}/api/forge/projects`, { method: 'POST', body: '{}', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);

    // 新建项目
    const created = await (await fetch(`${base}/api/forge/projects`, {
      method: 'POST', headers, body: JSON.stringify({ title: '接口测试剧本', episodeCount: 4 }),
    })).json();
    const projectId = created.project.id;
    assert.match(projectId, /^forge_/);
    assert.equal(created.project.nodes.length, 0);
    // 非法 ID 被拒
    assert.equal((await fetch(`${base}/api/forge/projects/bad id!/select`, { method: 'POST', headers, body: '{}' })).status, 400);

    // 加人物、固定结果与两个事件，让因果链接起来
    const patched = await (await fetch(`${base}/api/forge/projects/${projectId}`, {
      method: 'PATCH', headers, body: JSON.stringify({
        logline: '一句定位',
        cast: [{ name: '甲', desire: '活下去' }],
        outcomes: [{ episode: 4, title: '甲接管分配', lock: 'hard' }],
        nodes: [
          { id: 'nod1', episode: 1, title: '甲藏粮', result: '少了一袋粮', preconditions: ['按人头分饭'], beats: ['哨声'], order: 1 },
          { id: 'nod2', episode: 2, title: '甲被指认', result: '甲被当众指认', preconditions: ['少了一袋粮'], beats: ['收紧'], order: 1 },
        ],
        edges: [{ id: 'edg1', from: 'nod1', to: 'nod2', type: 'cause' }],
      }),
    })).json();
    assert.equal(patched.project.nodes.length, 2);
    assert.equal(patched.project.edges.length, 1);
    assert.equal(patched.project.cast.length, 1);
    assert.ok(patched.analysis.stats.nodes === 2);

    // 校验接口
    const analyzed = await (await fetch(`${base}/api/forge/projects/${projectId}/analyze`, { method: 'POST', headers, body: '{}' })).json();
    assert.ok(Array.isArray(analyzed.analysis.issues));
    assert.equal(analyzed.analysis.stats.nodes, 2);

    // 影响分析：删除第一个事件
    const impact = await (await fetch(`${base}/api/forge/projects/${projectId}/impact`, {
      method: 'POST', headers, body: JSON.stringify({ nodeId: 'nod1', delete: true }),
    })).json();
    assert.equal(impact.impact.deleted, true);
    assert.ok(impact.impact.affected.some(item => item.id === 'nod2'));
    // 未知事件返回 404
    assert.equal((await fetch(`${base}/api/forge/projects/${projectId}/impact`, { method: 'POST', headers, body: JSON.stringify({ nodeId: 'nope', delete: true }) })).status, 404);

    // 导出：Markdown + 文件下载
    const exported = await (await fetch(`${base}/api/forge/projects/${projectId}/export?from=1&to=4`)).json();
    assert.ok(exported.markdown.includes('## 五、完整分镜提示词'));
    assert.equal(exported.stats.episodes, 2);
    const download = await fetch(`${base}/api/forge/projects/${projectId}/export?download=1`);
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
    assert.ok((await download.text()).includes('分镜提示词'));

    // 本地方案：没配模型时也能出草案
    const plan = await (await fetch(`${base}/api/forge/projects/${projectId}/local-plan?outcomeId=${encodeURIComponent(patched.project.outcomes[0].id)}`)).json();
    assert.ok(Array.isArray(plan.plans) && plan.plans.length > 0);

    // 发布成分镜作品，并能在 /api/state 里看到
    const published = await (await fetch(`${base}/api/forge/projects/${projectId}/publish`, { method: 'POST', headers, body: JSON.stringify({ from: 1, to: 4 }) })).json();
    assert.ok(published.project.id);
    assert.ok(published.project.shots >= 2);
    const studioState = await (await fetch(`${base}/api/state?projectId=${published.project.id}`)).json();
    assert.equal(studioState.project.id, published.project.id);
    assert.ok(studioState.project.shots.length >= 2);
    assert.ok(studioState.project.assets.some(asset => asset.name === '甲'));

    // 换成必须填 Key 的服务商但不保存 Key：设置能存下，AI 任务必须先拦住。
    const savedSettings = await (await fetch(`${base}/api/forge/llm`, {
      method: 'PUT', headers, body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }),
    })).json();
    assert.equal(savedSettings.settings.provider, 'deepseek');
    assert.equal(savedSettings.settings.model, 'deepseek-chat');
    assert.equal(savedSettings.configured, false);
    assert.equal(JSON.stringify(savedSettings).includes('sk-'), false);

    const aiResponse = await fetch(`${base}/api/forge/projects/${projectId}/llm`, {
      method: 'POST', headers, body: JSON.stringify({ task: 'result-planner', payload: {} }),
    });
    assert.equal(aiResponse.status, 409);
    const aiError = await aiResponse.json();
    assert.equal(aiError.code, 'LLM_KEY_MISSING');
    assert.match(aiError.error, /API Key/);

    // 非法服务商/地址在保存时就被拒
    assert.equal((await fetch(`${base}/api/forge/llm`, { method: 'PUT', headers, body: JSON.stringify({ provider: '不存在' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/forge/llm`, { method: 'PUT', headers, body: JSON.stringify({ provider: 'custom', baseUrl: 'ftp://x', model: 'm' }) })).status, 400);

    // 删除项目
    assert.equal((await fetch(`${base}/api/forge/projects/${projectId}`, { method: 'DELETE', headers })).status, 200);
    const after = await (await fetch(`${base}/api/forge/state`)).json();
    assert.equal(after.projects.some(item => item.id === projectId), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    studio.close();
    await rm(temp, { recursive: true, force: true });
  }
});
