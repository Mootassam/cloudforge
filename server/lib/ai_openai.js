'use strict';
// OpenAI engine — same shape as ai.js (runAgent/checkKey/DEFAULT_MODEL) so the
// AI developer can run on OpenAI instead of Claude. It speaks OpenAI's
// chat-completions + function-calling format, but keeps the conversation history
// in the SAME Anthropic-style block format the rest of CloudForge uses, by
// translating in and out on every call. That way switching provider changes
// nothing else.
const OpenAI = require('openai');

const DEFAULT_MODEL = 'gpt-4o';
const MAX_ITERS = 14;

// our tool defs ({name, description, input_schema}) → OpenAI function tools
function toOaiTool(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } };
}

// Anthropic-style messages → OpenAI messages
function toOpenAI(system, msgs) {
  const out = [{ role: 'system', content: system }];
  for (const msg of msgs) {
    const content = msg.content;
    if (msg.role === 'user') {
      if (typeof content === 'string') { out.push({ role: 'user', content }); continue; }
      const toolResults = content.filter(b => b && b.type === 'tool_result');
      const others = content.filter(b => b && b.type !== 'tool_result');
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) });
      }
      if (others.length) {
        const parts = others.map(b => b.type === 'image'
          ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
          : { type: 'text', text: b.text || '' });
        out.push({ role: 'user', content: parts });
      }
    } else if (msg.role === 'assistant') {
      if (typeof content === 'string') { out.push({ role: 'assistant', content }); continue; }
      const textParts = content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
      const toolUses = content.filter(b => b && b.type === 'tool_use');
      const am = { role: 'assistant', content: textParts ? textParts : (toolUses.length ? null : '') };
      if (toolUses.length) am.tool_calls = toolUses.map(tu => ({ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }));
      out.push(am);
    }
  }
  return out;
}

async function runAgent({ apiKey, model, system, messages, tools, exec, onStep }) {
  const client = new OpenAI({ apiKey });
  const usedModel = model || DEFAULT_MODEL;
  const msgs = messages.slice();            // canonical Anthropic-style history
  const usage = { input_tokens: 0, output_tokens: 0 };
  let finalText = '';
  let iters = 0;

  while (iters++ < MAX_ITERS) {
    const resp = await client.chat.completions.create({
      model: usedModel,
      messages: toOpenAI(system, msgs),
      tools: tools.map(toOaiTool),
      tool_choice: 'auto',
      max_tokens: 4096
    });
    if (resp.usage) { usage.input_tokens += resp.usage.prompt_tokens || 0; usage.output_tokens += resp.usage.completion_tokens || 0; }

    const m = (resp.choices && resp.choices[0] && resp.choices[0].message) || {};
    if (m.content) finalText = String(m.content).trim();

    // store the assistant turn in Anthropic-style blocks
    const aBlocks = [];
    if (m.content) aBlocks.push({ type: 'text', text: String(m.content) });
    const toolCalls = m.tool_calls || [];
    for (const tc of toolCalls) {
      let input = {}; try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
      aBlocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    msgs.push({ role: 'assistant', content: aBlocks.length ? aBlocks : [{ type: 'text', text: '' }] });

    if (!toolCalls.length) break;

    const results = [];
    for (const tc of toolCalls) {
      let input = {}; try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
      if (onStep) onStep(tc.function.name, input);
      let outp;
      try { outp = await exec(tc.function.name, input); }
      catch (e) { outp = 'ERROR: ' + (e && e.message || e); }
      results.push({ type: 'tool_result', tool_use_id: tc.id, content: String(outp == null ? '' : outp).slice(0, 60000) });
    }
    msgs.push({ role: 'user', content: results });
  }

  return { text: finalText || 'Done.', messages: msgs, usage, model: usedModel };
}

// Cheap validity check — listing models needs a valid key, costs nothing.
async function checkKey(apiKey) {
  if (!apiKey) return { valid: false, error: 'No OpenAI key set.' };
  try { await new OpenAI({ apiKey }).models.list(); return { valid: true }; }
  catch (e) {
    const s = e && e.status;
    if (s === 401 || s === 403) return { valid: false, error: 'The OpenAI key is invalid or not authorized.' };
    return { valid: false, error: (e && e.message) ? String(e.message).split('\n')[0] : 'Could not verify the key.' };
  }
}

module.exports = { runAgent, checkKey, toOpenAI, toOaiTool, DEFAULT_MODEL };
