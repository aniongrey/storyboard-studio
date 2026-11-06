// RunningHub 文档要求 <30MB；按十进制字节保守校验，避免把 30MiB 当成 30MB。
export const IMAGE_UPLOAD_MAX_BYTES = 30_000_000;
export const VIDEO_REFERENCE_UPLOAD_MAX_BYTES = 30_000_000;
export const LOCAL_UPLOAD_MAX_BYTES = 60 * 1024 * 1024;
export const SOURCE_VIDEO_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
// 原视频打标只保存一条配乐/原声音频，整集音轨可能比单个素材大得多。
export const SOURCE_AUDIO_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

export function mediaUploadProblem(size, isImage) {
  if (isImage && size >= IMAGE_UPLOAD_MAX_BYTES) return '图片须小于 30 MB（30,000,000 字节），请另存较小的 JPG、PNG 或 WebP 图片。';
  if (size > LOCAL_UPLOAD_MAX_BYTES) return '文件超过本地上传上限 60 MB，请选择较小的素材。';
  return '';
}
