'use strict';

/* 题库同步接口。检测是只读的，可以公开；应用和回退必须带管理员令牌。
 * 没配 SYNC_ADMIN_TOKEN 时，只允许本机访问（方便本地调试）。 */

const http = require('../http');
const sync = require('../sync');
const config = require('../config');

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authorized(req, body) {
  const expected = config.sync.adminToken;
  if (!expected) return isLocal(req);
  const fromHeader = req.headers['x-admin-token'];
  const fromBody = body && body.token;
  const token = String(fromHeader || fromBody || '');
  if (!token) return false;
  /* 长度不同直接 false，避免 timingSafeEqual 抛错 */
  if (token.length !== expected.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
}

async function handle(req, res, parts) {
  const action = parts[2] || 'status';

  if (action === 'status' && req.method === 'GET') {
    http.sendJson(res, 200, sync.status());
    return;
  }

  if (action === 'check' && req.method === 'POST') {
    const result = await sync.check();
    http.sendJson(res, 200, {
      ok: !result.error,
      pending: result.pending,
      upstreamSha: result.upstreamSha,
      localSha: result.localSha,
      changes: result.changes,
      files: result.files,
      error: result.error,
    });
    return;
  }

  if (action === 'apply' || action === 'rollback') {
    if (req.method !== 'POST') {
      http.sendJson(res, 405, { error: '只支持 POST' });
      return;
    }
    const body = await http.readJson(req, 16 * 1024);
    if (!authorized(req, body)) {
      http.sendJson(res, 403, {
        error: config.sync.adminToken ? '管理员令牌不对' : '没有配置 SYNC_ADMIN_TOKEN，只能在本机操作',
      });
      return;
    }
    try {
      const result =
        action === 'apply' ? await sync.apply(body.sha) : await sync.rollback(body.short);
      http.sendJson(res, 200, result);
    } catch (err) {
      /* 并发冲突给 409，让前端能区分「正在跑」和「真失败」 */
      const code = err.code === 'SYNC_BUSY' ? 409 : 500;
      http.sendJson(res, code, { ok: false, busy: code === 409, error: err.message });
    }
    return;
  }

  http.sendJson(res, 404, { error: '未知的同步接口' });
}

module.exports = { handle };
