/**
 * StreamForge 24/7 — Interactive Broadcast Control Center Frontend
 */

const state = {
  baseUrl: window.location.origin,
  masterPlaylistUrl: `${window.location.origin}/api/playlist.m3u`,
  channels: [],
  events: [],
  settings: {},
  selectedSlug: null,
  hlsInstance: null
};

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  if (type === 'amber') el.style.borderColor = '#f59e0b';
  if (type === 'error') el.style.borderColor = '#ef4444';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
}

function formatHMS(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function formatMS(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function copyText(text, label = 'Link') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`✅ Copied ${label}: ${text}`);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(`✅ Copied ${label}!`);
  }
}

async function fetchDashboardState(autoSelectFirst = false) {
  try {
    const res = await fetch('/api/channels');
    const data = await res.json();
    if (!data.ok) return;

    state.baseUrl = data.baseUrl || window.location.origin;
    state.masterPlaylistUrl = data.masterPlaylistUrl || `${state.baseUrl}/api/playlist.m3u`;
    state.channels = data.channels || [];
    state.events = data.events || [];
    state.settings = data.settings || {};

    if ((autoSelectFirst || !state.selectedSlug) && state.channels.length > 0) {
      state.selectedSlug = state.channels[0].slug;
      playChannelInMonitor(state.channels[0]);
    }

    renderKPIs();
    renderChannelsList();
    renderInspectorPanel();
    renderEventsList();
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

function renderKPIs() {
  const activeCount = state.channels.filter(c => c.enabled && c.status !== 'STOPPED').length;
  const kpiActive = document.getElementById('kpiActiveCount');
  if (kpiActive) kpiActive.textContent = String(activeCount);

  const kpiGhStatus = document.getElementById('kpiGithubStatus');
  const kpiGhSub = document.getElementById('kpiGithubSub');

  const localToken = localStorage.getItem('sf_gh_token') || '';
  const localOwner = localStorage.getItem('sf_gh_owner') || state.settings.githubOwner || '';
  const localRepo = localStorage.getItem('sf_gh_repo') || state.settings.githubRepo || '';

  if ((state.settings.hasGithubToken || localToken) && localOwner && localRepo) {
    kpiGhStatus.textContent = `🟢 ${localOwner}/${localRepo}`;
    kpiGhStatus.style.color = '#34d399';
    kpiGhSub.textContent = `Auto-push .yml & workflow_dispatch active (${state.settings.githubBranch || 'main'})`;
  } else {
    kpiGhStatus.textContent = `⚡ Ready (Configure PAT)`;
    kpiGhStatus.style.color = '#fbbf24';
    kpiGhSub.textContent = `Click "GitHub Token & Repo" to connect your GitHub repository`;
  }
}

function renderChannelsList() {
  const container = document.getElementById('channelsListContainer');
  if (!container) return;

  if (state.channels.length === 0) {
    container.innerHTML = `
      <div class="channel-card" style="text-align: center; padding: 2.2rem;">
        <div style="font-size: 2rem; margin-bottom: 0.5rem;">📺</div>
        <div style="font-weight: 700; margin-bottom: 0.35rem;">No Live TV Channels Added Yet</div>
        <div style="font-size: 0.82rem; color: #94a3b8; margin-bottom: 1rem;">
          Click "Add TV Channel & Push .yml" to add your first .m3u8 stream and generate its 24/7 GitHub workflow!
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = state.channels.map(ch => {
    const t = ch.telemetry || {};
    const isSelected = ch.slug === state.selectedSlug;
    const isOverlap = t.phase === 'HANDOVER_OVERLAP';
    const isStopped = t.phase === 'STOPPED' || !ch.enabled;

    let badgeClass = 'live';
    let badgeText = `LIVE 24/7 • Slot ${t.activeSlot || 'A'} • Gen #${t.generation || 1}`;
    if (isOverlap) {
      badgeClass = 'overlap';
      badgeText = `⚡ 5m OVERLAP (Slot ${t.activeSlot} → Slot ${t.nextSlot})`;
    } else if (isStopped) {
      badgeClass = 'stopped';
      badgeText = `STOPPED`;
    }

    const loopRightText = isStopped
      ? 'Workflow Paused'
      : isOverlap
        ? `⚡ Next Loop (Slot ${t.nextSlot}) Active! Stopping Slot ${t.activeSlot} in ${formatMS(t.overlapRemainingSeconds)}`
        : `Next .yml Signal (Slot ${t.nextSlot}) in ${formatHMS(t.untilHandoverSeconds)}`;

    const totalCycleFormatted = formatHMS((t.loopDurationSeconds || 14400) + (t.overlapDurationSeconds || 300));
    const currentElapsedFormatted = formatHMS(t.elapsedSeconds || 0);

    return `
      <div class="channel-card ${isSelected ? 'active-selected' : ''} ${isOverlap ? 'status-overlap' : ''}" data-slug="${ch.slug}">
        <div class="channel-top">
          <div class="channel-info">
            <img src="${ch.logo}" alt="${ch.name}" class="channel-logo" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(ch.name)}&background=0D9488&color=fff&bold=true'" />
            <div>
              <div class="channel-name">
                <span>${ch.name}</span>
                <span class="meta-pill">${ch.category || 'Live TV'}</span>
                <span class="meta-pill">${(ch.qualityMode || 'copy').toUpperCase()}</span>
              </div>
              <div class="channel-meta">
                <span>ID: <code>${ch.slug}</code></span>
                <span>•</span>
                <span>Loop: <strong>${ch.loopHours || 4}h</strong> + <strong>${ch.overlapMinutes || 5}m</strong> overlap</span>
                <span>•</span>
                <span>Cap: <strong>5h</strong> (0 Queue)</span>
              </div>
            </div>
          </div>

          <span class="status-badge ${badgeClass}" id="badge-${ch.slug}">
            <span class="pulse-dot"></span>
            <span id="badge-text-${ch.slug}">${badgeText}</span>
          </span>
        </div>

        <!-- 4-Hour + 5-Minute Overlap Progress Box -->
        <div class="loop-box">
          <div class="loop-box-header">
            <span>
              ⏱️ <strong>Action Elapsed:</strong>
              <span class="loop-timer-mono" id="timer-elapsed-${ch.slug}">${currentElapsedFormatted}</span>
              <span style="color: #64748b;">/ ${totalCycleFormatted} (Max 05:00:00)</span>
            </span>
            <span id="timer-countdown-${ch.slug}" style="color: ${isOverlap ? '#fbbf24' : '#34d399'}; font-weight: 600;">
              ${loopRightText}
            </span>
          </div>
          <div class="progress-track">
            <div class="progress-fill ${isOverlap ? 'overlap-mode' : ''}" id="progress-bar-${ch.slug}" style="width: ${t.progressPercent || 15}%;"></div>
          </div>
          <div class="loop-markers">
            <span>00:00 Start (Slot ${t.activeSlot})</span>
            <span>02:00 Mid-Loop</span>
            <span style="color: #fbbf24;">04:00 Signal Next .yml (Slot ${t.nextSlot})</span>
            <span style="color: #34d399;">04:05 Overlap Done &amp; Self-Stop (5h Hard Cap)</span>
          </div>
        </div>

        <!-- Generated Vercel .m3u8 Link Row -->
        <div class="link-copy-group">
          <div class="link-input-box">
            <span class="link-tag">VERCEL .M3U8</span>
            <span class="link-text">${ch.vercelM3u8Url}</span>
          </div>
          <button class="btn btn-sm" onclick="window.copyChannelM3u8('${ch.slug}')">
            📋 Copy .m3u8 Link
          </button>
        </div>

        <!-- Generated Dedicated GitHub Workflow .yml Row -->
        <div class="link-copy-group" style="margin-bottom: 0.75rem;">
          <div class="link-input-box">
            <span class="link-tag yml-tag">GITHUB .YML</span>
            <span class="link-text">${ch.workflowPath}</span>
          </div>
          <button class="btn btn-sm" onclick="window.inspectChannelYaml('${ch.slug}')">
            📄 View / Download .yml
          </button>
        </div>

        <!-- Action Controls -->
        <div class="card-actions-bar">
          <div class="card-actions-left">
            <button class="btn btn-sm btn-primary" onclick="window.selectAndPlayChannel('${ch.slug}')">
              ▶ Watch Live Stream
            </button>
            <button class="btn btn-sm btn-amber" onclick="window.triggerChannelHandover('${ch.slug}')" title="Simulate/Trigger the 4-Hour mark so it signals the next workflow and enters the 5-minute overlap window">
              ⚡ Signal 4h→5m Handover
            </button>
            <button class="btn btn-sm btn-success" onclick="window.pushAndRunChannel('${ch.slug}')" title="Push .github/workflows/channel-${ch.slug}.yml to GitHub & dispatch run">
              🚀 Push .yml &amp; Run
            </button>
          </div>

          <div class="card-actions-right">
            ${isStopped
              ? `<button class="btn btn-sm btn-success" onclick="window.pushAndRunChannel('${ch.slug}')">▶ Start</button>`
              : `<button class="btn btn-sm" onclick="window.stopChannelStream('${ch.slug}')">⏹ Stop</button>`
            }
            <button class="btn btn-sm btn-danger" onclick="window.deleteChannel('${ch.slug}')">
              🗑
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function selectChannel(slug) {
  const ch = state.channels.find(c => c.slug === slug);
  if (!ch) return null;
  state.selectedSlug = slug;
  renderChannelsList();
  renderInspectorPanel();
  return ch;
}

function playChannelInMonitor(ch) {
  if (!ch) return;
  const video = document.getElementById('liveVideoPlayer');
  const badge = document.getElementById('playerChannelBadge');
  const slotBadge = document.getElementById('playerSlotBadge');
  const urlBox = document.getElementById('activePlayerM3u8Url');
  const overlayInfo = document.getElementById('videoOverlayInfo');

  if (badge) badge.textContent = ch.name;
  if (urlBox) urlBox.textContent = ch.vercelM3u8Url;

  const t = ch.telemetry || {};
  if (slotBadge) {
    slotBadge.className = `status-badge ${t.phase === 'HANDOVER_OVERLAP' ? 'overlap' : 'live'}`;
    slotBadge.textContent = `Slot ${t.activeSlot || 'A'} • Gen #${t.generation || 1}`;
  }

  if (overlayInfo) {
    overlayInfo.innerHTML = t.phase === 'HANDOVER_OVERLAP'
      ? `<span>⚡ 5-Min Overlap Handover (Slot ${t.activeSlot} → Slot ${t.nextSlot})</span>`
      : `<span>🟢 24/7 Signal • ${ch.name} (Slot ${t.activeSlot || 'A'})</span>`;
  }

  const streamUrl = ch.vercelM3u8Url;
  if (!video) return;

  if (state.hlsInstance) {
    state.hlsInstance.destroy();
    state.hlsInstance = null;
  }

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    state.hlsInstance = hls;
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.play().catch(() => {});
  }
}

function renderInspectorPanel() {
  const ch = state.channels.find(c => c.slug === state.selectedSlug) || state.channels[0];
  if (!ch) return;

  const pathEl = document.getElementById('inspectorYamlPath');
  const codeEl = document.getElementById('inspectorYamlContent');
  const dlBtn = document.getElementById('btnDownloadYamlFile');

  if (pathEl) pathEl.textContent = ch.workflowPath;
  if (codeEl) codeEl.textContent = ch.workflowYaml || '';
  if (dlBtn) {
    dlBtn.href = `/api/download-zip?slug=${encodeURIComponent(ch.slug)}`;
    dlBtn.setAttribute('download', `channel-${ch.slug}.yml`);
  }

  // Update Slot A / Slot B diagram lanes
  const t = ch.telemetry || {};
  const laneA = document.getElementById('laneSlotA');
  const laneB = document.getElementById('laneSlotB');
  const statusA = document.getElementById('laneSlotAStatus');
  const statusB = document.getElementById('laneSlotBStatus');

  if (laneA && laneB && statusA && statusB) {
    if (t.phase === 'HANDOVER_OVERLAP') {
      laneA.classList.add('active-lane');
      laneB.classList.add('active-lane');
      statusA.textContent = `OVERLAPPING (5m Handover Window)`;
      statusB.textContent = `OVERLAPPING (Warm Handover Active)`;
    } else if (t.activeSlot === 'B') {
      laneA.classList.remove('active-lane');
      laneB.classList.add('active-lane');
      statusA.textContent = `STANDBY (Triggers at 04:00:00)`;
      statusB.textContent = `ACTIVE 24/7 STREAM (Gen #${t.generation})`;
    } else {
      laneA.classList.add('active-lane');
      laneB.classList.remove('active-lane');
      statusA.textContent = `ACTIVE 24/7 STREAM (Gen #${t.generation})`;
      statusB.textContent = `STANDBY (Triggers at 04:00:00)`;
    }
  }
}

function renderEventsList() {
  const container = document.getElementById('eventsListContainer');
  if (!container) return;

  if (!state.events || state.events.length === 0) {
    container.innerHTML = `<div style="color: #64748b; font-size: 0.8rem;">No signal events yet.</div>`;
    return;
  }

  container.innerHTML = state.events.map(ev => {
    const timeStr = new Date(ev.time).toLocaleTimeString();
    return `
      <div class="event-item">
        <div class="event-item-top">
          <span style="color: #2dd4bf; font-weight: 700;">[${ev.type}] • ${ev.channel}</span>
          <span>${timeStr}</span>
        </div>
        <div style="color: #e2e8f0;">${ev.message}</div>
      </div>
    `;
  }).join('');
}

// 1-Second Live Broadcast Loop Ticker (Updates all 4h + 5m timers smoothly in real time)
function tickLiveTimers() {
  for (const ch of state.channels) {
    if (!ch.enabled || ch.status === 'STOPPED' || !ch.telemetry) continue;

    const t = ch.telemetry;
    const loopSec = t.loopDurationSeconds || 14400; // 4 hours
    const overlapSec = t.overlapDurationSeconds || 300; // 5 minutes
    const fullCycleSec = loopSec + overlapSec; // 14,700s (4h 05m)

    t.elapsedSeconds = (t.elapsedSeconds || 0) + 1;

    // Transition from 4h stream into 5m overlap window
    if (t.elapsedSeconds >= loopSec && t.elapsedSeconds < fullCycleSec) {
      t.phase = 'HANDOVER_OVERLAP';
      t.untilHandoverSeconds = 0;
      t.overlapRemainingSeconds = fullCycleSec - t.elapsedSeconds;
    } else if (t.elapsedSeconds >= fullCycleSec) {
      // 4h + 5m completed -> Old workflow stops itself, new slot becomes primary!
      t.elapsedSeconds = overlapSec; // New slot is already 5 minutes warm!
      t.phase = 'LIVE';
      const oldSlot = t.activeSlot || 'A';
      t.activeSlot = oldSlot === 'A' ? 'B' : 'A';
      t.nextSlot = oldSlot;
      t.generation = (t.generation || 1) + 1;
      t.untilHandoverSeconds = loopSec - t.elapsedSeconds;
      t.overlapRemainingSeconds = 0;
      showToast(`✅ [${ch.name}] 5-Min Overlap Complete! Slot ${oldSlot} exited cleanly; Slot ${t.activeSlot} (Gen #${t.generation}) is carrying 24/7 stream!`);
    } else {
      t.phase = 'LIVE';
      t.untilHandoverSeconds = loopSec - t.elapsedSeconds;
      t.overlapRemainingSeconds = 0;
    }

    t.progressPercent = Math.min(100, Math.round((t.elapsedSeconds / fullCycleSec) * 100));

    // Update DOM elements for this channel card without re-rendering full list
    const elapsedEl = document.getElementById(`timer-elapsed-${ch.slug}`);
    const countdownEl = document.getElementById(`timer-countdown-${ch.slug}`);
    const progressEl = document.getElementById(`progress-bar-${ch.slug}`);
    const badgeEl = document.getElementById(`badge-${ch.slug}`);
    const badgeTextEl = document.getElementById(`badge-text-${ch.slug}`);

    if (elapsedEl) elapsedEl.textContent = formatHMS(t.elapsedSeconds);
    if (countdownEl) {
      if (t.phase === 'HANDOVER_OVERLAP') {
        countdownEl.style.color = '#fbbf24';
        countdownEl.textContent = `⚡ Next Loop (Slot ${t.nextSlot}) Active! Stopping Slot ${t.activeSlot} in ${formatMS(t.overlapRemainingSeconds)}`;
      } else {
        countdownEl.style.color = '#34d399';
        countdownEl.textContent = `Next .yml Signal (Slot ${t.nextSlot}) in ${formatHMS(t.untilHandoverSeconds)}`;
      }
    }
    if (progressEl) {
      progressEl.style.width = `${t.progressPercent}%`;
      if (t.phase === 'HANDOVER_OVERLAP') {
        progressEl.classList.add('overlap-mode');
      } else {
        progressEl.classList.remove('overlap-mode');
      }
    }
    if (badgeEl && badgeTextEl) {
      badgeEl.className = `status-badge ${t.phase === 'HANDOVER_OVERLAP' ? 'overlap' : 'live'}`;
      badgeTextEl.textContent = t.phase === 'HANDOVER_OVERLAP'
        ? `⚡ 5m OVERLAP (Slot ${t.activeSlot} → Slot ${t.nextSlot})`
        : `LIVE 24/7 • Slot ${t.activeSlot} • Gen #${t.generation}`;
    }

    // Update active player telemetry text if this channel is selected
    if (ch.slug === state.selectedSlug) {
      const playerTel = document.getElementById('playerTelemetryText');
      if (playerTel) {
        playerTel.textContent = t.phase === 'HANDOVER_OVERLAP'
          ? `⚡ 5-Min Warm Overlap: ${formatMS(t.overlapRemainingSeconds)} left before Slot ${t.activeSlot} stops`
          : `Loop Timer: ${formatHMS(t.elapsedSeconds)} / 04:00:00 (Next .yml signal in ${formatHMS(t.untilHandoverSeconds)})`;
      }
    }
  }
}

// Global actions for Channel Cards
window.copyChannelM3u8 = function(slug) {
  const ch = state.channels.find(c => c.slug === slug);
  if (ch) copyText(ch.vercelM3u8Url, `${ch.name} Vercel .m3u8`);
};

window.selectAndPlayChannel = function(slug) {
  const ch = selectChannel(slug);
  if (ch) {
    playChannelInMonitor(ch);
    showToast(`▶ Playing ${ch.name} via Vercel .m3u8 Stream API`);
  }
};

window.inspectChannelYaml = function(slug) {
  const ch = selectChannel(slug);
  if (!ch) return;
  // Activate YAML tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="tabYaml"]')?.classList.add('active');
  document.getElementById('tabYaml')?.classList.add('active');
  showToast(`📄 Opened .github/workflows/channel-${ch.slug}.yml`);
};

window.triggerChannelHandover = async function(slug) {
  showToast(`⚡ Triggering 4-Hour Relay Signal & 5-Minute Overlap for ${slug}...`, 'amber');
  const res = await fetch('/api/channels', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      action: 'trigger_handover',
      githubToken: localStorage.getItem('sf_gh_token') || '',
      githubOwner: localStorage.getItem('sf_gh_owner') || '',
      githubRepo: localStorage.getItem('sf_gh_repo') || '',
      githubBranch: localStorage.getItem('sf_gh_branch') || 'main'
    })
  });
  const data = await res.json();
  if (data.ok) {
    await fetchDashboardState(false);
    const updated = state.channels.find(c => c.slug === slug);
    if (updated && state.selectedSlug === slug) {
      playChannelInMonitor(updated);
    }
    showToast(`⚡ 4h Handover Signal Active! Next loop triggered & overlapping for 5 minutes (300s)!`, 'amber');
  }
};

window.pushAndRunChannel = async function(slug) {
  showToast(`🚀 Pushing channel-${slug}.yml & starting 24/7 loop...`);
  const res = await fetch('/api/channels', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      action: 'push_and_run',
      githubToken: localStorage.getItem('sf_gh_token') || '',
      githubOwner: localStorage.getItem('sf_gh_owner') || '',
      githubRepo: localStorage.getItem('sf_gh_repo') || '',
      githubBranch: localStorage.getItem('sf_gh_branch') || 'main'
    })
  });
  const data = await res.json();
  if (data.ok) {
    await fetchDashboardState(false);
    if (data.githubPush?.ok) {
      showToast(`✅ Pushed channel-${slug}.yml to GitHub & triggered 24/7 workflow!`);
    } else {
      showToast(`✅ Generated channel-${slug}.yml & started 24/7 stream relay!`);
    }
  }
};

window.stopChannelStream = async function(slug) {
  const res = await fetch('/api/channels', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      action: 'stop_stream',
      githubToken: localStorage.getItem('sf_gh_token') || '',
      githubOwner: localStorage.getItem('sf_gh_owner') || '',
      githubRepo: localStorage.getItem('sf_gh_repo') || ''
    })
  });
  const data = await res.json();
  if (data.ok) {
    await fetchDashboardState(false);
    showToast(`⏹ Stopped stream workflow for ${slug}.`);
  }
};

window.deleteChannel = async function(slug) {
  const res = await fetch(`/api/channels?slug=${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      githubToken: localStorage.getItem('sf_gh_token') || '',
      githubOwner: localStorage.getItem('sf_gh_owner') || '',
      githubRepo: localStorage.getItem('sf_gh_repo') || ''
    })
  });
  const data = await res.json();
  if (data.ok) {
    if (state.selectedSlug === slug) state.selectedSlug = null;
    await fetchDashboardState(true);
    showToast(`🗑 Removed channel ${slug} and deleted its workflow.`);
  }
};

// Setup Event Listeners on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  fetchDashboardState(true);
  setInterval(tickLiveTimers, 1000);

  // Inspector Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(target)?.classList.add('active');
    });
  });

  // Copy Master .m3u Playlist
  document.getElementById('btnCopyMasterM3u')?.addEventListener('click', () => {
    copyText(state.masterPlaylistUrl, 'Master IPTV Playlist (.m3u)');
  });

  // Copy Active Player .m3u8
  document.getElementById('btnCopyActiveM3u8')?.addEventListener('click', () => {
    const ch = state.channels.find(c => c.slug === state.selectedSlug);
    if (ch) copyText(ch.vercelM3u8Url, `${ch.name} Vercel .m3u8`);
  });

  // Test Handover button on Active Player
  document.getElementById('btnSimulateHandoverActive')?.addEventListener('click', () => {
    if (state.selectedSlug) {
      window.triggerChannelHandover(state.selectedSlug);
    }
  });

  // Copy YAML Code button
  document.getElementById('btnCopyYamlCode')?.addEventListener('click', () => {
    const ch = state.channels.find(c => c.slug === state.selectedSlug);
    if (ch) copyText(ch.workflowYaml, `${ch.workflowFileName} YAML`);
  });

  // Auto-generate slug while typing channel name
  const nameInput = document.getElementById('inputChannelName');
  const slugInput = document.getElementById('inputChannelSlug');
  const wfHint = document.getElementById('hintWorkflowFile');

  nameInput?.addEventListener('input', () => {
    const s = slugify(nameInput.value || 'channel');
    if (slugInput) slugInput.value = s;
    if (wfHint) wfHint.textContent = `Creates: .github/workflows/channel-${s || 'channel'}.yml`;
  });

  slugInput?.addEventListener('input', () => {
    const s = slugify(slugInput.value || 'channel');
    if (wfHint) wfHint.textContent = `Creates: .github/workflows/channel-${s || 'channel'}.yml`;
  });

  // Open / Close Add Channel Modal
  const modalAdd = document.getElementById('modalAddChannel');
  const openAddModal = () => modalAdd?.classList.add('open');
  const closeAddModal = () => modalAdd?.classList.remove('open');

  document.getElementById('btnOpenAddChannel')?.addEventListener('click', openAddModal);
  document.getElementById('btnOpenAddChannel2')?.addEventListener('click', openAddModal);
  document.getElementById('btnCloseAddChannel')?.addEventListener('click', closeAddModal);
  document.getElementById('btnCancelAddChannel')?.addEventListener('click', closeAddModal);

  // Submit Add Channel Form
  document.getElementById('formAddChannel')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('btnSubmitChannel');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Generating .yml & Pushing...';
    }

    const payload = {
      name: document.getElementById('inputChannelName').value.trim(),
      slug: document.getElementById('inputChannelSlug').value.trim(),
      sourceUrl: document.getElementById('inputSourceUrl').value.trim(),
      category: document.getElementById('inputCategory').value,
      qualityMode: document.getElementById('inputQualityMode').value,
      loopHours: Number(document.getElementById('inputLoopHours').value) || 4,
      overlapMinutes: Number(document.getElementById('inputOverlapMinutes').value) || 5,
      logo: document.getElementById('inputLogoUrl').value.trim(),
      referer: document.getElementById('inputReferer').value.trim(),
      githubToken: localStorage.getItem('sf_gh_token') || '',
      githubOwner: localStorage.getItem('sf_gh_owner') || '',
      githubRepo: localStorage.getItem('sf_gh_repo') || '',
      githubBranch: localStorage.getItem('sf_gh_branch') || 'main'
    };

    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.ok && data.channel) {
        closeAddModal();
        document.getElementById('formAddChannel').reset();
        state.selectedSlug = data.channel.slug;
        await fetchDashboardState(false);
        const created = state.channels.find(c => c.slug === data.channel.slug);
        if (created) playChannelInMonitor(created);

        if (data.githubPush?.ok) {
          showToast(`🚀 Added "${data.channel.name}", pushed ${data.channel.workflowPath} to GitHub & started 24/7 loop!`);
        } else {
          showToast(`✅ Added "${data.channel.name}"! Generated ${data.channel.workflowPath} & Vercel .m3u8 link!`);
        }
      } else {
        showToast(`❌ ${data.error || 'Failed to add channel'}`, 'error');
      }
    } catch (err) {
      showToast(`❌ Error: ${err.message}`, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '🚀 Generate <code>.yml</code>, Push to GitHub &amp; Start 24/7 Stream';
      }
    }
  });

  // Open / Close GitHub Settings Modal
  const modalGh = document.getElementById('modalGithubSettings');
  const openGhModal = () => {
    document.getElementById('inputGhOwner').value = localStorage.getItem('sf_gh_owner') || state.settings.githubOwner || '';
    document.getElementById('inputGhRepo').value = localStorage.getItem('sf_gh_repo') || state.settings.githubRepo || '';
    document.getElementById('inputGhBranch').value = localStorage.getItem('sf_gh_branch') || state.settings.githubBranch || 'main';
    document.getElementById('inputGhToken').value = localStorage.getItem('sf_gh_token') || '';
    document.getElementById('inputVercelUrl').value = state.settings.vercelUrl || window.location.origin;
    modalGh?.classList.add('open');
  };
  const closeGhModal = () => modalGh?.classList.remove('open');

  document.getElementById('btnOpenGithubSettings')?.addEventListener('click', openGhModal);
  document.getElementById('btnCloseGithubSettings')?.addEventListener('click', closeGhModal);
  document.getElementById('btnCancelGithubSettings')?.addEventListener('click', closeGhModal);

  // Save & Verify GitHub Settings
  document.getElementById('formGithubSettings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const owner = document.getElementById('inputGhOwner').value.trim();
    const repo = document.getElementById('inputGhRepo').value.trim();
    const token = document.getElementById('inputGhToken').value.trim();
    const branch = document.getElementById('inputGhBranch').value.trim() || 'main';
    const vercelUrl = document.getElementById('inputVercelUrl').value.trim() || window.location.origin;

    localStorage.setItem('sf_gh_owner', owner);
    localStorage.setItem('sf_gh_repo', repo);
    localStorage.setItem('sf_gh_branch', branch);
    if (token) localStorage.setItem('sf_gh_token', token);

    const resultBox = document.getElementById('githubVerifyResultBox');
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.style.background = 'rgba(59, 130, 246, 0.12)';
      resultBox.style.border = '1px solid rgba(59, 130, 246, 0.35)';
      resultBox.textContent = '⏳ Verifying GitHub Token & Repository permissions...';
    }

    const res = await fetch('/api/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'verify',
        githubOwner: owner,
        githubRepo: repo,
        githubToken: token,
        githubBranch: branch,
        vercelUrl
      })
    });
    const data = await res.json();

    if (data.verified) {
      if (resultBox) {
        resultBox.style.background = 'rgba(16, 185, 129, 0.14)';
        resultBox.style.border = '1px solid rgba(16, 185, 129, 0.45)';
        resultBox.innerHTML = `✅ <strong>Connected to ${data.repoFullName}</strong> as <code>@${data.authenticatedUser}</code>! Ready to auto-push <code>.yml</code> workflows &amp; run 24/7 loops.`;
      }
      showToast(`✅ Connected to GitHub Repo: ${data.repoFullName}`);
      await fetchDashboardState(false);
    } else {
      if (resultBox) {
        resultBox.style.background = 'rgba(245, 158, 11, 0.14)';
        resultBox.style.border = '1px solid rgba(245, 158, 11, 0.45)';
        resultBox.textContent = data.error || data.message || 'Settings saved locally.';
      }
      renderKPIs();
    }
  });

  // Push All .yml to GitHub button
  document.getElementById('btnSyncAllGithub')?.addEventListener('click', async () => {
    const token = localStorage.getItem('sf_gh_token') || '';
    const owner = localStorage.getItem('sf_gh_owner') || state.settings.githubOwner || '';
    const repo = localStorage.getItem('sf_gh_repo') || state.settings.githubRepo || '';
    const branch = localStorage.getItem('sf_gh_branch') || state.settings.githubBranch || 'main';

    if (!token || !owner || !repo) {
      openGhModal();
      showToast('⚙️ Configure your GitHub Token, Owner & Repo first to push all .yml files to GitHub!', 'amber');
      return;
    }

    showToast(`🚀 Pushing all ${state.channels.length} channel .yml workflows to ${owner}/${repo}...`);
    const res = await fetch('/api/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync_all',
        githubToken: token,
        githubOwner: owner,
        githubRepo: repo,
        githubBranch: branch
      })
    });
    const data = await res.json();
    if (data.ok) {
      await fetchDashboardState(false);
      showToast(`✅ Pushed & triggered ${data.results?.length || 0} channel .yml workflows on GitHub!`);
    } else {
      showToast(`❌ ${data.error || 'Sync failed'}`, 'error');
    }
  });
});
