/* 孩子档案页：添加、编辑、删除孩子，切换当前孩子。数据来自 assets/children.js（localStorage）。 */
(function () {
  'use strict';
  var CC = window.CnmChildren;
  var listBox = document.getElementById('list');
  var form = document.getElementById('form');
  var nameIn = document.getElementById('f-name');
  var gradeSel = document.getElementById('f-grade');
  var bookSel = document.getElementById('f-book');
  var errBox = document.getElementById('f-error');
  var submitBtn = document.getElementById('f-submit');
  var cancelBtn = document.getElementById('f-cancel');
  var formTitle = document.getElementById('form-title');
  var editing = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fillSelect(sel, items, placeholder) {
    sel.textContent = '';
    if (placeholder) { var o = el('option', null, placeholder); o.value = ''; sel.appendChild(o); }
    items.forEach(function (x) { var o = el('option', null, x); o.value = x; sel.appendChild(o); });
  }
  fillSelect(gradeSel, CC.GRADES, '请选择年级');
  fillSelect(bookSel, CC.TEXTBOOKS);

  var params = new URLSearchParams(location.search);
  if (params.get('from') === 'diagnose') {
    var back = document.getElementById('back');
    var sub = params.get('subject');
    var href = '../diagnose/' + (sub === 'english' || sub === 'physics' || sub === 'chinese' ? '?subject=' + sub : '');
    var a = el('a', null, '← 回到诊断');
    a.href = href;
    back.appendChild(a);
    back.hidden = false;
  }

  function showError(msg) { errBox.textContent = msg || ''; errBox.hidden = !msg; }

  function resetForm() {
    editing = null;
    nameIn.value = '';
    gradeSel.value = '';
    bookSel.value = CC.TEXTBOOKS[0];
    formTitle.textContent = '添加孩子';
    submitBtn.textContent = '添加孩子';
    cancelBtn.hidden = true;
    showError('');
  }

  function startEdit(c) {
    editing = c.id;
    nameIn.value = c.name;
    gradeSel.value = c.grade;
    bookSel.value = c.textbook;
    formTitle.textContent = '修改「' + c.name + '」的信息';
    submitBtn.textContent = '保存修改';
    cancelBtn.hidden = false;
    showError('');
    document.getElementById('form-card').scrollIntoView({ block: 'center' });
    nameIn.focus();
  }

  function stats(c) {
    var recs = CC.recordsOf(c.id);
    var by = CC.latestStatus(c.id);
    var weak = 0;
    Object.keys(by).forEach(function (id) { if (by[id].status === 'weak') weak++; });
    return { runs: recs.length, weak: weak };
  }

  function card(c, isCurrent) {
    var st = stats(c);
    var art = el('article', 'kid-card' + (isCurrent ? ' is-current' : ''));
    var head = el('div', 'kid-head');
    head.appendChild(el('h3', null, c.name));
    if (isCurrent) head.appendChild(el('span', 'kid-badge', '当前'));
    art.appendChild(head);
    art.appendChild(el('p', 'kid-meta', c.grade + ' · ' + c.textbook));
    art.appendChild(el('p', 'kid-stat', st.runs
      ? '已诊断 ' + st.runs + ' 次，目前有 ' + st.weak + ' 个薄弱知识点'
      : '还没有诊断记录'));
    var row = el('div', 'kid-actions');
    if (!isCurrent) {
      var use = el('button', 'primary', '设为当前');
      use.type = 'button';
      use.addEventListener('click', function () { CC.setCurrent(c.id); render(); });
      row.appendChild(use);
    }
    var hist = el('a', 'btn', '历史与薄弱点');
    hist.href = 'history.html?child=' + encodeURIComponent(c.id);
    row.appendChild(hist);
    var edit = el('button', null, '编辑');
    edit.type = 'button';
    edit.addEventListener('click', function () { startEdit(c); });
    row.appendChild(edit);
    var del = el('button', 'danger', '删除');
    del.type = 'button';
    del.addEventListener('click', function () {
      if (!confirm('删除「' + c.name + '」的档案和全部诊断记录？删除后无法恢复。')) return;
      CC.remove(c.id);
      if (editing === c.id) resetForm();
      render();
    });
    row.appendChild(del);
    art.appendChild(row);
    return art;
  }

  function render() {
    var kids = CC.list();
    var cur = CC.current();
    listBox.textContent = '';
    if (!kids.length) {
      listBox.appendChild(el('p', 'kid-empty', '还没有孩子。在下面填昵称和年级，添加第一个。'));
    } else {
      kids.forEach(function (c) { listBox.appendChild(card(c, !!cur && cur.id === c.id)); });
    }
    var full = kids.length >= CC.MAX_CHILDREN && !editing;
    document.getElementById('form-card').hidden = full;
    if (full) {
      var note = el('p', 'muted small', '已经建满 ' + CC.MAX_CHILDREN + ' 个孩子。要添加新的，先删除不用的档案。');
      listBox.appendChild(note);
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = { name: nameIn.value, grade: gradeSel.value, textbook: bookSel.value };
    var res = editing ? CC.update(editing, f) : CC.add(f);
    if (!res.ok) { showError(res.error); return; }
    if (!editing && window.cnmTrack) window.cnmTrack('child_added');
    resetForm();
    render();
  });
  cancelBtn.addEventListener('click', function () { resetForm(); render(); });

  /* ---------------------------------------------------------- 备份
   * 记录全在 localStorage 里，换设备或清缓存就没了。这里只做整包导出、
   * 整包覆盖导入，不做合并：两份记录混在一起反而对不上。 */
  var BACKUP_KEYS = [
    'cnmChildren.v1',          // 孩子列表 + 当前孩子
    'cnmChildren.records.v1',  // 每次诊断的结果
    'cnm.tutor.threads.v1',    // 「问老师」的对话
    'cnm.tutor.mistakes.v1',   // 错题本
    'cnmDiagnose.seen.v1',     // 出过的题（避免反复出同一道）
    'cnmDiagnose.settings.v2'  // 题量、确认题数等偏好
  ];
  var BACKUP_AT = 'cnmChildren.backupAt';
  var exportBtn = document.getElementById('btn-export');
  var importInput = document.getElementById('file-import');
  var backupInfo = document.getElementById('backup-info');
  var backupMsg = document.getElementById('backup-msg');

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function dayText(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function agoText(ts) {
    var d = new Date(ts);
    var now = new Date();
    if (dayText(d) === dayText(now)) return '今天 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (dayText(d) === dayText(new Date(now.getTime() - 86400000))) return '昨天';
    return dayText(d);
  }
  function showBackupMsg(msg) {
    if (!backupMsg) return;
    backupMsg.textContent = msg || '';
    backupMsg.hidden = !msg;
  }
  function renderBackupInfo() {
    if (!backupInfo) return;
    var at = 0;
    try { at = parseInt(localStorage.getItem(BACKUP_AT), 10) || 0; } catch (e) { at = 0; }
    backupInfo.textContent = at ? '上次导出：' + agoText(at) + '。' : '还没有导出过。';
  }

  function exportBackup() {
    showBackupMsg('');
    var data = {};
    var count = 0;
    BACKUP_KEYS.forEach(function (k) {
      var v = null;
      try { v = localStorage.getItem(k); } catch (e) { v = null; }
      if (v != null) { data[k] = v; count++; }
    });
    if (!count) {
      showBackupMsg('这台设备上还没有可备份的记录。先加孩子、做一次诊断再来。');
      return;
    }
    var now = new Date();
    var text = JSON.stringify({
      app: 'cn-math-taxonomy', kind: 'backup', version: 1,
      exportedAt: now.toISOString(), data: data
    });
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'cnm-backup-' + dayText(now) + '.json';
    document.body.appendChild(a);
    a.click();
    /* iOS 上立刻 revoke 会把下载打断，等一会儿再收 */
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
    try { localStorage.setItem(BACKUP_AT, String(now.getTime())); } catch (e) { /* 隐私模式 */ }
    if (backupInfo) backupInfo.textContent = '上次导出：今天，' + (text.length / 1024).toFixed(0) + ' KB。文件在浏览器的「下载」里，记得转存到网盘。';
  }

  function importBackup(file) {
    if (!file) return;
    showBackupMsg('');
    var reader = new FileReader();
    reader.onerror = function () { showBackupMsg('读不了这个文件，换一个试试。'); };
    reader.onload = function () {
      var payload = null;
      try { payload = JSON.parse(String(reader.result)); } catch (e) { payload = null; }
      if (!payload || payload.app !== 'cn-math-taxonomy' || !payload.data || typeof payload.data !== 'object') {
        showBackupMsg('这不是本项目的备份文件，或者文件已经损坏。');
        return;
      }
      /* 先挑出能用的：值必须是一段合法 JSON 字符串，坏的不写，也不因此清空别的 */
      var entries = [];
      BACKUP_KEYS.forEach(function (k) {
        var v = payload.data[k];
        if (typeof v !== 'string') return;
        try { JSON.parse(v); } catch (e) { return; }
        entries.push([k, v]);
      });
      if (!entries.length) { showBackupMsg('备份里没有可用的数据，什么都没改。'); return; }

      var kids = 0;
      try {
        var s = JSON.parse(payload.data['cnmChildren.v1'] || 'null');
        kids = s && Array.isArray(s.children) ? s.children.length : 0;
      } catch (e) { kids = 0; }
      var when = '';
      try { when = payload.exportedAt ? agoText(new Date(payload.exportedAt).getTime()) : '时间未知'; } catch (e) { when = '时间未知'; }
      if (!confirm('导入会把这台设备上的档案、诊断记录、错题本全部换成备份里的内容。\n\n备份时间：' + when + '\n包含孩子：' + kids + ' 个\n\n继续？')) return;

      entries.forEach(function (e) {
        try { localStorage.setItem(e[0], e[1]); } catch (x) { /* 写不进去就算了 */ }
      });
      /* 备份里没有的那几项要清掉，保持整包一致，不然新旧数据会混在一起 */
      BACKUP_KEYS.forEach(function (k) {
        if (entries.some(function (e) { return e[0] === k; })) return;
        try { localStorage.removeItem(k); } catch (x) { /* ignore */ }
      });
      location.reload();
    };
    reader.readAsText(file);
  }

  if (exportBtn) exportBtn.addEventListener('click', exportBackup);
  if (importInput) {
    importInput.addEventListener('change', function () {
      var f = importInput.files && importInput.files[0];
      importInput.value = '';  /* 允许重复选同一个文件 */
      importBackup(f);
    });
  }
  renderBackupInfo();

  resetForm();
  render();
})();
