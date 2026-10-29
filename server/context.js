'use strict';

/* 上下文裁剪：这是整个接入的关键。
 * 不把 topics.json 塞进 prompt，只把「当前知识点 + 先修链 + 这道题 + 这个孩子」拼起来，
 * 通常 2-4k token。图本身就是检索器，不需要向量库。
 */

const data = require('./data');

const MAX_LEVELS = 2;
const MAX_PER_LEVEL = 8;

function fmtTopicLine(t, level, extra) {
  const bits = ['「' + (t.name || t.id) + '」'];
  if (t.chapter) bits.push('（' + t.chapter + '）');
  if (extra && extra.note) bits.push(' ' + extra.note);
  return '- ' + bits.join('');
}

function describeTopic(t) {
  if (!t) return '';
  const lines = [];
  lines.push('- 名称：' + (t.name || t.id));
  const where = [t.chapter, data.gradeLabel(t.grade)].filter(Boolean);
  if (where.length) lines.push('- 位置：' + where.join(' · '));
  if (t.description) lines.push('- 说明：' + t.description);
  const criteria = Array.isArray(t.mastery_criteria) ? t.mastery_criteria.filter(Boolean) : [];
  if (criteria.length) {
    lines.push('- 掌握标准：');
    criteria.slice(0, 5).forEach((c) => lines.push('  · ' + c));
  }
  return lines.join('\n');
}

function describeQuestion(q) {
  if (!q) return '';
  const lines = [];
  lines.push('题目：' + (q.prompt || ''));
  if (Array.isArray(q.choices) && q.choices.length) {
    lines.push('选项：');
    q.choices.forEach((c) => {
      const key = c && c.key ? c.key : '';
      const text = c && typeof c.text === 'string' ? c.text : '';
      lines.push('  ' + key + '. ' + text);
    });
  }
  if (q.answer) lines.push('标准答案：' + q.answer);
  if (q.explanation) lines.push('官方讲解要点：' + q.explanation);
  if (q.hint) lines.push('提示：' + q.hint);
  return lines.join('\n');
}

function describePrereqs(topicId) {
  const levels = data.ancestors(topicId, MAX_LEVELS, { limitPerLevel: MAX_PER_LEVEL });
  if (!levels.length) {
    const t = data.topic(topicId);
    if (t && t.root_reason) return '这个知识点前面没有更早的先修内容（起点知识点）。补充说明：' + t.root_reason;
    return '';
  }
  const g = data.graph();
  const out = [];
  levels.forEach((level, i) => {
    out.push('第' + (i + 1) + '层（' + (i === 0 ? '直接先修' : '再往前') + '）：');
    level.forEach((e) => {
      const t = g.byId.get(e.id);
      if (!t) return;
      const mark = e.strength === 'hard' ? '必须' : '建议';
      const reason = e.reason ? ' 原因：' + e.reason : '';
      out.push('- [' + mark + '] 「' + (t.name || t.id) + '」' + (t.chapter ? '（' + t.chapter + '）' : '') + reason);
    });
  });
  return out.join('\n');
}

function describeDiag(diag) {
  if (!diag || typeof diag !== 'object') return '';
  const g = data.graph();
  const nameOf = (id) => {
    const t = data.topic(id);
    return t ? t.name || t.id : String(id);
  };
  const lines = [];

  if (diag.label) lines.push('本次诊断范围：' + diag.label);

  const roots = Array.isArray(diag.roots) ? diag.roots.slice(0, 6) : [];
  if (roots.length) {
    lines.push('根因（最可能没打牢的地方，从早到晚）：');
    roots.forEach((id) => {
      const t = data.topic(id);
      const reason = t && t.root_reason ? '  ' + t.root_reason : '';
      const where = t && t.chapter ? '（' + t.chapter + '）' : '';
      lines.push('- ' + nameOf(id) + where + reason);
    });
  }

  const path = Array.isArray(diag.path) ? diag.path.slice(0, 10) : [];
  if (path.length) {
    lines.push('建议补齐顺序（按年级从低到高）：' + path.map(nameOf).join(' → '));
  }

  const weak = Array.isArray(diag.weak) ? diag.weak.slice(0, 8) : [];
  if (weak.length) lines.push('明确薄弱：' + weak.map(nameOf).join('、'));

  const shaky = Array.isArray(diag.shaky) ? diag.shaky.slice(0, 8) : [];
  if (shaky.length) lines.push('不太稳（时对时错）：' + shaky.map(nameOf).join('、'));

  if (!lines.length) return '';
  /* 补一句用途，模型才知道这些数据该怎么用 */
  lines.push('（这些是算法沿先修关系回溯出来的，可信度高于你的直觉判断。讲解时优先围绕它们。）');
  return lines.join('\n');
}

/* 这道题为什么出给他 —— 诊断引擎的出题理由与作答记录。
 * 这是 DeepSeek 网页版永远拿不到的东西：它不知道这题是引擎挑出来验证先修的。
 */
function describeWhy(opts) {
  const bits = [];
  if (opts.whyAsked) bits.push('- 出题理由（算法判断，不是学生说的）：' + String(opts.whyAsked).slice(0, 400));

  const att = opts.attempts;
  if (att && typeof att === 'object') {
    const hist = Array.isArray(att.history) ? att.history : [];
    const label = { correct: '对', wrong: '错', skip: '不会' };
    if (hist.length) {
      bits.push('- 他在这个知识点上已经答过 ' + hist.length + ' 题：' + hist.map((x) => label[x] || x).join(' → '));
    }
    if (att.need) {
      bits.push('- 规则：这个知识点要连续答对 ' + att.need + ' 题才算掌握；眼前这题是第 ' + (att.attempt || 1) + ' 题。');
    }
    if (typeof att.answered === 'number' && att.limit) {
      bits.push('- 本次诊断进度：已答 ' + att.answered + ' 题，上限 ' + att.limit + ' 题。');
    }
    if (att.status) {
      const st = { mastered: '已掌握', shaky: '不稳', weak: '薄弱', unknown: '未测' }[att.status] || att.status;
      bits.push('- 这个知识点当前的判定：' + st + '。');
    }
    if (att.mode === 'screen') bits.push('- 这是整体筛查模式：出题是抽查，不代表专门在查他个人。');
    if (att.isTarget === false) bits.push('- 注意：这个知识点不是他选的目标，而是目标的先修。');
  }

  if (!bits.length) return '';
  return bits.join('\n');
}

/* 这次对话是怎么触发的。同一个学生、同一道题，点「不会」和点「让老师讲讲」要讲得不一样。 */
function describeTrigger(opts) {
  const t = opts.trigger;
  if (t !== 'skip' && t !== 'explain') return '';
  const ans = opts.studentAnswer ? String(opts.studentAnswer).slice(0, 120) : '';
  const v = opts.verdict;
  const lines = [];

  if (t === 'skip') {
    lines.push('- 学生点了「不会」，他是真不会。不要再反问「你觉得哪一步卡住了」。');
    lines.push('- 页面已经显示了参考答案，他要的是「为什么是这个答案」，不是答案本身。');
    return lines.join('\n');
  }

  lines.push('- 学生点了「让老师讲讲这道题」，他是想弄懂，不是想跳过。');
  if (v === 'correct') {
    lines.push(
      '- 系统判定他做对了' + (ans ? '（他填的是：' + ans + '）' : '') +
        '。做对不等于懂，很可能就是蒙对的。把每一步的依据讲清楚：为什么必须这样、换成别的做法为什么不行。' +
        '不要只夸他答对了，也不要马上出变式题。'
    );
  } else if (v === 'wrong') {
    lines.push(
      '- 系统判定他做错了' + (ans ? '（他填的是：' + ans + '）' : '') +
        '。先指出错在哪一步、为什么错，再让他自己改这一步。他已经看过参考答案，不要再从头把整题讲一遍。'
    );
  } else {
    lines.push('- 系统没能自动判定对错（开放题或需要自评）。先对照标准答案说清关键步骤。');
  }
  return lines.join('\n');
}

/* 跨对话的学习记忆：错题本。
 *
 * 模型本身无状态，不把这段拼进 system，它每次都是第一次见这个孩子。
 * 但也不回放历史对话——那样 token 爆炸、噪声还大。
 * 这里只放「哪块反复错、当时填的什么、上次讲到哪」，通常 200-500 字。
 */
const VERDICT_TEXT = {
  wrong: '判错',
  skip: '点了不会',
  correct: '判对了但自己没底',
};

function shortDate(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || !d.getFullYear()) return '';
  return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

function describeMemory(memory, currentTopicId) {
  if (!Array.isArray(memory) || !memory.length) return '';
  const by = new Map();
  for (const m of memory.slice(0, 30)) {
    if (!m || typeof m !== 'object') continue;
    const key = m.tid ? String(m.tid) : 'unknown';
    const e = by.get(key) || { tid: m.tid ? String(m.tid) : null, count: 0, last: 0, samples: [] };
    e.count += Math.max(1, Number(m.count) || 1);
    const at = Number(m.at) || 0;
    if (at > e.last) e.last = at;
    if (m.ans || m.note) e.samples.push(m);
    by.set(key, e);
  }
  if (!by.size) return '';

  const rows = Array.from(by.values()).sort((a, b) => b.last - a.last).slice(0, 8);
  const lines = [];
  for (const e of rows) {
    const t = e.tid ? data.topic(e.tid) : null;
    const name = (t && (t.name || t.id)) || e.samples[0]?.tname || '未归到知识点';
    const sorted = e.samples.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    const s = sorted[0];
    /* 客户端算好的相对时间优先（「今天」比「10-28」更像人话，也不受服务端时区影响） */
    const whenText = (s && s.when) || shortDate(e.last);
    const unsure = e.samples.filter((x) => x.verdict === 'correct').length;

    const bits = [];
    if (e.count > 1) bits.push(`累计 ${e.count} 次`);
    if (whenText) bits.push(`最近一次在${whenText}`);
    let line = `- 「${name}」` + (bits.length ? bits.join('，') : '');

    if (s) {
      const detail = [];
      if (s.ans) detail.push(`他填「${String(s.ans).slice(0, 40)}」`);
      const v = VERDICT_TEXT[s.verdict];
      if (v) detail.push(v);
      if (detail.length) line += '。' + detail.join('，');
      if (s.note) line += `。上次讲到这里：${String(s.note).slice(0, 80)}`;
    }
    if (unsure && !(s && s.verdict === 'correct')) {
      line += `（另有 ${unsure} 次判对了、但他自己说没底）`;
    }
    if (e.tid && currentTopicId && String(e.tid) === String(currentTopicId)) {
      line += '（就是他现在问的这块）';
    }
    lines.push(line);
  }
  if (!lines.length) return '';

  lines.push('');
  lines.push('用法：这是过去几天的真实作答记录，比你的直觉判断可信。');
  lines.push('他这次问到同一处，直接按记录下判断，不要再从头试探；但不要当着他的面逐条念这些记录，也不要拿「你又错了」这种话说他。');
  return lines.join('\n');
}

function describeKid(kid) {
  if (!kid || typeof kid !== 'object') return '';
  const parts = [];
  if (kid.name) parts.push('昵称：' + String(kid.name).slice(0, 12));
  if (kid.grade) parts.push('年级：' + String(kid.grade));
  if (kid.textbook) parts.push('教材：' + String(kid.textbook));
  if (!parts.length) return '';
  return parts.join('\n');
}

function subjectName(subject) {
  return { math: '数学', english: '英语', physics: '物理', chinese: '语文' }[subject] || '学科';
}

function build(input) {
  const opts = input || {};
  const q = opts.questionId ? data.question(opts.questionId) : null;
  /* 题目自带 topicId，比前端传的更可信，不一致时以题目为准 */
  const rawTopic = (q && q.topicId) || opts.topicId;
  const topicId = rawTopic ? data.resolveId(rawTopic) : null;
  const t = topicId ? data.topic(topicId) : null;
  const subject = (t && t.subject) || opts.subject || 'math';

  const blocks = [];
  const meta = { topicId, questionId: q ? q.id : null, chars: 0, prereqCount: 0, memoryCount: 0 };

  blocks.push(
    [
      '你是一位面向中国中小学生的' + subjectName(subject) + '辅导老师，说话温和、简短、具体。',
      '你的学生是孩子或青少年，不要用说教口吻，不要堆术语，一次只讲一个点。',
    ].join('\n')
  );

  const kid = describeKid(opts.kid);
  if (kid) blocks.push('## 学生信息\n' + kid + '\n（只用昵称称呼，不要追问真实姓名、学校、住址。）');

  if (t) {
    blocks.push('## 当前知识点\n' + describeTopic(t));
    const pre = describePrereqs(topicId);
    if (pre) {
      const isStart = pre.indexOf('这个知识点前面没有') === 0;
      blocks.push(
        '## 这个知识点之前需要的基础（算法沿先修边回溯，由近到远）\n' +
          pre +
          (isStart ? '' : '\n\n用法：当前题确实进行不下去时，再怀疑这些前置没打牢，并告诉学生你要退回去补哪一环。')
      );
      meta.prereqCount = (pre.match(/^- \[/gm) || []).length;
    }
  }

  if (q) blocks.push('## 当前这道题\n' + describeQuestion(q));
  else if (opts.questionText) blocks.push('## 当前这道题\n' + String(opts.questionText).slice(0, 800));
  if (opts.studentAnswer) {
    const v = { correct: '判定为对', wrong: '判定为错', skip: '没作答', manual: '需要自评' }[opts.verdict] || '';
    blocks.push(
      '（学生在这道题上填的是：' +
        String(opts.studentAnswer).slice(0, 200) +
        (v ? '，系统' + v : '') +
        '）'
    );
  }
  if (opts.hasFigure) {
    blocks.push('（这道题带插图，但你看不到图。讲的时候不要描述图里画了什么，让学生自己对图，你只讲文字条件之间的推理。）');
  }

  const why = describeWhy(opts);
  if (why) {
    blocks.push(
      '## 这题为什么出给他\n' +
        why +
        '\n\n用法：这是你判断的起点，不要说「我们一起来看一下」。先按这些事实下结论，再开始讲。'
    );
  }

  const trig = describeTrigger(opts);
  if (trig) blocks.push('## 这次他是怎么问的\n' + trig);

  const diag = describeDiag(opts.diag);
  if (diag) blocks.push('## 这个学生最近的诊断结果\n' + diag);

  /* 错题本：这个孩子过去几天具体错在哪儿。没有它，模型每轮都是第一次见他。 */
  const memory = describeMemory(opts.memory, topicId);
  if (memory) {
    blocks.push('## 他之前栽过的地方（跨对话记录）\n' + memory);
    meta.memoryCount = Array.isArray(opts.memory) ? opts.memory.length : 0;
  }

  if (!t && !q && !opts.questionText) {
    blocks.push(
      [
        '## 现在的情况',
        '- 学生没有提供具体题目，你也不知道他正在做哪一题。',
        '- 不要据此给泛泛的学习建议。先用一句话要题：「把题目文字发我，或者告诉我你在做哪个知识点。」',
        '- 如果他描述了在学什么，就着那个内容继续；不要替他编题目。',
      ].join('\n')
    );
  }

  blocks.push(
    [
      '## 怎么讲',
      '0. 你坐在孩子旁边讲题。第一句话直接给判断，不要客套，不要「我们一起来看看」。',
      '1. 先定位，再确认。学生问「这题怎么做」时，第一句必须说清三件事：这道题考什么、他大概卡在哪、需要先确认什么。',
      '   反例：「你觉得哪一步卡住了？」——他要是能说清就不问了。',
      '   正例：「这题是异分母分数加法。按诊断，你的问题不在这一层，而在通分——你前面两道错题都是分母没统一。先把通分拿下。」',
      '2. 上下文里有标准答案时，你的讲解必须与它一致。不要自己重新求解，不要给出与标准答案不同的结论。',
      '   万一按标准答案讲不通，就说「这一步我核对一下」，不要硬编。',
      '3. 一次只推进一步。讲完一步停下来问「这一步跟上没有」，学生确认了再走下一步。不要一口气倒完。',
      '4. 学生答错：对着标准答案指出错在哪一步，然后让他自己重做这一步。不要直接报正确答案。',
      '5. 学生说「我不会」「直接告诉我」，或者他点了「不会」：给完整解法，分步骤，每步一句话，最多 4 步，最后一句点出这题的核心考点。这时不要再反问。',
      '6. 学生答对：一句话确认，然后换一道同类变式（自己出，数字小到能心算）。但他明确要你讲解释时例外，先把依据讲透，别急着出题。',
      '7. 上面列了先修链，但不要在学生问当前题的时候就跑题去补前置。先解决眼前这道题；只有当前题确实因为某个前置卡住，才退回去补它，并且要告诉学生你在退。',
      '8. 涉及公式用 LaTeX：行内 $a+b=b+a$，独立成行 $$...$$。不要 markdown 表格，不要用代码块包裹整段回答。',
      '9. 不确定的结论不要编。宁可说「这个我核对一下」，也不要给学生一个错的知识。',
      '10. 只聊学习相关。学生聊别的，温和地把话题带回当前知识点。',
      '11. 不要输出 HTML。',
    ].join('\n')
  );

  const system = blocks.join('\n\n');
  meta.chars = system.length;
  meta.hasQuestion = !!(q || opts.questionText);
  meta.hasWhy = !!why;
  meta.topicName = t ? t.name || t.id : null;
  return { system, meta };
}

module.exports = { build };
