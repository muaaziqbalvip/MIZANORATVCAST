/**
 * StreamForge 24/7 — State, Channel Registry & Signal Store
 * Works seamlessly both locally (persisting to data/channels.json & .github/workflows/)
 * and on Vercel Serverless (using /tmp + GitHub Repository Sync via Token).
 */

const fs = require('fs');
const path = require('path');
const { sanitizeSlug, generateChannelWorkflowYaml, generateWatchdogWorkflowYaml } = require('./workflow-generator');

const ROOT_DIR = path.resolve(__dirname, '../..');
const DATA_FILE = path.join(ROOT_DIR, 'data', 'channels.json');
const TMP_DATA_FILE = '/tmp/streamforge_channels.json';
const WORKFLOWS_DIR = path.join(ROOT_DIR, '.github', 'workflows');

// Default working public HLS (.m3u8) streams so user can test immediately
const DEFAULT_CHANNELS = [
  {
    id: 'redbull-tv-hd',
    slug: 'redbull-tv-hd',
    name: 'Red Bull TV HD',
    category: 'Sports & Action',
    logo: 'https://img.redbull.com/images/w_300/q_auto,f_auto/redbullcom/2020/4/28/bjo5f9p9f2t7r3n2x4v6/red-bull-tv-logo',
    sourceUrl: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
    qualityMode: 'copy',
    loopHours: 4,
    overlapMinutes: 5,
    maxTimeoutMinutes: 300,
    hlsSegmentTime: 4,
    hlsListSize: 8,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    referer: '',
    customRtmpUrl: '',
    enabled: true,
    status: 'LIVE',
    activeSlot: 'A',
    nextSlot: 'B',
    generation: 14,
    startedAt: new Date(Date.now() - (3 * 3600 + 48 * 60) * 1000).toISOString(), // 3h 48m into the 4h loop so user sees live timer near 4h!
    lastSignalAt: new Date().toISOString(),
    workflowFile: '.github/workflows/channel-redbull-tv-hd.yml',
    createdAt: '2026-10-24T06:00:00.000Z'
  },
  {
    id: 'dw-english-news',
    slug: 'dw-english-news',
    name: 'DW English News 24/7',
    category: 'International News',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/Deutsche_Welle_symbol_2012.svg/512px-Deutsche_Welle_symbol_2012.svg.png',
    sourceUrl: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8',
    qualityMode: '720p',
    loopHours: 4,
    overlapMinutes: 5,
    maxTimeoutMinutes: 300,
    hlsSegmentTime: 4,
    hlsListSize: 8,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    referer: '',
    customRtmpUrl: '',
    enabled: true,
    status: 'HANDOVER_OVERLAP',
    activeSlot: 'A',
    nextSlot: 'B',
    generation: 29,
    startedAt: new Date(Date.now() - (4 * 3600 + 2 * 60) * 1000).toISOString(), // At 4h 02m -> actively inside the 5-minute overlap window!
    lastSignalAt: new Date().toISOString(),
    workflowFile: '.github/workflows/channel-dw-english-news.yml',
    createdAt: '2026-10-24T06:00:00.000Z'
  },
  {
    id: 'mux-test-hd',
    slug: 'mux-test-hd',
    name: 'StreamForge Test Broadcast HD',
    category: 'Entertainment',
    logo: 'https://mux.com/favicon.ico',
    sourceUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    qualityMode: 'copy',
    loopHours: 4,
    overlapMinutes: 5,
    maxTimeoutMinutes: 300,
    hlsSegmentTime: 4,
    hlsListSize: 8,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    referer: '',
    customRtmpUrl: '',
    enabled: true,
    status: 'LIVE',
    activeSlot: 'B',
    nextSlot: 'A',
    generation: 8,
    startedAt: new Date(Date.now() - (1 * 3600 + 22 * 60) * 1000).toISOString(), // 1h 22m into 4h loop on Slot B
    lastSignalAt: new Date().toISOString(),
    workflowFile: '.github/workflows/channel-mux-test-hd.yml',
    createdAt: '2026-10-24T06:00:00.000Z'
  }
];

const DEFAULT_SETTINGS = {
  githubOwner: process.env.GITHUB_OWNER || '',
  githubRepo: process.env.GITHUB_REPO || '',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_PAT || '',
  vercelUrl: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
  streamSecret: process.env.STREAM_API_SECRET || 'streamforge-24x7',
  autoTriggerOnAdd: true,
  defaultLoopHours: 4,
  defaultOverlapMinutes: 5,
  defaultMaxTimeoutMinutes: 300
};

let memoryStore = null;

function ensureFilesInitialized() {
  if (memoryStore) return memoryStore;

  // Try loading from /tmp first (if on Vercel and already modified in warm lambda)
  try {
    if (fs.existsSync(TMP_DATA_FILE)) {
      const raw = fs.readFileSync(TMP_DATA_FILE, 'utf8');
      memoryStore = JSON.parse(raw);
      return memoryStore;
    }
  } catch (_) {}

  // Try loading from project data/channels.json
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      memoryStore = JSON.parse(raw);
      return memoryStore;
    }
  } catch (_) {}

  // Initialize default store
  memoryStore = {
    settings: { ...DEFAULT_SETTINGS },
    channels: DEFAULT_CHANNELS.map(c => ({ ...c })),
    signals: {},
    events: [
      {
        id: 'evt-1',
        time: new Date().toISOString(),
        type: 'SYSTEM_INIT',
        channel: 'system',
        message: 'StreamForge 24/7 Live Engine initialized. 4h Loop + 5m Overlap Handover + 5h Hard Cap active.'
      },
      {
        id: 'evt-2',
        time: new Date().toISOString(),
        type: 'HANDOVER_OVERLAP',
        channel: 'dw-english-news',
        message: '4-Hour mark reached on Slot A (Gen #29). Triggered Slot B (Gen #30). Running 5-minute smooth overlap window.'
      }
    ]
  };

  saveStore(memoryStore);
  syncLocalWorkflowFiles(memoryStore);
  return memoryStore;
}

function saveStore(store) {
  memoryStore = store;

  // Always save to /tmp for serverless environments
  try {
    fs.writeFileSync(TMP_DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (_) {}

  // Also save to workspace data/channels.json when writable
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Don't persist raw githubToken into git-tracked data/channels.json for security
    const safeForDisk = {
      ...store,
      settings: {
        ...store.settings,
        githubToken: store.settings?.githubToken ? '***SET_IN_RUNTIME***' : ''
      }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(safeForDisk, null, 2), 'utf8');
  } catch (_) {}
}

function syncLocalWorkflowFiles(store) {
  try {
    if (!fs.existsSync(WORKFLOWS_DIR)) {
      fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }
    // Write watchdog workflow
    const watchdogYml = generateWatchdogWorkflowYaml({
      branch: store.settings?.githubBranch || 'main'
    });
    fs.writeFileSync(path.join(WORKFLOWS_DIR, 'watchdog-guardian.yml'), watchdogYml, 'utf8');

    // Write each channel's dedicated .yml workflow
    for (const ch of store.channels || []) {
      const slug = sanitizeSlug(ch.slug || ch.id || ch.name);
      const yml = generateChannelWorkflowYaml(ch, {
        branch: store.settings?.githubBranch || 'main',
        vercelUrl: store.settings?.vercelUrl || ''
      });
      fs.writeFileSync(path.join(WORKFLOWS_DIR, `channel-${slug}.yml`), yml, 'utf8');
    }
  } catch (_) {}
}

/**
 * Computes real-time 4h loop + 5m overlap telemetry for a channel
 * even between runner heartbeats so the UI & stream router know exact loop phase.
 */
function computeChannelLiveTelemetry(channel) {
  const loopSeconds = (Number(channel.loopHours) || 4) * 3600; // 14,400s
  const overlapSeconds = (Number(channel.overlapMinutes) || 5) * 60; // 300s
  const maxLifetimeSeconds = (Number(channel.maxTimeoutMinutes) || 300) * 60; // 18,000s
  const fullCycleSeconds = loopSeconds + overlapSeconds; // 14,700s (4h 05m)

  if (!channel.enabled || channel.status === 'STOPPED') {
    return {
      ...channel,
      telemetry: {
        phase: 'STOPPED',
        phaseLabel: 'Stream Stopped',
        elapsedSeconds: 0,
        loopDurationSeconds: loopSeconds,
        overlapDurationSeconds: overlapSeconds,
        maxLifetimeSeconds,
        untilHandoverSeconds: loopSeconds,
        overlapRemainingSeconds: 0,
        progressPercent: 0,
        activeSlot: channel.activeSlot || 'A',
        nextSlot: channel.nextSlot || 'B',
        generation: channel.generation || 1,
        queueCount: 0
      }
    };
  }

  const startedEpoch = channel.startedAt ? new Date(channel.startedAt).getTime() : Date.now();
  const rawElapsedSec = Math.max(0, Math.floor((Date.now() - startedEpoch) / 1000));

  // Calculate how many 4h relay cycles have occurred since startedAt
  const cyclesCompleted = Math.floor(rawElapsedSec / loopSeconds);
  const elapsedInCurrentCycle = rawElapsedSec % loopSeconds;

  const baseGen = Number(channel.generation) || 1;
  const currentGen = baseGen + cyclesCompleted;
  const baseSlotIsA = (channel.activeSlot || 'A') === 'A';
  const currentSlotIsA = cyclesCompleted % 2 === 0 ? baseSlotIsA : !baseSlotIsA;
  const activeSlot = currentSlotIsA ? 'A' : 'B';
  const nextSlot = currentSlotIsA ? 'B' : 'A';

  // Determine if we are inside the 5-minute overlap window:
  // Either explicitly at >= 4h (if startedAt tracks a single run) OR during the first 5 minutes after a 4h boundary
  let isOverlapping = false;
  let elapsedDisplaySec = elapsedInCurrentCycle;
  let overlapRemainingSec = 0;
  let untilHandoverSec = Math.max(0, loopSeconds - elapsedInCurrentCycle);

  if (rawElapsedSec >= loopSeconds && rawElapsedSec < fullCycleSeconds) {
    // Actively between 4h00m and 4h05m!
    isOverlapping = true;
    elapsedDisplaySec = rawElapsedSec;
    overlapRemainingSec = fullCycleSeconds - rawElapsedSec;
    untilHandoverSec = 0;
  } else if (cyclesCompleted > 0 && elapsedInCurrentCycle < overlapSeconds) {
    isOverlapping = true;
    elapsedDisplaySec = loopSeconds + elapsedInCurrentCycle;
    overlapRemainingSec = overlapSeconds - elapsedInCurrentCycle;
    untilHandoverSec = 0;
  }

  const phase = isOverlapping ? 'HANDOVER_OVERLAP' : 'LIVE';
  const phaseLabel = isOverlapping
    ? `⚡ 5-Min Overlap Handover (Slot ${activeSlot} → Slot ${nextSlot})`
    : `🟢 24/7 Smooth Stream Active (Slot ${activeSlot})`;

  const progressPercent = Math.min(100, Math.round((elapsedDisplaySec / fullCycleSeconds) * 100));

  return {
    ...channel,
    status: phase,
    activeSlot,
    nextSlot,
    generation: currentGen,
    telemetry: {
      phase,
      phaseLabel,
      elapsedSeconds: elapsedDisplaySec,
      loopDurationSeconds: loopSeconds,
      overlapDurationSeconds: overlapSeconds,
      maxLifetimeSeconds,
      untilHandoverSeconds: untilHandoverSec,
      overlapRemainingSeconds: overlapRemainingSec,
      progressPercent,
      activeSlot,
      nextSlot,
      generation: currentGen,
      queueCount: 0
    }
  };
}

function logEvent(store, type, channelSlug, message) {
  if (!store.events) store.events = [];
  store.events.unshift({
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    time: new Date().toISOString(),
    type,
    channel: channelSlug,
    message
  });
  if (store.events.length > 60) {
    store.events = store.events.slice(0, 60);
  }
}

module.exports = {
  ROOT_DIR,
  WORKFLOWS_DIR,
  ensureFilesInitialized,
  saveStore,
  syncLocalWorkflowFiles,
  computeChannelLiveTelemetry,
  logEvent
};
