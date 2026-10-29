'use strict';

/* provider 路由：前端只说「用哪个 provider」，不关心协议。
 * 想接新厂商：在 .env 写 AI_<NAME>_KEY / BASE_URL / MODEL / PROTOCOL 即可，不用改代码。 */

const config = require('../config');
const openai = require('./openai');
const anthropic = require('./anthropic');

const ADAPTERS = { openai, anthropic };

function list() {
  return Object.keys(config.providers).map((name) => {
    const p = config.providers[name];
    return { name, model: p.model, protocol: p.protocol, default: name === config.defaultProvider };
  });
}

function pick(name) {
  const key = String(name || config.defaultProvider || '').toLowerCase();
  if (!key) {
    throw Object.assign(new Error('还没有配置任何模型服务商，请在 .env 里设置 AI_DEEPSEEK_KEY'), { code: 'NO_PROVIDER' });
  }
  const p = config.providers[key];
  if (!p) throw Object.assign(new Error('没有叫 ' + key + ' 的 provider'), { code: 'NO_PROVIDER' });
  return p;
}

function adapterOf(p) {
  const a = ADAPTERS[p.protocol];
  if (!a) throw Object.assign(new Error('不支持的协议 ' + p.protocol), { code: 'BAD_PROTOCOL' });
  return a;
}

async function* stream(opts) {
  const provider = pick(opts.provider);
  yield* adapterOf(provider).stream(Object.assign({}, opts, { provider }));
}

module.exports = { list, pick, stream };
