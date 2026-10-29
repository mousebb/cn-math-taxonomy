/* 题库更新提示条。由 chat.js 动态加载，页面不需要额外引 script。
 * 只做检测和人工确认：检测自动跑，应用/回退必须点按钮 + 填管理员令牌。
 * 如果是纯静态托管（没有后端），fetch 会失败，这个模块静默退出，不打扰用户。
 */
(function () {
  'use strict';

  var BASE = (window.CnmTutorBase || '/');
  if (BASE.slice(-1) !== '/') BASE += '/';

  var TOKEN_KEY = 'cnmSyncToken.v1';
  var state = { status: null, open: false, busy: false, timer: null };
  var dom = {};

  function h(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') n.textContent = v;
        else if (k === 'class') n.className = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(v) {
    try { localStorage.setItem(TOKEN_KEY, v || ''); } catch (e) { /* ignore */ }
  }

  async function api(path, body) {
    var opts = { method: body ? 'POST' : 'GET', headers: {} };
    if (body) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var token = getToken();
    if (token) opts.headers['x-admin-token'] = token;
    var res = await fetch(BASE + 'api/sync/' + path, opts);
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) {
      var msg = (json && (json.error || json.message)) || ('请求失败 ' + res.status);
      if (res.status === 409) msg = '另一个同步任务正在执行，等它跑完再点。';
      throw new Error(msg);
    }
    return json;
  }

  function describeChange() {
    var s = state.status;
    if (!s) return [];
    var rows = [];
    var c = s.changes || {};
    if (c['questions.json']) {
      rows.push('题目 ' + c['questions.json'].from + ' → ' + c['questions.json'].to +
        '（' + (c['questions.json'].delta > 0 ? '+' : '') + c['questions.json'].delta + '）');
    }
    if (c['topics.json']) {
      rows.push('知识点 ' + c['topics.json'].from + ' → ' + c['topics.json'].to);
    }
    if (!rows.length && s.files && s.files.length) {
      rows.push(s.files.map(function (f) { return f.file; }).join('、'));
    }
    return rows;
  }

  function render() {
    var s = state.status;
    if (!dom.wrap) return;

    var hasVersions = !!(s && Array.isArray(s.versions) && s.versions.length);
    var show = !!(s && s.enabled && (s.pending || state.open || hasVersions));
    dom.wrap.hidden = !show;
    if (!show) return;

    dom.title.textContent = s.pending ? '题库有新版本' : '题库已是最新';
    var rows = describeChange();
    dom.detail.textContent = rows.length
      ? rows.join(' · ')
      : (s.error ? '检测出错：' + s.error : '上次检查：' + (s.checkedAt || '—'));

    dom.meta.textContent = s.localSha
      ? '本地 ' + String(s.localSha).slice(0, 7) + ' ｜ 上游 ' + String(s.upstreamSha || '').slice(0, 7)
      : '';

    dom.applyBtn.hidden = !s.pending;
    dom.applyBtn.disabled = state.busy || !!s.busy;

    /* 环境提示：校验器是谁、data/ 是否已与 git HEAD 不同步 */
    var env = [];
    if (s.python === '未找到') env.push('没找到 python3，改用内置校验（比上游宽松）');
    else if (s.python) env.push('校验器 ' + s.python);
    if (s.dirty && s.dirty.dirty) env.push('data/ 已应用过更新，与 git HEAD 不同步（正常）');
    if (s.busy) env.push('正在执行：' + s.busy);
    dom.env.textContent = env.join(' · ');
    dom.env.hidden = !env.length;

    dom.versions.innerHTML = '';
    if (hasVersions) {
      dom.versions.appendChild(h('div', { class: 'cnm-sync-label', text: '可回退的版本' }));
      s.versions.forEach(function (v) {
        var btn = h('button', {
          class: 'cnm-sync-ver',
          type: 'button',
          title: '回退到这个版本',
          text: v.short + ' · ' + String(v.savedAt || '').slice(0, 10),
        });
        btn.disabled = state.busy;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          doRollback(v.short);
        });
        dom.versions.appendChild(btn);
      });
    }
  }

  async function refresh() {
    try {
      var res = await fetch(BASE + 'api/sync/status', { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      state.status = await res.json();
      render();
    } catch (e) {
      /* 没有后端就安静退出 */
    }
  }

  async function doApply() {
    state.busy = true;
    render();
    dom.msg.textContent = '正在校验并切换，可能要十几秒…';
    dom.msg.className = 'cnm-sync-msg';
    try {
      var out = await api('apply', { sha: state.status.upstreamSha, token: getToken() });
      if (out.ok) {
        setToken(dom.token.value.trim());
        var c = out.counts || {};
        var nums = [];
        if (c['questions.json'] != null) nums.push('题目 ' + c['questions.json']);
        if (c['topics.json'] != null) nums.push('知识点 ' + c['topics.json']);
        dom.msg.textContent = (out.message || '已更新') + (nums.length ? '（' + nums.join('，') + '）' : '');
        dom.msg.className = 'cnm-sync-msg ok';
      } else {
        var tail = out.output ? String(out.output).slice(-300) : '';
        var head = out.stage === 'validate' ? '校验没过，题库没动' : (out.message || '失败');
        dom.msg.textContent = head + (tail ? '：' + tail : '');
        dom.msg.className = 'cnm-sync-msg bad';
      }
    } catch (err) {
      dom.msg.textContent = err.message;
      dom.msg.className = 'cnm-sync-msg bad';
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  async function doRollback(short) {
    if (!window.confirm('回退到 ' + short + '？当前版本会先存一份快照。')) return;
    state.busy = true;
    render();
    try {
      var out = await api('rollback', { short: short, token: getToken() });
      dom.msg.textContent = out.message || '已回退';
      dom.msg.className = 'cnm-sync-msg ok';
    } catch (err) {
      dom.msg.textContent = err.message;
      dom.msg.className = 'cnm-sync-msg bad';
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  function build() {
    dom.title = h('span', { class: 'cnm-sync-title', text: '检查中…' });
    dom.detail = h('span', { class: 'cnm-sync-detail' });

    dom.meta = h('div', { class: 'cnm-sync-meta' });
    dom.token = h('input', {
      class: 'cnm-sync-token',
      type: 'password',
      placeholder: '管理员令牌（本机可留空）',
      autocomplete: 'off',
    });
    dom.token.value = getToken();
    dom.token.addEventListener('click', function (e) { e.stopPropagation(); });

    dom.applyBtn = h('button', { class: 'cnm-sync-apply', type: 'button', text: '应用更新' });
    dom.applyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      doApply();
    });

    dom.msg = h('div', { class: 'cnm-sync-msg' });
    dom.versions = h('div', { class: 'cnm-sync-versions' });
    dom.env = h('div', { class: 'cnm-sync-env', hidden: 'hidden' });

    dom.close = h('button', { class: 'cnm-sync-close', type: 'button', text: '收起' });
    dom.close.addEventListener('click', function (e) {
      e.stopPropagation();
      state.open = false;
      dom.panel.hidden = true;
      render();
    });

    dom.panel = h('div', { class: 'cnm-sync-panel', hidden: 'hidden' }, [
      dom.meta,
      h('div', { class: 'cnm-sync-row' }, [dom.token, dom.applyBtn]),
      dom.msg,
      dom.versions,
      dom.env,
      h('div', {
        class: 'cnm-sync-hint',
        text: '应用时先在上游数据的沙箱里跑它自己的 validate.py，通过才替换 data/；不通过则题库一个字节都不动。每次切换前留一份快照，默认保留 3 份。',
      }),
      h('div', { class: 'cnm-sync-foot' }, [dom.close]),
    ]);

    var inner = h('div', { class: 'cnm-sync-bar-inner' }, [dom.title, dom.detail]);
    inner.addEventListener('click', function () {
      state.open = !state.open;
      dom.panel.hidden = !state.open;
      render();
    });

    dom.wrap = h('div', { class: 'cnm-sync-wrap', hidden: 'hidden' }, [inner, dom.panel]);
    dom.panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(dom.wrap);
  }

  function boot() {
    build();
    refresh();
    state.timer = setInterval(refresh, 10 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
