'use strict';

/* POST /api/asr —— 语音转文字。
 * 请求体是原始音频字节（不是 multipart），Content-Type 由浏览器录完直接带上，例如
 *   content-type: audio/webm;codecs=opus
 * 响应：{ ok, text, ms }
 *
 * 为什么不用 multipart：服务端不需要解析表单，直接把字节重新包成上游要的 FormData 就行，
 * 少一层解析少一类 bug，也能顺便在流式读取时卡体积上限。
 */

const config = require('../config');
const http = require('../http');
const asr = require('../ai/asr');

const hits = new Map();
function allow(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= config.asr.perMinute) {
    hits.set(ip, list);
    return false;
  }
  list.push(now);
  hits.set(ip, list);
  return true;
}
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const alive = list.filter((t) => now - t < 60000);
    if (alive.length) hits.set(ip, alive);
    else hits.delete(ip);
  }
}, 120000);
if (sweeper.unref) sweeper.unref();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'local';
}

async function handle(req, res) {
  if (req.method !== 'POST') {
    http.sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return;
  }
  if (!config.asr.enabled) {
    http.sendJson(res, 503, { ok: false, error: '语音输入已关闭（ASR_ENABLED=0）' });
    return;
  }
  if (!asr.configured()) {
    http.sendJson(res, 503, {
      ok: false,
      code: 'NO_ASR',
      error: '还没有配置语音识别。请在 .env 里填 ASR_KEY（硅基流动的 key），重启后生效。',
    });
    return;
  }
  if (!allow(clientIp(req))) {
    http.sendJson(res, 429, { ok: false, error: '说话有点频繁，歇一下再试' });
    return;
  }

  let buffer;
  try {
    buffer = await http.readBinary(req, config.asr.maxBytes);
  } catch (err) {
    http.sendJson(res, 413, { ok: false, error: err.message });
    return;
  }

  const started = Date.now();
  try {
    const text = await asr.transcribe({ buffer, mime: req.headers['content-type'] });
    http.sendJson(res, 200, { ok: true, text, ms: Date.now() - started });
  } catch (err) {
    const status = err.code === 'NO_ASR' ? 503 : err.code === 'BAD_AUDIO' ? 400 : 502;
    http.sendJson(res, status, { ok: false, code: err.code || 'ASR_FAILED', error: err.message });
  }
}

module.exports = { handle };
