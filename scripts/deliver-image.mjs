import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs, constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { StudioStore } from '../server/store.mjs';
import { validateMedia } from '../server/media.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const jobId = option('--job'), image = option('--image');
if (!jobId || !image) {
  console.error('用法: node scripts/deliver-image.mjs --job <jobId> --image <生成的图片路径>');
  process.exitCode = 1;
} else {
  const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || path.join(appRoot, 'data'));
  const store = new StudioStore({ dataDir });
  try {
    const job = store.getJob(jobId);
    if (job.kind !== 'image' || job.status === 'ready') throw new Error('该任务不是等待交付的图片任务');
    const directory = path.resolve(dataDir, 'projects', job.projectId, 'staging', job.id);
    if (directory !== path.resolve(job.deliveryDirectory)) throw new Error('任务目录与当前工作区不一致');
    const request = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8'));
    if (request.jobId !== job.id || request.prompt !== job.snapshot.prompt) throw new Error('任务文件与冻结快照不一致');
    const info = await validateMedia(path.resolve(image), 'image');
    const filename = `image${info.extension}`;
    const target = path.join(directory, filename);
    try { await fs.copyFile(path.resolve(image), target, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST' || createHash('sha256').update(await fs.readFile(target)).digest('hex') !== info.sha256) throw error;
    }
    const manifest = { schemaVersion: 1, jobId: job.id, projectId: job.projectId, entityId: job.entityId,
      baseVersion: job.snapshot.baseVersion, prompt: job.snapshot.prompt,
      files: [{ path: filename, kind: 'image', sha256: info.sha256 }] };
    const temporary = path.join(directory, `result.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await fs.rename(temporary, path.join(directory, 'result.json'));
    console.log(JSON.stringify({ jobId: job.id, file: target, sha256: info.sha256, next: '点击工作台“刷新资产”登记候选图片' }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { store.close(); }
}
