import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForgeStore } from '../server/forge-store.mjs';
import { buildExport, createProject } from '../server/forge.mjs';

// 把因果剧本工程导出成工作台能直接导入的 Markdown（或直接写进工作台）。
// 用法：
//   node scripts/export-forge.mjs                        # 导出当前工程的全部集数到 outputs/
//   node scripts/export-forge.mjs --project forge_xxx --from 1 --to 12 --out outputs/x.md
//   node scripts/export-forge.mjs --file examples/storyforge-龙娘部落.json   # 不读数据库，直接读 JSON
//   node scripts/export-forge.mjs --publish              # 直接导入成工作台里的分镜作品
const args = process.argv.slice(2);
let projectId;
let dataDir;
let sourceFile;
let out;
let from = 1;
let to = 0;
let publish = false;
let invalid = '';

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  const value = () => args[++index];
  if (argument === '--project') projectId = value();
  else if (argument === '--data-dir') dataDir = value();
  else if (argument === '--file') sourceFile = value();
  else if (argument === '--out') out = value();
  else if (argument === '--from') from = number(value(), 1);
  else if (argument === '--to') to = number(value(), 0);
  else if (argument === '--publish') publish = true;
  else invalid = argument;
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (invalid) {
  console.error(`未知参数: ${invalid}`);
  console.error('用法: node scripts/export-forge.mjs [--project <id>] [--file <json>] [--from 1] [--to 30] [--out <file.md>] [--publish] [--data-dir <目录>]');
  process.exitCode = 1;
} else {
  let forge;
  let studio;
  try {
    let project;
    if (sourceFile) {
      project = createProject(JSON.parse(readFileSync(resolve(sourceFile), 'utf8')));
    } else {
      forge = new ForgeStore({ dataDir: dataDir ? resolve(dataDir) : join(appRoot, 'data') });
      const state = forge.state(projectId || undefined);
      if (!state.project) throw Object.assign(new Error('还没有因果剧本工程。'), { status: 404 });
      project = state.project;
    }

    const built = buildExport(project, { from, to: to || project.episodeCount });
    const safeTitle = project.title.replace(/[\\/:*?"<>|]/g, ' ').trim();
    const target = resolve(out || join(appRoot, 'outputs', `${safeTitle}_因果稿.md`));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, built.markdown, 'utf8');

    const result = {
      file: target,
      title: project.title,
      range: `${built.range.from}-${built.range.to}`,
      episodes: built.stats.episodes,
      shots: built.stats.shots,
      duration: built.stats.duration,
      cast: built.stats.cast,
      locations: built.stats.locations,
      usedScript: built.usedScript,
    };

    if (publish) {
      const { StudioStore } = await import('../server/store.mjs');
      studio = new StudioStore({ dataDir: dataDir ? resolve(dataDir) : join(appRoot, 'data') });
      const imported = studio.importMarkdown(built.markdown, `${safeTitle}.md`, { asNewProject: true });
      result.published = { id: imported.id, title: imported.title, scenes: imported.storyScenes.length, shots: imported.shots.length, issues: imported.issues.length };
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, status: error.status || 500 }, null, 2));
    process.exitCode = 1;
  } finally {
    forge?.close();
    studio?.close();
  }
}
