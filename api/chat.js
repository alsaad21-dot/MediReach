// Uses Google's Gemini API (free tier, no credit card required).
// Get a free key at https://aistudio.google.com/apikey and set it as the
// GEMINI_API_KEY environment variable in your Vercel project settings.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { system, messages } = req.body;
    const contents = (messages || []).map((m) => {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      (m.attachments || []).forEach((a) => {
        if (a && a.mimeType && a.data) parts.push({ inlineData: { mimeType: a.mimeType, data: a.data } });
      });
      if (parts.length === 0) parts.push({ text: '' });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    const callGemini = () => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { maxOutputTokens: 1200 },
        }),
      }
    );

    let response = await callGemini();
    // Free-tier rate limits can trip under bursty traffic (e.g. a room full of
    // people trying it at once) — one short retry smooths over most of those.
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      response = await callGemini();
    }

    const data = await response.json();
    if (!response.ok || data.error) {
      if (response.status === 429) {
        return res.status(429).json({ error: "Clarity's getting a lot of questions right now — give it a few seconds and try again." });
      }
      const message = data?.error?.message || `Gemini API error (${response.status})`;
      return res.status(response.status || 502).json({ error: message });
    }
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to contact AI service' });
  }
}
