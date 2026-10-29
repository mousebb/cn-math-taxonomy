'use strict';

/* POST /api/chat —— SSE 流式。
 * 请求体：{ provider?, topicId?, questionId?, questionText?, kid?, diag?, messages:[{role,content}] }
 * 响应：每行 data: {"type":...}，type 为 meta / delta / done / error
 */

const config = require('../config');
const http = require('../http');
const ai = require('../ai');
const context = require('../context');

/* 简单限流：每个 IP 每分钟最多 N 次。内存实现，重启清零，够 M1 用。 */
const hits = new Map();
function allow(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= config.chat.perMinute) {
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

function normalizeMessages(input) {
  if (!Array.isArray(input)) throw Object.assign(new Error('messages 必须是数组'), { code: 'BAD_INPUT' });
  const list = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) continue;
    list.push({ role, content: content.slice(0, config.chat.maxChars) });
  }
  const trimmed = list.slice(-config.chat.maxMessages);
  if (!trimmed.length) throw Object.assign(new Error('没有可发送的消息'), { code: 'BAD_INPUT' });
  if (trimmed[trimmed.length - 1].role !== 'user') {
    throw Object.assign(new Error('最后一条消息必须来自学生'), { code: 'BAD_INPUT' });
  }
  const total = trimmed.reduce((n, m) => n + m.content.length, 0);
  if (total > config.chat.maxChars * 2) {
    throw Object.assign(new Error('对话太长了，先清理一下再问'), { code: 'TOO_LONG' });
  }
  return trimmed;
}

/* 错题本条目：客户端传来的，只做白名单化和截断，不信任其中的任何字段 */
const KINDS = new Set(['wrong', 'skip', 'correct']);
function normalizeMemory(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const m of input.slice(0, 30)) {
    if (!m || typeof m !== 'object') continue;
    out.push({
      tid: m.tid ? String(m.tid).slice(0, 80) : null,
      tname: m.tname ? String(m.tname).slice(0, 60) : '',
      ans: m.ans ? String(m.ans).slice(0, 80) : '',
      verdict: KINDS.has(m.verdict) ? m.verdict : 'wrong',
      note: m.note ? String(m.note).slice(0, 160) : '',
      at: Number(m.at) || 0,
      when: m.when ? String(m.when).slice(0, 12) : '',
      count: Math.min(20, Math.max(1, Number(m.count) || 1)),
    });
  }
  return out.length ? out : null;
}

async function handle(req, res) {
  if (req.method !== 'POST') {
    http.sendJson(res, 405, { error: '只支持 POST' });
    return;
  }
  if (!allow(clientIp(req))) {
    http.sendJson(res, 429, { error: '问得太快了，歇一分钟再问。' });
    return;
  }

  let body;
  try {
    body = await http.readJson(req, 256 * 1024);
  } catch (err) {
    http.sendJson(res, 400, { error: err.message });
    return;
  }

  let messages;
  try {
    messages = normalizeMessages(body.messages);
  } catch (err) {
    http.sendJson(res, 400, { error: err.message });
    return;
  }

  let built;
  try {
    built = context.build({
      topicId: body.topicId,
      questionId: body.questionId,
      questionText: body.questionText,
      studentAnswer: body.studentAnswer,
      verdict: body.verdict,
      trigger: body.trigger,
      hasFigure: body.hasFigure,
      whyAsked: body.whyAsked,
      attempts: body.attempts,
      kid: body.kid,
      diag: body.diag,
      subject: body.subject,
      memory: normalizeMemory(body.memory),
    });
  } catch (err) {
    http.sendJson(res, 500, { error: '上下文准备失败：' + err.message });
    return;
  }

  const controller = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    controller.abort();
  });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (obj) => {
    if (closed) return;
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };

  const startedAt = Date.now();
  let chars = 0;

  /* 上游可能既不报错也不结束（连接被中间设备挂住、模型排队），
   * 表现就是前端永远转圈。这里发心跳维持连接，并在长时间无数据时主动收尾。 */
  let lastAt = Date.now();
  const IDLE_MS = Math.max(5, config.chat.idleSeconds) * 1000;
  const PING_MS = Math.min(15000, Math.floor(IDLE_MS / 3));
  const watchdog = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastAt > IDLE_MS) {
      send({ type: 'error', message: '老师那边一直没有回应，已经断开。检查一下网络，或者换个问法再试。' });
      try {
        controller.abort();
      } catch (err) {
        /* ignore */
      }
      return;
    }
    /* 注释行，浏览器端按 data: 取事件，会自然忽略 */
    res.write(': ping\n\n');
  }, PING_MS);
  if (watchdog.unref) watchdog.unref();

  try {
    send({
      type: 'meta',
      topic: body.topicId || null,
      topicName: built.meta.topicName || null,
      questionId: built.meta.questionId || null,
      hasQuestion: !!built.meta.hasQuestion,
      hasWhy: !!built.meta.hasWhy,
      contextChars: built.meta.chars,
      prereqCount: built.meta.prereqCount,
      memoryCount: built.meta.memoryCount || 0,
    });

    const iterator = ai.stream({
      provider: body.provider,
      system: built.system,
      messages,
      signal: controller.signal,
      temperature: config.chat.temperature,
      maxTokens: config.chat.maxTokens,
    });

    for await (const delta of iterator) {
      if (closed) break;
      lastAt = Date.now();
      chars += delta.length;
      send({ type: 'delta', text: delta });
    }

    send({ type: 'done', ms: Date.now() - startedAt, chars });
  } catch (err) {
    if (closed) return;
    if (err.name === 'AbortError') return;
    let message = err.message || '出错了';
    if (err.code === 'NO_PROVIDER') message = '老师还没配好（服务端缺少 API key），先找管理员。';
    send({ type: 'error', message });
  } finally {
    clearInterval(watchdog);
    if (!closed) res.end();
  }
}

module.exports = { handle };
