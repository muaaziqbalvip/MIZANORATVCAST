/**
 * StreamForge 24/7 — Vercel Live HLS (.m3u8) Stream & Relay Endpoint (/api/stream)
 * (v2.6 — Includes Automatic Nimble Streamer `nimblesessionid` 404 Session Healer)
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
 * Generates candidate parent/entry URLs when a Nimble Streamer / OTT URL with
 * an expired `?nimblesessionid=...` or `chunks.m3u8` returns HTTP 404.
 */
function buildSessionRecoveryCandidates(rawUrl) {
  const candidates = [rawUrl];
  try {
    const u = new URL(rawUrl);
    // 1. Strip expired nimblesessionid / wmsAuthSign query param
    if (u.searchParams.has('nimblesessionid')) {
      const noSession = new URL(rawUrl);
      noSession.searchParams.delete('nimblesessionid');
      candidates.push(noSession.toString());
    }

    const baseNoQuery = `${u.origin}${u.pathname}`;
    if (!candidates.includes(baseNoQuery)) candidates.push(baseNoQuery);

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      // Same directory playlist.m3u8 and index.m3u8
      const dirPath = '/' + parts.slice(0, -1).join('/');
      candidates.push(`${u.origin}${dirPath}/playlist.m3u8`);
      candidates.push(`${u.origin}${dirPath}/index.m3u8`);

      // Parent directory playlist.m3u8 and index.m3u8 (e.g. /live/pogo_sd_abr/playlist.m3u8)
      if (parts.length >= 3) {
        const parentDir = '/' + parts.slice(0, -2).join('/');
        candidates.push(`${u.origin}${parentDir}/playlist.m3u8`);
        candidates.push(`${u.origin}${parentDir}/index.m3u8`);
      }
      if (parts.length >= 4) {
        const grandParentDir = '/' + parts.slice(0, -3).join('/');
        candidates.push(`${u.origin}${grandParentDir}/playlist.m3u8`);
        candidates.push(`${u.origin}${grandParentDir}/index.m3u8`);
      }
    }
  } catch (_) {}

  return [...new Set(candidates)];
}

async function fetchWithSessionRecovery(targetUrl, headers) {
  const candidates = buildSessionRecoveryCandidates(targetUrl);
  let lastRes = null;

  for (const candidateUrl of candidates) {
    try {
      const res = await fetch(candidateUrl, {
        headers: {
          ...headers,
          'Connection': 'close'
        },
        redirect: 'follow'
      });
      if (res.ok) {
        return { res, resolvedUrl: res.url || candidateUrl, healed: candidateUrl !== targetUrl };
      }
      lastRes = res;
    } catch (_) {}
  }

  return { res: lastRes, resolvedUrl: targetUrl, healed: false };
}

function rewriteM3u8Manifest(manifestText, sourceManifestUrl, baseUrl, slug, useSegmentProxy = false) {
  const lines = manifestText.split(/\r?\n/);
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

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
      const { res: upstreamRes, resolvedUrl, healed } = await fetchWithSessionRecovery(proxyTargetUrl, upstreamHeaders);

      if (!upstreamRes || !upstreamRes.ok) {
        res.statusCode = upstreamRes ? upstreamRes.status : 502;
        return res.end(`Upstream stream returned HTTP ${res.statusCode}`);
      }

      if (healed) {
        res.setHeader('X-StreamForge-Session-Healed', 'true');
      }

      const contentType = upstreamRes.headers.get('content-type') || '';
      if (
        contentType.includes('mpegurl') ||
        /\.m3u8(\?|$)/i.test(resolvedUrl)
      ) {
        const text = await upstreamRes.text();
        const rewritten = rewriteM3u8Manifest(
          text,
          resolvedUrl,
          baseUrl,
          channel.slug,
          Boolean(channel.referer)
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        return res.end(rewritten);
      }

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
  const ghOwner = store.settings?.githubOwner || process.env.GITHUB_OWNER || '';
  const ghRepo = store.settings?.githubRepo || process.env.GITHUB_REPO || '';

  // Try GitHub 'live-streams' branch first if FFmpeg runner is actively pushing segments
  if (ghOwner && ghRepo) {
    const rawGhUrl = `https://raw.githubusercontent.com/${encodeURIComponent(ghOwner)}/${encodeURIComponent(ghRepo)}/live-streams/channels/${channel.slug}/index.m3u8`;
    try {
      const ghRes = await fetch(rawGhUrl, { headers: { 'Cache-Control': 'no-cache' } });
      if (ghRes.ok) {
        const ghManifest = await ghRes.text();
        if (ghManifest.includes('#EXTM3U') && ghManifest.includes('.ts')) {
          const rewritten = rewriteM3u8Manifest(ghManifest, rawGhUrl, baseUrl, channel.slug, false);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          res.setHeader('X-StreamForge-Source', 'github-live-streams-branch');
          return res.end(rewritten);
        }
      }
    } catch (_) {}
  }

  // Fetch & rewrite live stream from channel's sourceUrl with automatic Nimble session recovery
  try {
    const activeSourceUrl = store.signals?.[channel.slug]?.sourceUrl || channel.sourceUrl;
    const { res: upstreamRes, resolvedUrl, healed } = await fetchWithSessionRecovery(activeSourceUrl, upstreamHeaders);

    if (!upstreamRes || !upstreamRes.ok) {
      res.statusCode = upstreamRes ? upstreamRes.status : 502;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: false,
        error: `Source stream returned HTTP ${res.statusCode}`,
        sourceUrl: activeSourceUrl
      }));
    }

    if (healed) {
      res.setHeader('X-StreamForge-Session-Healed', 'true');
    }

    const manifestText = await upstreamRes.text();
    const rewrittenManifest = rewriteM3u8Manifest(
      manifestText,
      resolvedUrl,
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
