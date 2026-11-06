import express from 'express';
import { analyze, analyzeImpact, buildExport, localPlans, normalizeProject, seedFromStudio } from './forge.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const checkedId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw fail('无效对象 ID');
  return value;
};
const safeFilename = value => String(value || '因果剧本').replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

// 因果剧本的 HTTP 面：所有写入都经过 normalizeProject，AI 结果只返回建议，不落库。
export function createForgeApi({ forgeStore, studioStore, llm }) {
  const router = express.Router();

  const withAnalysis = project => ({ project, analysis: project ? analyze(project) : null });
  const currentLlm = () => {
    try { return llm.publicState(); }
    catch (error) { return { providers: [], settings: null, configured: false, error: error.message }; }
  };

  router.get('/state', (req, res) => {
    const state = forgeStore.state(req.query.projectId || undefined);
    res.json({ ...state, ...withAnalysis(state.project), llm: currentLlm() });
  });

  router.post('/projects', (req, res) => {
    if (req.body?.fromProjectId) {
      const studioProject = studioStore.getProject(checkedId(req.body.fromProjectId));
      const seeded = seedFromStudio(studioProject, { title: req.body.title });
      res.status(201).json(withAnalysis(forgeStore.create(seeded)));
      return;
    }
    res.status(201).json(withAnalysis(forgeStore.create(req.body || {})));
  });

  router.patch('/projects/:id', (req, res) => {
    const project = forgeStore.update(checkedId(req.params.id), req.body || {});
    res.json(withAnalysis(project));
  });

  router.post('/projects/:id/select', (req, res) => {
    const project = forgeStore.select(checkedId(req.params.id));
    res.json(withAnalysis(project));
  });

  router.delete('/projects/:id', (req, res) => res.json(forgeStore.delete(checkedId(req.params.id))));

  // 未保存也能校验：传整份 project 时只做规范化与分析，不写库。
  router.post('/projects/:id/analyze', (req, res) => {
    const stored = forgeStore.project(checkedId(req.params.id));
    const project = req.body?.project ? normalizeProject({ ...stored, ...req.body.project, id: stored.id }, { id: stored.id }) : stored;
    res.json({ project, analysis: analyze(project) });
  });

  router.post('/projects/:id/impact', (req, res) => {
    const project = forgeStore.project(checkedId(req.params.id));
    const nodeId = checkedId(req.body?.nodeId || '');
    const deleting = req.body?.delete === true || !req.body?.next;
    let next = null;
    if (!deleting) {
      // 先规范化再合并，避免界面传回非法集数/未知人物把分析带偏。
      const merged = normalizeProject({ ...project, nodes: project.nodes.map(node => (node.id === nodeId ? { ...node, ...req.body.next } : node)) }, { id: project.id });
      next = merged.nodes.find(node => node.id === nodeId) || null;
      if (!next) throw fail('事件不存在。', 404);
    }
    res.json({ impact: analyzeImpact(project, nodeId, next) });
  });

  router.get('/projects/:id/export', (req, res) => {
    const project = forgeStore.project(checkedId(req.params.id));
    const built = buildExport(project, {
      from: Number(req.query.from) || 1,
      to: Number(req.query.to) || project.episodeCount,
    });
    if (req.query.download) {
      const name = `${safeFilename(project.title)}-因果剧本-第${built.range.from}-${built.range.to}集.md`;
      res.set({
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      res.send(built.markdown);
      return;
    }
    res.json({ markdown: built.markdown, stats: built.stats, usedScript: built.usedScript, range: built.range });
  });

  // 发布 = 用同一条导入链路把剧本变成分镜作品；不覆盖现有同名作品。
  router.post('/projects/:id/publish', (req, res) => {
    const project = forgeStore.project(checkedId(req.params.id));
    const built = buildExport(project, {
      from: Number(req.body?.from) || 1,
      to: Number(req.body?.to) || project.episodeCount,
    });
    if (!built.stats.shots) throw fail('当前范围没有任何事件，导出为空；请先给剧集添加事件。', 409);
    const filename = `${safeFilename(project.title)}-StoryForge-第${built.range.from}-${built.range.to}集.md`;
    const imported = studioStore.importMarkdown(built.markdown, filename, { asNewProject: req.body?.asNewProject !== false });
    res.status(201).json({
      project: { id: imported.id, title: imported.title, shots: imported.shots.length, scenes: imported.storyScenes.length, duration: imported.summaryDuration, issues: imported.issues.length },
      filename,
      stats: built.stats,
    });
  });

  router.get('/projects/:id/local-plan', (req, res) => {
    const project = forgeStore.project(checkedId(req.params.id));
    const outcome = project.outcomes.find(item => item.id === req.query.outcomeId) || project.outcomes.find(item => item.lock === 'hard') || project.outcomes[0];
    if (!outcome) throw fail('先建立一个固定结果，才能生成方案。', 409);
    res.json({ outcome, plans: localPlans(project, outcome), source: 'template' });
  });

  router.post('/projects/:id/llm', async (req, res) => {
    const project = forgeStore.project(checkedId(req.params.id));
    const task = req.body?.task;
    const result = await llm.runTask(task, project, req.body?.payload || {});
    res.json(result);
  });

  router.get('/llm', (req, res) => res.json(currentLlm()));
  router.put('/llm', (req, res) => res.json(llm.save(req.body || {})));
  router.post('/llm/test', async (req, res) => res.json(await llm.test()));
  router.get('/llm/models', async (req, res) => res.json(await llm.listModels()));

  return router;
}
