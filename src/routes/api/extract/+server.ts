import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { SYSTEM_PROMPT, EXTRACT_PROMPT, EXTRACT_TOOL, REGION_PROMPT, REGION_TOOL } from '$lib/extract/prompt';
import { providerOf, type ExtractRequest, type Provider } from '$lib/types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MAX_TOKENS = 1024;
const MAX_RETRIES = 4;
const BACKOFF_BASE = 1500; // ms: 1.5, 3, 6, 12

const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro'
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRIABLE = [408, 409, 429, 500, 502, 503, 529];

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
}

// Anthropic Messages API with forced tool_use.
async function callAnthropic(
  key: string,
  model: string,
  image: string,
  prompt: string,
  tool: typeof EXTRACT_TOOL | typeof REGION_TOOL
): Promise<unknown> {
  const payload = {
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: prompt }
        ]
      }
    ]
  };
  let lastErr = 'unknown error';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      lastErr = `Anthropic HTTP ${res.status}`;
      if (RETRIABLE.includes(res.status) && attempt < MAX_RETRIES) { await sleep(BACKOFF_BASE * 2 ** attempt); continue; }
      throw new Error(lastErr);
    }
    const data = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
    const block = (data.content ?? []).find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (block?.input != null) return block.input;
    lastErr = 'Model returned no tool_use block';
    if (attempt < MAX_RETRIES) { await sleep(BACKOFF_BASE * 2 ** attempt); continue; }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

// Gemini via its OpenAI-compatible Chat Completions endpoint, forced function call.
async function callGemini(
  key: string,
  model: string,
  image: string,
  prompt: string,
  tool: typeof EXTRACT_TOOL | typeof REGION_TOOL
): Promise<unknown> {
  const payload = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
        ]
      }
    ],
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
    tool_choice: { type: 'function', function: { name: tool.name } }
  };
  let lastErr = 'unknown error';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      lastErr = `Gemini HTTP ${res.status}`;
      if (RETRIABLE.includes(res.status) && attempt < MAX_RETRIES) { await sleep(BACKOFF_BASE * 2 ** attempt); continue; }
      throw new Error(lastErr);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    const args = msg?.tool_calls?.[0]?.function?.arguments;
    try {
      if (args) return JSON.parse(args);
      if (msg?.content) return JSON.parse(stripFences(msg.content));
    } catch {
      lastErr = 'Could not parse model JSON';
    }
    if (!args && !msg?.content) lastErr = 'Model returned no structured output';
    if (attempt < MAX_RETRIES) { await sleep(BACKOFF_BASE * 2 ** attempt); continue; }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

function resolveKey(provider: Provider, requestKey?: string): string | null {
  const fromReq = (requestKey ?? '').trim();
  if (fromReq) return fromReq;
  const envKey = provider === 'google' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
  return envKey?.trim() || null;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: ExtractRequest;
  try {
    body = (await request.json()) as ExtractRequest;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { image, model, mode, hint, apiKey } = body;
  if (!image || !ALLOWED_MODELS.has(model)) {
    return json({ ok: false, error: 'Missing image or unsupported model' }, { status: 400 });
  }

  const provider = providerOf(model);
  const key = resolveKey(provider, apiKey);
  if (!key) {
    const label = provider === 'google' ? 'Google AI' : 'Anthropic';
    return json({ ok: false, error: `Missing ${label} API key — enter it in settings or set the server env var.` }, { status: 401 });
  }

  const isRegions = mode === 'regions';
  const tool = isRegions ? REGION_TOOL : EXTRACT_TOOL;
  const basePrompt = isRegions ? REGION_PROMPT : EXTRACT_PROMPT;
  const trimmedHint = (hint ?? '').trim();
  const prompt = trimmedHint ? `${basePrompt}\n\n${trimmedHint}` : basePrompt;

  try {
    const data =
      provider === 'google'
        ? await callGemini(key, model, image, prompt, tool)
        : await callAnthropic(key, model, image, prompt, tool);
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
};
