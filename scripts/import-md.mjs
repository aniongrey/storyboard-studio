import { readFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioStore } from '../server/store.mjs';

const args = process.argv.slice(2);
let source;
let dataDir;
let appendTo;
let episodeNumber;
let asNewProject = false;
let invalid = false;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--data-dir') {
    dataDir = args[++index];
    if (!dataDir || dataDir.startsWith('--')) invalid = true;
  } else if (argument === '--append-to') {
    appendTo = args[++index];
    if (!appendTo || appendTo.startsWith('--')) invalid = true;
  } else if (argument === '--episode') {
    episodeNumber = Number(args[++index]);
    if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) invalid = true;
  } else if (argument === '--as-new-project') asNewProject = true;
  else if (argument.startsWith('--') || source) invalid = true;
  else source = argument;
}
if (!source || invalid || (appendTo && asNewProject) || (episodeNumber !== undefined && !appendTo)) {
  console.error('用法: node scripts/import-md.mjs <分镜.md> [--data-dir <目录>] [--as-new-project | --append-to <projectId> [--episode <集数>]]');
  process.exitCode = 1;
} else {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let store;
  try {
    store = new StudioStore({ dataDir: dataDir ? resolve(dataDir) : resolve(appRoot, 'data') });
    const markdown = readFileSync(resolve(source), 'utf8');
    const project = appendTo ? store.appendMarkdown(appendTo, markdown, basename(source), { episodeNumber }) : store.importMarkdown(markdown, basename(source), { asNewProject });
    console.log(JSON.stringify({ id: project.id, title: project.title, characters: project.assets.filter(a => a.type === 'character').length, locations: project.assets.filter(a => a.type === 'location').length, props: project.assets.filter(a => a.type === 'prop').length, scenes: project.storyScenes.length, shots: project.shots.length, duration: project.summaryDuration, issues: project.issues.length, agentInstructions: project.agentInstructions || { file: 'AGENTS.md', text: readFileSync(resolve(appRoot, 'AGENTS.md'), 'utf8') } }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, status: error.status || 500, code: error.code, comparison: error.comparison }, null, 2));
    process.exitCode = 1;
  } finally { store?.close(); }
}
