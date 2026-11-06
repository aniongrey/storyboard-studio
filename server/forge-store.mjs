import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProject, normalizeProject } from './forge.mjs';

const now = () => new Date().toISOString();
const copy = value => (value === undefined ? undefined : structuredClone(value));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// 因果项目的存储与分镜作品分开：同一台工作台、同一个 sqlite 文件，但只碰自己的表。
// 这样剧本科目的整份文档可以整体读写，不会把已有作品的那一行 JSON 撑大。
export class ForgeStore {
  constructor({ dataDir }) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, 'studio.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS forge_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    const row = this.db.prepare('SELECT value FROM forge_state WHERE id=1').get();
    this.document = row ? JSON.parse(row.value) : { activeProjectId: null, projects: [] };
    if (!row) this.write();
  }

  read() {
    const row = this.db.prepare('SELECT value FROM forge_state WHERE id=1').get();
    if (row) this.document = JSON.parse(row.value);
    return this.document;
  }

  write() {
    this.db.prepare('INSERT INTO forge_state (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(this.document));
  }

  change(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.read();
      const result = operation();
      this.write();
      this.db.exec('COMMIT');
      return copy(result);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  project(projectId) {
    this.read();
    const id = projectId || this.document.activeProjectId;
    const project = this.document.projects.find(item => item.id === id);
    if (!project) fail('因果剧本项目不存在。', 404);
    return project;
  }

  list() {
    this.read();
    return this.document.projects.map(project => ({
      id: project.id,
      title: project.title,
      episodeCount: project.episodeCount,
      updatedAt: project.updatedAt,
      nodes: project.nodes.length,
      outcomes: project.outcomes.length,
    })).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  state(projectId) {
    this.read();
    const active = projectId || this.document.activeProjectId || this.document.projects[0]?.id;
    return {
      projects: this.list(),
      project: active ? copy(this.project(active)) : null,
    };
  }

  create(input = {}) {
    return this.change(() => {
      const project = createProject(input);
      project.createdAt = now();
      project.updatedAt = project.createdAt;
      this.document.projects.push(project);
      this.document.activeProjectId = project.id;
      return project;
    });
  }

  update(projectId, patch = {}) {
    return this.change(() => {
      const current = this.project(projectId);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('剧本修改必须是对象。');
      const merged = normalizeProject({ ...current, ...patch, id: current.id, createdAt: current.createdAt }, { id: current.id });
      merged.updatedAt = now();
      const index = this.document.projects.findIndex(item => item.id === current.id);
      this.document.projects[index] = merged;
      return merged;
    });
  }

  select(projectId) {
    return this.change(() => {
      this.project(projectId);
      this.document.activeProjectId = projectId;
      return this.project(projectId);
    });
  }

  delete(projectId) {
    return this.change(() => {
      const project = this.project(projectId);
      this.document.projects = this.document.projects.filter(item => item.id !== project.id);
      if (this.document.activeProjectId === project.id) this.document.activeProjectId = this.document.projects[0]?.id || null;
      return { deleted: project.id };
    });
  }

  // 首次启动时放一份可运行的示例：不是教学占位，是第 1–20 集的真实因果链。
  seed(seedPath) {
    if (this.document.projects.length || !existsSync(seedPath)) return null;
    const payload = JSON.parse(readFileSync(seedPath, 'utf8'));
    return this.change(() => {
      const project = createProject(payload);
      project.createdAt = now();
      project.updatedAt = project.createdAt;
      this.document.projects.push(project);
      this.document.activeProjectId = project.id;
      return project;
    });
  }

  close() { this.db.close(); }
}
