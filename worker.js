/**
 * Cloudflare Worker — Anthropic API Proxy + Deploy Notes CRUD
 *
 * Secrets (Cloudflare Dashboard > Workers > Settings > Variables & Secrets):
 *   ANTHROPIC_API_KEY  : Anthropic API 키
 *   NOTES_TOKEN        : 배포 노트 편집용 토큰 (쓰기 전용, 읽기는 공개)
 *
 * KV Binding (Settings > KV Namespace Bindings):
 *   Variable name: NOTES  →  KV namespace: DEPLOY_NOTES
 */

const ALLOWED_ORIGINS = [
  'https://ynlee-pm.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'file://',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o)) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function checkToken(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return env.NOTES_TOKEN && token === env.NOTES_TOKEN;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── GET /notes  : 전체 노트 조회 (공개) ──
    if (path === '/notes' && request.method === 'GET') {
      const raw = await env.NOTES.get('notes');
      return json(raw ? JSON.parse(raw) : [], 200, origin);
    }

    // ── POST /notes  : 노트 저장 (토큰 필요) ──
    if (path === '/notes' && request.method === 'POST') {
      if (!checkToken(request, env)) return json({ error: 'Unauthorized' }, 401, origin);
      let notes;
      try { notes = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }
      await env.NOTES.put('notes', JSON.stringify(notes));
      return json({ ok: true }, 200, origin);
    }

    // ── DELETE /notes/:id  : 노트 개별 삭제 (토큰 필요) ──
    if (path.startsWith('/notes/') && request.method === 'DELETE') {
      if (!checkToken(request, env)) return json({ error: 'Unauthorized' }, 401, origin);
      const id = path.slice('/notes/'.length);
      const raw = await env.NOTES.get('notes');
      const notes = (raw ? JSON.parse(raw) : []).filter(n => n.id !== id);
      await env.NOTES.put('notes', JSON.stringify(notes));
      return json({ ok: true }, 200, origin);
    }

    // ── POST /  : Anthropic API 프록시 ──
    if (request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: { message: 'Worker에 ANTHROPIC_API_KEY Secret이 설정되지 않았습니다.' } }, 500, origin);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: { message: 'Invalid JSON body' } }, 400, origin); }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  },
};
