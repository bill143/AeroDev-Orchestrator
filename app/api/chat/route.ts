// app/api/chat/route.ts
// Server-side proxy to AI model providers. API keys are read from the server
// environment and NEVER sent to the browser. The client (AIPlayground.tsx →
// streamCompletion) POSTs { prompt, model, capability } here and receives the
// model's text streamed back as a plain-text body.
//
// ROUTING: if `model` contains a "/" (e.g. "deepseek/deepseek-r1:free") the
// request is sent to OpenRouter. Otherwise it is sent to Google Gemini.
//
// REQUIRED ENV VARS (set in your host's dashboard, never in code):
//   GEMINI_API_KEY      = key from https://aistudio.google.com/apikey
//   OPENROUTER_API_KEY  = key from https://openrouter.ai/keys

export const runtime = 'edge';

interface ChatBody {
  prompt?: string;
  model?: string;
  capability?: string;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function systemFor(capability: string): string {
  switch (capability) {
    case 'code':
      return 'You are a senior software engineer. Prefer correct, production-ready code with brief explanations. Use fenced code blocks.';
    case 'search':
      return 'You are a research assistant. Answer concisely and note when a claim would need a live source to verify.';
    case 'image':
      return 'Describe, in vivid detail, the image the user is asking for. (Image generation is not yet enabled; provide a precise prompt-style description.)';
    case 'video':
      return 'Describe, shot by shot, the video the user is asking for. (Video generation is not yet enabled; provide a precise storyboard.)';
    default:
      return 'You are a helpful, concise assistant.';
  }
}

export async function POST(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const prompt = (body.prompt ?? '').toString().trim();
  if (!prompt) return json({ error: 'Missing "prompt".' }, 400);
  if (prompt.length > 32000) return json({ error: 'Prompt too long.' }, 413);

  const capability = (body.capability ?? 'auto').toString();
  const requestedModel = (body.model ?? '').toString().trim();
  const isOpenRouter = requestedModel.includes('/');

  if (isOpenRouter) {
    return handleOpenRouter(requestedModel, prompt, capability);
  }
  return handleGemini(requestedModel, prompt, capability);
}

async function handleOpenRouter(model: string, prompt: string, capability: string): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return json({ error: 'Server is not configured with OPENROUTER_API_KEY.' }, 501);
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://aero-dev-orchestrator.vercel.app',
        'X-Title': 'Elite Arena',
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.7,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemFor(capability) },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch {
    return json({ error: 'Failed to reach the model service.' }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await safeText(upstream);
    return json({ error: `Model service error (${upstream.status}). ${detail}`.trim() }, 502);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const evt of events) {
          for (const line of evt.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload);
              const text = obj?.choices?.[0]?.delta?.content;
              if (text) controller.enqueue(encoder.encode(text));
            } catch {}
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });

  return streamResponse(stream);
}

async function handleGemini(requestedModel: string, prompt: string, capability: string): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'Server is not configured with GEMINI_API_KEY.' }, 501);
  }

  const model =
    requestedModel.toLowerCase().startsWith('gemini')
      ? requestedModel
      : (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

  const upstreamUrl = `${GEMINI_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemFor(capability) }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
    });
  } catch {
    return json({ error: 'Failed to reach the model service.' }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await safeText(upstream);
    return json({ error: `Model service error (${upstream.status}). ${detail}`.trim() }, 502);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const evt of events) {
          for (const line of evt.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload);
              const text = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) controller.enqueue(encoder.encode(text));
            } catch {}
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });

  return streamResponse(stream);
}

function streamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return '';
  }
}