'use strict';

/* OpenAI 兼容协议。DeepSeek / 通义 / 智谱 / Kimi / OpenAI 本体都走这里。
 * 只做一件事：把上游 SSE 拆成纯文本增量。不做重试（重试放在调用方，避免重复计费）。 */

function endpoint(provider) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('provider ' + provider.name + ' 缺少 BASE_URL');
  /* 有人会把 base 写成 https://api.deepseek.com/v1，两种都容忍 */
  return /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/chat/completions';
}

async function* stream(opts) {
  const { provider, system, messages, signal, temperature, maxTokens } = opts;
  const body = {
    model: provider.model,
    messages: system ? [{ role: 'system', content: system }].concat(messages) : messages,
    stream: true,
    temperature,
    max_tokens: maxTokens,
  };

  const res = await fetch(endpoint(provider), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + provider.apiKey,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 600);
    } catch (err) {
      detail = '';
    }
    throw new Error('上游返回 ' + res.status + '：' + detail);
  }
  if (!res.body) throw new Error('上游没有返回流');

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    /* 正常 SSE 每行都很短。如果上游一直不发换行（连接被中间设备改写、返回了 HTML），
     * buffer 会无限增长把内存吃光，这里直接判定为畸形响应。 */
    if (buffer.length > 1024 * 1024) {
      throw new Error('上游返回的数据格式异常（长时间没有换行），已中断');
    }
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(payload);
      } catch (err) {
        continue;
      }
      if (json.usage && opts.onUsage) opts.onUsage(json.usage);
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) yield delta.content;
    }
  }
}

module.exports = { stream, endpoint };
