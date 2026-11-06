import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sendFishAudioResult } from '../server/fish-audio-response.mjs';

test('Fish responses preserve default JSON and return exact audio bytes only for download:true', () => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff, 0x7f]);
  const result = { audio, size: audio.length, contentType: 'audio/mpeg' };

  for (const download of [undefined, false, 'true']) {
    const res = { json: mock.fn(), type: mock.fn(), send: mock.fn() };
    sendFishAudioResult(res, result, download);
    assert.equal(res.json.mock.callCount(), 1);
    assert.deepEqual(res.json.mock.calls[0].arguments, [{ ok: true, size: audio.length, contentType: 'audio/mpeg' }]);
    assert.equal(res.type.mock.callCount(), 0);
    assert.equal(res.send.mock.callCount(), 0);
  }

  const res = { json: mock.fn(), type: mock.fn(() => res), send: mock.fn(() => res) };
  assert.equal(sendFishAudioResult(res, result, true), res);
  assert.equal(res.json.mock.callCount(), 0);
  assert.deepEqual(res.type.mock.calls[0].arguments, ['audio/mpeg']);
  assert.equal(res.send.mock.callCount(), 1);
  assert.equal(res.send.mock.calls[0].arguments[0], audio);
});
