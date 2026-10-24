/**
 * StreamForge 24/7 — Channels & Workflow Management API (/api/channels)
 * Handles adding channels, generating per-channel .yml files, pushing to GitHub via Token,
 * and triggering the 24/7 4h+5m relay loop.
 */

const fs = require('fs');
const path = require('path');
const {
  WORKFLOWS_DIR,
  ensureFilesInitialized,
  saveStore,
  syncLocalWorkflowFiles,
  computeChannelLiveTelemetry,
  logEvent
} = require('./_lib/store');
const {
  sanitizeSlug,
  generateChannelWorkflowYaml,
  generateWatchdogWorkflowYaml
} = require('./_lib/workflow-generator');
const {
  upsertRepoFile,
  deleteRepoFile,
  triggerWorkflowDispatch,
  cancelWorkflowRuns
} = require('./_lib/github-client');

function getBaseUrl(req, store) {
  if (store?.settings?.vercelUrl) {
    return store.settings.vercelUrl.replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-GitHub-Token');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  const store = ensureFilesInitialized();
  const baseUrl = getBaseUrl(req, store);

  // GET /api/channels
  if (req.method === 'GET') {
    const urlObj = new URL(req.url, baseUrl);
    const slugQuery = urlObj.searchParams.get('slug');

    const enrichedChannels = (store.channels || []).map(ch => {
      const liveCh = computeChannelLiveTelemetry(ch);
      const ymlContent = generateChannelWorkflowYaml(liveCh, {
        branch: store.settings?.githubBranch || 'main',
        vercelUrl: baseUrl
      });
      return {
        ...liveCh,
        vercelM3u8Url: `${baseUrl}/api/stream/${liveCh.slug}/index.m3u8`,
        shortM3u8Url: `${baseUrl}/stream/${liveCh.slug}.m3u8`,
        workflowFileName: `channel-${liveCh.slug}.yml`,
        workflowPath: `.github/workflows/channel-${liveCh.slug}.yml`,
        workflowYaml: ymlContent
      };
    });

    if (slugQuery) {
      const found = enrichedChannels.find(c => c.slug === slugQuery || c.id === slugQuery);
      if (!found) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: false, error: 'Channel not found' }));
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, channel: found }));
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      baseUrl,
      masterPlaylistUrl: `${baseUrl}/api/playlist.m3u`,
      settings: {
        githubOwner: store.settings?.githubOwner || '',
        githubRepo: store.settings?.githubRepo || '',
        githubBranch: store.settings?.githubBranch || 'main',
        hasGithubToken: Boolean(
          store.settings?.githubToken &&
          store.settings.githubToken !== '***SET_IN_RUNTIME***'
        ),
        vercelUrl: store.settings?.vercelUrl || baseUrl,
        defaultLoopHours: store.settings?.defaultLoopHours || 4,
        defaultOverlapMinutes: store.settings?.defaultOverlapMinutes || 5,
        defaultMaxTimeoutMinutes: store.settings?.defaultMaxTimeoutMinutes || 300
      },
      channels: enrichedChannels,
      events: (store.events || []).slice(0, 30)
    }));
  }

  const body = await parseJsonBody(req);

  // Resolve GitHub credentials (from request body or saved settings)
  const ghToken = (
    body.githubToken ||
    req.headers['x-github-token'] ||
    (store.settings?.githubToken !== '***SET_IN_RUNTIME***' ? store.settings?.githubToken : '') ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_PAT ||
    ''
  ).trim();
  const ghOwner = (body.githubOwner || store.settings?.githubOwner || process.env.GITHUB_OWNER || '').trim();
  const ghRepo = (body.githubRepo || store.settings?.githubRepo || process.env.GITHUB_REPO || '').trim();
  const ghBranch = (body.githubBranch || store.settings?.githubBranch || process.env.GITHUB_BRANCH || 'main').trim();

  // Save updated GitHub settings if provided
  if (body.githubOwner) store.settings.githubOwner = ghOwner;
  if (body.githubRepo) store.settings.githubRepo = ghRepo;
  if (body.githubBranch) store.settings.githubBranch = ghBranch;
  if (body.githubToken && body.githubToken !== '***SET_IN_RUNTIME***') {
    store.settings.githubToken = ghToken;
  }

  // POST /api/channels — Create a new channel + Generate .yml + Push to GitHub + Trigger Run
  if (req.method === 'POST') {
    const rawName = (body.name || '').trim();
    const rawSource = (body.sourceUrl || '').trim();

    if (!rawName || !rawSource) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: false,
        error: 'Channel Name aur Source .m3u8 Stream Link dono zaroori hain!'
      }));
    }

    const slug = sanitizeSlug(body.slug || rawName);
    const workflowFileName = `channel-${slug}.yml`;
    const workflowPath = `.github/workflows/${workflowFileName}`;

    const newChannel = {
      id: slug,
      slug,
      name: rawName,
      category: body.category || 'Live TV',
      logo: body.logo || `https://ui-avatars.com/api/?name=${encodeURIComponent(rawName)}&background=0D9488&color=fff&bold=true`,
      sourceUrl: rawSource,
      qualityMode: body.qualityMode || 'copy',
      loopHours: Number(body.loopHours) || 4,
      overlapMinutes: Number(body.overlapMinutes) || 5,
      maxTimeoutMinutes: Number(body.maxTimeoutMinutes) || 300,
      hlsSegmentTime: Number(body.hlsSegmentTime) || 4,
      hlsListSize: Number(body.hlsListSize) || 8,
      userAgent: body.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      referer: body.referer || '',
      customRtmpUrl: body.customRtmpUrl || '',
      enabled: true,
      status: 'LIVE',
      activeSlot: 'A',
      nextSlot: 'B',
      generation: 1,
      startedAt: new Date().toISOString(),
      lastSignalAt: new Date().toISOString(),
      workflowFile: workflowPath,
      createdAt: new Date().toISOString()
    };

    // Replace if slug already exists or add new
    const existingIdx = store.channels.findIndex(c => c.slug === slug);
    if (existingIdx >= 0) {
      store.channels[existingIdx] = newChannel;
    } else {
      store.channels.unshift(newChannel);
    }

    // Generate dedicated YAML workflow for this channel
    const ymlContent = generateChannelWorkflowYaml(newChannel, {
      branch: ghBranch,
      vercelUrl: baseUrl
    });

    // Save locally to .github/workflows/channel-<slug>.yml
    try {
      if (!fs.existsSync(WORKFLOWS_DIR)) {
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
      }
      fs.writeFileSync(path.join(WORKFLOWS_DIR, workflowFileName), ymlContent, 'utf8');
    } catch (_) {}

    saveStore(store);
    syncLocalWorkflowFiles(store);

    // Push workflow .yml to GitHub & trigger 24/7 run if GitHub credentials are configured
    let githubPushResult = { ok: false, simulated: true };
    let githubDispatchResult = { ok: false, simulated: true };

    if (ghToken && ghOwner && ghRepo) {
      githubPushResult = await upsertRepoFile({
        token: ghToken,
        owner: ghOwner,
        repo: ghRepo,
        branch: ghBranch,
        filePath: workflowPath,
        content: ymlContent,
        commitMessage: `feat(channel): add 24/7 live workflow ${workflowFileName} for ${rawName}`
      });

      // Also push watchdog workflow if not pushed yet
      const watchdogYml = generateWatchdogWorkflowYaml({ branch: ghBranch });
      await upsertRepoFile({
        token: ghToken,
        owner: ghOwner,
        repo: ghRepo,
        branch: ghBranch,
        filePath: '.github/workflows/watchdog-guardian.yml',
        content: watchdogYml,
        commitMessage: 'chore(watchdog): update 24/7 zero-queue watchdog workflow'
      }).catch(() => null);

      // Trigger workflow_dispatch on Slot A (Gen #1)
      if (githubPushResult.ok && body.autoStart !== false) {
        // Brief pause so GitHub registers the newly pushed workflow file
        await new Promise(r => setTimeout(r, 1200));
        githubDispatchResult = await triggerWorkflowDispatch({
          token: ghToken,
          owner: ghOwner,
          repo: ghRepo,
          branch: ghBranch,
          workflowFileName,
          slot: 'A',
          generation: '1',
          sourceOverride: rawSource,
          vercelApiOverride: baseUrl
        });
      }
    }

    const modeMsg = githubPushResult.ok
      ? `Pushed ${workflowPath} to GitHub (${ghOwner}/${ghRepo}) & triggered Slot A (Gen #1)`
      : `Generated ${workflowPath} & started 24/7 stream relay`;

    logEvent(store, 'CHANNEL_ADDED', slug, `Added "${rawName}" (${slug}). ${modeMsg}`);
    saveStore(store);

    const liveCh = computeChannelLiveTelemetry(newChannel);

    res.statusCode = 201;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      channel: {
        ...liveCh,
        vercelM3u8Url: `${baseUrl}/api/stream/${slug}/index.m3u8`,
        shortM3u8Url: `${baseUrl}/stream/${slug}.m3u8`,
        workflowFileName,
        workflowPath,
        workflowYaml: ymlContent
      },
      githubPush: githubPushResult,
      githubDispatch: githubDispatchResult
    }));
  }

  // PUT /api/channels — Actions on existing channel (trigger handover, push yml, start/stop, edit)
  if (req.method === 'PUT') {
    const slug = sanitizeSlug(body.slug || body.id);
    const channel = store.channels.find(c => c.slug === slug || c.id === slug);

    if (!channel) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: 'Channel not found' }));
    }

    const action = body.action || 'update';
    const workflowFileName = `channel-${channel.slug}.yml`;
    const workflowPath = `.github/workflows/${workflowFileName}`;

    if (action === 'trigger_handover') {
      // Simulate or execute the exact 4-hour mark -> 5-minute overlap handover signal!
      const loopSeconds = (Number(channel.loopHours) || 4) * 3600;
      // Set startedAt to exactly 4h00m02s ago so it enters the 5-minute (300s) overlap window right now!
      channel.startedAt = new Date(Date.now() - (loopSeconds + 2) * 1000).toISOString();
      channel.status = 'HANDOVER_OVERLAP';
      channel.enabled = true;

      let dispatchRes = { ok: false, simulated: true };
      if (ghToken && ghOwner && ghRepo) {
        const nextSlot = (channel.activeSlot || 'A') === 'A' ? 'B' : 'A';
        const nextGen = (Number(channel.generation) || 1) + 1;
        dispatchRes = await triggerWorkflowDispatch({
          token: ghToken,
          owner: ghOwner,
          repo: ghRepo,
          branch: ghBranch,
          workflowFileName,
          slot: nextSlot,
          generation: String(nextGen),
          sourceOverride: channel.sourceUrl,
          vercelApiOverride: baseUrl
        });
      }

      logEvent(
        store,
        'HANDOVER_SIGNAL',
        channel.slug,
        `4-Hour Handover Signal triggered for "${channel.name}". Next slot booting up while current stream overlaps for 5 minutes (300s)!`
      );
      saveStore(store);

      const liveCh = computeChannelLiveTelemetry(channel);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: true,
        message: '4-Hour Relay Signal triggered! Entering 5-minute warm overlap window.',
        channel: liveCh,
        githubDispatch: dispatchRes
      }));
    }

    if (action === 'stop_stream') {
      channel.enabled = false;
      channel.status = 'STOPPED';
      let cancelRes = { ok: false, simulated: true };
      if (ghToken && ghOwner && ghRepo) {
        cancelRes = await cancelWorkflowRuns({
          token: ghToken,
          owner: ghOwner,
          repo: ghRepo,
          workflowFileName
        });
      }
      logEvent(store, 'STREAM_STOPPED', channel.slug, `Stopped 24/7 stream loop for "${channel.name}".`);
      saveStore(store);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: true,
        channel: computeChannelLiveTelemetry(channel),
        githubCancel: cancelRes
      }));
    }

    if (action === 'restart_stream' || action === 'push_and_run') {
      channel.enabled = true;
      channel.status = 'LIVE';
      channel.startedAt = new Date().toISOString();
      channel.generation = (Number(channel.generation) || 1) + 1;

      const ymlContent = generateChannelWorkflowYaml(channel, {
        branch: ghBranch,
        vercelUrl: baseUrl
      });

      try {
        fs.writeFileSync(path.join(WORKFLOWS_DIR, workflowFileName), ymlContent, 'utf8');
      } catch (_) {}

      let pushRes = { ok: false, simulated: true };
      let dispatchRes = { ok: false, simulated: true };

      if (ghToken && ghOwner && ghRepo) {
        pushRes = await upsertRepoFile({
          token: ghToken,
          owner: ghOwner,
          repo: ghRepo,
          branch: ghBranch,
          filePath: workflowPath,
          content: ymlContent,
          commitMessage: `chore(workflow): sync ${workflowFileName} and trigger 24/7 loop`
        });
        await new Promise(r => setTimeout(r, 1000));
        dispatchRes = await triggerWorkflowDispatch({
          token: ghToken,
          owner: ghOwner,
          repo: ghRepo,
          branch: ghBranch,
          workflowFileName,
          slot: channel.activeSlot || 'A',
          generation: String(channel.generation),
          sourceOverride: channel.sourceUrl,
          vercelApiOverride: baseUrl
        });
      }

      logEvent(store, 'STREAM_STARTED', channel.slug, `Pushed ${workflowFileName} & started 24/7 loop (Slot ${channel.activeSlot || 'A'}, Gen #${channel.generation}).`);
      saveStore(store);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: true,
        channel: computeChannelLiveTelemetry(channel),
        githubPush: pushRes,
        githubDispatch: dispatchRes
      }));
    }

    // Default: Update channel fields
    if (body.name) channel.name = body.name.trim();
    if (body.sourceUrl) channel.sourceUrl = body.sourceUrl.trim();
    if (body.category) channel.category = body.category.trim();
    if (body.logo) channel.logo = body.logo.trim();
    if (body.qualityMode) channel.qualityMode = body.qualityMode;
    if (body.loopHours) channel.loopHours = Number(body.loopHours);
    if (body.overlapMinutes) channel.overlapMinutes = Number(body.overlapMinutes);
    if (body.maxTimeoutMinutes) channel.maxTimeoutMinutes = Number(body.maxTimeoutMinutes);
    if (body.userAgent !== undefined) channel.userAgent = body.userAgent;
    if (body.referer !== undefined) channel.referer = body.referer;
    if (body.customRtmpUrl !== undefined) channel.customRtmpUrl = body.customRtmpUrl;

    const ymlContent = generateChannelWorkflowYaml(channel, {
      branch: ghBranch,
      vercelUrl: baseUrl
    });

    saveStore(store);
    syncLocalWorkflowFiles(store);

    let pushRes = { ok: false, simulated: true };
    if (ghToken && ghOwner && ghRepo) {
      pushRes = await upsertRepoFile({
        token: ghToken,
        owner: ghOwner,
        repo: ghRepo,
        branch: ghBranch,
        filePath: workflowPath,
        content: ymlContent,
        commitMessage: `chore(channel): update ${workflowFileName}`
      });
    }

    logEvent(store, 'CHANNEL_UPDATED', channel.slug, `Updated configuration & regenerated ${workflowFileName}.`);
    saveStore(store);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      channel: {
        ...computeChannelLiveTelemetry(channel),
        workflowYaml: ymlContent
      },
      githubPush: pushRes
    }));
  }

  // DELETE /api/channels
  if (req.method === 'DELETE') {
    const urlObj = new URL(req.url, baseUrl);
    const slug = sanitizeSlug(body.slug || urlObj.searchParams.get('slug') || '');
    const idx = store.channels.findIndex(c => c.slug === slug || c.id === slug);

    if (idx < 0) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: 'Channel not found' }));
    }

    const removed = store.channels.splice(idx, 1)[0];
    const workflowFileName = `channel-${removed.slug}.yml`;
    const workflowPath = `.github/workflows/${workflowFileName}`;

    try {
      const localWf = path.join(WORKFLOWS_DIR, workflowFileName);
      if (fs.existsSync(localWf)) fs.unlinkSync(localWf);
    } catch (_) {}

    if (ghToken && ghOwner && ghRepo) {
      await cancelWorkflowRuns({
        token: ghToken,
        owner: ghOwner,
        repo: ghRepo,
        workflowFileName
      }).catch(() => null);
      await deleteRepoFile({
        token: ghToken,
        owner: ghOwner,
        repo: ghRepo,
        branch: ghBranch,
        filePath: workflowPath,
        commitMessage: `chore(channel): remove ${workflowFileName}`
      }).catch(() => null);
    }

    logEvent(store, 'CHANNEL_DELETED', removed.slug, `Deleted channel "${removed.name}" and removed ${workflowFileName}.`);
    saveStore(store);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, deletedSlug: removed.slug }));
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
};
