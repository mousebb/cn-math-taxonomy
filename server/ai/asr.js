'use strict';

/* 语音转文字。DeepSeek 没有音频接口，所以这一层独立于 chat 的 provider。
 * 目标是所有「OpenAI 兼容」的 /audio/transcriptions 服务，换厂商只改 .env：
 *   ASR_BASE_URL=https://api.siliconflow.cn/v1
 *   ASR_MODEL=FunAudioLLM/SenseVoiceSmall
 *   ASR_KEY=sk-xxx
 */

const config = require('../config');

/* 浏览器 MediaRecorder 在不同平台吐不同容器，这里只做「mime → 文件后缀」的映射，
 * 不改码流：上游按后缀判断格式，改名比转码便宜得多。 */
const EXT = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

function baseMime(raw) {
  return String(raw || '').split(';')[0].trim().toLowerCase();
}

function configured() {
  return !!(config.asr.enabled && config.asr.key);
}

function info() {
  return {
    configured: configured(),
    enabled: config.asr.enabled,
    model: config.asr.model,
    maxSeconds: config.asr.maxSeconds,
  };
}

async function transcribe(opts) {
  const cfg = config.asr;
  if (!configured()) {
    throw Object.assign(new Error('还没有配置语音识别，请在 .env 里填 ASR_KEY'), { code: 'NO_ASR' });
  }

  const mime = baseMime(opts && opts.mime);
  const ext = EXT[mime];
  if (!ext) {
    throw Object.assign(new Error('不支持的录音格式：' + (mime || '未知')), { code: 'BAD_AUDIO' });
  }

  const buf = opts.buffer;
  if (!buf || !buf.length) {
    throw Object.assign(new Error('没有收到录音'), { code: 'BAD_AUDIO' });
  }

  const form = new FormData();
  form.set('model', cfg.model);
  if (cfg.language && cfg.language !== 'auto') form.set('language', cfg.language);
  form.set('file', new Blob([new Uint8Array(buf)], { type: mime }), 'voice.' + ext);

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  let res;
  let raw;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + cfg.key },
      body: form,
      signal: controller.signal,
    });
    raw = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const msg = err && err.name === 'AbortError'
      ? '语音识别超时了，重说一次试试'
      : '连不上语音识别服务：' + (err && err.message ? err.message : '网络错误');
    throw Object.assign(new Error(msg), { code: 'ASR_NETWORK' });
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw Object.assign(new Error('语音识别失败（' + res.status + '）：' + String(raw || '').slice(0, 200)), {
      code: 'ASR_UPSTREAM',
    });
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw Object.assign(new Error('语音识别返回了无法解析的内容'), { code: 'ASR_UPSTREAM' });
  }

  return String((json && json.text) || '').trim();
}

module.exports = { transcribe, configured, info };
