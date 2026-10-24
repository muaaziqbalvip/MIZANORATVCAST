/**
 * StreamForge 24/7 — Vercel Live HLS (.m3u8) Stream & Relay Endpoint (/api/stream)
 *
 * Generates a permanent Vercel .m3u8 link per channel:
 *   https://<your-vercel-domain>/api/stream/<channel-slug>/index.m3u8
 *
 * Connects seamlessly to:
 *   1. Active GitHub Action Runner Signal & `live-streams` branch HLS buffer
 *   2. Intelligent Edge HLS Manifest Rewriter & CORS/Header Proxy for 24/7 uninterrupted playback
 */

const {
  ensureFilesInitialized,
  computeChannelLiveTelemetry
} = require('./_lib/store');
const { sanitizeSlug } = require('./_lib/workflow-generator');

function getBaseUrl(req, store) {
  if (store?.settings?.vercelUrl) {
    return store.settings.vercelUrl.replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch (_) {
    return relative;
  }
}

/**
 * Rewrites an HLS .m3u8 manifest so all relative URLs (variant playlists, segments, keys)
 * point either to the proxy endpoint (when custom headers/CORS are needed) or absolute URLs.
 */
function rewriteM3u8Manifest(manifestText, sourceManifestUrl, baseUrl, slug, useSegmentProxy = false) {
  const lines = manifestText.split(/\r?\n/);
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite URI="..." attributes inside #EXT-X-MEDIA or #EXT-X-KEY or #EXT-X-MAP tags
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uriVal) => {
        const absUri = resolveUrl(sourceManifestUrl, uriVal);
        if (absUri.includes('.m3u8') || useSegmentProxy) {
          const proxied = `${baseUrl}/api/stream/${slug}/proxy?url=${encodeURIComponent(absUri)}`;
          return `URI="${proxied}"`;
        }
        return `URI="${absUri}"`;
      });
    }

    // Non-comment line is a child playlist (.m3u8) or media segment (.ts, .m4s, .aac)
    const absUrl = resolveUrl(sourceManifestUrl, trimmed);
    const isSubPlaylist = /\.m3u8(\?|$)/i.test(absUrl);

    if (isSubPlaylist || useSegmentProxy) {
      return `${baseUrl}/api/stream/${slug}/proxy?url=${encodeURIComponent(absUrl)}`;
    }
    return absUrl;
  });

  return rewritten.join('\n');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  const store = ensureFilesInitialized();
  const baseUrl = getBaseUrl(req, store);
  const urlObj = new URL(req.url, baseUrl);

  // Extract slug & file from query or path (/api/stream/:slug/:file)
  let slug = urlObj.searchParams.get('slug') || '';
  let file = urlObj.searchParams.get('file') || 'index.m3u8';
  const proxyTargetUrl = urlObj.searchParams.get('url') || '';

  if (!slug) {
    const pathMatch = urlObj.pathname.match(/^\/(?:api\/)?stream\/([^/.]+)(?:\.m3u8|\/(.*))?$/);
    if (pathMatch) {
      slug = pathMatch[1];
      file = pathMatch[2] || 'index.m3u8';
    }
  }

  slug = sanitizeSlug(slug);
  const rawChannel = (store.channels || []).find(c => c.slug === slug || c.id === slug);

  if (!rawChannel) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: false,
      error: `Channel '${slug}' not found in StreamForge 24/7 registry.`
    }));
  }

  const channel = computeChannelLiveTelemetry(rawChannel);

  // Attach live 24/7 relay signal telemetry headers
  res.setHeader('X-StreamForge-Channel', channel.slug);
  res.setHeader('X-StreamForge-Slot', channel.telemetry.activeSlot);
  res.setHeader('X-StreamForge-Next-Slot', channel.telemetry.nextSlot);
  res.setHeader('X-StreamForge-Generation', String(channel.telemetry.generation));
  res.setHeader('X-StreamForge-Loop-Phase', channel.telemetry.phase);

  const upstreamHeaders = {
    'User-Agent': channel.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };
  if (channel.referer) {
    upstreamHeaders['Referer'] = channel.referer;
  }

  // Case 1: Sub-playlist or segment proxy request (/api/stream/:slug/proxy?url=...)
  if (file === 'proxy' || proxyTargetUrl) {
    if (!proxyTargetUrl) {
      res.statusCode = 400;
      return res.end('Missing proxy target url');
    }

    try {
      const upstreamRes = await fetch(proxyTargetUrl, {
        headers: upstreamHeaders,
        redirect: 'follow'
      });

      if (!upstreamRes.ok) {
        res.statusCode = upstreamRes.status;
        return res.end(`Upstream stream returned HTTP ${upstreamRes.status}`);
      }

      const contentType = upstreamRes.headers.get('content-type') || '';
      const finalUrl = upstreamRes.url || proxyTargetUrl;

      if (
        contentType.includes('mpegurl') ||
        /\.m3u8(\?|$)/i.test(finalUrl)
      ) {
        const text = await upstreamRes.text();
        const rewritten = rewriteM3u8Manifest(
          text,
          finalUrl,
          baseUrl,
          channel.slug,
          Boolean(channel.referer)
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        return res.end(rewritten);
      }

      // Binary segment (.ts, .m4s, .aac)
      const arrayBuf = await upstreamRes.arrayBuffer();
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType || 'video/mp2t');
      return res.end(Buffer.from(arrayBuf));
    } catch (err) {
      res.statusCode = 502;
      return res.end(`Stream proxy error: ${err.message}`);
    }
  }

  // Case 2: Primary Vercel .m3u8 endpoint (/api/stream/:slug/index.m3u8)
  // Step 2A: Check if GitHub 'live-streams' branch has an active FFmpeg HLS relay manifest
  const ghOwner = store.settings?.githubOwner || process.env.GITHUB_OWNER || '';
  const ghRepo = store.settings?.githubRepo || process.env.GITHUB_REPO || '';

  if (ghOwner && ghRepo && req.url.includes('mode=github_branch')) {
    const rawGhUrl = `https://raw.githubusercontent.com/${encodeURIComponent(ghOwner)}/${encodeURIComponent(ghRepo)}/live-streams/channels/${channel.slug}/index.m3u8`;
    try {
      const ghRes = await fetch(rawGhUrl, { headers: { 'Cache-Control': 'no-cache' } });
      if (ghRes.ok) {
        const ghManifest = await ghRes.text();
        if (ghManifest.includes('#EXTM3U')) {
          const rewritten = rewriteM3u8Manifest(ghManifest, rawGhUrl, baseUrl, channel.slug, false);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          res.setHeader('X-StreamForge-Source', 'github-live-streams-branch');
          return res.end(rewritten);
        }
      }
    } catch (_) {}
  }

  // Step 2B: Fetch & rewrite live stream from channel's sourceUrl connected with runner signal
  try {
    const activeSourceUrl = store.signals?.[channel.slug]?.sourceUrl || channel.sourceUrl;
    const upstreamRes = await fetch(activeSourceUrl, {
      headers: upstreamHeaders,
      redirect: 'follow'
    });

    if (!upstreamRes.ok) {
      res.statusCode = upstreamRes.status;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: false,
        error: `Source stream returned HTTP ${upstreamRes.status}`,
        sourceUrl: activeSourceUrl
      }));
    }

    const finalUrl = upstreamRes.url || activeSourceUrl;
    const manifestText = await upstreamRes.text();

    const rewrittenManifest = rewriteM3u8Manifest(
      manifestText,
      finalUrl,
      baseUrl,
      channel.slug,
      Boolean(channel.referer)
    );

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('X-StreamForge-Source', 'active-24x7-signal-relay');
    return res.end(rewrittenManifest);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: false,
      error: `Failed to connect to upstream m3u8 signal: ${err.message}`
    }));
  }
};
