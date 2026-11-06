export function sendFishAudioResult(res, result, download) {
  if (download === true) return res.type(result.contentType).send(result.audio);
  return res.json({ ok: true, size: result.size, contentType: result.contentType });
}
