import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioStore } from '../server/store.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new StudioStore({ dataDir: process.env.STUDIO_DATA_DIR || path.join(appRoot, 'data') });
try {
  const jobs = store.state().projects.flatMap(project => store.state(project.id).jobs)
    .filter(job => job.kind === 'image' && job.status !== 'ready');
  console.log(JSON.stringify(jobs.map(job => ({ id: job.id, projectId: job.projectId, entityId: job.entityId,
    status: job.status, deliveryDirectory: job.deliveryDirectory, prompt: job.snapshot.prompt,
    references: job.snapshot.references, instruction: job.instruction })), null, 2));
} finally { store.close(); }
