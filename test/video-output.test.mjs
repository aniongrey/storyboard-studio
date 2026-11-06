import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { VIDEO_ASPECT_RATIOS, VIDEO_OUTPUT_RESOLUTIONS, planVideoOutput, predictVideoSize, validateNativeVideoOutput, resizeVideoOutput } from '../server/video-output.mjs';

const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('native targets derive standard dimensions and reject targets beyond the documented pixel budget', () => {
  const expected480 = [[480, 480], [480, 720], [720, 480], [480, 640], [640, 480], [480, 854], [854, 480], [1120, 480]];
  for (let index = 0; index < VIDEO_ASPECT_RATIOS.length; index++) {
    const aspect = VIDEO_ASPECT_RATIOS[index];
    assert.deepEqual([planVideoOutput('480p', aspect).width, planVideoOutput('480p', aspect).height], expected480[index]);
    for (const resolution of VIDEO_OUTPUT_RESOLUTIONS.slice(1)) {
      if (aspect === '21:9 (Ultrawide)' && resolution === '1080p') {
        assert.throws(() => planVideoOutput(resolution, aspect));
        continue;
      }
      const plan = planVideoOutput(resolution, aspect);
      assert.equal(plan.mode, 'native_target');
      assert.equal(Math.min(plan.width, plan.height), Number.parseInt(resolution, 10));
      assert.equal(plan.width % 2, 0); assert.equal(plan.height % 2, 0);
      assert.ok(plan.expectedWidth >= plan.width && plan.expectedHeight >= plan.height);
      assert.ok(Number(plan.pixels) >= 0.2 && Number(plan.pixels) <= 2);
    }
  }
  assert.equal(planVideoOutput('native', VIDEO_ASPECT_RATIOS[0]).mode, 'native');
  assert.throws(() => planVideoOutput('2k', VIDEO_ASPECT_RATIOS[0]), /原生清晰度/);
  assert.throws(() => planVideoOutput('720p', '16:9'), /画面比例/);
});

test('native presets use the cloud 1024-squared pixel budget and 32-pixel grid', () => {
  const portrait = '9:16 (Portrait Widescreen)';
  for (const [resolution, pixels, expectedWidth, expectedHeight] of [
    ['480p', '0.4', 480, 864], ['720p', '0.9', 736, 1280], ['1080p', '2', 1088, 1920],
  ]) {
    const plan = planVideoOutput(resolution, portrait);
    assert.deepEqual([plan.pixels, plan.expectedWidth, plan.expectedHeight], [pixels, expectedWidth, expectedHeight]);
    assert.deepEqual(predictVideoSize(pixels, portrait), { width: expectedWidth, height: expectedHeight });
  }
  const custom = planVideoOutput('native', portrait, '0.7');
  assert.deepEqual([custom.mode, custom.width, custom.height, custom.pixels], ['native', null, null, '0.7']);
  for (const pixels of ['0.1', '2.1', 'NaN', '', null]) assert.throws(() => planVideoOutput('native', portrait, pixels));
});

test('native target validation rejects undersized or unknown originals without promoting them to 1080p', () => {
  const plan = planVideoOutput('1080p', '9:16 (Portrait Widescreen)');
  for (const info of [{ width: 480, height: 864 }, { width: 1080, height: 1918 }, { width: 1056, height: 1920 }, {}, { width: 0, height: 0 }]) {
    assert.throws(() => validateNativeVideoOutput(info, plan), { code: 'NATIVE_RESOLUTION_MISMATCH' });
  }
  assert.doesNotThrow(() => validateNativeVideoOutput({ width: 1088, height: 1920 }, plan));
  assert.doesNotThrow(() => validateNativeVideoOutput({ width: 480, height: 864 }, planVideoOutput('native')));
});

test('legacy frozen resize plans still preserve the original and export a padded MP4 with audio', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'storyboard-video-output-'));
  try {
    const sourceFile = join(directory, 'cloud-original.mp4'), outputFile = join(directory, 'portrait-export.mp4');
    await run('ffmpeg', ['-nostdin', '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=12:d=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=0.5',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceFile], { windowsHide: true });
    assert.ok((await stat(sourceFile)).size < 20 * 1024 * 1024);
    const originalHash = digest(await readFile(sourceFile));
    const output = { mode: 'resize', resolution: '480p', width: 480, height: 854 };
    assert.equal(await resizeVideoOutput({ sourceFile, outputFile, output }), outputFile);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputFile], { windowsHide: true });
    const probe = JSON.parse(stdout), video = probe.streams.find(stream => stream.codec_type === 'video'), audio = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.deepEqual([video.width, video.height, video.codec_name], [480, 854, 'h264']);
    assert.equal(audio.codec_name, 'aac'); assert.ok(Number(probe.format.duration) >= 0.5);
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', outputFile, '-f', 'null', '-'], { windowsHide: true });
    const { stdout: topPixels } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', outputFile,
      '-vf', 'crop=32:32:100:20', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', windowsHide: true });
    assert.equal(topPixels.length, 32 * 32 * 3);
    assert.ok(topPixels.reduce((sum, value) => sum + value, 0) / topPixels.length < 5, 'letterbox area should remain black');
    assert.equal(digest(await readFile(sourceFile)), originalHash);
    assert.equal(await resizeVideoOutput({ sourceFile, outputFile, output: planVideoOutput('native', VIDEO_ASPECT_RATIOS[0]) }), sourceFile);
    assert.equal(digest(await readFile(sourceFile)), originalHash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
