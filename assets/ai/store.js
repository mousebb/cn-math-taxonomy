/* 问老师的本地存储层：对话线程 + 错题本。
 *
 * 为什么单独抽一层：现在只有浏览器本地，M2 上账号后要换成云端。
 * 调用方只认 CnmTutorStore 这几个方法，换实现不用改 chat.js。
 *
 * 存储分两个 key：
 *   cnm.tutor.threads.v1   {v, items:{[key]: Thread}}
 *   cnm.tutor.mistakes.v1  {v, items:[Mistake]}
 *
 * Thread = {
 *   key, kind:'q'|'t'|'free', qid, tid, subject, topicName, kidId,
 *   title,            // 列表里显示的一行摘要
 *   ctx,              // 发起时的上下文快照（离开那道题也能继续问）
 *   msgs: [{r:'user'|'assistant', c:String, t:Number}],
 *   createdAt, updatedAt
 * }
 *
 * Mistake = {
 *   id,               // qid + 日期，同题同天只记一次（重复错靠 count 体现不了，
 *                     // 但同一天反复刷同一题没有信息量，反而会淹没别的错题）
 *   qid, tid, subject, tname, qtext,
 *   ans,              // 学生当时填的
 *   verdict,          // wrong | skip | correct
 *   note,             // 老师这次的第一句结论（收尾时补）
 *   thread,           // 对应线程 key，点进去能看完整讲解
 *   count, firstAt, lastAt
 * }
 */
(function () {
  'use strict';

  var THREADS_KEY = 'cnm.tutor.threads.v1';
  var MISTAKES_KEY = 'cnm.tutor.mistakes.v1';

  /* 浏览器 localStorage 一般按字符数算配额（约 5M）。留足余量，
   * 因为同一个域下还有孩子档案、诊断记录、题库缓存。 */
  var THREAD_MAX = 80;
  var MSG_MAX = 200;
  var MSG_CHAR_MAX = 8000;
  var TOTAL_CHAR_MAX = 1800000;
  var MISTAKE_MAX = 300;

  var listeners = [];
  var dirty = { threads: false, mistakes: false };
  var flushTimer = 0;
  var cache = { threads: null, mistakes: null };
  var quotaWarned = false;

  /* ------------------------------------------------------------ 底层读写 */
  function readRaw(key, fallback) {
    try {
      var text = localStorage.getItem(key);
      if (!text) return fallback;
      var v = JSON.parse(text);
      if (!v || typeof v !== 'object') return fallback;
      return v;
    } catch (e) {
      /* JSON 坏了就当没有，不要让它挡住面板打开 */
      return fallback;
    }
  }

  function writeRaw(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageOk() {
    try {
      var k = '__cnm_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  var HAS_LS = storageOk();
  var mem = { threads: { v: 1, items: {} }, mistakes: { v: 1, items: [] } };

  function shapeThreads(raw) {
    if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') {
      return { v: 1, items: {} };
    }
    var items = {};
    Object.keys(raw.items).forEach(function (k) {
      var t = raw.items[k];
      if (!t || typeof t !== 'object') return;
      if (!Array.isArray(t.msgs)) t.msgs = [];
      t.msgs = t.msgs
        .filter(function (m) { return m && (m.r === 'user' || m.r === 'assistant') && typeof m.c === 'string' && m.c; })
        .map(function (m) { return { r: m.r, c: String(m.c).slice(0, MSG_CHAR_MAX), t: Number(m.t) || 0 }; })
        .slice(-MSG_MAX);
      items[k] = t;
    });
    return { v: 1, items: items };
  }

  function shapeMistakes(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return { v: 1, items: [] };
    return { v: 1, items: raw.items.filter(function (m) { return m && m.id; }).slice(-MISTAKE_MAX) };
  }

  function threads() {
    if (cache.threads) return cache.threads;
    var raw = HAS_LS ? readRaw(THREADS_KEY, null) : null;
    cache.threads = shapeThreads(raw || mem.threads);
    return cache.threads;
  }

  function mistakes() {
    if (cache.mistakes) return cache.mistakes;
    var raw = HAS_LS ? readRaw(MISTAKES_KEY, null) : null;
    cache.mistakes = shapeMistakes(raw || mem.mistakes);
    return cache.mistakes;
  }

  /* 写盘节流：流式回答期间不会反复序列化整份数据 */
  function scheduleFlush(which) {
    dirty[which] = true;
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = 0;
      flushThreads();
      flushMistakes();
      emit();
    }, 60);
  }

  function flushThreads() {
    if (!dirty.threads) return;
    dirty.threads = false;
    var data = threads();
    trimThreads(data);
    if (!HAS_LS) {
      mem.threads = data;
      return;
    }
    /* 配额不够时从最旧的开始丢，丢到写得进去为止。
     * 宁可少留几条历史，也不能让「保存失败」把整份数据搞成只读。 */
    for (var attempt = 0; attempt < 6; attempt += 1) {
      if (writeRaw(THREADS_KEY, data)) return;
      var keys = Object.keys(data.items);
      if (keys.length <= 1) break;
      keys.sort(function (a, b) { return (data.items[a].updatedAt || 0) - (data.items[b].updatedAt || 0); });
      delete data.items[keys[0]];
    }
    if (!quotaWarned) {
      quotaWarned = true;
      try { console.warn('[问老师] 本地存储空间不够，已丢弃最早的对话记录。'); } catch (e) { /* ignore */ }
    }
  }

  function flushMistakes() {
    if (!dirty.mistakes) return;
    dirty.mistakes = false;
    var data = mistakes();
    data.items = data.items.slice(-MISTAKE_MAX);
    if (!HAS_LS) {
      mem.mistakes = data;
      return;
    }
    if (!writeRaw(MISTAKES_KEY, data)) {
      /* 错题本比历史更重要：历史可以让位 */
      data.items = data.items.slice(-Math.floor(MISTAKE_MAX / 2));
      writeRaw(MISTAKES_KEY, data);
    }
  }

  function trimThreads(data) {
    var keys = Object.keys(data.items);
    if (keys.length > THREAD_MAX) {
      keys.sort(function (a, b) { return (data.items[a].updatedAt || 0) - (data.items[b].updatedAt || 0); });
      keys.slice(0, keys.length - THREAD_MAX).forEach(function (k) { delete data.items[k]; });
      keys = Object.keys(data.items);
    }
    /* 总量兜底：超了就从最旧的整条删，比按字符截断更好理解 */
    var size = 0;
    try { size = JSON.stringify(data).length; } catch (e) { return; }
    if (size <= TOTAL_CHAR_MAX) return;
    keys.sort(function (a, b) { return (data.items[a].updatedAt || 0) - (data.items[b].updatedAt || 0); });
    for (var i = 0; i < keys.length && size > TOTAL_CHAR_MAX; i += 1) {
      size -= JSON.stringify(data.items[keys[i]]).length;
      delete data.items[keys[i]];
    }
  }

  function emit() {
    listeners.slice().forEach(function (fn) {
      try { fn(); } catch (e) { /* 订阅方出错不影响存储 */ }
    });
  }

  /* -------------------------------------------------------------- 线程 API */
  function listThreads() {
    var data = threads();
    return Object.keys(data.items)
      .map(function (k) { return data.items[k]; })
      .filter(function (t) { return t && Array.isArray(t.msgs) && t.msgs.length; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
      .map(function (t) {
        return {
          key: t.key,
          kind: t.kind,
          qid: t.qid || null,
          tid: t.tid || null,
          subject: t.subject || 'math',
          topicName: t.topicName || '',
          kidId: t.kidId || null,
          title: t.title || '未命名对话',
          turns: t.msgs.filter(function (m) { return m.r === 'user'; }).length,
          updatedAt: t.updatedAt || 0,
        };
      });
  }

  function getThread(key) {
    if (!key) return null;
    var t = threads().items[key];
    return t ? t : null;
  }

  function saveThread(t) {
    if (!t || !t.key) return null;
    if (!Array.isArray(t.msgs)) t.msgs = [];
    t.msgs = t.msgs
      .filter(function (m) { return m && typeof m.c === 'string' && m.c; })
      .slice(-MSG_MAX)
      .map(function (m) {
        return { r: m.r === 'assistant' ? 'assistant' : 'user', c: String(m.c).slice(0, MSG_CHAR_MAX), t: m.t || Date.now() };
      });
    if (!t.msgs.length) {
      removeThread(t.key);
      return null;
    }
    var now = Date.now();
    t.createdAt = t.createdAt || now;
    t.updatedAt = now;
    threads().items[t.key] = t;
    scheduleFlush('threads');
    return t;
  }

  function removeThread(key) {
    var data = threads();
    if (!data.items[key]) return false;
    delete data.items[key];
    scheduleFlush('threads');
    return true;
  }

  function clearThreads() {
    cache.threads = { v: 1, items: {} };
    dirty.threads = true;
    flushThreads();
    emit();
  }

  /* ------------------------------------------------------------- 错题本 API */
  function dayKey(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function addMistake(m) {
    if (!m || !m.qid) return null;
    var data = mistakes();
    var now = m.at || Date.now();
    var id = m.id || (m.qid + '@' + dayKey(now));
    var found = null;
    data.items.forEach(function (x) { if (x.id === id) found = x; });
    if (found) {
      found.lastAt = now;
      /* 同一天、同一道题反复追问，是同一个事件，不重复计数。
       * 隔天再错会落到新的日期 id 上，grouped() 里自然累加。 */
      if (m.ans) found.ans = m.ans;
      if (m.verdict) found.verdict = m.verdict;
      if (m.note) found.note = m.note;
      if (m.thread) found.thread = m.thread;
      scheduleFlush('mistakes');
      return found;
    }
    var item = {
      id: id,
      qid: m.qid,
      tid: m.tid || null,
      subject: m.subject || 'math',
      tname: m.tname || '',
      qtext: String(m.qtext || '').slice(0, 300),
      ans: String(m.ans || '').slice(0, 120),
      verdict: m.verdict || 'wrong',
      note: String(m.note || '').slice(0, 240),
      thread: m.thread || '',
      count: 1,
      firstAt: now,
      lastAt: now,
    };
    data.items.push(item);
    if (data.items.length > MISTAKE_MAX) data.items = data.items.slice(-MISTAKE_MAX);
    scheduleFlush('mistakes');
    return item;
  }

  /* 老师讲完后回头补一句结论，不新增条目 */
  function patchMistake(id, patch) {
    if (!id || !patch) return false;
    var data = mistakes();
    var hit = null;
    data.items.forEach(function (x) { if (x.id === id) hit = x; });
    if (!hit) return false;
    if (patch.note) hit.note = String(patch.note).slice(0, 240);
    if (patch.thread) hit.thread = patch.thread;
    if (patch.tid) hit.tid = patch.tid;
    if (patch.tname) hit.tname = patch.tname;
    scheduleFlush('mistakes');
    return true;
  }

  function removeMistake(id) {
    var data = mistakes();
    var before = data.items.length;
    data.items = data.items.filter(function (x) { return x.id !== id; });
    if (data.items.length === before) return false;
    scheduleFlush('mistakes');
    return true;
  }

  function clearMistakes() {
    cache.mistakes = { v: 1, items: [] };
    dirty.mistakes = true;
    flushMistakes();
    emit();
  }

  function listMistakes() {
    return mistakes().items.slice().sort(function (a, b) { return (b.lastAt || 0) - (a.lastAt || 0); });
  }

  /* 按知识点归类：老师要的是「这块他一直不行」，不是一堆孤立错题 */
  function groupMistakes() {
    var by = {};
    var order = [];
    listMistakes().forEach(function (m) {
      var gid = m.tid || 'unknown';
      if (!by[gid]) {
        by[gid] = { tid: m.tid || null, tname: m.tname || '未归到知识点', items: [], count: 0, lastAt: 0, oldestAt: 0 };
        order.push(gid);
      }
      var g = by[gid];
      g.items.push(m);
      g.count += m.count || 1;
      if ((m.lastAt || 0) > g.lastAt) g.lastAt = m.lastAt || 0;
      if (!g.oldestAt || (m.lastAt || 0) < g.oldestAt) g.oldestAt = m.lastAt || 0;
    });
    return order
      .map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.lastAt - a.lastAt; });
  }

  /* 给服务端用的精简版：只保留模型判断需要的字段，且限制条数，别把请求撑大。
   * excludeQid 用来排掉「当前这道题」——它的作答已经在 system 的「这题为什么出给他」里，
   * 再当历史重复一遍只是白烧 token。 */
  function memoryPayload(limit, excludeQid) {
    var max = limit || 20;
    var items = listMistakes()
      .filter(function (m) { return !excludeQid || m.qid !== excludeQid; })
      .slice(0, max)
      .map(function (m) {
        return {
          tid: m.tid || null,
          tname: m.tname || '',
          ans: m.ans || '',
          verdict: m.verdict || 'wrong',
          note: (m.note || '').slice(0, 120),
          at: m.lastAt || 0,
          /* 服务端在别的时区也别说错「今天」，相对时间在这儿算好 */
          when: when(m.lastAt),
          count: m.count || 1,
        };
      });
    return items.length ? items : null;
  }

  /* 输出便于人读的相对时间：今天/昨天/3 天前/10-24 */
  function when(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var day = 86400000;
    var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((t0 - t1) / day);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff > 1 && diff < 7) return diff + ' 天前';
    return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  window.CnmTutorStore = {
    available: HAS_LS,
    threads: {
      list: listThreads,
      get: getThread,
      save: saveThread,
      remove: removeThread,
      clear: clearThreads,
    },
    mistakes: {
      list: listMistakes,
      grouped: groupMistakes,
      add: addMistake,
      patch: patchMistake,
      remove: removeMistake,
      clear: clearMistakes,
      memory: memoryPayload,
    },
    when: when,
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      };
    },
    /* 立刻落盘（关页面、切换线程前调用） */
    flush: function () {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
      flushThreads();
      flushMistakes();
      emit();
    },
  };
})();
