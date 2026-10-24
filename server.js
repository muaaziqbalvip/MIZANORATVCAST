/**
 * StreamForge 24/7 — Local & Production HTTP Server
 * Mirrors Vercel Serverless Routing (`vercel.json`) for local dev, Docker, VPS, and Live Preview.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const channelsHandler = require('./api/channels');
const githubHandler = require('./api/github');
const signalHandler = require('./api/signal');
const streamHandler = require('./api/stream');
const playlistHandler = require('./api/playlist');
const downloadZipHandler = require('./api/download-zip');
const { ensureFilesInitialized, syncLocalWorkflowFiles } = require('./api/_lib/store');

// Initialize default channels & write initial .github/workflows/channel-*.yml files on boot
const initialStore = ensureFilesInitialized();
syncLocalWorkflowFiles(initialStore);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'audio/x-mpegurl',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const urlObj = new URL(req.url, `${proto}://${host}`);
    const pathname = urlObj.pathname;

    // 1. API Routes & Vercel Rewrites
    if (pathname === '/api/channels' || pathname === '/api/channels/') {
      return await channelsHandler(req, res);
    }

    if (pathname === '/api/github' || pathname === '/api/github/') {
      return await githubHandler(req, res);
    }

    if (pathname === '/api/signal' || pathname === '/api/signal/') {
      return await signalHandler(req, res);
    }

    if (pathname === '/api/playlist' || pathname === '/api/playlist.m3u' || pathname === '/playlist.m3u') {
      return await playlistHandler(req, res);
    }

    if (pathname === '/api/download-zip' || pathname === '/api/download-zip/') {
      return await downloadZipHandler(req, res);
    }

    // Stream routes:
    // - /api/stream?slug=...
    // - /api/stream/:slug/index.m3u8
    // - /api/stream/:slug/:file
    // - /stream/:slug.m3u8
    if (
      pathname === '/api/stream' ||
      pathname.startsWith('/api/stream/') ||
      pathname.startsWith('/stream/')
    ) {
      return await streamHandler(req, res);
    }

    // Allow viewing raw generated .github/workflows/*.yml directly
    if (pathname.startsWith('/.github/workflows/') && pathname.endsWith('.yml')) {
      const wfFile = path.basename(pathname);
      const wfPath = path.join(__dirname, '.github', 'workflows', wfFile);
      if (fs.existsSync(wfPath)) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        return res.end(fs.readFileSync(wfPath, 'utf8'));
      }
    }

    // 2. Serve Static Frontend from public/
    let safePath = pathname === '/' ? '/index.html' : pathname;
    safePath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(PUBLIC_DIR, safePath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.end(fs.readFileSync(filePath));
  } catch (err) {
    console.error('Server error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`====================================================================`);
  console.log(`📺 StreamForge 24/7 Live TV Engine (Vercel + GitHub Actions)`);
  console.log(`🌐 Dashboard URL   : http://${HOST}:${PORT}`);
  console.log(`📡 Master M3U      : http://${HOST}:${PORT}/api/playlist.m3u`);
  console.log(`⚡ 24/7 Loop Mode  : 4h Stream -> 5m Overlap Signal -> 5h Cap`);
  console.log(`====================================================================`);
});
