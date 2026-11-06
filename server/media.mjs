import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnvironment } from './codex.mjs';
import { mediaUploadProblem } from '../public/media-limits.mjs';

const run = promisify(execFile);

export function revealMediaFile(file, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('explorer.exe', [`/select,${file}`], { shell: false, windowsHide: true, stdio: 'ignore', env: childEnvironment() });
    child.once('error', () => reject(new Error('无法打开资源管理器，请确认本机 Windows 桌面可用。')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function safeWithin(baseDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)
      || relativePath.split(/[\\/]/).includes('..')) throw Object.assign(new Error('文件路径必须位于任务目录内'), { status: 400 });
  const base = await fs.realpath(baseDir);
  const file = await fs.realpath(path.resolve(base, relativePath));
  const relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('文件路径超出目录'), { status: 400 });
  return file;
}

export function sniffMedia(buffer) {
  if (buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: '.png', kind: 'image' };
  if (buffer.length > 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { mime: 'image/jpeg', extension: '.jpg', kind: 'image' };
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', extension: '.webp', kind: 'image' };
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return { mime: 'audio/wav', extension: '.wav', kind: 'audio' };
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer.length >= 4 && buffer[0] === 255 && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x18) !== 0x08 && (buffer[1] & 0x06) === 0x02 && (buffer[2] & 0xf0) !== 0 && (buffer[2] & 0xf0) !== 0xf0 && (buffer[2] & 0x0c) !== 0x0c)) return { mime: 'audio/mpeg', extension: '.mp3', kind: 'audio' };
  if (buffer.subarray(4, 8).toString() === 'ftyp') return { mime: 'video/mp4', extension: '.mp4', kind: 'video' };
  throw Object.assign(new Error('支持 PNG、JPEG、WebP 图片、MP4 视频和 WAV、MP3 音频；文件内容与支持格式不符'), { status: 400 });
}

export async function validateMedia(file, expectedKind) {
  const stats = await fs.stat(file);
  if (!stats.isFile() || stats.size < 32 || stats.size > 200 * 1024 * 1024) throw Object.assign(new Error('媒体文件为空、无效或超过 200 MB'), { status: 400 });
  const bytes = await fs.readFile(file);
  const type = sniffMedia(bytes);
  if (expectedKind && type.kind !== expectedKind) throw Object.assign(new Error('媒体类型与当前任务不一致'), { status: 400 });
  const problem = type.kind === 'image' && mediaUploadProblem(stats.size, true);
  if (problem) throw Object.assign(new Error(problem), { status: 400, code: 'IMAGE_UPLOAD_LIMIT' });
  let metadata;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate,channels:format=duration', '-of', 'json', file], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
    metadata = JSON.parse(stdout);
    const stream = metadata.streams?.find(s => s.codec_type === (type.kind === 'audio' ? 'audio' : 'video'));
    const duration = Number(metadata.format?.duration) || null;
    if (type.kind === 'audio') {
      if (!stream?.channels || !Number(stream.sample_rate) || !Number.isFinite(duration) || duration <= 0) throw new Error('音频缺少有效声道、采样率或时长');
    } else if (!stream?.width || !stream?.height || stream.width * stream.height > 40000000) throw new Error('媒体尺寸无效或过大');
    await run('ffmpeg', ['-v', 'error', '-xerror', '-i', file, ...(type.kind === 'image' ? ['-frames:v', '1'] : []), '-f', 'null', '-'], { timeout: 90000, maxBuffer: 1024 * 1024, windowsHide: true });
    return { ...type, width: stream.width || null, height: stream.height || null, duration,
      ...(type.kind === 'audio' ? { sampleRate: Number(stream.sample_rate), channels: stream.channels, codec: stream.codec_name } : {}),
      size: stats.size, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    throw Object.assign(new Error(error.code === 'ENOENT' ? '需要 ffprobe 和 ffmpeg 才能校验媒体文件' : `媒体无法完整解码：${String(error.message).slice(0, 300)}`), { status: 400 });
  }
}
