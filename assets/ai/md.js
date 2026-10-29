/* 极简 Markdown + LaTeX 渲染。只处理模型实际会用的子集：
 * 段落、换行、粗体、行内代码、无序/有序列表、标题、$$块公式、$行内公式。
 * 不用 innerHTML，全部 createElement，所以模型输出什么都不可能注入 HTML。
 * window.CnmMd.render(text) -> DocumentFragment
 */
(function () {
  'use strict';

  var KATEX = window.katex || null;

  /* 超过这个长度的 TeX 不交给 KaTeX。
   * 流式输出中途常出现「$$ 开了没闭合」的状态，此时整段剩余文本都会被当成 TeX，
   * 长度随每次增量增长，KaTeX 解析畸形长串会吃掉大量 CPU 和内存。 */
  var MAX_TEX = 400;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var OPTS = { math: true };

  function mathNode(tex, display) {
    var span = el('span', display ? 'md-math md-math-block' : 'md-math');
    if (KATEX && OPTS.math && tex.length <= MAX_TEX) {
      try {
        KATEX.render(tex, span, { displayMode: !!display, throwOnError: false, strict: false });
        return span;
      } catch (e) {
        /* 落到下面的原文 */
      }
    }
    span.textContent = display ? tex : '$' + tex + '$';
    span.className += ' md-math-raw';
    return span;
  }

  /* 行内：$公式$ / **粗体** / `代码`
   *
   * 这个正则带 g 标志，lastIndex 是对象自身的可变状态。下面 inline() 会递归处理粗体，
   * 内层的 exec 无论成功还是失败都会改写 lastIndex（失败时按规范归零），
   * 所以外层绝不能依赖 lastIndex 自然延续——每轮必须用 last 显式定位，
   * 否则会从同一位置反复匹配同一段粗体，last 永不前进，形成死循环。 */
  var INLINE = /\$([^$\n]+)\$|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

  function inline(text) {
    var frag = document.createDocumentFragment();
    var last = 0;
    var m;

    while (true) {
      INLINE.lastIndex = last;
      m = INLINE.exec(text);
      if (!m) break;

      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] != null) {
        frag.appendChild(mathNode(m[1], false));
      } else if (m[2] != null) {
        var b = el('strong');
        b.appendChild(inline(m[2]));
        frag.appendChild(b);
      } else if (m[3] != null) {
        frag.appendChild(el('code', 'md-code', m[3]));
      }

      last = m.index + m[0].length;
      /* 兜底：任何 0 宽匹配都不允许让循环停在原地 */
      if (m[0].length === 0) last = m.index + 1;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  /* opts.math === false 时跳过 KaTeX，公式保留 $...$ 原文。
   * 流式输出期间用它：既避免每次增量都重跑 KaTeX，也避免把半截公式喂给解析器。 */
  function render(text, opts) {
    OPTS.math = !(opts && opts.math === false);
    var frag = renderInner(text);
    OPTS.math = true;
    return frag;
  }

  function renderInner(text) {
    var frag = document.createDocumentFragment();
    var lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
    var para = [];
    var list = null;
    var i = 0;

    function flushPara() {
      if (!para.length) return;
      var p = el('p');
      p.appendChild(inline(para.join('\n')));
      frag.appendChild(p);
      para = [];
    }
    function flushList() {
      if (list) {
        frag.appendChild(list);
        list = null;
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      /* 代码块 */
      if (/^\s*```/.test(line)) {
        flushPara();
        flushList();
        var buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1;
        var pre = el('pre', 'md-pre');
        pre.appendChild(el('code', null, buf.join('\n')));
        frag.appendChild(pre);
        continue;
      }

      /* 独立成行的 $$...$$ */
      var blockMath = /^\s*\$\$([\s\S]*?)\$\$\s*$/.exec(line);
      if (blockMath) {
        flushPara();
        flushList();
        frag.appendChild(mathNode(blockMath[1].trim(), true));
        i += 1;
        continue;
      }
      /* $$ 单独一行开头，跨行到结尾 */
      if (/^\s*\$\$\s*$/.test(line)) {
        var openAt = i;
        var tex = [];
        i += 1;
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
          tex.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          flushPara();
          flushList();
          i += 1;
          frag.appendChild(mathNode(tex.join('\n').trim(), true));
          continue;
        }
        /* 没等到闭合的 $$（流式输出中途很常见）：整段退回当普通段落，
         * 否则后面所有正文都会被吞进一个公式块里 */
        i = openAt;
        para.push(line);
        i += 1;
        continue;
      }

      if (!line.trim()) {
        flushPara();
        flushList();
        i += 1;
        continue;
      }

      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        flushList();
        var level = Math.min(4, h[1].length);
        var node = el('h' + level, 'md-h');
        node.appendChild(inline(h[2]));
        frag.appendChild(node);
        i += 1;
        continue;
      }

      var ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      var ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var wantOrdered = !!ol;
        if (!list || list.__ordered !== wantOrdered) {
          flushList();
          list = el(wantOrdered ? 'ol' : 'ul', 'md-list');
          list.__ordered = wantOrdered;
        }
        var li = el('li');
        li.appendChild(inline(ul ? ul[1] : ol[2]));
        list.appendChild(li);
        i += 1;
        continue;
      }

      flushList();
      para.push(line);
      i += 1;
    }

    flushPara();
    flushList();
    return frag;
  }

  function setKatex(k) {
    KATEX = k || window.katex || null;
  }

  window.CnmMd = { render: render, setKatex: setKatex };
})();
