// Uses Google's Gemini API (free tier, no credit card required).
// Get a free key at https://aistudio.google.com/apikey and set it as the
// GEMINI_API_KEY environment variable in your Vercel project settings.
const MODEL = 'gemini-3.1-flash-lite';

// Free-tier Gemini regularly answers 429/503 ("high demand") for a few
// seconds at a time, so we retry with a growing delay before giving up.
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [700, 1500, 2500];
const ATTEMPT_TIMEOUT_MS = 25000;
const TOTAL_BUDGET_MS = 50000; // stays under the 60s maxDuration in vercel.json

const BUSY_MESSAGE = "Clarity's getting a lot of questions right now — give it a few seconds and try again.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (status) => status === 429 || status >= 500;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Clarity isn't fully set up yet (missing API key on the server)." });
  }

  try {
    const { system, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'No message to send.' });
    }

    const contents = messages.map((m) => {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      (m.attachments || []).forEach((a) => {
        if (a && a.mimeType && a.data) parts.push({ inlineData: { mimeType: a.mimeType, data: a.data } });
      });
      if (parts.length === 0) parts.push({ text: '' });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    const body = JSON.stringify({
      ...(typeof system === 'string' && system ? { system_instruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: { maxOutputTokens: 1200 },
    });

    const callGemini = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
      try {
        return await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal }
        );
      } finally {
        clearTimeout(timer);
      }
    };

    const startedAt = Date.now();
    let response = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        response = await callGemini();
      } catch (err) {
        // Network error or per-attempt timeout — treat like a transient failure.
        response = null;
      }
      if (response && !isRetryable(response.status)) break;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || Date.now() - startedAt + delay > TOTAL_BUDGET_MS) break;
      await sleep(delay);
    }

    if (!response) {
      return res.status(503).json({ error: BUSY_MESSAGE });
    }

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) {
      if (isRetryable(response.status)) {
        return res.status(503).json({ error: BUSY_MESSAGE });
      }
      const message = data?.error?.message || `Gemini API error (${response.status})`;
      return res.status(response.status || 502).json({ error: message });
    }
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to contact AI service' });
  }
}
