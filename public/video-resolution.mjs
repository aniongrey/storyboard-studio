export const VIDEO_OUTPUT_RESOLUTIONS = ['native', '480p', '720p', '1080p'];
export const VIDEO_ASPECT_RATIOS = [
  '1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)',
  '4:3 (Standard)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)',
];
export const VIDEO_PIXEL_LIMITS = { min: 0.2, max: 2, step: 0.1 };

function aspectPair(aspectRatio) {
  if (aspectRatio && typeof aspectRatio === 'object') {
    const width = Number(aspectRatio.width), height = Number(aspectRatio.height);
    if (!(width > 0) || !(height > 0)) throw new Error('首帧尺寸未知，请先绑定首帧后再选择原生清晰度。');
    return [width, height];
  }
  if (!VIDEO_ASPECT_RATIOS.includes(aspectRatio)) throw new Error('画面比例不是工作流文档中的有效选项。');
  return aspectRatio.split(' ')[0].split(':').map(Number);
}

export function predictVideoSize(pixels, aspectRatio) {
  const amount = Number(pixels);
  if (!Number.isFinite(amount) || amount < VIDEO_PIXEL_LIMITS.min || amount > VIDEO_PIXEL_LIMITS.max) throw new Error('像素/百万需要 0.2–2.0 之间的数值。');
  const [horizontal, vertical] = aspectPair(aspectRatio);
  // RunningHub 作者的尺寸表对应 ComfyUI ResolutionSelector：1024² 像素单位、32 像素网格。
  const scale = Math.sqrt(amount * 1024 * 1024 / (horizontal * vertical));
  return { width: Math.max(32, Math.round(horizontal * scale / 32) * 32), height: Math.max(32, Math.round(vertical * scale / 32) * 32) };
}

export function planVideoOutput(resolution = 'native', aspectRatio, pixels = '0.4') {
  if (!VIDEO_OUTPUT_RESOLUTIONS.includes(resolution)) throw new Error('原生清晰度请选择自定义像素、480p、720p或1080p。');
  if (resolution === 'native') {
    const amount = Number(pixels);
    if (!Number.isFinite(amount) || amount < 0.2 || amount > 2) throw new Error('像素/百万需要 0.2–2.0 之间的数值。');
    let expected;
    try { expected = predictVideoSize(amount, aspectRatio); } catch { /* 首帧未绑定时仍保留自定义像素。 */ }
    return { mode: 'native', width: null, height: null, resolution, pixels: String(amount), expectedWidth: expected?.width ?? null, expectedHeight: expected?.height ?? null,
      note: `按 ${amount} 百万像素生成并保留云端原片，不在本机放大。` };
  }
  const [horizontal, vertical] = aspectPair(aspectRatio), shortEdge = Number.parseInt(resolution, 10);
  const even = value => 2 * Math.round(value / 2);
  const width = horizontal >= vertical ? even(shortEdge * horizontal / vertical) : shortEdge;
  const height = horizontal >= vertical ? shortEdge : even(shortEdge * vertical / horizontal);
  for (let tenths = 2; tenths <= 20; tenths++) {
    const amount = tenths / 10, expected = predictVideoSize(amount, aspectRatio);
    if (expected.width >= width && expected.height >= height) {
      return { mode: 'native_target', resolution, width, height, pixels: String(amount), expectedWidth: expected.width, expectedHeight: expected.height,
        note: `原生生成预计 ${expected.width} × ${expected.height} px（${amount} 百万像素）；回片须至少 ${width} × ${height} px，不在本机放大。` };
    }
  }
  throw new Error(`当前比例的原生 ${resolution} 超出此工作流 2.0 百万像素范围，请降低清晰度或更换比例。`);
}
