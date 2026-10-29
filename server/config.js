'use strict';

/* 配置：只读 .env 和 process.env，不写任何文件。
 * 约定：所有模型服务商都用 AI_<NAME>_KEY 注册，换供应商不改代码。
 *   AI_DEEPSEEK_KEY=sk-xxx
 *   AI_DEEPSEEK_MODEL=deepseek-flash
 *   AI_DEEPSEEK_BASE_URL=https://api.deepseek.com
 *   AI_DEEPSEEK_PROTOCOL=openai
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function parseEnv(text) {
  const out = Object.create(null);
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = s.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.length > 1 && val[val.length - 1] === q) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash > 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

let fileEnv = {};
try {
  fileEnv = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
} catch (err) {
  fileEnv = {};
}

function raw(key, fallback) {
  const a = process.env[key];
  if (a != null && a !== '') return a;
  const b = fileEnv[key];
  if (b != null && b !== '') return b;
  return fallback;
}

function num(key, fallback) {
  const n = Number(raw(key, ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(key, fallback) {
  const v = String(raw(key, '')).toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

/* 内置默认，只在你没写 BASE_URL / MODEL 时兜底。
 * deepseek-flash 是官方模型名（旧名 deepseek-v4-flash 会被路由到同一模型）。 */
const DEFAULTS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', protocol: 'openai' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', protocol: 'openai' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', protocol: 'openai' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', protocol: 'openai' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', protocol: 'openai' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', protocol: 'anthropic' },
};

/* 兼容直接写 DEEPSEEK_API_KEY 这种老习惯 */
const ALIAS_KEY = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

function collectProviders() {
  const names = new Set();
  const scan = (src) => {
    for (const key of Object.keys(src)) {
      const m = /^AI_([A-Z0-9]+)_KEY$/.exec(key);
      if (m) names.add(m[1].toLowerCase());
    }
  };
  scan(fileEnv);
  scan(process.env);
  for (const name of Object.keys(ALIAS_KEY)) {
    if (raw(ALIAS_KEY[name], '')) names.add(name);
  }

  const list = {};
  for (const name of names) {
    const up = name.toUpperCase();
    const d = DEFAULTS[name] || {};
    const apiKey = raw(`AI_${up}_KEY`, '') || raw(ALIAS_KEY[name] || '', '');
    if (!apiKey) continue;
    list[name] = {
      name,
      protocol: raw(`AI_${up}_PROTOCOL`, d.protocol || 'openai'),
      baseUrl: raw(`AI_${up}_BASE_URL`, d.baseUrl || ''),
      model: raw(`AI_${up}_MODEL`, d.model || ''),
      apiKey,
    };
  }
  return list;
}

const providers = collectProviders();
const configuredDefault = raw('AI_DEFAULT', '').toLowerCase();
const defaultProvider = providers[configuredDefault]
  ? configuredDefault
  : (Object.keys(providers)[0] || '');

module.exports = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  runtimeDir: path.join(ROOT, 'runtime'),
  port: num('PORT', 8787),
  host: raw('HOST', '127.0.0.1'),
  /* 只在本机演示时想省事可以设 PUBLIC=1，默认只监听回环 */
  providers,
  defaultProvider,
  chat: {
    maxMessages: num('CHAT_MAX_MESSAGES', 24),
    maxChars: num('CHAT_MAX_CHARS', 4000),
    temperature: Number(raw('CHAT_TEMPERATURE', '0.4')),
    maxTokens: num('CHAT_MAX_TOKENS', 1600),
    perMinute: num('CHAT_PER_MINUTE', 12),
    /* 上游多久没有任何数据就主动断开，避免前端永远转圈 */
    idleSeconds: num('CHAT_IDLE_SECONDS', 45),
  },
  /* 语音输入（STT）。DeepSeek 没有音频接口，所以这里是独立的一家。
   * 默认硅基流动 SenseVoice：OpenAI 兼容的 /audio/transcriptions，中文好，目前免费。 */
  asr: {
    enabled: bool('ASR_ENABLED', true),
    baseUrl: raw('ASR_BASE_URL', 'https://api.siliconflow.cn/v1'),
    model: raw('ASR_MODEL', 'FunAudioLLM/SenseVoiceSmall'),
    key: raw('ASR_KEY', '') || raw('AI_SILICONFLOW_KEY', ''),
    language: raw('ASR_LANGUAGE', 'zh'),
    maxBytes: num('ASR_MAX_BYTES', 8 * 1024 * 1024),
    maxSeconds: num('ASR_MAX_SECONDS', 60),
    perMinute: num('ASR_PER_MINUTE', 20),
  },
  sync: {
    enabled: bool('SYNC_ENABLED', true),
    intervalMin: num('SYNC_INTERVAL_MIN', 360),
    upstream: raw('SYNC_UPSTREAM', 'https://github.com/xiaoyang111222/cn-math-taxonomy.git'),
    branch: raw('SYNC_BRANCH', 'main'),
    keep: num('SYNC_KEEP', 3),
    adminToken: raw('SYNC_ADMIN_TOKEN', ''),
    /* auto：有 python3 就跑上游 validate.py，没有就用内置校验；
     * builtin：强制用内置校验（服务器没装 python 时可用这个跳过探测） */
    validator: raw('SYNC_VALIDATOR', 'auto'),
    files: ['topics.json', 'dependencies.json', 'questions.json', 'cn-curriculum-standards.json', 'id-aliases.json'],
  },
};
