/**
 * StreamForge 24/7 — Runner Signal Receiver & Handover Router (/api/signal)
 * Connects the GitHub Actions 4h+5m loop signals directly to the Vercel 24/7 Stream APIs.
 */

const {
  ensureFilesInitialized,
  saveStore,
  logEvent
} = require('./_lib/store');
const { sanitizeSlug } = require('./_lib/workflow-generator');

async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Stream-Token');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  const store = ensureFilesInitialized();

  if (req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      activeSignals: store.signals || {},
      recentEvents: (store.events || []).slice(0, 25)
    }));
  }

  if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    const slug = sanitizeSlug(body.slug || '');

    if (!slug) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: 'Missing channel slug in signal payload' }));
    }

    if (!store.signals) store.signals = {};

    const decodedManifest = body.manifestBase64
      ? Buffer.from(body.manifestBase64, 'base64').toString('utf8')
      : null;

    store.signals[slug] = {
      slug,
      state: body.state || 'LIVE',
      slot: body.slot || 'A',
      nextSlot: body.nextSlot || 'B',
      generation: Number(body.generation) || 1,
      elapsedSeconds: Number(body.elapsedSeconds) || 0,
      loopDurationSeconds: Number(body.loopDurationSeconds) || 14400,
      overlapDurationSeconds: Number(body.overlapDurationSeconds) || 300,
      runId: body.runId || null,
      repository: body.repository || null,
      sourceUrl: body.sourceUrl || null,
      manifestContent: decodedManifest || store.signals[slug]?.manifestContent || null,
      message: body.message || '',
      updatedAt: new Date().toISOString()
    };

    // Update corresponding channel record in registry
    const ch = (store.channels || []).find(c => c.slug === slug);
    if (ch) {
      ch.status = body.state === 'HANDOVER_COMPLETED' ? 'LIVE' : (body.state || 'LIVE');
      if (body.state === 'HANDOVER_COMPLETED') {
        ch.activeSlot = body.nextSlot || (ch.activeSlot === 'A' ? 'B' : 'A');
        ch.nextSlot = ch.activeSlot === 'A' ? 'B' : 'A';
        ch.generation = (Number(body.generation) || ch.generation || 1) + 1;
        ch.startedAt = new Date().toISOString();
      } else {
        ch.activeSlot = body.slot || ch.activeSlot || 'A';
        ch.nextSlot = body.nextSlot || ch.nextSlot || 'B';
        ch.generation = Number(body.generation) || ch.generation || 1;
      }
      ch.lastSignalAt = new Date().toISOString();
    }

    if (body.state === 'HANDOVER_OVERLAP' || body.state === 'HANDOVER_COMPLETED' || body.state === 'STARTING') {
      logEvent(store, body.state, slug, body.message || `Signal ${body.state} from Slot ${body.slot} (Gen #${body.generation})`);
    }

    saveStore(store);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      receivedAt: new Date().toISOString(),
      slug,
      activeState: store.signals[slug].state
    }));
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
};
