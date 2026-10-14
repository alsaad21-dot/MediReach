// Permanently deletes the signed-in person's data and login.
//
// Deleting a login needs Supabase's secret key, which must never reach the browser — so the browser
// asks this endpoint, which checks who is asking and then deletes only *that* person's rows.
// Set SUPABASE_SERVICE_ROLE_KEY (the project's secret key) in your Vercel project settings.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qtofuzvlftxlqxnejxqh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_RXjnbT5WVKUP1v-eV3SgyQ_CeFk7aey';

// Child rows first, then the profile, then the login itself.
const TABLES = ['messages', 'feedback', 'conversations', 'profiles'];

// Legacy service-role keys are JWTs and go in both headers; newer "sb_secret_..." keys go in apikey only.
const adminHeaders = (key) => ({
  apikey: key,
  ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
  'Content-Type': 'application/json',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return res.status(501).json({ error: "Account deletion isn't switched on yet. Please contact the MediReach team." });
  }

  try {
    const header = String(req.headers?.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Please sign in again and retry.' });
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'Deletion was not confirmed.' });

    // Who is asking? (Only ever delete the caller's own data.)
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!who) return res.status(503).json({ error: "Couldn't check your sign-in just now — please try again." });
    if (!who.ok) return res.status(401).json({ error: 'Your session has expired — refresh the page and sign in again.' });
    const user = await who.json().catch(() => null);
    const userId = user && user.id;
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return res.status(401).json({ error: 'Please sign in again and retry.' });

    for (const table of TABLES) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?user_id=eq.${userId}`, {
        method: 'DELETE',
        headers: { ...adminHeaders(serviceKey), Prefer: 'return=minimal' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        console.error(`delete-account: couldn't clear ${table} (${r.status})`);
        return res.status(502).json({ error: "Couldn't delete everything — please try again." });
      }
    }

    const del = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: adminHeaders(serviceKey),
      signal: AbortSignal.timeout(20000),
    });
    if (!del.ok) {
      console.error(`delete-account: couldn't delete login (${del.status})`);
      return res.status(502).json({ error: "Your data was deleted, but we couldn't remove your login. Please try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Something went wrong deleting your account. Please try again.' });
  }
}
