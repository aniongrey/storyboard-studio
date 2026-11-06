import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sniffMedia } from '../server/media.mjs';

const run = promisify(execFile);

// 按填写顺序排成四格，完整保留画面，不足四张的格子留白。
export async function stitchImages(images, outputFile) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 4 || images.some(file => typeof file !== 'string' || !file)) throw new Error('请选择1至4张图片。');
  if (typeof outputFile !== 'string' || !/\.png$/i.test(outputFile)) throw new Error('拼图输出必须是新的 PNG 文件。');
  const files = await Promise.all(images.map(file => realpath(file)));
  for (const file of files) {
    const handle = await open(file, 'r');
    try {
      const header = Buffer.alloc(32);
      const { bytesRead } = await handle.read(header);
      if (sniffMedia(header.subarray(0, bytesRead)).kind !== 'image') throw new Error('拼图输入只能是图片。');
    } finally { await handle.close(); }
  }
  const output = resolve(outputFile);
  if (files.some(file => file.toLowerCase() === output.toLowerCase())) throw new Error('不能覆盖输入图片。');
  const args = ['-hide_banner', '-loglevel', 'error', '-n'];
  for (const file of files) args.push('-i', file);
  for (let index = files.length; index < 4; index++) args.push('-f', 'lavfi', '-i', 'color=white:s=1280x720');
  const filters = Array.from({ length: 4 }, (_, index) => `[${index}:v]scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,format=rgb24[t${index}]`);
  filters.push('[t0][t1][t2][t3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]');
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp.png`;
  try {
    await run('ffmpeg', [...args, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-update', '1', temporary], { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
    await copyFile(temporary, output, constants.COPYFILE_EXCL);
  } finally { await unlink(temporary).catch(() => {}); }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, ...images] = process.argv.slice(2);
  try { console.log(await stitchImages(images, output)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
