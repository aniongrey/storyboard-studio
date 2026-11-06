// 原视频打标的音频：每集只保留一条导入音频，并按故事板的打标时间点切出本组音频。
// 原则是「宁可多切，不可少切」：起点向前留白并向下对齐到整帧，终点向后留白并向上对齐到整帧。
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const AUDIO_CUT_PADDING = { before: 2, after: 3 };
export const MIN_AUDIO_CLIP_SECONDS = 1;
// 单组切音最长 10 分钟：再长说明没对上本组镜头（会退化成整集），提示用户填镜号或起止。
export const MAX_AUDIO_CLIP_SECONDS = 600;
// 空白填充最多 30 秒，避免误填把整集音轨切进本组。
const MAX_PADDING_SECONDS = 30;

export function sourceAudioExtension(filename) {
  return /\.(wav|mp3|m4a)$/i.exec(String(filename || ''))?.[0].toLowerCase() || '';
}

export function sourceAudioMime(filename) {
  return { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' }[sourceAudioExtension(filename)] || 'application/octet-stream';
}

// 与页面上的时间解析保持一致：支持 00:01.800 / 4.267秒 / 01:02:03.125 / 00:01.800–00:04.267。
export function parseTimePoint(value) {
  const label = String(value ?? '').trim();
  if (!label) return null;
  const start = label.split(/[–—~～→]|至/, 1)[0].trim().replaceAll('：', ':').replace(/(?:秒|s)$/i, '').trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(start)) return null;
  const parts = start.split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) ? seconds : null;
}

// 一条打标里用逗号分隔的多个关键帧都算本镜的时间点，不拆成额外镜头。
export function markTimePoints(mark) {
  return String(mark?.time ?? '').split(/[,，]/).map(parseTimePoint).filter(value => value !== null);
}

// 显式起止可以直接写「00:08-00:15」「8，15」。
export function rangeTimePoints(text) {
  return String(text ?? '').split(/[,，]|[-–—~～]|至/).map(parseTimePoint).filter(value => value !== null);
}

function padding(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, MAX_PADDING_SECONDS) : fallback;
}

// 切点对齐到原视频帧：起点向下取整、终点向上取整，都比原始时间点更宽一点。
export function snapToFrames({ start, end }, fps) {
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0) return { start, end: Math.max(end, start) };
  return { start: Math.max(0, Math.floor(start * rate) / rate), end: Math.ceil(end * rate) / rate };
}

/*
  本组音频范围：
  1. 用户填了起止时间 → 就用它；
  2. 打标里写了「对应镜号」的条目 → 用这些打标的时间点；
  3. 本集打标条数与镜头数一致 → 按本集镜头顺序与打标顺序一一对应；
  4. 都对不上 → 用本集全部打标点（宁可多切，不会漏掉本组的台词）。
*/
export function planAudioCut({ groupCodes = [], episodeShots = [], episodeMarks = [], before, after, range = '', duration = 0, fps = 0 } = {}) {
  const codes = groupCodes.map(code => String(code ?? '').trim()).filter(Boolean);
  const usable = episodeMarks.map(mark => ({ mark, points: markTimePoints(mark) })).filter(item => item.points.length);
  let points = [], source = 'all', note = '';
  const explicit = rangeTimePoints(range);
  if (explicit.length) {
    points = explicit;
    source = 'range';
    note = '按你填写的起止时间切，前后仍各留一段。';
  } else {
    const bound = usable.filter(({ mark }) => codes.includes(String(mark.shotCode ?? '').trim()));
    const ordered = usable.length === episodeShots.length
      ? codes.map(code => usable[episodeShots.findIndex(shot => String(shot.code ?? '').trim() === code)]?.points || []).flat()
      : [];
    if (bound.length) {
      points = bound.flatMap(item => item.points);
      source = 'shot-code';
      note = '按打标里填写的对应镜号切。';
    } else if (ordered.length) {
      points = ordered;
      source = 'order';
      note = '本集打标与镜头数一致，按顺序对应切。';
    } else {
      points = usable.flatMap(item => item.points);
      note = usable.length ? '本组镜头对不上打标条目：按本集全部打标点切，宁可多切。' : '';
    }
  }
  if (!points.length) {
    throw Object.assign(new Error('本集还没有可用的打标时间点，也没填起止时间；请先打标，或直接填写本组起止。'), { status: 400, code: 'AUDIO_CUT_NO_POINTS' });
  }
  const limit = Number(duration) > 0 ? Number(duration) : Infinity;
  // 打标时间点可能超出音轨（用户按原视频打字但音轨更短等），先夹回可用范围再算前后留白。
  const clip = value => Number.isFinite(limit) ? Math.min(Math.max(0, value), limit) : Math.max(0, value);
  const rawFirst = Math.min(...points), rawLast = Math.max(...points);
  const first = clip(rawFirst), last = clip(rawLast);
  let start = Math.max(0, first - padding(before, AUDIO_CUT_PADDING.before));
  let end = Math.min(limit, last + padding(after, AUDIO_CUT_PADDING.after));
  if (!(end - start >= MIN_AUDIO_CLIP_SECONDS)) {
    end = Math.min(limit, start + MIN_AUDIO_CLIP_SECONDS);
    start = Math.max(0, end - MIN_AUDIO_CLIP_SECONDS);
  }
  if (!(end > start)) throw Object.assign(new Error('算出来的音频范围是空的，请检查打标时间点或原视频时长。'), { status: 400, code: 'AUDIO_CUT_EMPTY' });
  const snapped = snapToFrames({ start, end }, fps);
  return {
    start: snapped.start,
    end: Math.min(limit, snapped.end),
    points, first: rawFirst, last: rawLast, source, note,
  };
}

export async function probeSourceMedia(file) {
  let payload;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,r_frame_rate:format=duration', '-of', 'json', file], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
    payload = JSON.parse(stdout);
  } catch (error) {
    throw Object.assign(new Error(error.code === 'ENOENT' ? '需要 ffprobe 和 ffmpeg 才能读取音频' : `这个文件读不出音轨：${String(error.message).slice(0, 300)}`), { status: 400, code: 'SOURCE_MEDIA_UNREADABLE' });
  }
  const streams = payload.streams || [];
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const video = streams.find(stream => stream.codec_type === 'video');
  const duration = Number(payload.format?.duration);
  const [num, den] = String(video?.r_frame_rate || '').split('/').map(Number);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    fps: num > 0 && den > 0 ? num / den : 0,
    audio: audio ? { codec: audio.codec_name || '', sampleRate: Number(audio.sample_rate) || null, channels: Number(audio.channels) || null } : null,
  };
}

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function cutAudioClip({ inputFile, outputFile, start, end, ffmpegPath = 'ffmpeg' }) {
  await fsp.mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.part.wav`;
  const length = Math.max(0.1, Number(end) - Number(start));
  try {
    await run(ffmpegPath, ['-nostdin', '-y', '-v', 'error',
      '-ss', Number(start).toFixed(3), '-i', inputFile, '-t', length.toFixed(3),
      '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', temporary], { timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (!(await fsp.stat(temporary)).size) throw new Error('切出的音频是空文件');
    await fsp.rename(temporary, outputFile);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    await fsp.unlink(outputFile).catch(() => {});
    throw Object.assign(new Error(error.code === 'ENOENT' ? '需要 ffmpeg 才能切音频' : `音频切割失败：${String(error.message).slice(0, 300)}`), { status: 500, code: 'AUDIO_CUT_FAILED' });
  }
  return outputFile;
}

export function audioCutLabel(start, end) {
  const clock = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${clock(start)}-${clock(end)}`;
}
