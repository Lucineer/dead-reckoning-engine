// ═══════════════════════════════════════════════════════════════════
// Dead Reckoning Engine — Expensive models storyboard. Cheap models animate. Git coordinates.
// Cocapn Vessel — The repo IS the agent
// Superinstance & Lucineer (DiGennaro et al.) — 2026-04-04
// ═══════════════════════════════════════════════════════════════════

export interface Env {
  DR_KV: KVNamespace;
  // BYOK — set in Cloudflare Secrets Store
  DEEPSEEK_API_KEY?: string;
  SILICONFLOW_API_KEY?: string;
  DEEPINFRA_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

// ── Folder constants (KV prefix keys) ──
const FOLDERS = {
  compass: 'dr:compass:',      // Human input / focus
  dead: 'dr:dead:',            // Imagined answers (not correct)
  working: 'dr:working:',      // Current practical understanding
  ground: 'dr:ground:',        // Verified knowledge
  open: 'dr:open:',            // Open questions for other agents
  archives: 'dr:archives:',    // Preserved dead ends
  published: 'dr:published:',  // Ready for consumption
} as const;

const NOVELTY_THRESHOLD = 0.85; // If last N outputs >85% similar → plateau

// ── Storyboarder / Inbetweener model configs ──
const STORYBOARDERS = [
  { id: 'deepseek-reasoner', url: 'https://api.deepseek.com/chat/completions', envKey: 'DEEPSEEK_API_KEY', cost: 'high' },
  { id: 'seed-2.0-pro', url: 'https://api.deepinfra.com/v1/openai/chat/completions', envKey: 'DEEPINFRA_API_KEY', cost: 'high' },
  { id: 'kimi-k2.5', url: 'https://api.moonshot.ai/v1/chat/completions', envKey: 'MOONSHOT_API_KEY', cost: 'high' },
];

const INBETWEENERS = [
  { id: 'deepseek-chat', url: 'https://api.deepseek.com/chat/completions', envKey: 'DEEPSEEK_API_KEY', cost: 'low' },
  { id: 'seed-2.0-mini', url: 'https://api.deepinfra.com/v1/openai/chat/completions', envKey: 'DEEPINFRA_API_KEY', cost: 'low' },
  { id: 'phi-4', url: 'https://api.deepinfra.com/v1/openai/chat/completions', envKey: 'DEEPINFRA_API_KEY', cost: 'very-low' },
  { id: 'hermes-3-70b', url: 'https://api.deepinfra.com/v1/openai/chat/completions', envKey: 'DEEPINFRA_API_KEY', cost: 'low' },
  { id: 'olmo-3.1-32b', url: 'https://api.deepinfra.com/v1/openai/chat/completions', envKey: 'DEEPINFRA_API_KEY', cost: 'low' },
];

// ── Helper: simple hash for novelty detection ──
async function simpleHash(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Helper: call LLM ──
async function callModel(model: { id: string; url: string; envKey: string }, prompt: string, env: Env, maxTokens = 2000, temperature = 0.8): Promise<string> {
  const key = env[model.envKey as keyof Env];
  if (!key) return `[No API key for ${model.envKey}]`;
  try {
    const resp = await fetch(model.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      }),
    });
    if (!resp.ok) return `[API error ${resp.status}: ${await resp.text()}]`;
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content || '[Empty response]';
  } catch (e: any) {
    return `[Fetch error: ${e.message}]`;
  }
}

// ── Helper: get first available model ──
function getAvailable(models: { envKey: string }[], env: Env) {
  return models.find(m => env[m.envKey as keyof Env]) || null;
}

// ── Helper: list all items in a folder ──
async function listFolder(kv: KVNamespace, prefix: string): Promise<{ key: string; value: string }[]> {
  const items: { key: string; value: string }[] = [];
  let cursor: string | undefined;
  do {
    const list = await kv.list({ prefix, cursor, limit: 100 });
    for (const key of list.keys) {
      const keyStr = (key as any).name || String(key);
      const value = await kv.get(keyStr) || '';
      items.push({ key: keyStr.slice(prefix.length), value });
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return items;
}

// ── Pipeline: Process compass input → storyboard ──
async function processCompass(env: Env): Promise<string[]> {
  const results: string[] = [];
  const items = await listFolder(env.DR_KV, FOLDERS.compass);
  const unprocessed = items.filter(i => !i.key.startsWith('_processed/'));

  if (unprocessed.length === 0) return ['No new compass input'];

  const storyboarder = getAvailable(STORYBOARDERS, env);
  if (!storyboarder) return ['No storyboarder API key available'];

  for (const item of unprocessed.slice(0, 3)) { // Max 3 per pulse
    const prompt = `You are a storyboard artist for a research/development pipeline.

The creator has dropped this into the compass-bearing folder:
---
${item.value}
---

Create a DEAD RECKONING storyboard. This is NOT the final answer. It's a framework for exploration.

Structure your response:
1. CORE QUESTION: What is the creator actually trying to understand/build?
2. KEY BEATS: 3-5 major insight points to explore
3. OPEN THREADS: Questions that need more work
4. ASSUMPTIONS: What are we assuming that might be wrong?
5. NEXT FRAMES: Specific prompts for inbetweener models to explore each beat

Be specific and practical. This will be used by cheaper models to fill in details.`;

    const storyboard = await callModel(storyboarder, prompt, env, 2500, 0.9);
    const hash = await simpleHash(storyboard);

    // Store dead reckoning
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await env.DR_KV.put(`${FOLDERS.dead}${id}`, JSON.stringify({
      compassKey: item.key,
      storyboard,
      hash,
      model: storyboarder.id,
      createdAt: new Date().toISOString(),
      inbetweenerCount: 0,
      lastNoveltyCheck: null,
      noveltyScores: [],
      status: 'storyboarded',
    }));

    // Mark compass as processed
    await env.DR_KV.put(`${FOLDERS.compass}_processed/${item.key}`, item.value);
    await env.DR_KV.delete(`${FOLDERS.compass}${item.key}`);

    results.push(`Storyboarded: ${item.key.slice(0, 30)} → dead/${id}`);
  }

  return results;
}

// ── Pipeline: Inbetweeners iterate on dead reckoning ──
async function iterateDeadReckoning(env: Env): Promise<string[]> {
  const results: string[] = [];
  const inbetweener = getAvailable(INBETWEENERS, env);
  if (!inbetweener) return ['No inbetweener API key available'];

  const items = await listFolder(env.DR_KV, FOLDERS.dead);
  const active = items.filter(i => {
    try { return JSON.parse(i.value).status === 'storyboarded'; } catch { return false; }
  });

  for (const item of active.slice(0, 2)) { // Max 2 per pulse
    const dr = JSON.parse(item.value);
    const count = dr.inbetweenerCount || 0;

    // Check novelty plateau
    if (count >= 3 && dr.noveltyScores.length >= 3) {
      const recent = dr.noveltyScores.slice(-3);
      const avgSimilarity = recent.reduce((a: number, b: number) => a + b, 0) / recent.length;
      if (avgSimilarity > NOVELTY_THRESHOLD) {
        dr.status = 'plateaued';
        await env.DR_KV.put(`${FOLDERS.dead}${item.key}`, JSON.stringify(dr));
        results.push(`Plateaued: ${item.key} → needs new storyboard`);
        continue;
      }
    }

    if (count >= 10) {
      dr.status = 'exhausted';
      await env.DR_KV.put(`${FOLDERS.dead}${item.key}`, JSON.stringify(dr));
      results.push(`Exhausted: ${item.key} → 10 iterations`);
      continue;
    }

    // Call inbetweener with the storyboard + previous iterations
    const prompt = `You are an inbetweener artist. A storyboarder has created this framework:

${dr.storyboard}

This has been iterated ${count} times. ${count > 0 ? 'Previous iterations are available in the dead-reckoning folder.' : ''}

Pick ONE key beat from the storyboard that hasn't been deeply explored yet. Flesh it out with specifics, examples, and concrete details. Be creative but stay within the established framework. 500 words.`;

    const iteration = await callModel(inbetweener, prompt, env, 1500, 0.95);
    const hash = await simpleHash(iteration);

    // Store iteration
    const iterId = `${item.key}/iter-${count}`;
    await env.DR_KV.put(`${FOLDERS.dead}${iterId}`, JSON.stringify({
      parentKey: item.key,
      iteration,
      hash,
      model: inbetweener.id,
      createdAt: new Date().toISOString(),
    }));

    // Update parent with novelty score
    const prevHash = dr.lastNoveltyHash;
    let novelty = 1.0;
    if (prevHash) novelty = prevHash === hash ? 0.0 : 0.5 + Math.random() * 0.4; // Simplified
    dr.noveltyScores.push(novelty);
    dr.inbetweenerCount = count + 1;
    dr.lastNoveltyHash = hash;
    dr.lastNoveltyCheck = new Date().toISOString();
    await env.DR_KV.put(`${FOLDERS.dead}${item.key}`, JSON.stringify(dr));

    results.push(`Iterated: ${item.key} → ${inbetweener.id} (round ${count + 1}, novelty: ${novelty.toFixed(2)})`);
  }

  return results;
}

// ── Pipeline: Move plateaued items to working-theory ──
async function graduateToWorking(env: Env): Promise<string[]> {
  const results: string[] = [];
  const items = await listFolder(env.DR_KV, FOLDERS.dead);
  const graduated = items.filter(i => {
    try { return JSON.parse(i.value).status === 'plateaued' || JSON.parse(i.value).status === 'exhausted'; } catch { return false; }
  });

  for (const item of graduated) {
    const dr = JSON.parse(item.value);
    // Gather all iterations
    const iterations = await listFolder(env.DR_KV, `${FOLDERS.dead}${item.key}/`);

    await env.DR_KV.put(`${FOLDERS.working}${item.key}`, JSON.stringify({
      ...dr,
      iterationCount: iterations.length,
      graduatedAt: new Date().toISOString(),
      assumptions: ['Derived from dead reckoning — verify before relying on this'],
      status: 'working',
    }));

    results.push(`Graduated: ${item.key} → working-theory`);
  }

  return results;
}

// ── HTML landing page ──
const HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Dead Reckoning Engine</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh}
.container{max-width:900px;margin:0 auto;padding:2rem}
h1{font-size:2rem;background:linear-gradient(135deg,#f59e0b,#ef4444);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.5rem}
.subtitle{color:#888;margin-bottom:2rem}
.pipeline{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:2rem 0}
.folder{padding:.6rem 1rem;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer;transition:all .2s;border:1px solid #333}
.folder:hover{transform:translateY(-2px)}
.compass{background:#1a1a2e;border-color:#f59e0b44;color:#f59e0b}
.dead{background:#1a1a2e;border-color:#ef444444;color:#ef4444}
.working{background:#1a1a2e;border-color:#3b82f644;color:#3b82f6}
.ground{background:#1a1a2e;border-color:#22c55e44;color:#22c55e}
.published{background:#1a1a2e;border-color:#a855f744;color:#a855f7}
.arrow{color:#444;font-size:1.2rem}
.section{margin:2rem 0}
.section h2{font-size:1.1rem;color:#aaa;margin-bottom:1rem;text-transform:uppercase;letter-spacing:.1em}
.items{display:flex;flex-direction:column;gap:.5rem}
.item{background:#111;padding:1rem;border-radius:8px;border-left:3px solid #333;font-size:.85rem}
.item pre{white-space:pre-wrap;font-size:.8rem;color:#aaa;margin-top:.5rem;max-height:200px;overflow:hidden}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin:2rem 0}
.stat{background:#111;padding:1rem;border-radius:8px;text-align:center}
.stat .num{font-size:1.8rem;font-weight:700}
.stat .label{font-size:.7rem;color:#888;text-transform:uppercase;margin-top:.25rem}
.api-status{font-size:.8rem;color:#666;margin:1rem 0}
form{display:flex;gap:.5rem;margin:1rem 0}
form input{flex:1;padding:.6rem;background:#111;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:.9rem}
form button{padding:.6rem 1.2rem;background:linear-gradient(135deg,#f59e0b,#ef4444);border:none;border-radius:6px;color:#fff;font-weight:600;cursor:pointer}
</style>
</head><body>
<div class="container">
<h1>⚓ Dead Reckoning Engine</h1>
<p class="subtitle">Expensive models storyboard. Cheap models animate. Git coordinates.</p>

<div class="stats" id="stats">
<div class="stat"><div class="num" id="s-compass">-</div><div class="label">Compass</div></div>
<div class="stat"><div class="num" id="s-dead">-</div><div class="label">Dead Reckoning</div></div>
<div class="stat"><div class="num" id="s-working">-</div><div class="label">Working Theory</div></div>
<div class="stat"><div class="num" id="s-ground">-</div><div class="label">Ground Truth</div></div>
<div class="stat"><div class="num" id="s-published">-</div><div class="label">Published</div></div>
<div class="stat"><div class="num" id="s-open">-</div><div class="label">Open Questions</div></div>
</div>

<div class="pipeline">
<div class="folder compass">compass-bearing</div><span class="arrow">→</span>
<div class="folder dead">dead-reckoning</div><span class="arrow">→</span>
<div class="folder working">working-theory</div><span class="arrow">→</span>
<div class="folder ground">ground-truth</div><span class="arrow">→</span>
<div class="folder published">published</div>
</div>

<div class="section">
<h2>🧭 Drop into Compass</h2>
<p style="color:#666;font-size:.85rem;margin-bottom:.5rem">Add prompts, focus areas, or raw ideas. The engine will storyboard and iterate.</p>
<form id="compass-form">
<input type="text" id="compass-input" placeholder="What are you thinking about? Drop it here..." />
<button type="submit">Drop</button>
</form>
</div>

<div class="section">
<h2>📋 Dead Reckoning Items</h2>
<div class="items" id="dead-items"><p style="color:#444">Loading...</p></div>
</div>

<div class="section">
<h2>🔧 Working Theory</h2>
<div class="items" id="working-items"><p style="color:#444">Loading...</p></div>
</div>

<div class="section">
<h2>❓ Open Questions</h2>
<div class="items" id="open-items"><p style="color:#444">Loading...</p></div>
</div>
</div>

<script>
const API = '';

async function load() {
  const r = await fetch(API + '/api/status');
  const d = await r.json();
  document.getElementById('s-compass').textContent = d.compass;
  document.getElementById('s-dead').textContent = d.dead;
  document.getElementById('s-working').textContent = d.working;
  document.getElementById('s-ground').textContent = d.ground;
  document.getElementById('s-published').textContent = d.published;
  document.getElementById('s-open').textContent = d.open;

  document.getElementById('dead-items').innerHTML = d.deadItems.map(i =>
    '<div class="item" style="border-left-color:#ef4444"><strong>' + i.id + '</strong> <span style="color:#666">(' + i.model + ', ' + i.iterations + ' iters)</span><pre>' + (i.storyboard || '').slice(0, 300) + '...</pre></div>'
  ).join('') || '<p style="color:#444">No dead reckoning items</p>';

  document.getElementById('working-items').innerHTML = d.workingItems.map(i =>
    '<div class="item" style="border-left-color:#3b82f6"><strong>' + i.id + '</strong><pre>' + (i.storyboard || '').slice(0, 200) + '...</pre></div>'
  ).join('') || '<p style="color:#444">No working theory items</p>';

  document.getElementById('open-items').innerHTML = d.openItems.map(i =>
    '<div class="item" style="border-left-color:#22c55e"><strong>' + i.id + '</strong><pre>' + (i.value || '').slice(0, 200) + '</pre></div>'
  ).join('') || '<p style="color:#444">No open questions</p>';
}

document.getElementById('compass-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('compass-input');
  if (!input.value.trim()) return;
  await fetch(API + '/api/compass', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: input.value}) });
  input.value = '';
  setTimeout(load, 1000);
};

load();
setInterval(load, 30000);
</script>
</head><div style="text-align:center;padding:24px;color:#475569;font-size:.75rem"><a href="https://the-fleet.casey-digennaro.workers.dev" style="color:#64748b">⚓ The Fleet</a> · <a href="https://cocapn.ai" style="color:#64748b">Cocapn</a></div></body></html>`;

// ── Router ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS + CSP
    const headers = {
      'Content-Type': 'application/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https:*;",
      'Access-Control-Allow-Origin': '*',
    };

    // Landing page
    if (path === '/') {
      return new Response(HTML, { headers });
    }

    // Health
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', vessel: 'dead-reckoning-engine', version: '0.1.0', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  if (path === '/vessel.json') { try { const vj = await import('./vessel.json', { with: { type: 'json' } }); return new Response(JSON.stringify(vj.default || vj), { headers: { 'Content-Type': 'application/json' } }); } catch { return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); } }

    // Status — folder counts + items
    if (path === '/api/status') {
      try {
      const [compass, dead, working, ground, published, open] = await Promise.all([
        listFolder(env.DR_KV, FOLDERS.compass),
        listFolder(env.DR_KV, FOLDERS.dead),
        listFolder(env.DR_KV, FOLDERS.working),
        listFolder(env.DR_KV, FOLDERS.ground),
        listFolder(env.DR_KV, FOLDERS.published),
        listFolder(env.DR_KV, FOLDERS.open),
      ]);

      const deadItems = dead.filter(i => !i.key.includes('/')).map(i => {
        try {
          const d = JSON.parse(i.value);
          return { id: i.key, model: d.model, iterations: d.inbetweenerCount || 0, status: d.status, storyboard: d.storyboard?.slice(0, 500) };
        } catch { return { id: i.key, model: '?', iterations: 0, status: 'parse-error', storyboard: '' } };
      });

      const workingItems = working.map(i => {
        try { return { id: i.key, storyboard: JSON.parse(i.value).storyboard?.slice(0, 300) }; }
        catch { return { id: i.key, storyboard: '' }; }
      });

      return new Response(JSON.stringify({
        compass: compass.filter(i => !i.key.startsWith('_processed/')).length,
        dead: dead.length,
        working: working.length,
        ground: ground.length,
        published: published.length,
        open: open.length,
        deadItems: deadItems.slice(0, 10),
        workingItems: workingItems.slice(0, 10),
        openItems: open.slice(0, 10),
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Drop into compass
    if (path === '/api/compass' && request.method === 'POST') {
      const body = await request.json() as { content: string };
      if (!body.content) return new Response(JSON.stringify({ error: 'No content' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.DR_KV.put(`${FOLDERS.compass}${id}`, body.content);
      return new Response(JSON.stringify({ ok: true, id }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Drop open question
    if (path === '/api/open' && request.method === 'POST') {
      const body = await request.json() as { question: string };
      if (!body.question) return new Response(JSON.stringify({ error: 'No question' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.DR_KV.put(`${FOLDERS.open}${id}`, JSON.stringify({ question: body.question, createdAt: new Date().toISOString(), answers: [] }));
      return new Response(JSON.stringify({ ok: true, id }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Trigger pipeline manually
    if (path === '/api/pipeline' && request.method === 'POST') {
      try {
        const results: Record<string, string[]> = {};
        results.compass = await processCompass(env);
        results.iterate = await iterateDeadReckoning(env);
        results.graduate = await graduateToWorking(env);
        return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e.message, stack: e.stack }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Promote working-theory to ground-truth
    if (path === '/api/ground' && request.method === 'POST') {
      const body = await request.json() as { key: string; evidence: string };
      const item = await env.DR_KV.get(`${FOLDERS.working}${body.key}`);
      if (!item) return new Response(JSON.stringify({ error: 'Not found in working-theory' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const parsed = JSON.parse(item);
      parsed.status = 'ground-truth';
      parsed.verifiedAt = new Date().toISOString();
      parsed.evidence = body.evidence || 'Manual verification';
      await env.DR_KV.put(`${FOLDERS.ground}${body.key}`, JSON.stringify(parsed));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Promote ground-truth to published
    if (path === '/api/publish' && request.method === 'POST') {
      const body = await request.json() as { key: string };
      const item = await env.DR_KV.get(`${FOLDERS.ground}${body.key}`);
      if (!item) return new Response(JSON.stringify({ error: 'Not found in ground-truth' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const parsed = JSON.parse(item);
      parsed.status = 'published';
      parsed.publishedAt = new Date().toISOString();
      await env.DR_KV.put(`${FOLDERS.published}${body.key}`, JSON.stringify(parsed));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Move dead-reckoning to archives
    if (path === '/api/archive' && request.method === 'POST') {
      const body = await request.json() as { key: string };
      const item = await env.DR_KV.get(`${FOLDERS.dead}${body.key}`);
      if (!item) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      await env.DR_KV.put(`${FOLDERS.archives}${body.key}`, item);
      await env.DR_KV.delete(`${FOLDERS.dead}${body.key}`);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not found', { status: 404 });
  },

  // Cron trigger — pulse check every 5 minutes
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const results: string[] = [];
    results.push(...(await processCompass(env)));
    results.push(...(await iterateDeadReckoning(env)));
    results.push(...(await graduateToWorking(env)));
    console.log(`Pulse: ${results.join('; ')}`);
  },
};
