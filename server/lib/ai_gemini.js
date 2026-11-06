'use strict';
// Google Gemini engine — same shape as ai.js / ai_openai.js
// (runAgent/checkKey/DEFAULT_MODEL). Speaks Gemini's REST + function-calling
// format but keeps the conversation in the SAME Anthropic-style block format
// the rest of CloudForge uses, translating in/out each call. Uses Node 18
// global fetch — no extra SDK.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_ITERS = 14;

// our tool defs → Gemini functionDeclarations (strip JSON-schema bits Gemini rejects)
function toDecl(t) {
  const p = JSON.parse(JSON.stringify(t.input_schema || { type: 'object', properties: {} }));
  delete p.additionalProperties;
  if (p.properties) for (const k of Object.keys(p.properties)) { delete p.properties[k].additionalProperties; }
  return { name: t.name, description: t.description, parameters: p };
}

// Anthropic-style messages → Gemini contents (tracks tool_use id → name so a
// tool_result can be matched back to its function by name, as Gemini requires).
function toGemini(msgs) {
  const contents = [];
  const idName = {};
  for (const m of msgs) {
    const c = m.content;
    if (m.role === 'user') {
      if (typeof c === 'string') { contents.push({ role: 'user', parts: [{ text: c }] }); continue; }
      const parts = [];
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text') parts.push({ text: b.text || '' });
        else if (b.type === 'image') parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
        else if (b.type === 'tool_result') parts.push({ functionResponse: { name: idName[b.tool_use_id] || 'tool', response: { result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) } } });
      }
      if (parts.length) contents.push({ role: 'user', parts });
    } else if (m.role === 'assistant') {
      if (typeof c === 'string') { contents.push({ role: 'model', parts: [{ text: c }] }); continue; }
      const parts = [];
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') { idName[b.id] = b.name; parts.push({ functionCall: { name: b.name, args: b.input || {} } }); }
      }
      if (parts.length) contents.push({ role: 'model', parts });
    }
  }
  return contents;
}

async function callGemini(apiKey, model, body) {
  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body)
  });
  let data = null; try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return data;
}

async function runAgent({ apiKey, model, system, messages, tools, exec, onStep }) {
  const usedModel = model || DEFAULT_MODEL;
  const msgs = messages.slice();                 // canonical Anthropic-style history
  const usage = { input_tokens: 0, output_tokens: 0 };
  let finalText = '';
  let iters = 0;

  while (iters++ < MAX_ITERS) {
    const data = await callGemini(apiKey, usedModel, {
      system_instruction: { parts: [{ text: system }] },
      contents: toGemini(msgs),
      tools: [{ function_declarations: tools.map(toDecl) }],
      generationConfig: { maxOutputTokens: 4096 }
    });
    const um = data.usageMetadata || {};
    usage.input_tokens += um.promptTokenCount || 0;
    usage.output_tokens += um.candidatesTokenCount || 0;

    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const calls = [];
    const aBlocks = [];
    let text = '';
    parts.forEach((p, i) => {
      if (p.text) { text += p.text; }
      else if (p.functionCall) { const id = 'g' + iters + '_' + i; calls.push({ id, name: p.functionCall.name, input: p.functionCall.args || {} }); aBlocks.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} }); }
    });
    if (text) { finalText = text.trim(); aBlocks.unshift({ type: 'text', text }); }
    msgs.push({ role: 'assistant', content: aBlocks.length ? aBlocks : [{ type: 'text', text: '' }] });

    if (!calls.length) break;

    const results = [];
    for (const call of calls) {
      if (onStep) onStep(call.name, call.input);
      let out; try { out = await exec(call.name, call.input); } catch (e) { out = 'ERROR: ' + (e && e.message || e); }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: String(out == null ? '' : out).slice(0, 60000) });
    }
    msgs.push({ role: 'user', content: results });
  }

  return { text: finalText || 'Done.', messages: msgs, usage, model: usedModel };
}

async function checkKey(apiKey) {
  if (!apiKey) return { valid: false, error: 'No Gemini key set.' };
  try {
    const res = await fetch(`${BASE}/models`, { headers: { 'x-goog-api-key': apiKey } });
    if (res.ok) return { valid: true };
    if (res.status === 400 || res.status === 401 || res.status === 403) return { valid: false, error: 'The Gemini key is invalid or not authorized.' };
    return { valid: false, error: 'Gemini said HTTP ' + res.status };
  } catch (e) { return { valid: false, error: (e && e.message) ? String(e.message).split('\n')[0] : 'Could not reach Gemini.' }; }
}

module.exports = { runAgent, checkKey, toGemini, DEFAULT_MODEL };
