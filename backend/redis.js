// ═══════════════════════════════════════════════════════════════════
// REDIS CLIENT — Upstash REST API (sin SDK, solo fetch)
// Usado para persistir promos.json entre deploys de Railway.
// Si no hay credenciales configuradas, todas las ops son no-ops silenciosas.
// ═══════════════════════════════════════════════════════════════════

const URL   = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export async function redisGet(key) {
  if (!URL || !TOKEN) return null;
  try {
    const res = await fetch(`${URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    return data.result !== null && data.result !== undefined
      ? JSON.parse(data.result)
      : null;
  } catch {
    return null;
  }
}

export async function redisSet(key, value) {
  if (!URL || !TOKEN) return;
  try {
    await fetch(`${URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value)),
    });
  } catch (err) {
    console.warn('⚠️  Redis SET falló:', err.message);
  }
}
