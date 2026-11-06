import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fail = message => Object.assign(new Error(message), { status: 400 });

export function sourceVideoFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[/\\]{2}/.test(file) || !/\.(mp4|webm|mov|mkv|m4v)$/i.test(file)) throw fail('请保存本机原视频的绝对路径后再预览。');
  return file;
}

export function sourceFrameSeconds(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 86400) throw fail('抽帧时间须为 0 至 86400 之间的秒数。');
  return Number(value);
}

export async function extractSourceFrame({ inputFile, seconds }) {
  sourceVideoFile(inputFile);
  sourceFrameSeconds(String(seconds));
  try {
    const { stdout } = await run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(seconds), '-i', inputFile, '-map', '0:v:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (!stdout.length) throw new Error('empty frame');
    return stdout;
  } catch (error) {
    throw Object.assign(fail(error.code === 'ENOENT' ? '需要 ffmpeg 才能查看原视频时间点图片。' : '这个时间点无法抽取图片，请确认原视频可播放且时间点在视频范围内。'), { code: 'SOURCE_FRAME_FAILED' });
  }
}
