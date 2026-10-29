/* AI 辅导面板：自动挂载，页面里只要一行 <script src="/assets/ai/chat.js"></script>。
 * 上下文从现有数据推断：当前孩子（CnmChildren）、正在诊断的知识点（session）、最近一次薄弱点（records）。
 * 不改动诊断引擎，只在旁边加一个入口。
 */
(function () {
  'use strict';

  var SELF = document.currentScript || document.querySelector('script[src*="ai/chat.js"]');
  var BASE = SELF && SELF.src ? SELF.src.replace(/assets\/ai\/chat\.js.*$/, '') : '/';
  if (BASE.slice(-1) !== '/') BASE += '/';

  var state = {
    open: false,
    busy: false,
    controller: null,
    messages: [],
    ctx: null,
    meta: null,
    msgQuestion: null,
    trigger: null,
    katexReady: false,
    greetShown: false,
    voice: { recording: false, busy: false },
    /* 线程：一道题（或一个知识点、一段自由对话）一条，切题不销毁，存本地 */
    threadKey: null,
    threadAt: 0,
    /* 从历史里打开的旧线程钉住它自己的上下文，不跟着当前页面走 */
    pinned: false,
    /* chat | history | mistakes */
    view: 'chat',
    mistakeId: null,
    storeOk: false,
  };

  var dom = {};
  var readyPromise = null;

  /* ---------------------------------------------------------------- 工具 */
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

  function readJson(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function loadCssOnce(href) {
    if (document.querySelector('link[data-cnm="' + href + '"]')) return;
    var link = h('link', { rel: 'stylesheet', href: href });
    link.setAttribute('data-cnm', href);
    document.head.appendChild(link);
  }

  function loadScriptOnce(src) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(ok) {
        if (settled) return;
        settled = true;
        resolve(!!ok);
      }
      /* 无论如何都要收尾：脚本加载失败、被拦截、缓存层迟迟不回调，
       * 都不能让调用方的 .then 永远不执行（否则面板一直停在「正在准备」） */
      function arm() {
        setTimeout(function () { done(true); }, 8000);
      }

      var found = document.querySelector('script[data-cnm="' + src + '"]');
      if (found) {
        if (found.dataset.done) return done(true);
        if (found.dataset.failed) return done(false);
        found.addEventListener('load', function () { done(true); });
        found.addEventListener('error', function () { done(false); });
        arm();
        return;
      }
      var s = h('script', { src: src });
      s.setAttribute('data-cnm', src);
      s.async = true;
      s.addEventListener('load', function () {
        s.dataset.done = '1';
        done(true);
      });
      s.addEventListener('error', function () {
        s.dataset.failed = '1';
        done(false);
      });
      document.head.appendChild(s);
      arm();
    });
  }

  function ensureRenderers() {
    var tasks = [];
    if (!window.CnmMd) tasks.push(loadScriptOnce(BASE + 'assets/ai/md.js'));
    /* 存储层：对话线程 + 错题本。它比渲染器更关键，缺了就没法复习。 */
    if (!window.CnmTutorStore) tasks.push(loadScriptOnce(BASE + 'assets/ai/store.js'));
    if (!state.katexReady) {
      loadCssOnce(BASE + 'assets/vendor/katex/katex.min.css');
      state.katexReady = true;
      if (!window.katex) tasks.push(loadScriptOnce(BASE + 'assets/vendor/katex/katex.min.js'));
    }
    return Promise.all(tasks).then(function () {
      if (window.CnmMd && window.katex) window.CnmMd.setKatex(window.katex);
      state.storeOk = !!window.CnmTutorStore;
      /* store.js 加载失败也要往下走：能问，只是不留历史 */
      return !!window.CnmTutorStore;
    });
  }

  /* 统一的「可以干活了」：渲染器 + 存储层都就绪。
   * 首次调用会真的去加载脚本，之后直接走已 resolve 的 promise（微任务级别）。 */
  function ready() {
    if (!readyPromise) readyPromise = ensureRenderers();
    return readyPromise;
  }

  /* ------------------------------------------------------------ 上下文推断 */
  function detectContext() {
    var ctx = { kid: null, topicId: null, diag: null, subject: 'math', label: '' };

    if (window.CnmChildren) {
      try {
        var c = window.CnmChildren.current();
        if (c) ctx.kid = { name: c.name, grade: c.grade, textbook: c.textbook };
      } catch (e) {
        /* 站点没有档案模块也不影响 */
      }
    }

    var params = new URLSearchParams(location.search);
    if (params.get('target')) ctx.topicId = params.get('target');

    var SESSIONS = [
      ['cnmDiagnose.session.v2', 'math'],
      ['cneDiagnose.session.v2', 'english'],
      ['cnpDiagnose.session.v2', 'physics'],
      ['cncDiagnose.session.v2', 'chinese'],
    ];
    for (var i = 0; i < SESSIONS.length; i += 1) {
      var s = readJson(SESSIONS[i][0], null);
      if (s && Array.isArray(s.targets) && s.targets.length) {
        ctx.subject = SESSIONS[i][1];
        if (!ctx.topicId) ctx.topicId = s.targets[0];
        ctx.label = s.label || '';
        break;
      }
    }

    /* 最近一次诊断记录：拿根因和薄弱点塞给模型 */
    try {
      var all = readJson('cnmChildren.records.v1', {});
      var kidId = window.CnmChildren && window.CnmChildren.current() ? window.CnmChildren.current().id : null;
      var recs = kidId && Array.isArray(all[kidId]) ? all[kidId] : [];
      if (recs.length) {
        var rec = recs[0];
        ctx.diag = {
          label: rec.label || ctx.label || '',
          roots: Array.isArray(rec.roots) ? rec.roots.slice(0, 6) : [],
          weak: Array.isArray(rec.weak) ? rec.weak.slice(0, 8) : [],
          shaky: Array.isArray(rec.shaky) ? rec.shaky.slice(0, 8) : [],
        };
        if (!ctx.topicId && ctx.diag.weak.length) ctx.topicId = ctx.diag.weak[0];
        if (rec.subject) ctx.subject = rec.subject;
      }
    } catch (e) {
      /* ignore */
    }

    /* 诊断页正在做的那道题：由 diagnose/app.js 暴露（window.CnmDiagCurrent）。
     * 这是「问老师」和「把题贴给 DeepSeek」唯一真正的区别：题目、标准答案、出题理由、作答记录。 */
    var cur = window.CnmDiagCurrent;
    if (cur && cur.question) {
      ctx.diagCurrent = cur;
      if (cur.topicId) ctx.topicId = cur.topicId;
      ctx.topicName = cur.topicName || '';
      ctx.questionId = cur.question.id || null;
      ctx.questionText = cur.question.prompt || '';
      ctx.hasFigure = !!cur.question.figure;
      ctx.whyAsked = cur.why || '';
      ctx.studentAnswer = cur.studentAnswer || '';
      ctx.verdict = cur.verdict || null;
      ctx.attempts = {
        attempt: cur.attempt,
        need: cur.need,
        status: cur.status,
        history: cur.history || [],
        answered: cur.answered,
        limit: cur.limit,
        mode: cur.mode,
        isTarget: cur.isTarget,
      };
      if (cur.subject) ctx.subject = cur.subject;
      if (cur.targetLabel) ctx.label = cur.targetLabel;
    }

    return ctx;
  }

  function subjectName(s) {
    return { math: '数学', english: '英语', physics: '物理', chinese: '语文' }[s] || '学科';
  }

  /* ------------------------------------------------ 线程：归档、恢复、切换 */
  /* 一条线程 = 一道题 / 一个知识点 / 一段自由对话。
   * 以前切到下一题就把 messages 清空，上一题的讲解对模型和孩子一起消失；
   * 现在只是存起来、换成新线程，回到那道题还能原样看到。 */
  function threadKeyOf(ctx) {
    if (!ctx) return 'free';
    if (ctx.questionId) return 'q:' + ctx.questionId;
    if (ctx.topicId) return 't:' + ctx.topicId;
    return 'free';
  }

  /* 只留发请求要用的字段。CnmDiagCurrent 里可能挂着 DOM 或大对象，
   * 直接 JSON 化会撑爆 localStorage。 */
  function snapshotCtx(ctx) {
    if (!ctx) return null;
    return {
      kid: ctx.kid || null,
      subject: ctx.subject || 'math',
      topicId: ctx.topicId || null,
      topicName: ctx.topicName || '',
      questionId: ctx.questionId || null,
      questionText: (ctx.questionText || '').slice(0, 800),
      hasFigure: !!ctx.hasFigure,
      whyAsked: ctx.whyAsked || '',
      studentAnswer: ctx.studentAnswer || '',
      verdict: ctx.verdict || null,
      attempts: ctx.attempts || null,
      diag: ctx.diag || null,
      label: ctx.label || '',
    };
  }

  function plain(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>$\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function makeTitle() {
    var ctx = state.ctx || {};
    var fromQ = plain(ctx.questionText);
    if (fromQ) return fromQ.slice(0, 28);
    var firstUser = null;
    for (var i = 0; i < state.messages.length; i += 1) {
      if (state.messages[i].role === 'user') { firstUser = state.messages[i]; break; }
    }
    if (firstUser) {
      var t = plain(firstUser.content);
      if (t) return t.slice(0, 28);
    }
    return ctx.topicName || '一段对话';
  }

  function currentKidId() {
    try {
      var c = window.CnmChildren && window.CnmChildren.current();
      return c ? c.id || null : null;
    } catch (e) {
      return null;
    }
  }

  function persist() {
    if (!state.storeOk || !state.threadKey || !state.messages.length) return;
    var ctx = state.ctx || {};
    window.CnmTutorStore.threads.save({
      key: state.threadKey,
      kind: String(state.threadKey).split(':')[0],
      qid: ctx.questionId || null,
      tid: ctx.topicId || null,
      subject: ctx.subject || 'math',
      topicName: ctx.topicName || '',
      kidId: currentKidId(),
      title: makeTitle(),
      ctx: snapshotCtx(ctx),
      msgs: state.messages.map(function (m) {
        return { r: m.role, c: m.content, t: m.t || Date.now() };
      }),
      createdAt: state.threadAt || 0,
    });
  }

  var MAX_RENDER = 80;

  function renderAll() {
    dom.body.innerHTML = '';
    if (!state.greetShown) greet();
    var msgs = state.messages;
    var skipped = 0;
    if (msgs.length > MAX_RENDER) {
      skipped = msgs.length - MAX_RENDER;
      msgs = msgs.slice(-MAX_RENDER);
    }
    if (skipped) {
      dom.body.appendChild(
        h('div', { class: 'cnm-tutor-hint', text: '前面还有 ' + skipped + ' 条更早的内容，已折叠。' })
      );
    }
    msgs.forEach(function (m) { addMsg(m.role, m.content); });
    scrollBottom();
  }

  /* liveCtx 传 null 表示「按当前页面判断，页面不是这道题就用存档快照」 */
  function loadThread(key, liveCtx) {
    var live = liveCtx || detectContext();
    var store = window.CnmTutorStore;
    var t = store ? store.threads.get(key) : null;
    state.threadKey = key;
    state.meta = null;
    if (t && Array.isArray(t.msgs) && t.msgs.length) {
      state.messages = t.msgs.map(function (m) { return { role: m.r, content: m.c, t: m.t }; });
      state.threadAt = t.createdAt || 0;
      /* 页面正好是这道题 → 用实时上下文（作答状态可能变了）；
       * 在别处打开旧线程 → 用快照，照样能接着讲那道题 */
      state.ctx = threadKeyOf(live) === key ? live : (t.ctx || live);
      state.greetShown = true;
    } else {
      state.messages = [];
      state.threadAt = Date.now();
      state.ctx = live;
      state.greetShown = false;
    }
    state.msgQuestion = key;
    renderAll();
    updateSub();
  }

  /* 页面换了题就跟着换线程；同一道题则刷新实时上下文 */
  function follow(ctx) {
    var key = threadKeyOf(ctx);
    if (key === state.threadKey) {
      state.ctx = ctx;
      return;
    }
    persist();
    loadThread(key, ctx);
  }

  function openThread(key) {
    if (state.busy) stop();
    if (!state.open) showPanel();
    persist();
    state.pinned = true;
    loadThread(key, null);
    showView('chat');
    dom.input.focus();
  }

  document.addEventListener('cnm:tutor', function () {
    /* 学生在新题上点了「不会」：解除钉住，跟着当前页面走 */
    state.pinned = false;
  });

  /* -------------------------------------------------------------- 语音输入 */
  /* 浏览器录音 → 服务端 /api/asr 转文字 → 填进输入框（不自动发）。
   * 为什么不自动发：孩子说话常吞字，识别成「这题我不」就直接问出去反而要重来。
   * 为什么不直接用 webkitSpeechRecognition：Chrome 走 Google 服务，国内基本报 network 错。 */
  var MIME_CANDIDATES = [
    'audio/webm;codecs=opus', 'audio/webm',
    'audio/ogg;codecs=opus', 'audio/mp4', 'audio/ogg',
  ];
  var MAX_RECORD_MS = 45000;
  var rec = null;

  function canRecord() {
    return !!(
      window.isSecureContext &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      window.MediaRecorder
    );
  }

  function pickMime() {
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      if (window.MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return '';
  }

  function micIcon(recording) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    if (recording) {
      var sq = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      sq.setAttribute('x', '7'); sq.setAttribute('y', '7');
      sq.setAttribute('width', '10'); sq.setAttribute('height', '10');
      sq.setAttribute('rx', '2');
      sq.setAttribute('fill', 'currentColor');
      sq.setAttribute('stroke', 'none');
      svg.appendChild(sq);
      return svg;
    }
    var mic = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    mic.setAttribute('d', 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z');
    var arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arc.setAttribute('d', 'M5 11a7 7 0 0 0 14 0M12 18v3');
    svg.appendChild(mic);
    svg.appendChild(arc);
    return svg;
  }

  function tipDefault() {
    return 'Enter 发送 · Shift+Enter 换行';
  }

  function setMicState(mode) {
    if (!dom.mic) return;
    state.voice.recording = mode === 'rec';
    state.voice.busy = mode === 'busy';
    dom.mic.className = 'cnm-tutor-mic' + (mode === 'rec' ? ' rec' : mode === 'busy' ? ' busy' : '');
    dom.mic.disabled = mode === 'busy';
    dom.mic.title = mode === 'rec' ? '点一下结束录音' : '语音输入（点一下开始，再点一下结束）';
    var icon = micIcon(mode === 'rec');
    if (dom.mic.replaceChildren) dom.mic.replaceChildren(icon);
    else {
      dom.mic.textContent = '';
      dom.mic.appendChild(icon);
    }
    if (dom.send) dom.send.disabled = mode === 'rec' || mode === 'busy';
    if (dom.tipText && mode === 'idle') dom.tipText.textContent = tipDefault();
  }

  function cancelRec() {
    if (rec && rec.timer) clearInterval(rec.timer);
    if (rec && rec.mr && rec.mr.state !== 'inactive') {
      try { rec.mr.stop(); } catch (e) { /* ignore */ }
    }
    releaseStream();
    rec = null;
    if (dom.mic) setMicState('idle');
  }

  function releaseStream() {
    if (rec && rec.stream) {
      rec.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
  }

  function startRec() {
    if (state.voice.busy || state.voice.recording) return;
    if (state.busy) {
      showError('老师还在回答，等它说完再按麦克风。');
      return;
    }
    clearError();
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        /* 等授权的这几百毫秒里，面板可能已经被关掉或重置了 */
        if (!state.open) {
          stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
          return;
        }
        var mime = pickMime();
        var mr;
        try {
          mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        } catch (e) {
          mr = new MediaRecorder(stream);
        }
        rec = { mr: mr, stream: stream, chunks: [], type: mr.mimeType || mime || 'audio/webm', startedAt: Date.now() };
        mr.addEventListener('dataavailable', function (e) {
          if (e.data && e.data.size) rec && rec.chunks.push(e.data);
        });
        mr.addEventListener('stop', onRecordStop);
        mr.addEventListener('error', function () {
          showError('录音出错了，检查一下麦克风有没有被别的程序占用。');
          cancelRec();
        });
        mr.start();
        setMicState('rec');
        updateRecHint();
        rec.timer = setInterval(updateRecHint, 250);
        rec.auto = setTimeout(stopRec, MAX_RECORD_MS);
      })
      .catch(function (err) {
        showError(micErrorText(err));
      });
  }

  function updateRecHint() {
    if (!rec || !dom.tipText) return;
    var s = Math.floor((Date.now() - rec.startedAt) / 1000);
    var mm = Math.floor(s / 60);
    var ss = ('0' + (s % 60)).slice(-2);
    dom.tipText.textContent = '● 录音中 ' + mm + ':' + ss + (s >= 40 ? ' · 快说完了' : ' · 再点一下结束');
  }

  function stopRec() {
    if (!rec) return;
    if (rec.timer) clearInterval(rec.timer);
    if (rec.auto) clearTimeout(rec.auto);
    if (dom.tipText) dom.tipText.textContent = '正在转换成文字…';
    setMicState('busy');
    try {
      rec.mr.stop();
    } catch (e) {
      releaseStream();
      rec = null;
      setMicState('idle');
    }
  }

  function onRecordStop() {
    if (!rec) return;
    var blob = new Blob(rec.chunks, { type: rec.type });
    var ms = Date.now() - rec.startedAt;
    releaseStream();
    rec = null;
    if (!blob.size || ms < 500) {
      setMicState('idle');
      showError('录得太短了，按住说一句完整的话。');
      return;
    }
    uploadAudio(blob);
  }

  function uploadAudio(blob) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    fetch(BASE + 'api/asr', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'audio/webm' },
      body: blob,
      signal: controller.signal,
    })
      .then(function (res) {
        return res.json().then(function (j) { return { ok: res.ok, json: j }; });
      })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok || !r.json || !r.json.ok) {
          throw new Error((r.json && r.json.error) || '语音识别失败');
        }
        var text = String(r.json.text || '').trim();
        if (!text) {
          showError('没听清，再说一次试试。');
          return;
        }
        insertText(text);
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') showError('语音识别超时了，网络可能不太好。');
        else showError((err && err.message) || '语音识别失败');
      })
      .then(function () {
        setMicState('idle');
      });
  }

  function insertText(text) {
    var el = dom.input;
    if (!el) return;
    var v = el.value || '';
    var start = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
    var end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
    var before = v.slice(0, start);
    var after = v.slice(end);
    var ins = text;
    if (before && !/\s$/.test(before)) ins = ' ' + ins;
    if (after && !/^\s/.test(after)) ins = ins + ' ';
    el.value = before + ins + after;
    var pos = before.length + ins.length;
    try { el.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    autosize();
    el.focus();
  }

  function micErrorText(err) {
    var name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风被拒绝了。点地址栏左边的小锁，把「麦克风」改成允许，再试一次。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '没有找到麦克风，检查一下设备有没有插好。';
    }
    if (name === 'NotReadableError') {
      return '麦克风被别的程序占用了，关掉它再试。';
    }
    return '打不开麦克风：' + (err && err.message ? err.message : name || '未知错误');
  }

  /* 服务端没配 key 就不显示按钮——让学生点了才看到报错，比没有按钮更糟。
   * 页面不是 HTTPS 时也不显示：浏览器根本不会给麦克风权限。 */
  function probeVoice() {
    if (!canRecord()) {
      if (dom.mic) dom.mic.hidden = 'hidden';
      if (!window.isSecureContext) {
        try {
          console.info('[问老师] 语音输入需要 HTTPS 或 localhost，当前页面不是安全上下文，已隐藏麦克风按钮。');
        } catch (e) { /* ignore */ }
      }
      return;
    }
    fetch(BASE + 'api/health', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.asr && j.asr.configured === false && dom.mic) {
          dom.mic.hidden = 'hidden';
          try {
            console.info('[问老师] 语音识别还没配置：在 .env 里填 ASR_KEY（硅基流动的 key）后重启即可。');
          } catch (e) { /* ignore */ }
        }
      })
      .catch(function () { /* 拿不到健康检查就乐观地留着按钮 */ });
  }

  /* ------------------------------------------------------------------ UI */
  function svgIcon(name) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '17');
    svg.setAttribute('height', '17');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var add = function (tag, attrs) {
      var el = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      svg.appendChild(el);
    };
    if (name === 'clock') {
      add('circle', { cx: '12', cy: '12', r: '9' });
      add('path', { d: 'M12 7v5l3.2 2' });
    } else if (name === 'book') {
      add('path', { d: 'M4 19.2V5.6A2.6 2.6 0 0 1 6.6 3H20v18H6.6A2.6 2.6 0 0 1 4 19.2z' });
      add('path', { d: 'M4 16.5h16' });
    }
    return svg;
  }

  function buildPanel() {
    dom.fab = h('button', { class: 'cnm-tutor-fab', type: 'button', 'aria-label': '打开AI辅导' }, [
      '问老师',
    ]);
    dom.fab.addEventListener('click', function () { openPanel(); });

    dom.dot = h('span', { class: 'cnm-dots' }, [h('i'), h('i'), h('i')]);
    dom.dotWrap = h('div', { class: 'cnm-msg-bubble' }, [dom.dot]);

    dom.body = h('div', { class: 'cnm-tutor-body', role: 'log', 'aria-live': 'polite' });
    dom.error = h('div', { class: 'cnm-tutor-error', hidden: 'hidden' });

    dom.input = h('textarea', {
      class: 'cnm-tutor-input',
      rows: '1',
      placeholder: '哪里不懂？说说是哪一步卡住了',
      'aria-label': '输入问题',
    });
    dom.send = h('button', { class: 'cnm-tutor-send', type: 'submit', 'aria-label': '发送', text: '发送' });

    dom.mic = h('button', {
      class: 'cnm-tutor-mic',
      type: 'button',
      title: '语音输入（点一下开始，再点一下结束）',
      'aria-label': '语音输入',
    });
    dom.mic.appendChild(micIcon(false));
    dom.mic.addEventListener('click', function () {
      if (state.voice.recording) stopRec();
      else startRec();
    });

    dom.form = h('form', { class: 'cnm-tutor-form' }, [dom.input, dom.mic, dom.send]);
    dom.form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.busy) {
        stop();
        return;
      }
      var text = dom.input.value.trim();
      if (!text) return;
      dom.input.value = '';
      autosize();
      send(text);
    });

    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        dom.form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    dom.input.addEventListener('input', autosize);

    dom.clear = h('button', { class: 'cnm-tutor-icon', type: 'button', title: '清空这段对话', text: '↺' });
    dom.clear.addEventListener('click', reset);

    dom.close = h('button', { class: 'cnm-tutor-icon', type: 'button', title: '收起', text: '×' });
    dom.close.addEventListener('click', closePanel);

    dom.histBtn = h('button', {
      class: 'cnm-tutor-icon',
      type: 'button',
      title: '问过的题',
      'aria-label': '问过的题',
    });
    dom.histBtn.appendChild(svgIcon('clock'));
    dom.histBtn.addEventListener('click', function () {
      showView(state.view === 'history' ? 'chat' : 'history');
    });

    dom.bookBtn = h('button', {
      class: 'cnm-tutor-icon',
      type: 'button',
      title: '错题本',
      'aria-label': '错题本',
    });
    dom.bookBtn.appendChild(svgIcon('book'));
    dom.bookBtn.addEventListener('click', function () {
      showView(state.view === 'mistakes' ? 'chat' : 'mistakes');
    });

    dom.title = h('div', { class: 'cnm-tutor-title', text: '问老师' });
    dom.sub = h('div', { class: 'cnm-tutor-sub', text: '' });

    dom.foot = h('div', { class: 'cnm-tutor-foot' }, [
      dom.form,
      h('div', { class: 'cnm-tutor-tip' }, [
        dom.tipText = h('span', { text: tipDefault() }),
        h('span', { class: 'grow', style: 'flex:1' }),
        dom.clear,
      ]),
    ]);

    dom.listTitle = h('div', { class: 'cnm-tutor-list-title', text: '' });
    dom.listBody = h('div', { class: 'cnm-tutor-list-body' });
    dom.listBack = h('button', { class: 'cnm-tutor-icon dark', type: 'button', title: '返回对话', text: '←' });
    dom.listBack.addEventListener('click', function () { showView('chat'); });
    dom.list = h('div', { class: 'cnm-tutor-list', hidden: 'hidden' }, [
      h('div', { class: 'cnm-tutor-list-head' }, [dom.listBack, dom.listTitle]),
      dom.listBody,
    ]);

    dom.panel = h('div', { class: 'cnm-tutor', hidden: 'hidden', role: 'dialog', 'aria-label': 'AI 辅导' }, [
      h('div', { class: 'cnm-tutor-head' }, [
        h('div', { class: 'cnm-tutor-id' }, [dom.title, dom.sub]),
        h('span', { class: 'grow', style: 'flex:1' }),
        dom.histBtn,
        dom.bookBtn,
        dom.close,
      ]),
      dom.error,
      dom.body,
      dom.foot,
      dom.list,
    ]);

    document.body.appendChild(dom.fab);
    document.body.appendChild(dom.panel);
  }

  /* ------------------------------------------------------- 历史 / 错题本视图 */
  function showView(name) {
    state.view = name;
    var chat = name === 'chat';
    dom.body.hidden = !chat;
    dom.foot.hidden = !chat;
    dom.list.hidden = chat;
    dom.histBtn.classList.toggle('on', name === 'history');
    dom.bookBtn.classList.toggle('on', name === 'mistakes');
    dom.title.textContent = chat ? '问老师' : name === 'history' ? '问过的题' : '错题本';
    if (chat) {
      updateSub();
      return;
    }
    dom.sub.textContent = name === 'history' ? '切到下一题也不会丢' : '答错、点不会，都会记下来';
    if (name === 'history') renderHistory();
    else renderMistakes();
  }

  function emptyHint(text) {
    dom.listBody.appendChild(h('div', { class: 'cnm-tutor-empty', text: text }));
  }

  function renderHistory() {
    dom.listBody.innerHTML = '';
    var store = window.CnmTutorStore;
    if (!store) {
      emptyHint('历史没能加载出来，刷新页面试试。');
      return;
    }
    var list = store.threads.list();
    /* 一个浏览器可能换了孩子用，别让孩子看到别人的对话 */
    var kidId = currentKidId();
    if (kidId) {
      list = list.filter(function (t) { return !t.kidId || t.kidId === kidId; });
    }
    if (!list.length) {
      emptyHint('还没有问过的题。在诊断页问一次，这里就会出现。');
      return;
    }
    var cur = state.threadKey;
    list.forEach(function (t) {
      var bits = [subjectName(t.subject)];
      if (t.topicName && t.topicName !== t.title) bits.push(t.topicName);
      bits.push(t.turns + ' 轮');
      bits.push(store.when(t.updatedAt));
      var row = h('div', { class: 'cnm-hist-row' + (t.key === cur ? ' cur' : ''), role: 'button', tabindex: '0' }, [
        h('div', { class: 'cnm-hist-main' }, [
          h('div', { class: 'cnm-hist-title', text: t.title }),
          h('div', { class: 'cnm-hist-meta', text: bits.join(' · ') }),
        ]),
      ]);
      row.addEventListener('click', function () { openThread(t.key); });
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThread(t.key);
        }
      });
      var del = h('button', { class: 'cnm-hist-del', type: 'button', title: '删除这条', text: '×' });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!window.confirm('删掉「' + t.title + '」这段对话？删了就找不回来了。')) return;
        store.threads.remove(t.key);
        if (t.key === state.threadKey) {
          state.messages = [];
          state.greetShown = false;
          state.threadAt = Date.now();
          renderAll();
        }
        renderHistory();
      });
      row.appendChild(del);
      dom.listBody.appendChild(row);
    });

    if (list.length > 3) {
      var foot = h('div', { class: 'cnm-list-foot' });
      var clear = h('button', { class: 'cnm-list-clear', type: 'button', text: '清空全部历史' });
      clear.addEventListener('click', function () {
        if (!window.confirm('清空全部 ' + list.length + ' 段对话？错题本里的记录不会删。')) return;
        store.threads.clear();
        state.messages = [];
        state.greetShown = false;
        state.threadAt = Date.now();
        renderAll();
        renderHistory();
      });
      foot.appendChild(clear);
      dom.listBody.appendChild(foot);
    }
  }

  var VERDICT_LABEL = { wrong: '判定为错', skip: '点了我不会', correct: '做对了但没底' };

  function renderMistakes() {
    dom.listBody.innerHTML = '';
    var store = window.CnmTutorStore;
    if (!store) {
      emptyHint('错题本没能加载出来，刷新页面试试。');
      return;
    }
    var groups = store.mistakes.grouped();
    var all = store.mistakes.list();
    if (!groups.length) {
      emptyHint('还没有错题。以后答错、或者点「不会」，这里会自动记一条，老师下次也会记着。');
      return;
    }

    var stat = h('div', { class: 'cnm-mist-stat' }, [
      h('span', { text: '共 ' + all.length + ' 道题 · ' + groups.length + ' 个知识点' }),
    ]);
    dom.listBody.appendChild(stat);

    groups.forEach(function (g) {
      var card = h('div', { class: 'cnm-mist-group' });
      card.appendChild(
        h('div', { class: 'cnm-mist-head' }, [
          h('span', { class: 'cnm-mist-topic', text: g.tname }),
          h('span', { class: 'cnm-mist-count', text: '错 ' + g.count + ' 次' }),
        ])
      );
      g.items.forEach(function (m) {
        var item = h('div', { class: 'cnm-mist-item', role: 'button', tabindex: '0' });
        item.appendChild(h('div', { class: 'cnm-mist-q', text: m.qtext || '（题目文字没存下来）' }));
        var line = [];
        if (m.ans) line.push('你填的「' + m.ans + '」');
        line.push(VERDICT_LABEL[m.verdict] || '判定为错');
        line.push(store.when(m.lastAt));
        item.appendChild(h('div', { class: 'cnm-mist-ans', text: line.join(' · ') }));
        if (m.note) item.appendChild(h('div', { class: 'cnm-mist-note', text: '老师上次说：' + m.note }));
        var go = function () {
          var key = m.thread || (m.qid ? 'q:' + m.qid : '');
          if (key && store.threads.get(key)) openThread(key);
          else {
            showView('chat');
            if (m.qid) {
              /* 讲解没存下来（比如当时没连上），至少把题目和错误答案带过去问 */
              state.pinned = false;
              state.ctx = Object.assign({}, state.ctx || {}, {
                questionId: m.qid,
                topicId: m.tid || null,
                topicName: m.tname || '',
                questionText: m.qtext || '',
                studentAnswer: m.ans || '',
                verdict: m.verdict === 'correct' ? 'correct' : m.verdict === 'skip' ? null : 'wrong',
                subject: m.subject || 'math',
              });
              state.threadKey = threadKeyOf(state.ctx);
              state.messages = [];
              state.greetShown = false;
              renderAll();
              updateSub();
            }
          }
        };
        item.addEventListener('click', go);
        item.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go();
          }
        });
        card.appendChild(item);
      });
      dom.listBody.appendChild(card);
    });

    var foot = h('div', { class: 'cnm-list-foot' });
    var clear = h('button', { class: 'cnm-list-clear', type: 'button', text: '清空错题记录' });
    clear.addEventListener('click', function () {
      if (!window.confirm('清空全部 ' + all.length + ' 条错题记录？对话历史不受影响。')) return;
      store.mistakes.clear();
      renderMistakes();
    });
    foot.appendChild(clear);
    dom.listBody.appendChild(foot);
  }

  function autosize() {
    dom.input.style.height = 'auto';
    dom.input.style.height = Math.min(120, dom.input.scrollHeight) + 'px';
  }

  function showError(msg) {
    dom.error.textContent = msg;
    dom.error.hidden = false;
  }

  function clearError() {
    dom.error.hidden = true;
    dom.error.textContent = '';
  }

  function addMsg(role, content) {
    var bubble = h('div', { class: 'cnm-msg-bubble' });
    if (role === 'assistant' && window.CnmMd) {
      bubble.appendChild(window.CnmMd.render(content));
    } else {
      bubble.textContent = content;
    }
    var wrap = h('div', { class: 'cnm-msg ' + role }, [bubble]);
    dom.body.appendChild(wrap);
    scrollBottom();
    return bubble;
  }

  function scrollBottom() {
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  function greet() {
    if (state.greetShown) return;
    state.greetShown = true;
    var ctx = state.ctx || detectContext();
    var name = ctx.kid && ctx.kid.name ? ctx.kid.name + '，' : '';
    var parts = ['我是你的' + subjectName(ctx.subject) + '老师。'];
    if (ctx.questionId && ctx.topicName) {
      parts.push('你在做的「' + ctx.topicName + '」那道题我能看到，包括参考答案。哪一步不明白，直接说。');
    } else if (ctx.topicId) {
      parts.push('你现在看的这块内容，我不会直接把答案给你，先说说你想到哪一步了。');
    } else {
      parts.push('有哪道题、哪个知识点不明白，直接把题目发我。');
    }
    var hint = h('div', { class: 'cnm-tutor-hint' });
    hint.appendChild(document.createTextNode(name + parts.join('')));
    dom.body.appendChild(hint);
  }

  function reset() {
    cancelRec();
    stop();
    /* 「清空」= 连存档一起删掉，下次再进来不会又翻出这段旧讲解 */
    if (state.storeOk && state.threadKey) window.CnmTutorStore.threads.remove(state.threadKey);
    state.messages = [];
    state.meta = null;
    state.trigger = null;
    state.ctx = detectContext();
    state.threadAt = Date.now();
    state.threadKey = threadKeyOf(state.ctx);
    state.msgQuestion = state.threadKey;
    state.pinned = false;
    state.greetShown = false;
    dom.body.innerHTML = '';
    clearError();
    if (state.view !== 'chat') showView('chat');
    greet();
    updateSub();
    dom.input.focus();
  }

  function updateSub() {
    var ctx = state.ctx || {};
    var m = state.meta || {};
    var bits = [];
    if (ctx.kid && ctx.kid.name) {
      bits.push(ctx.kid.name + (ctx.kid.grade ? ' · ' + ctx.kid.grade : ''));
    }
    var topic = m.topicName || ctx.topicName;
    if (topic) bits.push(topic);
    if (m.hasQuestion) bits.push('这道题');
    if (m.prereqCount) bits.push('先修 ' + m.prereqCount + ' 项');
    if (m.hasWhy) bits.push('出题理由');
    if (m.memoryCount) bits.push('记住了 ' + m.memoryCount + ' 处错');
    if (state.pinned) bits.push('历史对话');
    dom.sub.textContent = bits.length ? bits.join(' ｜ ') : '基于当前页面内容';
  }

  function showPanel() {
    dom.fab.hidden = true;
    dom.panel.hidden = false;
    state.open = true;
  }

  function openPanel() {
    showPanel();
    if (state.view !== 'chat') showView('chat');
    ready().then(function () {
      if (!state.threadKey) {
        var ctx = detectContext();
        loadThread(threadKeyOf(ctx), ctx);
      } else if (!state.pinned) {
        /* 页面已经翻到下一题了：换线程，别接着讲上一题 */
        follow(detectContext());
      }
      harvest();
      updateSub();
      dom.input.focus();
    });
  }

  function closePanel() {
    cancelRec();
    stop();
    persist();
    if (state.storeOk && window.CnmTutorStore) window.CnmTutorStore.flush();
    dom.panel.hidden = true;
    dom.fab.hidden = false;
    state.open = false;
    /* 收起面板 = 这次复习结束。下次点开跟着页面上的题走，
     * 而不是还停在刚才从历史翻出来的旧题上。 */
    state.pinned = false;
    if (state.view !== 'chat') showView('chat');
  }

  /* -------------------------------------------------------------- 发送 */
  function stop() {
    if (state.controller) {
      try { state.controller.abort(); } catch (e) { /* ignore */ }
      state.controller = null;
    }
    if (state.busy) {
      state.busy = false;
      if (dom.dotWrap && dom.dotWrap.parentNode) dom.dotWrap.parentNode.remove();
      dom.send.disabled = false;
      dom.send.classList.remove('stop');
      dom.send.textContent = '发送';
    }
  }

  function setBusy(on) {
    state.busy = on;
    dom.send.disabled = false;
    if (on) {
      dom.send.classList.add('stop');
      dom.send.textContent = '停止';
    } else {
      dom.send.classList.remove('stop');
      dom.send.textContent = '发送';
    }
  }

  /* 顺手收一笔：页面上已经判错、但学生没点「让老师讲讲」的题，也要进错题本。
   * 没有讲解不影响记录，之后从错题本点进来还能补问。 */
  function harvest() {
    if (!state.storeOk || !window.CnmTutorStore) return;
    var cur = window.CnmDiagCurrent;
    if (!cur || !cur.question || !cur.question.id) return;
    if (cur.verdict !== 'wrong') return;
    window.CnmTutorStore.mistakes.add({
      qid: cur.question.id,
      tid: cur.topicId || null,
      subject: cur.subject || 'math',
      tname: cur.topicName || '',
      qtext: cur.question.prompt || '',
      ans: cur.studentAnswer || '',
      verdict: 'wrong',
    });
  }

  /* 这一轮值得记进错题本吗？
   * 判错、点「不会」、以及做对了但自己没底（点了让老师讲讲）——第三种最容易漏，
   * 孩子蒙对了系统就放过他，下次照样错。
   * 只看线程的第一轮：后面追问是同一件事，重复记只会把错题本刷满。 */
  function noteMistake() {
    if (!state.storeOk || !window.CnmTutorStore) return;
    var userTurns = state.messages.filter(function (m) { return m.role === 'user'; }).length;
    if (userTurns > 0) return;
    /* 用 state.ctx 而不是 window.CnmDiagCurrent：从历史打开的旧题，
     * 当前页面可能早就翻到别的题了。 */
    var ctx = state.ctx || {};
    if (!ctx.questionId) return;
    var trig = state.trigger;
    var kind = null;
    if (ctx.verdict === 'wrong') kind = 'wrong';
    else if (trig === 'skip') kind = 'skip';
    else if (ctx.verdict === 'correct' && trig === 'explain') kind = 'correct';
    if (!kind) return;
    var m = window.CnmTutorStore.mistakes.add({
      qid: ctx.questionId,
      tid: ctx.topicId || null,
      subject: ctx.subject || 'math',
      tname: ctx.topicName || '',
      qtext: ctx.questionText || '',
      ans: ctx.studentAnswer || '',
      verdict: kind,
      thread: state.threadKey || '',
    });
    if (m) state.mistakeId = m.id;
  }

  /* 拿老师回答的第一句当「这次讲到哪儿了」，下次翻错题本能看到 */
  function firstLine(text) {
    var s = plain(String(text || '').slice(0, 600));
    var m = s.match(/^(.{1,110}?)[。！？!?]/);
    if (m) return m[1].replace(/^[，,、\s]+/, '');
    return s.slice(0, 90);
  }

  function finishMistake(buffer) {
    if (!state.mistakeId || !state.storeOk || !window.CnmTutorStore) return;
    var note = firstLine(buffer);
    window.CnmTutorStore.mistakes.patch(state.mistakeId, {
      note: note || '',
      thread: state.threadKey || '',
    });
    state.mistakeId = null;
  }

  async function send(text) {
    clearError();
    /* 每次发送都重新取一次上下文：学生可能已经翻到下一题。
     * 从历史打开的旧线程（pinned）例外——它讲的就是那道题，不能被当前页面顶掉。 */
    if (!state.pinned) follow(detectContext());
    if (!state.threadKey) {
      state.ctx = state.ctx || detectContext();
      state.threadKey = threadKeyOf(state.ctx);
      state.threadAt = Date.now();
    }
    /* 记忆快照要在 noteMistake 之前取：本轮刚记下的这条错题，
     * 系统提示里已经有「他这题填了什么」，没必要再当历史重复一遍。
     * 同理也排掉当前这道题——要的是「他在别处栽过」，不是复述眼前这题。 */
    var memorySnapshot =
      state.storeOk && window.CnmTutorStore
        ? window.CnmTutorStore.mistakes.memory(24, (state.ctx || {}).questionId)
        : null;
    noteMistake();
    state.messages.push({ role: 'user', content: text, t: Date.now() });
    addMsg('user', text);
    persist();

    var pending = h('div', { class: 'cnm-msg assistant' }, [dom.dotWrap.cloneNode(true)]);
    dom.body.appendChild(pending);
    scrollBottom();

    var bubble = null;
    var buffer = '';
    /* 流式期间的渲染节流状态。
     * 不能每个增量都全量重渲染：一次 1500 字的回答约 1500 个增量，
     * 每次都 split + 逐行正则 + 建整棵 DOM 是 O(n²)，主线程会被占满。
     * 这里按 120ms 合并，且中途跳过 KaTeX（半截公式既慢又难看）。 */
    var paintTimer = 0;
    var lastPaint = 0;
    var painted = false;
    var paintCount = 0;
    var beganAt = Date.now();
    /* 模型抽风时会一直吐字，设个硬上限，超了就掐断，别把内存吃光 */
    var MAX_CHARS = 12000;
    var idleTimer = 0;
    var timedOut = false;
    var controller = new AbortController();
    state.controller = controller;
    setBusy(true);

    /* 把累积文本画进气泡。final 为 true 时才启用 KaTeX。 */
    function paint(final) {
      if (!bubble) return;
      lastPaint = Date.now();
      painted = true;
      paintCount += 1;
      bubble.textContent = '';
      if (!window.CnmMd) {
        bubble.textContent = buffer;
        scrollBottom();
        return;
      }
      bubble.appendChild(window.CnmMd.render(buffer, { math: !!final }));
      scrollBottom();
    }

    function queuePaint() {
      if (paintTimer) return;
      var wait = 120 - (Date.now() - lastPaint);
      paintTimer = setTimeout(function () {
        paintTimer = 0;
        paint(false);
      }, wait > 0 ? wait : 0);
    }

    /* 流卡住时的兜底：40 秒没有任何增量就主动断开，而不是永远转圈 */
    function armIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        idleTimer = 0;
        timedOut = true;
        try { controller.abort(); } catch (e) { /* ignore */ }
      }, 40000);
    }

    function clearTimers() {
      if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    }

    try {
      var c = state.ctx || {};
      var payload = {
        messages: state.messages.slice(-12).map(function (m) {
          return { role: m.role, content: m.content };
        }),
        kid: c.kid,
        topicId: c.topicId,
        diag: c.diag,
        subject: c.subject,
        questionId: c.questionId || undefined,
        questionText: c.questionText || undefined,
        whyAsked: c.whyAsked || undefined,
        studentAnswer: c.studentAnswer || undefined,
        verdict: c.verdict || undefined,
        /* 只在触发这一轮带上，后续追问不再重复「他点了让老师讲讲」 */
        trigger: state.trigger || undefined,
        hasFigure: c.hasFigure || undefined,
        attempts: c.attempts || undefined,
        /* 跨对话的学习记忆：这孩子最近在哪儿栽过、填的什么、上次讲到哪。
         * 不带这个，模型每次都是第一次见他。 */
        memory: memorySnapshot || undefined,
      };
      state.trigger = null;
      var res = await fetch(BASE + 'api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        var info = null;
        try { info = await res.json(); } catch (e) { info = null; }
        throw new Error((info && info.error) || '服务返回 ' + res.status);
      }
      if (!res.body) throw new Error('浏览器不支持流式响应');

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      armIdle();

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        armIdle();
        buf += decoder.decode(chunk.value, { stream: true });

        var idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          var raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          var line = raw.split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
          if (!line) continue;
          var evt;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch (e) {
            continue;
          }
          if (evt.type === 'meta') {
            state.meta = evt;
            updateSub();
          } else if (evt.type === 'delta') {
            if (!bubble) {
              pending.remove();
              bubble = addMsg('assistant', '');
            }
            buffer += evt.text;
            if (buffer.length > MAX_CHARS) {
              throw new Error('这次回答太长了，已经中断。你把问题说得再具体一点试试。');
            }
            /* 第一个字先画出来，避免开头有 120ms 空白 */
            if (!painted) paint(false);
            else queuePaint();
          } else if (evt.type === 'error') {
            throw new Error(evt.message || '服务出错');
          }
        }
      }

      if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
      if (pending.parentNode) pending.remove();
      if (buffer) {
        /* 收尾：一次性正式渲染，公式这时才交给 KaTeX */
        paint(true);
        state.messages.push({ role: 'assistant', content: buffer, t: Date.now() });
        persist();
      } else {
        addMsg('assistant', '（这次没生成内容，换个问法再试试）');
      }
    } catch (err) {
      if (pending.parentNode) pending.remove();
      if (err.name === 'AbortError') {
        /* 被中断：已经收到的部分照样渲染好留给学生，不要留半截原始标记 */
        if (buffer) {
          paint(true);
          state.messages.push({ role: 'assistant', content: buffer, t: Date.now() });
          persist();
        }
        if (timedOut) showError('老师那边一直没回应，已经断开。检查一下网络，或者换个问法再试。');
      } else {
        if (buffer) {
          /* 已经生成了一部分才出错：这部分是学生看得见的，留在历史里 */
          paint(true);
          state.messages.push({ role: 'assistant', content: buffer, t: Date.now() });
          persist();
        } else {
          /* 一个字都没出来：失败的这一轮不留在历史里，避免模型接着错误上下文答 */
          state.messages.pop();
          persist();
        }
        var msg = err.message || '出错了';
        if (/Failed to fetch|NetworkError|fetch/i.test(msg)) {
          msg = '没连上辅导服务。请确认后端已经启动（node server/index.js），并且页面是从那个服务打开的。';
        }
        showError(msg);
      }
    } finally {
      clearTimers();
      state.controller = null;
      setBusy(false);
      finishMistake(buffer);
      harvest();
      if (state.storeOk && window.CnmTutorStore) window.CnmTutorStore.flush();
      if (state.view === 'mistakes') renderMistakes();
      dom.input.focus();
      /* 排查卡顿用：控制台能直接看到这一轮转发了多少字、画了几次 */
      try {
        console.debug('[问老师] 本轮结束', {
          字符数: buffer.length,
          重绘次数: paintCount,
          耗时ms: Date.now() - beganAt,
        });
      } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------------------- 事件：学生点了「不会」/「让老师讲讲」 */
  var AUTO_SKIP = '这题我点了「不会」，参考答案我已经看到了，但我不明白为什么是这个答案。一步一步给我讲讲。';

  /* 判错和蒙对要用不同的说法：一个想知道错在哪，一个想确认自己是不是真懂 */
  function explainText() {
    var cur = window.CnmDiagCurrent || {};
    var ans = cur.studentAnswer ? '我填的是「' + cur.studentAnswer + '」，' : '';
    if (cur.verdict === 'correct') {
      return ans + '系统判对了，但我不太确定自己是不是真懂了。把这道题每一步的依据讲清楚。';
    }
    if (cur.verdict === 'wrong') {
      return ans + '系统判错了。讲讲我错在哪一步。';
    }
    return '讲讲这道题的完整思路和关键步骤。';
  }

  var lastAuto = null;

  function autoAsk(text, reason, trigger) {
    var cur = window.CnmDiagCurrent;
    var qid = (cur && cur.question && cur.question.id) || '';
    /* 同一道题、同一个判定结果，不重复自动开口 */
    var key = reason + '|' + qid + '|' + ((cur && cur.verdict) || '');
    if (key === lastAuto) return;
    if (!qid) return;
    lastAuto = key;
    state.trigger = trigger || null;
    state.pinned = false;
    if (state.busy) stop();
    ready().then(function () {
      showPanel();
      showView('chat');
      follow(detectContext());
      updateSub();
      send(text);
    });
  }

  document.addEventListener('cnm:tutor', function (e) {
    var detail = (e && e.detail) || {};
    if (detail.reason === 'skip') {
      autoAsk(AUTO_SKIP, 'skip', 'skip');
    } else if (detail.reason === 'explain') {
      autoAsk(explainText(), 'explain', 'explain');
    }
  });

  /* ---------------------------------------------------------------- 启动 */
  function boot() {
    loadCssOnce(BASE + 'assets/ai/chat.css');
    window.CnmTutorBase = BASE;
    buildPanel();
    /* 麦克风能不能用，要同时看浏览器（HTTPS/权限）和服务端（有没有配 ASR key） */
    probeVoice();
    /* 题库更新提示：晚一点加载，不跟首屏抢带宽 */
    setTimeout(function () {
      loadScriptOnce(BASE + 'assets/ai/sync.js');
    }, 1200);
    /* 空闲时预取渲染器和存储层，点开就不卡 */
    var warm = function () { ready(); };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(warm, { timeout: 3000 });
    } else {
      setTimeout(warm, 1500);
    }
    /* 关页面前落盘：切题时已经存过，这里兜住「正在流式输出时关掉」 */
    var flush = function () {
      try {
        persist();
        if (window.CnmTutorStore) window.CnmTutorStore.flush();
      } catch (e) { /* ignore */ }
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.CnmTutor = {
    open: openPanel,
    close: closePanel,
    context: detectContext,
    /* 方便在控制台查：CnmTutor.store.threads.list() */
    get store() {
      return window.CnmTutorStore;
    },
  };
})();
