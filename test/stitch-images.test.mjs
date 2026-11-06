import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stitchImages } from '../scripts/stitch-images.mjs';

const run = promisify(execFile);

test('four images keep their order; short grids leave white cells and never overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-image-grid-'));
  try {
    const files = [];
    for (const color of ['red', 'lime', 'blue', 'yellow']) {
      const file = join(directory, `${color}.png`);
      await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=32x18`, '-frames:v', '1', file], { windowsHide: true });
      files.push(file);
    }
    const sample = async (file, x, y) => {
      const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', windowsHide: true });
      return [...stdout];
    };
    const output = await stitchImages(files, join(directory, 'four.png'));
    const expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    for (let index = 0; index < 4; index++) {
      const pixel = await sample(output, 640 + index % 2 * 1280, 360 + Math.floor(index / 2) * 720);
      assert.ok(pixel.every((channel, position) => Math.abs(channel - expected[index][position]) < 5));
    }
    const before = await readFile(output);
    await assert.rejects(stitchImages(files, output));
    assert.deepEqual(await readFile(output), before);
    const short = await stitchImages(files.slice(0, 3), join(directory, 'three.png'));
    assert.deepEqual(await sample(short, 1920, 1080), [255, 255, 255]);
    await assert.rejects(stitchImages([], join(directory, 'empty.png')), /1至4/);
    await assert.rejects(stitchImages([...files, files[0]], join(directory, 'five.png')), /1至4/);
    await assert.rejects(stitchImages(files, files[0]));
    await assert.rejects(stitchImages(files, join(directory, 'bad.jpg')), /PNG/);
    const video = join(directory, 'not-an-image.png');
    await writeFile(video, Buffer.from('0000ftyp000000000000000000000000'));
    await assert.rejects(stitchImages([video], join(directory, 'invalid.png')), /只能是图片/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
