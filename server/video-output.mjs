import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export { VIDEO_OUTPUT_RESOLUTIONS, VIDEO_ASPECT_RATIOS, planVideoOutput, predictVideoSize } from '../public/video-resolution.mjs';

const run = promisify(execFile);

export function validateNativeVideoOutput(info, output) {
  if (output.mode !== 'native_target') return;
  if (!(Number(info.width) >= output.width && Number(info.height) >= output.height)) {
    throw Object.assign(new Error(`云端原片 ${info.width || '未知'} × ${info.height || '未知'} px 未达到原生 ${output.resolution}（至少 ${output.width} × ${output.height} px）；原片已保留，未进行放大。`),
      { code: 'NATIVE_RESOLUTION_MISMATCH', status: 502 });
  }
}

export async function resizeVideoOutput({ sourceFile, outputFile, output, ffmpegPath = 'ffmpeg' }) {
  if (output.mode === 'native') return sourceFile;
  if (output.mode !== 'resize' || !Number.isInteger(output.width) || !Number.isInteger(output.height)
      || output.width < 2 || output.height < 2 || output.width % 2 || output.height % 2) throw new Error('导出尺寸必须是正偶数。');
  if (sourceFile === outputFile) throw new Error('导出文件不能覆盖云端原视频。');
  const { width, height } = output;
  await run(ffmpegPath, ['-nostdin', '-y', '-v', 'error', '-i', sourceFile,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', outputFile],
  { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true });
  return outputFile;
}
