const API_BASE = "https://smart-clinic-1.onrender.com"


async function api(path, opts = {}) {
  const url = API_BASE + path;
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(()=>null);
    throw new Error(text || 'API error ' + res.status);
  }
  try { return await res.json(); } catch(e) { return null; }
}
