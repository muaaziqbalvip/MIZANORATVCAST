/**
 * StreamForge 24/7 — GitHub Integration & Sync Endpoint (/api/github)
 */

const {
  ensureFilesInitialized,
  saveStore,
  syncLocalWorkflowFiles,
  logEvent
} = require('./_lib/store');
const {
  generateChannelWorkflowYaml,
  generateWatchdogWorkflowYaml
} = require('./_lib/workflow-generator');
const {
  verifyGitHubConfig,
  upsertRepoFile,
  triggerWorkflowDispatch,
  getWorkflowRuns
} = require('./_lib/github-client');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-GitHub-Token');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  const store = ensureFilesInitialized();
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const baseUrl = (store.settings?.vercelUrl || `${proto}://${host}`).replace(/\/+$/, '');

  const body = req.method === 'POST' ? await parseJsonBody(req) : {};
  const urlObj = new URL(req.url, baseUrl);
  const action = body.action || urlObj.searchParams.get('action') || 'status';

  const token = (
    body.githubToken ||
    req.headers['x-github-token'] ||
    (store.settings?.githubToken !== '***SET_IN_RUNTIME***' ? store.settings?.githubToken : '') ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_PAT ||
    ''
  ).trim();
  const owner = (body.githubOwner || store.settings?.githubOwner || process.env.GITHUB_OWNER || '').trim();
  const repo = (body.githubRepo || store.settings?.githubRepo || process.env.GITHUB_REPO || '').trim();
  const branch = (body.githubBranch || store.settings?.githubBranch || process.env.GITHUB_BRANCH || 'main').trim();

  if (action === 'save_settings' || action === 'verify') {
    if (body.githubOwner !== undefined) store.settings.githubOwner = owner;
    if (body.githubRepo !== undefined) store.settings.githubRepo = repo;
    if (body.githubBranch !== undefined) store.settings.githubBranch = branch;
    if (body.vercelUrl !== undefined) store.settings.vercelUrl = body.vercelUrl.trim();
    if (body.githubToken && body.githubToken !== '***SET_IN_RUNTIME***') {
      store.settings.githubToken = token;
    }
    saveStore(store);
    syncLocalWorkflowFiles(store);

    if (!token || !owner || !repo) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: true,
        saved: true,
        verified: false,
        message: 'Settings saved locally. Provide GitHub Token, Owner & Repo to push live workflows to GitHub.'
      }));
    }

    const verifyRes = await verifyGitHubConfig({ token, owner, repo, branch });
    if (verifyRes.ok) {
      logEvent(store, 'GITHUB_CONNECTED', 'system', `Connected to GitHub repo ${ verifyRes.repoFullName } as @${verifyRes.authenticatedUser}`);
      saveStore(store);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: verifyRes.ok,
      saved: true,
      verified: verifyRes.ok,
      ...verifyRes
    }));
  }

  if (action === 'sync_all') {
    if (!token || !owner || !repo) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: false,
        error: 'Pehle Settings me GitHub Token, Username (Owner) aur Repository Name add karen!'
      }));
    }

    const results = [];
    // 1. Push watchdog-guardian.yml
    const watchdogYml = generateWatchdogWorkflowYaml({ branch });
    await upsertRepoFile({
      token,
      owner,
      repo,
      branch,
      filePath: '.github/workflows/watchdog-guardian.yml',
      content: watchdogYml,
      commitMessage: 'chore(watchdog): sync 24/7 zero-queue watchdog workflow'
    });

    // 2. Push each channel's dedicated .yml workflow and trigger if enabled
    for (const ch of store.channels || []) {
      const wfName = `channel-${ch.slug}.yml`;
      const wfPath = `.github/workflows/${wfName}`;
      const yml = generateChannelWorkflowYaml(ch, {
        branch,
        vercelUrl: store.settings?.vercelUrl || baseUrl
      });

      const pushRes = await upsertRepoFile({
        token,
        owner,
        repo,
        branch,
        filePath: wfPath,
        content: yml,
        commitMessage: `feat(channel): sync 24/7 workflow ${wfName}`
      });

      let dispatchRes = { ok: false };
      if (pushRes.ok && ch.enabled && body.triggerAll !== false) {
        await new Promise(r => setTimeout(r, 800));
        dispatchRes = await triggerWorkflowDispatch({
          token,
          owner,
          repo,
          branch,
          workflowFileName: wfName,
          slot: ch.activeSlot || 'A',
          generation: String(ch.generation || 1),
          sourceOverride: ch.sourceUrl,
          vercelApiOverride: store.settings?.vercelUrl || baseUrl
        });
      }

      results.push({
        slug: ch.slug,
        workflowPath: wfPath,
        pushed: pushRes.ok,
        dispatched: dispatchRes.ok,
        error: pushRes.error || dispatchRes.error || null
      });
    }

    logEvent(store, 'GITHUB_SYNC_ALL', 'system', `Synced ${results.length} channel .yml workflows to ${owner}/${repo}.`);
    saveStore(store);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      results
    }));
  }

  if (action === 'runs') {
    const slug = body.slug || urlObj.searchParams.get('slug') || '';
    const wfName = `channel-${slug}.yml`;
    const runsInfo = await getWorkflowRuns({
      token,
      owner,
      repo,
      workflowFileName: wfName
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(runsInfo));
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify({
    ok: true,
    configured: Boolean(token && owner && repo),
    owner,
    repo,
    branch
  }));
};
