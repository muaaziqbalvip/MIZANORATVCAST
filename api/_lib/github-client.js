/**
 * StreamForge 24/7 — GitHub REST API Integration Client
 * Pushes per-channel .yml workflows, triggers 24/7 workflow_dispatch loops,
 * checks active/queued runs, and fetches live branch manifests.
 */

const GITHUB_API_BASE = 'https://api.github.com';

function buildHeaders(token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'StreamForge-24x7-LiveTV-Engine/2.4',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function verifyGitHubConfig({ token, owner, repo, branch = 'main' }) {
  if (!token || !owner || !repo) {
    return {
      ok: false,
      error: 'Missing GitHub Token, Owner, or Repository name.'
    };
  }

  try {
    const userRes = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: buildHeaders(token)
    });
    const userData = await userRes.json().catch(() => ({}));

    const repoRes = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: buildHeaders(token)
    });
    const repoData = await repoRes.json().catch(() => ({}));

    if (!repoRes.ok) {
      return {
        ok: false,
        status: repoRes.status,
        authenticatedUser: userData.login || null,
        error: repoData.message || `Cannot access repository ${owner}/${repo} (HTTP ${repoRes.status})`
      };
    }

    return {
      ok: true,
      authenticatedUser: userData.login || owner,
      repoFullName: repoData.full_name,
      defaultBranch: repoData.default_branch || branch,
      private: Boolean(repoData.private),
      permissions: repoData.permissions || {},
      htmlUrl: repoData.html_url
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || 'Network error connecting to GitHub API'
    };
  }
}

async function upsertRepoFile({ token, owner, repo, branch = 'main', filePath, content, commitMessage }) {
  if (!token || !owner || !repo) {
    return { ok: false, simulated: true, error: 'GitHub credentials not configured (Saved locally)' };
  }

  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;

  try {
    // Check if file already exists to get its SHA
    let sha = undefined;
    const existingRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
      headers: buildHeaders(token)
    });
    if (existingRes.ok) {
      const existingData = await existingRes.json().catch(() => ({}));
      if (existingData && existingData.sha) {
        sha = existingData.sha;
      }
    }

    const body = {
      message: commitMessage || `chore(workflow): update ${filePath}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch
    };
    if (sha) {
      body.sha = sha;
    }

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: buildHeaders(token),
      body: JSON.stringify(body)
    });
    const putData = await putRes.json().catch(() => ({}));

    if (!putRes.ok) {
      return {
        ok: false,
        status: putRes.status,
        error: putData.message || `Failed to push ${filePath} to GitHub (HTTP ${putRes.status})`
      };
    }

    return {
      ok: true,
      filePath,
      commitSha: putData.commit?.sha || null,
      htmlUrl: putData.content?.html_url || `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

async function deleteRepoFile({ token, owner, repo, branch = 'main', filePath, commitMessage }) {
  if (!token || !owner || !repo) {
    return { ok: false, simulated: true };
  }

  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;

  try {
    const existingRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
      headers: buildHeaders(token)
    });
    if (!existingRes.ok) {
      return { ok: true, alreadyDeleted: true };
    }
    const existingData = await existingRes.json();
    const delRes = await fetch(url, {
      method: 'DELETE',
      headers: buildHeaders(token),
      body: JSON.stringify({
        message: commitMessage || `chore(workflow): remove ${filePath}`,
        sha: existingData.sha,
        branch
      })
    });
    return { ok: delRes.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function triggerWorkflowDispatch({
  token,
  owner,
  repo,
  branch = 'main',
  workflowFileName,
  slot = 'A',
  generation = '1',
  sourceOverride = '',
  vercelApiOverride = ''
}) {
  if (!token || !owner || !repo) {
    return {
      ok: false,
      simulated: true,
      message: 'Local simulation mode active (Add GitHub Token in Settings to run on GitHub Actions).'
    };
  }

  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFileName)}/dispatches`;

  try {
    // First check if there is already a queued run to avoid queue buildup
    const runsUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFileName)}/runs?status=queued&per_page=5`;
    const queuedRes = await fetch(runsUrl, { headers: buildHeaders(token) });
    if (queuedRes.ok) {
      const queuedData = await queuedRes.json().catch(() => ({}));
      if ((queuedData.total_count || 0) > 0) {
        return {
          ok: true,
          alreadyQueued: true,
          message: `Workflow ${workflowFileName} already has a queued run (Zero-Queue protection active).`
        };
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify({
        ref: branch,
        inputs: {
          slot: String(slot || 'A'),
          generation: String(generation || '1'),
          source_override: String(sourceOverride || ''),
          vercel_api_override: String(vercelApiOverride || '')
        }
      })
    });

    if (res.status === 204 || res.ok) {
      return {
        ok: true,
        workflowFileName,
        slot,
        generation,
        actionsUrl: `https://github.com/${owner}/${repo}/actions/workflows/${workflowFileName}`
      };
    }

    const errData = await res.json().catch(() => ({}));
    return {
      ok: false,
      status: res.status,
      error: errData.message || `Failed to trigger workflow ${workflowFileName} (HTTP ${res.status})`
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

async function getWorkflowRuns({ token, owner, repo, workflowFileName }) {
  if (!token || !owner || !repo) {
    return { ok: false, simulated: true, runs: [] };
  }

  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFileName)}/runs?per_page=6`;
  try {
    const res = await fetch(url, { headers: buildHeaders(token) });
    if (!res.ok) {
      return { ok: false, status: res.status, runs: [] };
    }
    const data = await res.json();
    const runs = (data.workflow_runs || []).map(r => ({
      id: r.id,
      name: r.display_title || r.name,
      status: r.status, // completed, in_progress, queued
      conclusion: r.conclusion,
      runNumber: r.run_number,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      htmlUrl: r.html_url
    }));
    return {
      ok: true,
      totalCount: data.total_count || runs.length,
      inProgressCount: runs.filter(r => r.status === 'in_progress').length,
      queuedCount: runs.filter(r => r.status === 'queued').length,
      runs
    };
  } catch (err) {
    return { ok: false, error: err.message, runs: [] };
  }
}

async function cancelWorkflowRuns({ token, owner, repo, workflowFileName }) {
  if (!token || !owner || !repo) {
    return { ok: false, simulated: true };
  }

  const runsInfo = await getWorkflowRuns({ token, owner, repo, workflowFileName });
  if (!runsInfo.ok) return runsInfo;

  const activeRuns = runsInfo.runs.filter(r => r.status === 'in_progress' || r.status === 'queued');
  const cancelledIds = [];

  for (const run of activeRuns) {
    const cancelUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run.id}/cancel`;
    const res = await fetch(cancelUrl, {
      method: 'POST',
      headers: buildHeaders(token)
    }).catch(() => null);
    if (res && (res.status === 202 || res.ok)) {
      cancelledIds.push(run.id);
    }
  }

  return {
    ok: true,
    cancelledCount: cancelledIds.length,
    cancelledIds
  };
}

module.exports = {
  verifyGitHubConfig,
  upsertRepoFile,
  deleteRepoFile,
  triggerWorkflowDispatch,
  getWorkflowRuns,
  cancelWorkflowRuns
};
