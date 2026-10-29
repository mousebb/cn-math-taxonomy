'use strict';

/* Anthropic Messages API：协议不同，单独适配。
 * 差异：system 是顶层字段、鉴权用 x-api-key、必须带 anthropic-version、事件类型不同。 */

function endpoint(provider) {
  const base = String(provider.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  return base + '/v1/messages';
}

async function* stream(opts) {
  const { provider, system, messages, signal, temperature, maxTokens } = opts;

  const res = await fetch(endpoint(provider), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens || 1600,
      temperature: typeof temperature === 'number' ? temperature : 0.4,
      system: system || undefined,
      messages,
      stream: true,
    }),
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
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch (err) {
        continue;
      }
      if (json.type === 'content_block_delta' && json.delta && json.delta.type === 'text_delta') {
        if (json.delta.text) yield json.delta.text;
      } else if (json.type === 'message_stop') {
        return;
      } else if (json.type === 'error' && json.error) {
        throw new Error('上游报错：' + (json.error.message || ''));
      }
    }
  }
}

module.exports = { stream, endpoint };
