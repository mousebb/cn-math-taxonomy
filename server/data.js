'use strict';

/* 数据层：把 11MB 的 JSON 读进内存并建索引。
 * 只读，不写任何 data/ 文件——题库同步由 server/sync.js 单独负责。
 * 字段一律防御式读取：上游加字段、缺字段都不应该让服务起不来。
 */

const fs = require('node:fs');
const path = require('node:path');

let current = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error('读取失败 ' + file + '：' + err.message);
  }
}

function gradeLabel(grade) {
  const n = Number(grade);
  if (!Number.isFinite(n)) return '';
  if (n >= 1 && n <= 9) return ['一', '二', '三', '四', '五', '六', '七', '八', '九'][n - 1] + '年级';
  if (n === 10 || n === 11 || n === 12) return ['高一', '高二', '高三'][n - 10];
  return '';
}

function build(dir) {
  const topics = readJson(path.join(dir, 'topics.json'), []);
  const deps = readJson(path.join(dir, 'dependencies.json'), []);
  const questions = readJson(path.join(dir, 'questions.json'), []);
  const aliasFile = readJson(path.join(dir, 'id-aliases.json'), { aliases: {} });

  const byId = new Map();
  for (const t of topics) {
    if (t && t.id) byId.set(t.id, t);
  }

  /* 先修边：prereqs[A] = A 依赖谁 */
  const prereqs = new Map();
  const dependents = new Map();
  for (const d of deps) {
    if (!d || !d.topicId || !d.prerequisiteId) continue;
    const edge = {
      id: d.prerequisiteId,
      strength: d.strength === 'soft' ? 'soft' : 'hard',
      reason: typeof d.reason === 'string' ? d.reason : '',
    };
    if (!prereqs.has(d.topicId)) prereqs.set(d.topicId, []);
    prereqs.get(d.topicId).push(edge);
    if (!dependents.has(d.prerequisiteId)) dependents.set(d.prerequisiteId, []);
    dependents.get(d.prerequisiteId).push({ id: d.topicId, strength: edge.strength });
  }
  /* 硬先修排前面，模型读起来更顺 */
  for (const list of prereqs.values()) {
    list.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'hard' ? -1 : 1));
  }

  const questionsByTopic = new Map();
  const questionById = new Map();
  for (const q of questions) {
    if (!q || !q.id || !q.topicId) continue;
    questionById.set(q.id, q);
    if (!questionsByTopic.has(q.topicId)) questionsByTopic.set(q.topicId, []);
    questionsByTopic.get(q.topicId).push(q);
  }

  const aliases = (aliasFile && aliasFile.aliases) || {};

  return {
    dir,
    topics,
    byId,
    prereqs,
    dependents,
    questionsByTopic,
    questionById,
    aliases,
    stats: {
      topics: topics.length,
      edges: deps.length,
      questions: questions.length,
    },
  };
}

function load(dir) {
  const target = dir || require('./config').dataDir;
  current = build(target);
  return current;
}

function graph() {
  if (!current) load();
  return current;
}

function reload(dir) {
  return load(dir);
}

/* 旧 id（cnm_ext_*）映射到代表知识点 */
function resolveId(id) {
  const g = graph();
  if (!id) return null;
  if (g.byId.has(id)) return id;
  const alias = g.aliases[id];
  if (alias && Array.isArray(alias.targets) && alias.targets.length) {
    const hit = alias.targets.find((x) => g.byId.has(x));
    if (hit) return hit;
  }
  return null;
}

function topic(id) {
  const g = graph();
  const real = resolveId(id);
  return real ? g.byId.get(real) || null : null;
}

/* 先修链：从 topicId 往回 BFS，返回按层分组的结果。
 * 只走 hard 边可以过滤掉弱相关，但讲解时保留 soft 更有信息量。 */
function ancestors(id, depth, opts) {
  const g = graph();
  const maxDepth = Math.max(1, Math.min(6, Number(depth) || 2));
  const hardOnly = !!(opts && opts.hardOnly);
  const limitPerLevel = (opts && opts.limitPerLevel) || 10;

  const start = resolveId(id);
  if (!start) return [];

  const seen = new Set([start]);
  let frontier = [start];
  const levels = [];

  for (let d = 1; d <= maxDepth && frontier.length; d += 1) {
    const next = [];
    for (const nodeId of frontier) {
      const edges = g.prereqs.get(nodeId) || [];
      for (const e of edges) {
        if (seen.has(e.id)) continue;
        if (hardOnly && e.strength !== 'hard') continue;
        if (!g.byId.has(e.id)) continue;
        seen.add(e.id);
        next.push({ id: e.id, strength: e.strength, reason: e.reason, from: nodeId, level: d });
      }
    }
    if (!next.length) break;
    levels.push(next.slice(0, limitPerLevel));
    frontier = next.map((x) => x.id);
  }
  return levels;
}

function questionsOf(topicId, limit) {
  const g = graph();
  const real = resolveId(topicId);
  const list = (real && g.questionsByTopic.get(real)) || [];
  return limit ? list.slice(0, limit) : list.slice();
}

function question(id) {
  const g = graph();
  return g.questionById.get(id) || null;
}

function searchTopics(keyword, limit) {
  const g = graph();
  const q = String(keyword || '').trim();
  if (!q) return [];
  const out = [];
  for (const t of g.topics) {
    if (t.name && t.name.includes(q)) out.push(t);
    if (out.length >= (limit || 8)) break;
  }
  return out;
}

module.exports = {
  load,
  reload,
  graph,
  topic,
  resolveId,
  ancestors,
  questionsOf,
  question,
  searchTopics,
  gradeLabel,
};
