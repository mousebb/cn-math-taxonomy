'use strict';

/* 题库同步：只做三件事
 *   1. 定时 git fetch 上游，比对 data/ 有没有变化（只读，不落盘）
 *   2. 管理员手动确认后，把目标版本写进隔离沙箱，跑上游那版自己的 validate.py
 *   3. 校验通过才原子替换 data/；失败则 data/ 一个字节都没动过
 *
 * 纪律：
 *   - 不 git pull、不 git checkout（checkout 会写暂存区，污染 git status）
 *   - 只用 git show 取内容，工作区的 git 索引永远干净
 *   - 任何一步出错，data/ 保持原样
 *
 * 为什么需要沙箱：validate.py 把 ROOT/data 写死在 __file__ 推导出来的路径上，
 * 想复用它就必须让它看到一个伪造的根目录。于是 runtime/validate/ 下复制一份
 * scripts/ 和待校验的 data/，ROOT 自然指向 runtime/validate。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('./config');
const data = require('./data');

const STATE_FILE = path.join(config.runtimeDir, 'sync-state.json');
const VERSIONS_DIR = path.join(config.runtimeDir, 'versions');
const SANDBOX = path.join(config.runtimeDir, 'validate');
const SANDBOX_DATA = path.join(SANDBOX, 'data');
const SANDBOX_SCRIPTS = path.join(SANDBOX, 'scripts');

const FILES = config.sync.files;
const PY_TIMEOUT = 180000;

/* ---------------------------------------------------------------- 状态 */

function emptyState() {
  return {
    checkedAt: null,
    localSha: null,
    upstreamSha: null,
    appliedSha: null,
    pending: false,
    files: [],
    changes: {},
    versions: [],
    error: null,
    lastApply: null,
    dirty: null,
    engine: null,
  };
}

let state = emptyState();

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = Object.assign(emptyState(), raw);
  } catch (err) {
    state = emptyState();
  }
  return state;
}

function saveState() {
  try {
    fs.mkdirSync(config.runtimeDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    /* 写不进状态文件不该让同步功能炸掉 */
  }
}

/* ---------------------------------------------------------------- git */

function git(args, opts) {
  const options = Object.assign(
    { cwd: config.root, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    opts || {}
  );
  return new Promise((resolve, reject) => {
    execFile('git', args, options, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim().slice(0, 400);
        reject(new Error('git ' + args.slice(0, 2).join(' ') + ' 失败：' + msg));
        return;
      }
      resolve(stdout);
    });
  });
}

function short(sha) {
  return String(sha || '').slice(0, 7);
}

function readJsonCount(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch (err) {
    return null;
  }
}

/* 取某个 commit 里 data 下文件的内容，不落盘、不碰索引 */
async function readAt(sha, file) {
  const out = await git(['show', sha + ':data/' + file], { encoding: 'buffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');
}

/* 解析 --numstat 输出：每行 "增\t删\t路径" */
function parseNumstat(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [added, removed, file] = parts;
    rows.push({
      file: file.replace(/^data\//, ''),
      added: added === '-' ? 0 : Number(added),
      removed: removed === '-' ? 0 : Number(removed),
    });
  }
  return rows;
}

async function headSha() {
  const out = await git(['rev-parse', 'HEAD']);
  return String(out).trim();
}

/* 确认这个 commit 在本地对象库里，没有就补一次 fetch */
async function ensureCommit(sha) {
  const exists = await git(['cat-file', '-e', sha + '^{commit}'])
    .then(() => true)
    .catch(() => false);
  if (exists) return;
  await git(['fetch', '--quiet', '--no-tags', config.sync.upstream, config.sync.branch]);
  await git(['cat-file', '-e', sha + '^{commit}']);
}

/* data/ 相对 git HEAD 是否真的变了。
 * 用 git diff 而不是 git status：Windows 上 core.autocrlf=true 时，
 * status 会因为行尾/stat 把没改内容的文件也标成 M，diff 才是内容真相。 */
async function dirtyData() {
  try {
    const out = String(await git(['diff', '--name-only', 'HEAD', '--', 'data/']));
    const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return { dirty: files.length > 0, count: files.length, files };
  } catch (err) {
    return null;
  }
}

/* ---------------------------------------------------------------- 检测 */

/* 只读检测：fetch + 比对，不改工作区 */
async function check() {
  if (!config.sync.enabled) {
    state.checkedAt = new Date().toISOString();
    state.error = null;
    return state;
  }

  try {
    await git(['fetch', '--quiet', '--no-tags', config.sync.upstream, config.sync.branch]);
    const upstreamSha = String(await git(['rev-parse', 'FETCH_HEAD'])).trim();
    const localSha = state.appliedSha || (await headSha());

    state.checkedAt = new Date().toISOString();
    state.upstreamSha = upstreamSha;
    state.localSha = localSha;
    state.error = null;

    if (upstreamSha === localSha) {
      state.pending = false;
      state.files = [];
      state.changes = {};
      saveState();
      return state;
    }

    const numstat = await git(['diff', '--numstat', localSha, upstreamSha, '--', 'data/']);
    state.files = parseNumstat(numstat);
    state.pending = state.files.length > 0;

    /* 题数 / 知识点数变化，用户最关心这两个数 */
    if (state.pending) {
      const changes = {};
      for (const name of ['questions.json', 'topics.json', 'dependencies.json']) {
        if (!state.files.some((f) => f.file === name)) continue;
        try {
          const before = readJsonCount((await readAt(localSha, name)).toString('utf8'));
          const after = readJsonCount((await readAt(upstreamSha, name)).toString('utf8'));
          if (before != null && after != null) changes[name] = { from: before, to: after, delta: after - before };
        } catch (err) {
          /* 单个文件取不到不影响整体状态 */
        }
      }
      state.changes = changes;
    }
  } catch (err) {
    state.checkedAt = new Date().toISOString();
    state.error = err.message;
    saveState();
  }

  saveState();
  return state;
}

/* ---------------------------------------------------------------- 快照 */

function listVersions() {
  try {
    const names = fs.readdirSync(VERSIONS_DIR);
    const rows = [];
    for (const name of names) {
      const metaFile = path.join(VERSIONS_DIR, name, 'meta.json');
      try {
        rows.push(JSON.parse(fs.readFileSync(metaFile, 'utf8')));
      } catch (err) {
        /* 残缺目录忽略 */
      }
    }
    rows.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    return rows;
  } catch (err) {
    return [];
  }
}

/* 把当前 data/ 快照到 runtime/versions/<short>/ ，绝不覆盖已有快照 */
function snapshotCurrent(sha) {
  const base = short(sha) || 'unknown';
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(VERSIONS_DIR, id))) {
    id = base + '-' + n;
    n += 1;
  }
  const dir = path.join(VERSIONS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const stats = {};
  for (const file of FILES) {
    const from = path.join(config.dataDir, file);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dir, file));
    try {
      stats[file] = readJsonCount(fs.readFileSync(from, 'utf8'));
    } catch (err) {
      stats[file] = null;
    }
  }
  const meta = { sha, short: id, savedAt: new Date().toISOString(), stats };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return meta;
}

/* 校验没过、data/ 根本没动时，这份快照就是当前数据的副本，留着只会挤掉有用的版本 */
function dropSnapshot(meta) {
  if (!meta || !meta.short) return;
  try {
    fs.rmSync(path.join(VERSIONS_DIR, meta.short), { recursive: true, force: true });
  } catch (err) {
    /* ignore */
  }
  state.versions = listVersions();
}

function pruneVersions() {
  const keep = Math.max(1, config.sync.keep);
  const all = listVersions();
  for (const meta of all.slice(keep)) {
    const dir = path.join(VERSIONS_DIR, meta.short);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      /* 删不掉就算了，下次再试 */
    }
  }
  state.versions = listVersions();
}

/* ---------------------------------------------------------------- 沙箱 */

function emptyDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    /* ignore */
  }
  fs.mkdirSync(dir, { recursive: true });
}

/* 把目标版本的数据写进沙箱（不碰真实 data/）。
 * 顺带把上游那一版自己的 scripts/validate.py 拷过来：用它的规则校验它的数据。 */
async function stageVersion(sha) {
  emptyDir(SANDBOX_DATA);
  fs.mkdirSync(SANDBOX_SCRIPTS, { recursive: true });

  const counts = {};
  for (const file of FILES) {
    let buf;
    try {
      buf = await readAt(sha, file);
    } catch (err) {
      continue; /* 上游没有这个文件就跳过 */
    }
    fs.writeFileSync(path.join(SANDBOX_DATA, file), buf);
    if (file.endsWith('.json')) counts[file] = readJsonCount(buf.toString('utf8'));
  }

  /* validate.py 会检查 data/mappings/，目录不存在时返回 0，不算错；存在就带上 */
  const mapDir = path.join(config.dataDir, 'mappings');
  if (fs.existsSync(mapDir)) {
    fs.cpSync(mapDir, path.join(SANDBOX_DATA, 'mappings'), { recursive: true });
  }

  let validateSource = 'local';
  for (const name of ['validate.py', 'check_figures.py']) {
    const target = path.join(SANDBOX_SCRIPTS, name);
    let got = false;
    try {
      const buf = await git(['show', sha + ':scripts/' + name], { encoding: 'buffer' });
      fs.writeFileSync(target, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'));
      got = true;
      if (name === 'validate.py') validateSource = 'upstream';
    } catch (err) {
      got = false;
    }
    if (!got) {
      const local = path.join(config.root, 'scripts', name);
      if (fs.existsSync(local)) fs.copyFileSync(local, target);
      if (name === 'validate.py') validateSource = 'local';
    }
  }

  return { counts, validateSource };
}

/* ---------------------------------------------------------------- 校验 */

let pythonBin;

function detectPython() {
  if (pythonBin !== undefined) return Promise.resolve(pythonBin);
  const cands =
    process.platform === 'win32'
      ? [['python', []], ['py', ['-3']], ['python3', []]]
      : [['python3', []], ['python', []]];
  return new Promise((resolve) => {
    const step = (i) => {
      if (i >= cands.length) {
        pythonBin = null;
        resolve(null);
        return;
      }
      const [cmd, pre] = cands[i];
      execFile(cmd, pre.concat(['-V']), { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
        const v = (String(stdout || '') + String(stderr || '')).trim();
        if (err || !/^Python\s+3\./.test(v)) {
          step(i + 1);
          return;
        }
        pythonBin = { cmd, pre, version: v };
        resolve(pythonBin);
      });
    };
    step(0);
  });
}

/* 内置校验：没有 python 时的兜底，查最关键的不变量。
 * 不如上游 validate.py 严，但能挡住「JSON 坏了 / id 重复 / 边指向不存在的点 / 有环」这类致命问题。 */
function builtinValidate() {
  const lines = [];
  const errors = [];
  const readArr = (name) => {
    const p = path.join(SANDBOX_DATA, name);
    if (!fs.existsSync(p)) return null;
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(v)) {
        errors.push(name + ' 顶层必须是数组');
        return null;
      }
      return v;
    } catch (e) {
      errors.push(name + ' JSON 不合法：' + e.message);
      return null;
    }
  };

  const topics = readArr('topics.json');
  const deps = readArr('dependencies.json');
  const questions = readArr('questions.json');
  if (!topics || !deps) {
    errors.push('缺少 topics.json 或 dependencies.json');
    return { ok: false, output: errors.concat(['VALIDATION FAILED']).join('\n') };
  }

  const ids = new Map();
  for (const t of topics) {
    if (!t || !t.id) {
      errors.push('topics 里有条目缺少 id');
      continue;
    }
    if (ids.has(t.id)) errors.push('知识点 id 重复：' + t.id);
    ids.set(t.id, t);
  }

  const prereqs = new Map();
  const seenEdges = new Set();
  let nHard = 0;
  for (const d of deps) {
    const a = d && d.topicId;
    const b = d && d.prerequisiteId;
    if (!a || !b) {
      errors.push('dependencies 里有条目缺少 topicId / prerequisiteId');
      continue;
    }
    if (!ids.has(a)) errors.push('先修边的 topicId 不存在：' + a);
    if (!ids.has(b)) errors.push('先修边的 prerequisiteId 不存在：' + b);
    if (a === b) errors.push('先修边自环：' + a);
    if (seenEdges.has(a + '>' + b)) errors.push('重复边：' + a + ' -> ' + b);
    seenEdges.add(a + '>' + b);
    if (d.strength === 'hard') nHard += 1;
    if (!prereqs.has(a)) prereqs.set(a, []);
    prereqs.get(a).push(b);
  }

  /* 环检测（迭代 DFS，避免深图爆栈） */
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map();
  let cycle = null;
  for (const start of ids.keys()) {
    if (cycle) break;
    if ((color.get(start) || WHITE) !== WHITE) continue;
    const stack = [[start, 0]];
    const order = [start];
    color.set(start, GREY);
    while (stack.length && !cycle) {
      const top = stack[stack.length - 1];
      const list = prereqs.get(top[0]) || [];
      if (top[1] >= list.length) {
        color.set(top[0], BLACK);
        stack.pop();
        order.pop();
        continue;
      }
      const nxt = list[top[1]];
      top[1] += 1;
      if (!ids.has(nxt)) continue;
      const c = color.get(nxt) || WHITE;
      if (c === GREY) {
        cycle = order.slice(order.indexOf(nxt)).concat([nxt]);
        break;
      }
      if (c === WHITE) {
        color.set(nxt, GREY);
        stack.push([nxt, 0]);
        order.push(nxt);
      }
    }
  }
  if (cycle) errors.push('存在环路：' + cycle.join(' -> '));

  if (questions) {
    const qids = new Set();
    let nChoice = 0;
    for (const q of questions) {
      if (!q || !q.id) {
        errors.push('题目缺少 id');
        continue;
      }
      if (qids.has(q.id)) errors.push('题目 id 重复：' + q.id);
      qids.add(q.id);
      if (!q.topicId || !ids.has(q.topicId)) errors.push(q.id + ' 的 topicId 不存在：' + q.topicId);
      if (!q.prompt || !String(q.prompt).trim()) errors.push(q.id + ' 题干为空');
      if (q.answer == null || !String(q.answer).trim()) errors.push(q.id + ' 答案为空');
      if (q.type === 'choice') {
        nChoice += 1;
        const keys = Array.isArray(q.choices) ? q.choices.map((c) => c && c.key) : [];
        if (keys.length < 3 || keys.length > 4) errors.push(q.id + ' 选择题必须有 3-4 个选项');
        else if (!keys.includes(q.answer)) errors.push(q.id + ' 答案不是任何一个选项');
      }
    }
    lines.push('题库：共 ' + questions.length + ' 题（选择题 ' + nChoice + '）');
  }

  lines.unshift(
    '知识点：' + topics.length + ' 个；先修边：' + deps.length +
    ' 条（hard ' + nHard + '，soft ' + (deps.length - nHard) + '）'
  );

  if (errors.length) {
    const head = errors.slice(0, 40);
    lines.push('错误：' + errors.length + ' 个');
    for (const e of head) lines.push('  ' + e);
    if (errors.length > head.length) lines.push('  ……另有 ' + (errors.length - head.length) + ' 个');
    lines.push('VALIDATION FAILED');
    return { ok: false, output: lines.join('\n') };
  }
  lines.push('VALIDATION PASSED');
  return { ok: true, output: lines.join('\n') };
}

/* 跑校验闸门。返回 { ok, output, engine } */
async function runValidate() {
  const script = path.join(SANDBOX_SCRIPTS, 'validate.py');
  const forced = String(config.sync.validator || 'auto').toLowerCase() === 'builtin';
  const py = forced ? null : await detectPython();

  if (forced || !fs.existsSync(script) || !py) {
    const r = builtinValidate();
    state.engine = { python: null, source: 'builtin' };
    return {
      ok: r.ok,
      output: (forced ? '（已按 SYNC_VALIDATOR=builtin 强制使用内置校验）\n' : '（未找到 python3，已改用内置校验）\n') + r.output,
      engine: 'builtin',
    };
  }

  const output = await new Promise((resolve) => {
    execFile(
      py.cmd,
      py.pre.concat([script]),
      { cwd: SANDBOX, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: PY_TIMEOUT },
      (err, stdout, stderr) => {
        resolve((String(stdout || '') + String(stderr || '')).trim());
      }
    );
  });

  state.engine = { python: py.version, source: 'upstream' };
  return { ok: /VALIDATION PASSED/.test(output), output: output.slice(-4000), engine: 'upstream' };
}

/* ---------------------------------------------------------------- 切换 */

/* 原子替换：先在同目录写临时文件，再 rename 覆盖。
 * rename 在同一个文件系统内是原子操作，几个文件也是毫秒级，
 * 静态托管不会读到「topics 是新的、questions 还是旧的」这种中间态。 */
function atomicInstall(srcDir) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmpSuffix = '.sync-tmp';
  const pending = [];

  for (const file of FILES) {
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) continue;
    const buf = fs.readFileSync(src);
    const dest = path.join(config.dataDir, file);
    /* 内容一样就不写：少动一个文件就少一个不一致窗口，也少一行假的 git 改动。
     * 比较时统一去掉 \r，否则 Windows 上 core.autocrlf 会把「内容相同、行尾不同」误判成改动。 */
    try {
      const cur = fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n');
      if (cur === buf.toString('utf8').replace(/\r\n/g, '\n')) continue;
    } catch (err) {
      /* 目标不存在，继续写 */
    }
    const tmp = path.join(config.dataDir, '.' + file + tmpSuffix);
    fs.writeFileSync(tmp, buf);
    pending.push({ tmp, dest });
  }
  if (!pending.length) return { changed: 0 };

  for (const p of pending) {
    fs.renameSync(p.tmp, p.dest);
  }
  return { changed: pending.length };
}

function restoreFrom(dir) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const file of FILES) {
    const src = path.join(dir, file);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(config.dataDir, file));
  }
}

/* ---------------------------------------------------------------- 并发锁 */

let busy = null;

function busyError() {
  const err = new Error('另一个同步任务正在执行（' + busy + '），请稍后再试');
  err.code = 'SYNC_BUSY';
  return err;
}

/* ---------------------------------------------------------------- 应用 */

async function apply(sha) {
  if (!config.sync.enabled) throw new Error('同步功能已关闭');
  const target = String(sha || state.upstreamSha || '').trim();
  if (!/^[0-9a-f]{7,40}$/.test(target)) throw new Error('版本号不合法');
  if (busy) throw busyError();

  busy = 'apply ' + short(target);
  try {
    await ensureCommit(target);
    const currentSha = state.appliedSha || (await headSha());
    const snapshot = snapshotCurrent(currentSha);

    let staged;
    try {
      staged = await stageVersion(target);
    } catch (err) {
      dropSnapshot(snapshot);
      state.lastApply = {
        at: new Date().toISOString(),
        ok: false,
        target,
        stage: 'stage',
        message: '取上游数据失败，data/ 未改动',
        output: err.message,
      };
      saveState();
      return { ok: false, stage: 'stage', message: '取上游数据失败，data/ 未改动', output: err.message };
    }

    const result = await runValidate();

    if (!result.ok) {
      dropSnapshot(snapshot);
      state.lastApply = {
        at: new Date().toISOString(),
        ok: false,
        target,
        from: currentSha,
        stage: 'validate',
        message: '校验没过，data/ 未改动（仍是 ' + short(currentSha) + '）',
        output: result.output,
        engine: result.engine,
        counts: staged.counts,
      };
      saveState();
      return {
        ok: false,
        stage: 'validate',
        message: '校验没过，data/ 未改动',
        output: result.output,
        engine: result.engine,
        counts: staged.counts,
      };
    }

    try {
      atomicInstall(SANDBOX_DATA);
    } catch (err) {
      /* 替换中途失败：用快照恢复，保证 data/ 不是半新半旧 */
      restoreFrom(path.join(VERSIONS_DIR, snapshot.short));
      data.reload();
      dropSnapshot(snapshot);
      state.lastApply = {
        at: new Date().toISOString(),
        ok: false,
        target,
        from: currentSha,
        stage: 'install',
        message: '写入失败，已用快照 ' + snapshot.short + ' 恢复',
        output: err.message,
      };
      saveState();
      return { ok: false, stage: 'install', message: '写入失败，已恢复原样', output: err.message };
    }

    data.reload();
    state.appliedSha = target;
    state.localSha = target;
    state.upstreamSha = target;
    state.pending = false;
    state.files = [];
    state.changes = {};
    state.checkedAt = new Date().toISOString();
    state.error = null;
    state.dirty = await dirtyData();
    state.lastApply = {
      at: new Date().toISOString(),
      ok: true,
      target,
      from: currentSha,
      stage: 'done',
      message: '已切换到 ' + short(target),
      output: result.output,
      engine: result.engine,
      validateSource: staged.validateSource,
      counts: staged.counts,
    };
    pruneVersions();
    saveState();
    return {
      ok: true,
      message: '已切换到 ' + short(target),
      snapshot,
      versions: state.versions,
      engine: result.engine,
      counts: staged.counts,
      stats: data.graph().stats,
    };
  } finally {
    busy = null;
    emptyDir(SANDBOX_DATA);
  }
}

/* ---------------------------------------------------------------- 回退 */

async function rollback(shortId) {
  if (busy) throw busyError();
  const all = listVersions();
  if (!all.length) throw new Error('没有可回退的快照');
  const target = shortId ? all.find((v) => v.short === shortId || v.sha === shortId) : all[0];
  if (!target) throw new Error('找不到这个快照：' + shortId);

  const dir = path.join(VERSIONS_DIR, target.short);
  if (!fs.existsSync(dir)) throw new Error('快照目录不存在');

  busy = 'rollback ' + target.short;
  try {
    const currentSha = state.appliedSha || (await headSha());
    const before = snapshotCurrent(currentSha);

    try {
      atomicInstall(dir);
    } catch (err) {
      restoreFrom(path.join(VERSIONS_DIR, before.short));
      data.reload();
      dropSnapshot(before);
      state.lastApply = {
        at: new Date().toISOString(),
        ok: false,
        target: target.sha,
        from: currentSha,
        stage: 'install',
        message: '回退写入失败，数据未改动',
        output: err.message,
      };
      saveState();
      return { ok: false, message: '回退失败，数据未改动', output: err.message };
    }

    data.reload();
    state.appliedSha = target.sha;
    state.localSha = target.sha;
    state.pending = target.sha !== state.upstreamSha;
    state.dirty = await dirtyData();
    state.lastApply = {
      at: new Date().toISOString(),
      ok: true,
      target: target.sha,
      from: currentSha,
      stage: 'done',
      message: '已回退到 ' + target.short,
      rollback: true,
    };
    pruneVersions();
    saveState();
    return { ok: true, message: '已回退到 ' + target.short, restored: target, backup: before };
  } finally {
    busy = null;
  }
}

/* ---------------------------------------------------------------- 对外 */

function status() {
  return {
    enabled: config.sync.enabled,
    checkedAt: state.checkedAt,
    localSha: state.localSha,
    upstreamSha: state.upstreamSha,
    appliedSha: state.appliedSha,
    pending: state.pending,
    files: state.files,
    changes: state.changes,
    versions: listVersions(),
    lastApply: state.lastApply,
    dirty: state.dirty,
    engine: state.engine,
    python: pythonBin === undefined ? null : pythonBin ? pythonBin.version : '未找到',
    busy: busy,
    error: state.error,
    intervalMin: config.sync.intervalMin,
    keep: config.sync.keep,
    stats: data.graph().stats,
  };
}

let timer = null;

function init() {
  loadState();
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  /* 上次进程如果死在 apply 中途，沙箱里可能留着半成品，启动时清掉 */
  emptyDir(SANDBOX_DATA);
  detectPython().catch(() => {});
  if (!config.sync.enabled) return;
  check().catch(() => {});
  const ms = Math.max(5, config.sync.intervalMin) * 60 * 1000;
  timer = setInterval(() => {
    check().catch(() => {});
  }, ms);
  if (timer.unref) timer.unref();
}

module.exports = { init, check, status, apply, rollback, loadState, detectPython };
