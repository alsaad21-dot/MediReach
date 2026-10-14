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

// ---- Who may call this endpoint ---------------------------------------------
// Only people signed in to MediReach (guests included) may use Clarity — otherwise anyone who finds
// this URL could spend the Gemini quota. The browser sends its Supabase access token and we check it
// with Supabase. These two values are public by design (they already ship in index.html), so they
// are safe to keep here; set SUPABASE_URL / SUPABASE_ANON_KEY in Vercel to override.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qtofuzvlftxlqxnejxqh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_RXjnbT5WVKUP1v-eV3SgyQ_CeFk7aey';

// ---- Limits ----------------------------------------------------------------
// Best-effort, per server instance (Vercel may run several, and they reset when they restart), so this
// stops casual abuse and runaway loops rather than a determined attacker. For hard limits, add a Vercel
// Firewall rate-limit rule on /api/chat as well.
const USER_PER_MINUTE = 10;
const USER_PER_HOUR = 120;
const IP_PER_MINUTE = 30;
const MAX_MESSAGES = 80;
const MAX_SYSTEM_CHARS = 30000;
const MAX_MESSAGE_CHARS = 12000;
const MAX_ATTACHMENTS_PER_MESSAGE = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (status) => status === 429 || status >= 500;

const hits = new Map(); // key -> array of timestamps (ms)
function overLimit(key, windowMs, max, now) {
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, recent);
  return recent.length >= max;
}
function record(key, now) {
  const list = hits.get(key) || [];
  list.push(now);
  hits.set(key, list);
}
function prune(now) {
  if (hits.size < 2000) return;
  for (const [key, list] of hits) {
    if (!list.some((t) => now - t < 3600 * 1000)) hits.delete(key);
  }
}

const verified = new Map(); // token -> { userId, until }
async function verifyToken(token) {
  const now = Date.now();
  const cached = verified.get(token);
  if (cached && cached.until > now) return { userId: cached.userId };

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return { unavailable: true };
  }
  if (response.status === 401 || response.status === 403) return { invalid: true };
  if (!response.ok) return { unavailable: true };
  const user = await response.json().catch(() => null);
  if (!user || !user.id) return { invalid: true };
  if (verified.size > 1000) verified.clear();
  verified.set(token, { userId: user.id, until: now + 60 * 1000 });
  return { userId: user.id };
}

function validate(system, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'No message to send.';
  if (messages.length > MAX_MESSAGES) return 'This conversation is too long — start a new chat.';
  if (system !== undefined && (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS)) return 'Invalid request.';
  for (const m of messages) {
    if (!m || typeof m !== 'object') return 'Invalid request.';
    if (m.content !== undefined && m.content !== null && (typeof m.content !== 'string' || m.content.length > MAX_MESSAGE_CHARS)) {
      return 'That message is too long — try shortening it.';
    }
    if (m.attachments !== undefined && m.attachments !== null) {
      if (!Array.isArray(m.attachments) || m.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) return 'Too many attachments.';
      for (const a of m.attachments) {
        const okType = a && typeof a.mimeType === 'string' && (a.mimeType.startsWith('image/') || a.mimeType === 'application/pdf');
        if (!okType || typeof a.data !== 'string') return 'Unsupported attachment.';
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Clarity isn't fully set up yet (missing API key on the server)." });
  }

  try {
    const now = Date.now();
    prune(now);

    // 1. Signed in?
    const header = String(req.headers?.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      return res.status(401).json({ error: 'Please sign in to chat with Clarity. If you were signed in, refresh the page and try again.' });
    }
    const auth = await verifyToken(token);
    if (auth.unavailable) {
      return res.status(503).json({ error: "Couldn't check your sign-in just now — please try again in a moment." });
    }
    if (auth.invalid) {
      return res.status(401).json({ error: 'Your session has expired — refresh the page and sign in again.' });
    }

    // 2. Not going too fast?
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const ipKey = `ip:${forwarded || 'unknown'}`;
    const userKey = `user:${auth.userId}`;
    if (overLimit(userKey, 60 * 1000, USER_PER_MINUTE, now) || overLimit(userKey, 3600 * 1000, USER_PER_HOUR, now) || overLimit(ipKey, 60 * 1000, IP_PER_MINUTE, now)) {
      res.setHeader?.('Retry-After', '20');
      return res.status(429).json({ error: "You're sending messages quickly — wait a few seconds and try again." });
    }
    record(userKey, now);
    record(ipKey, now);

    // 3. Sensible request?
    const { system, messages } = req.body || {};
    const problem = validate(system, messages);
    if (problem) return res.status(400).json({ error: problem });

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
