'use strict';

/* 入口：node server/index.js
 * 一个进程干三件事：托管静态站、提供 /api/chat 流式对话、定时检测上游题库。
 * 零依赖，只用 Node 内置模块（需要 Node 18+，推荐 20/22）。
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const config = require('./config');
const data = require('./data');
const h = require('./http');
const ai = require('./ai');
const asr = require('./ai/asr');
const sync = require('./sync');
const chatRoute = require('./routes/chat');
const syncRoute = require('./routes/sync');
const asrRoute = require('./routes/asr');

/* 白名单：只有这些前缀允许静态访问。
 * server/、scripts/、runtime/、.git/、docs/ 一律不对外，防止 .env 和源码泄露。 */
const PUBLIC_PREFIX = ['/assets/', '/children/', '/diagnose/', '/explore/', '/data/'];
const PUBLIC_EXACT = ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/favicon.ico', '/LICENSE'];

function isPublic(pathname) {
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}

function cacheHeader(pathname) {
  if (pathname.startsWith('/data/')) return { 'cache-control': 'no-cache' };
  if (pathname.startsWith('/assets/vendor/')) return { 'cache-control': 'public, max-age=604800' };
  /* assets/ai/ 是自研扩展，改得勤；给 5 分钟缓存会让人以为改动没生效。 */
  if (pathname.startsWith('/assets/ai/')) return { 'cache-control': 'no-cache' };
  return { 'cache-control': 'public, max-age=300' };
}

async function route(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    h.sendText(res, 400, 'bad url');
    return;
  }
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] === 'api') {
    if (segments[1] === 'chat') {
      if (segments[2] === 'providers') {
        h.sendJson(res, 200, { providers: ai.list(), default: config.defaultProvider });
        return;
      }
      await chatRoute.handle(req, res);
      return;
    }
    if (segments[1] === 'sync') {
      await syncRoute.handle(req, res, segments);
      return;
    }
    if (segments[1] === 'asr') {
      await asrRoute.handle(req, res);
      return;
    }
    if (segments[1] === 'health') {
      const g = data.graph();
      h.sendJson(res, 200, {
        ok: true,
        node: process.version,
        stats: g.stats,
        providers: ai.list().map((p) => ({ name: p.name, model: p.model, default: p.default })),
        asr: asr.info(),
        sync: { enabled: config.sync.enabled, pending: sync.status().pending },
      });
      return;
    }
    h.sendJson(res, 404, { error: '没有这个接口' });
    return;
  }

  if (!isPublic(url.pathname)) {
    h.sendText(res, 404, 'not found');
    return;
  }

  h.serveStatic(req, res, config.root, url.pathname, cacheHeader(url.pathname));
}

function banner() {
  const g = data.graph();
  const providers = ai.list();
  const lines = [];
  lines.push('');
  lines.push('  知识图谱 · 本地服务');
  lines.push('  ─────────────────────────────');
  lines.push('  地址      http://' + config.host + ':' + config.port + '/');
  lines.push('  数据      ' + g.stats.topics + ' 个知识点 · ' + g.stats.edges + ' 条先修边 · ' + g.stats.questions + ' 道题');
  if (providers.length) {
    lines.push(
      '  模型      ' +
        providers
          .map((p) => p.name + '/' + p.model + (p.default ? '（默认）' : ''))
          .join('、')
    );
  } else {
    lines.push('  模型      未配置 —— 在 .env 里写 AI_DEEPSEEK_KEY=sk-xxx 后重启');
  }
  lines.push(
    '  同步      ' +
      (config.sync.enabled
        ? '每 ' + config.sync.intervalMin + ' 分钟检查一次上游 · 保留 ' + config.sync.keep + ' 个版本'
        : '已关闭')
  );
  lines.push('');
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  data.load();
  sync.init();

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch (e) {
          /* ignore */
        }
        return;
      }
      h.sendJson(res, 500, { error: err && err.message ? err.message : '服务端错误' });
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[错误] 端口 ' + config.port + ' 已被占用。换个端口：PORT=8888 node server/index.js');
    } else {
      console.error('[错误] ' + err.message);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log(banner());
    const s = sync.status();
    if (s.error) console.log('  [同步] 首次检测失败：' + s.error + '\n');
  });

  const shutdown = (sig) => {
    console.log('\n[退出] 收到 ' + sig + '，关闭服务');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
