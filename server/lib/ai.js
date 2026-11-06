'use strict';
// Claude agent loop (official Anthropic SDK). Runs a bounded tool-use loop:
// Claude calls our tools (list files / read file / propose edit), we execute
// them, and loop until it stops. The AI key stays server-side (hidden).
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_ITERS = 14;

// Drop "thinking" blocks before we store/resend an assistant turn. Thinking
// blocks are bound to the exact conversation + system prompt that made them;
// resending them after the system prompt changes (e.g. the owner edits the
// global rules) returns a 400. We don't need them preserved across turns.
function stripThinking(content) {
  if (!Array.isArray(content)) return content;
  return content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
}

// tools: [{name, description, input_schema}], exec(name, input) -> string result
async function runAgent({ apiKey, model, system, messages, tools, exec, onStep }) {
  const client = new Anthropic({ apiKey });
  const usedModel = model || DEFAULT_MODEL;
  const msgs = messages.slice();
  let iters = 0;
  let finalText = '';
  // accumulate token usage across the whole tool-use loop (for spend estimates)
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  while (iters++ < MAX_ITERS) {
    const resp = await client.messages.create({
      model: usedModel,
      max_tokens: 16000,
      system,
      tools,
      messages: msgs
    });
    if (resp.usage) {
      usage.input_tokens += resp.usage.input_tokens || 0;
      usage.output_tokens += resp.usage.output_tokens || 0;
      usage.cache_read_input_tokens += resp.usage.cache_read_input_tokens || 0;
      usage.cache_creation_input_tokens += resp.usage.cache_creation_input_tokens || 0;
    }

    // collect any assistant text
    const textParts = resp.content.filter(b => b.type === 'text').map(b => b.text);
    if (textParts.length) finalText = textParts.join('\n').trim();

    if (resp.stop_reason === 'refusal') {
      finalText = 'I can’t help with that request.';
      msgs.push({ role: 'assistant', content: stripThinking(resp.content) });
      break;
    }

    // keep the assistant turn (text + tool_use), minus thinking blocks
    msgs.push({ role: 'assistant', content: stripThinking(resp.content) });

    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !toolUses.length) break;

    const results = [];
    for (const tu of toolUses) {
      if (onStep) onStep(tu.name, tu.input);
      let out;
      try { out = await exec(tu.name, tu.input); }
      catch (e) { out = 'ERROR: ' + (e && e.message || e); }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out == null ? '' : out).slice(0, 60000) });
    }
    msgs.push({ role: 'user', content: results });
  }

  return { text: finalText || 'Done.', messages: msgs, usage, model: usedModel };
}

// Cheap validity check for an API key — count_tokens costs nothing but needs a
// working key, so it tells us if the key is valid without spending credit.
async function checkKey(apiKey, model) {
  if (!apiKey) return { valid: false, error: 'No AI key set.' };
  try {
    await new Anthropic({ apiKey }).messages.countTokens({
      model: model || DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'ping' }]
    });
    return { valid: true };
  } catch (e) {
    const status = e && e.status;
    if (status === 401 || status === 403) return { valid: false, error: 'The API key is invalid or not authorized.' };
    if (status === 400) return { valid: true, note: 'Key works (model may need adjusting).' };
    return { valid: false, error: (e && e.message) ? e.message.split('\n')[0] : 'Could not verify the key.' };
  }
}

module.exports = { runAgent, checkKey, DEFAULT_MODEL };
