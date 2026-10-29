'use strict';

/* 极小的 HTTP 工具：响应、读 body、静态文件。零依赖。 */

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    'content-type': type || 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit) {
  const max = limit || 256 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' });
  }
}

/* 读二进制请求体（上传录音用）。readBody 会 toString('utf8')，音频走那条路会被破坏。
 * 超过上限时不能直接 destroy：那样浏览器只会看到连接中断，拿不到 413 的说明。
 * 正确做法是停止累积、把剩下的字节读掉（不占内存），再正常返回错误。 */
function readBinary(req, limit) {
  const max = limit || 8 * 1024 * 1024;
  const hardMax = max * 20;
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    let killed = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (!over && size > max) {
        over = true;
        chunks.length = 0;
      }
      if (!over) chunks.push(c);
      if (size > hardMax && !killed) {
        killed = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) reject(Object.assign(new Error('录音太大了，说短一点'), { code: 'TOO_LARGE' }));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (over) reject(Object.assign(new Error('录音太大了，说短一点'), { code: 'TOO_LARGE' }));
      else reject(Object.assign(new Error('读取请求体失败'), { code: 'READ_FAILED' }));
    });
  });
}

/* 静态文件：只允许 root 之内的路径，禁止目录穿越。 */
function serveStatic(req, res, root, urlPath, extraHeaders) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (err) {
    sendText(res, 400, 'bad path');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const file = path.resolve(root, safe);
  if (!file.startsWith(root + path.sep) && file !== root) {
    sendText(res, 403, 'forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      sendText(res, 404, 'not found');
      return;
    }
    const headers = Object.assign(
      {
        'content-type': mimeOf(file),
        'content-length': st.size,
        'last-modified': st.mtime.toUTCString(),
      },
      extraHeaders || {}
    );
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const s = fs.createReadStream(file);
    s.on('error', () => res.destroy());
    s.pipe(res);
  });
}

module.exports = { MIME, mimeOf, sendJson, sendText, readBody, readJson, readBinary, serveStatic };
