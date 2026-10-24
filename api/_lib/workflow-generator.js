/**
 * StreamForge 24/7 — Per-Channel GitHub Actions Workflow (.yml) Generator
 *
 * Architecture:
 * - Each TV Channel gets its own isolated workflow: `.github/workflows/channel-<slug>.yml`
 * - Max GitHub Action Lifetime Cap: 5 Hours (300 minutes) (`timeout-minutes: 300`)
 * - Primary Stream Loop Duration: 4 Hours (14,400 seconds / 240 minutes)
 * - At 4 Hours: Triggers the NEXT workflow run via GitHub API (`workflow_dispatch`) on the alternate slot (Slot A <-> Slot B)
 *   so there is ZERO queue waiting and both runners overlap smoothly.
 * - 5-Minute Warm Handover Overlap (300 seconds): Current workflow continues streaming for 5 minutes while the newly
 *   triggered workflow boots up, initializes FFmpeg, and registers its `LIVE` signal with the 24/7 Stream API.
 * - At 4 Hours 05 Minutes: Current workflow gracefully stops FFmpeg and terminates cleanly (`exit 0`).
 */

function sanitizeSlug(input) {
  return String(input || 'channel')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'channel-1';
}

function generateChannelWorkflowYaml(channel, config = {}) {
  const slug = sanitizeSlug(channel.slug || channel.id || channel.name);
  const name = (channel.name || slug).replace(/["\\]/g, '');
  const sourceUrl = channel.sourceUrl || '';
  const category = channel.category || 'Live TV';
  const qualityMode = channel.qualityMode || 'copy'; // 'copy' | '720p' | '1080p' | '480p'
  const loopHours = Number(channel.loopHours) || 4;
  const loopSeconds = Math.round(loopHours * 3600); // Default: 14400s (4 hours)
  const overlapMinutes = Number(channel.overlapMinutes) || 5;
  const overlapSeconds = Math.round(overlapMinutes * 60); // Default: 300s (5 minutes)
  const maxTimeoutMinutes = Number(channel.maxTimeoutMinutes) || 300; // Default: 300m (5 hours)
  const hlsSegmentTime = Number(channel.hlsSegmentTime) || 4;
  const hlsListSize = Number(channel.hlsListSize) || 8;
  const userAgent = channel.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const referer = channel.referer || '';
  const customRtmpUrl = channel.customRtmpUrl || '';
  const branch = config.branch || channel.branch || 'main';
  const vercelBaseUrl = (config.vercelUrl || channel.vercelUrl || '').replace(/\/+$/, '');
  const workflowFileName = `channel-${slug}.yml`;

  // Build FFmpeg encoding parameters based on selected smooth stream profile
  let ffmpegCodecArgs = '-c:v copy -c:a copy -bsf:a aac_adtstoasc';
  if (qualityMode === '720p') {
    ffmpegCodecArgs = '-vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30" -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 2800k -bufsize 5000k -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -ac 2';
  } else if (qualityMode === '1080p') {
    ffmpegCodecArgs = '-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30" -c:v libx264 -preset veryfast -tune zerolatency -b:v 4500k -maxrate 5000k -bufsize 9000k -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a 160k -ar 44100 -ac 2';
  } else if (qualityMode === '480p') {
    ffmpegCodecArgs = '-vf "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,fps=25" -c:v libx264 -preset veryfast -tune zerolatency -b:v 1100k -maxrate 1300k -bufsize 2400k -g 50 -keyint_min 50 -sc_threshold 0 -c:a aac -b:a 96k -ar 44100 -ac 2';
  }

  return `# ============================================================================
# 📺 STREAMFORGE 24/7 LIVE TV WORKFLOW — DEDICATED CHANNEL ENGINE
# ============================================================================
# Channel Name      : ${name}
# Channel ID / Slug : ${slug}
# Category          : ${category}
# Workflow File     : .github/workflows/${workflowFileName}
# Vercel M3U8 Link  : ${vercelBaseUrl || 'https://<your-vercel-domain>'}/api/stream/${slug}/index.m3u8
#
# ⏱️ 24/7 ZERO-QUEUE RELAY LOOP ARCHITECTURE:
#   1. Max Action Hard Limit : ${maxTimeoutMinutes} Minutes (5 Hours)
#   2. Active Stream Loop    : ${loopHours} Hours (${loopSeconds} seconds)
#   3. At ${loopHours} Hours (${loopSeconds}s) : Signals & triggers next workflow run on alternate slot (A <-> B)
#   4. Handover Overlap      : ${overlapMinutes} Minutes (${overlapSeconds} seconds) warm parallel streaming
#   5. At ${loopHours}h ${String(overlapMinutes).padStart(2, '0')}m (${loopSeconds + overlapSeconds}s)      : Gracefully stops FFmpeg and exits cleanly (Zero Queue!)
# ============================================================================

name: "📺 Live 24/7 • ${name} (${slug})"

on:
  workflow_dispatch:
    inputs:
      slot:
        description: "Dual-Runner Relay Slot (A or B for 5-min zero-downtime overlap)"
        required: false
        default: "A"
      generation:
        description: "24/7 Continuous Relay Generation Number"
        required: false
        default: "1"
      source_override:
        description: "Optional override for Source M3U8 URL"
        required: false
        default: ""
      vercel_api_override:
        description: "Optional override for Vercel Stream API Base URL"
        required: false
        default: ""

# Dual-Slot Concurrency:
# Slot A and Slot B have distinct concurrency groups so Slot B can boot & stream
# during Slot A's 5-minute handover window without waiting in a queue, while
# preventing duplicate runs on the same slot.
concurrency:
  group: streamforge-${slug}-slot-\${{ github.event.inputs.slot || 'A' }}
  cancel-in-progress: true

permissions:
  contents: write
  actions: write

env:
  CHANNEL_SLUG: "${slug}"
  CHANNEL_NAME: "${name}"
  DEFAULT_SOURCE_URL: "${sourceUrl}"
  DEFAULT_VERCEL_API: "${vercelBaseUrl}"
  TARGET_BRANCH: "${branch}"
  WORKFLOW_FILE: "${workflowFileName}"
  QUALITY_MODE: "${qualityMode}"
  LOOP_DURATION_SEC: "${loopSeconds}"
  OVERLAP_DURATION_SEC: "${overlapSeconds}"
  MAX_LIFETIME_SEC: "${maxTimeoutMinutes * 60 - 120}"
  HLS_SEGMENT_TIME: "${hlsSegmentTime}"
  HLS_LIST_SIZE: "${hlsListSize}"
  CUSTOM_USER_AGENT: "${userAgent}"
  CUSTOM_REFERER: "${referer}"
  CUSTOM_RTMP_URL: "${customRtmpUrl}"

jobs:
  live_stream_relay:
    name: "🔴 24/7 Stream [${slug}] Slot \${{ github.event.inputs.slot || 'A' }} (Gen #\${{ github.event.inputs.generation || '1' }})"
    runs-on: ubuntu-latest
    timeout-minutes: ${maxTimeoutMinutes}

    steps:
      - name: "📦 Checkout Repository Metadata"
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: "⚙️ Install FFmpeg & Smooth Streaming Dependencies"
        run: |
          sudo apt-get update -y
          sudo apt-get install -y ffmpeg curl jq git bc
          ffmpeg -version | head -n 2

      - name: "🚀 Initialize High-Speed RAM Disk (/dev/shm) & Live Branch"
        run: |
          mkdir -p "/dev/shm/hls_\${CHANNEL_SLUG}"
          mkdir -p "/tmp/live_branch"

          # Configure Git identity for live HLS manifest & state updates
          git config --global user.name "StreamForge 24/7 Engine"
          git config --global user.email "stream-bot@users.noreply.github.com"

          TOKEN="\${GH_PAT:-\${GITHUB_TOKEN}}"
          REPO_URL="https://x-access-token:\${TOKEN}@github.com/\${GITHUB_REPOSITORY}.git"

          # Clone or initialize the isolated 'live-streams' orphan branch
          # (Pushing to 'live-streams' never triggers unnecessary Vercel production builds)
          if git ls-remote --exit-code --heads "\${REPO_URL}" live-streams >/dev/null 2>&1; then
            git clone --depth 1 --branch live-streams "\${REPO_URL}" /tmp/live_branch || true
          fi

          if [ ! -d "/tmp/live_branch/.git" ]; then
            mkdir -p /tmp/live_branch
            cd /tmp/live_branch
            git init
            git checkout --orphan live-streams
            git remote add origin "\${REPO_URL}"
            mkdir -p "channels/\${CHANNEL_SLUG}"
            echo "# StreamForge 24/7 Live Stream Buffer" > README.md
            git add .
            git commit -m "init: live-streams relay branch" || true
            git push -u origin live-streams --force || true
          fi
        env:
          GH_PAT: \${{ secrets.GH_PAT }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: "📡 Run 4-Hour Smooth Stream + 5-Minute Overlap Handover Loop"
        env:
          GH_PAT: \${{ secrets.GH_PAT }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          STREAM_API_SECRET: \${{ secrets.STREAM_API_SECRET }}
          CURRENT_SLOT: \${{ github.event.inputs.slot || 'A' }}
          CURRENT_GEN: \${{ github.event.inputs.generation || '1' }}
          INPUT_SOURCE_OVERRIDE: \${{ github.event.inputs.source_override || '' }}
          INPUT_VERCEL_OVERRIDE: \${{ github.event.inputs.vercel_api_override || '' }}
        run: |
          set +e

          # Determine active tokens & endpoints
          API_TOKEN="\${GH_PAT:-\${GITHUB_TOKEN}}"
          SOURCE_URL="\${INPUT_SOURCE_OVERRIDE:-\${DEFAULT_SOURCE_URL}}"
          VERCEL_API="\${INPUT_VERCEL_OVERRIDE:-\${DEFAULT_VERCEL_API}}"

          # Compute opposite slot for the 4-hour relay handover (A -> B, B -> A)
          if [ "\${CURRENT_SLOT}" = "A" ]; then
            NEXT_SLOT="B"
          else
            NEXT_SLOT="A"
          fi
          NEXT_GEN=\$((CURRENT_GEN + 1))

          RAM_DIR="/dev/shm/hls_\${CHANNEL_SLUG}"
          START_EPOCH=\$(date +%s)
          HANDOVER_TRIGGERED=0
          STOP_AT_EPOCH=\$((START_EPOCH + LOOP_DURATION_SEC + OVERLAP_DURATION_SEC))
          TRIGGER_AT_EPOCH=\$((START_EPOCH + LOOP_DURATION_SEC))

          echo "=================================================================="
          echo "🔴 STARTING 24/7 SMOOTH STREAM ENGINE: \${CHANNEL_NAME} (\${CHANNEL_SLUG})"
          echo "   • Active Slot          : Slot \${CURRENT_SLOT} (Generation #\${CURRENT_GEN})"
          echo "   • Next Relay Slot      : Slot \${NEXT_SLOT} (Generation #\${NEXT_GEN})"
          echo "   • Loop Trigger Mark    : \${LOOP_DURATION_SEC}s (${loopHours} Hours)"
          echo "   • Handover Overlap     : \${OVERLAP_DURATION_SEC}s (${overlapMinutes} Minutes)"
          echo "   • Graceful Exit Mark   : \$((LOOP_DURATION_SEC + OVERLAP_DURATION_SEC))s (${loopHours}h ${overlapMinutes}m)"
          echo "   • Hard Safety Ceiling  : ${maxTimeoutMinutes} Minutes (5 Hours)"
          echo "=================================================================="

          # Helper: Send real-time status & manifest signal to Vercel 24/7 Stream API
          send_signal() {
            local STATE="\$1"
            local MESSAGE="\$2"
            local NOW=\$(date +%s)
            local ELAPSED=\$((NOW - START_EPOCH))

            local MANIFEST_B64=""
            if [ -f "\${RAM_DIR}/index.m3u8" ]; then
              MANIFEST_B64=\$(base64 -w 0 "\${RAM_DIR}/index.m3u8" 2>/dev/null || base64 "\${RAM_DIR}/index.m3u8" | tr -d '\\n')
            fi

            local PAYLOAD=\$(jq -n \\
              --arg slug "\${CHANNEL_SLUG}" \\
              --arg name "\${CHANNEL_NAME}" \\
              --arg state "\${STATE}" \\
              --arg slot "\${CURRENT_SLOT}" \\
              --arg nextSlot "\${NEXT_SLOT}" \\
              --argjson generation "\${CURRENT_GEN}" \\
              --argjson elapsed "\${ELAPSED}" \\
              --argjson loopSec "\${LOOP_DURATION_SEC}" \\
              --argjson overlapSec "\${OVERLAP_DURATION_SEC}" \\
              --arg runId "\${GITHUB_RUN_ID}" \\
              --arg repo "\${GITHUB_REPOSITORY}" \\
              --arg sourceUrl "\${SOURCE_URL}" \\
              --arg message "\${MESSAGE}" \\
              --arg manifestB64 "\${MANIFEST_B64}" \\
              --arg updatedAt "\$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \\
              '{
                slug: \$slug,
                name: \$name,
                state: \$state,
                slot: \$slot,
                nextSlot: \$nextSlot,
                generation: \$generation,
                elapsedSeconds: \$elapsed,
                loopDurationSeconds: \$loopSec,
                overlapDurationSeconds: \$overlapSec,
                runId: \$runId,
                repository: \$repo,
                sourceUrl: \$sourceUrl,
                message: \$message,
                manifestBase64: \$manifestB64,
                updatedAt: \$updatedAt
              }')

            # Save state to live-streams branch directory
            if [ -d "/tmp/live_branch" ]; then
              mkdir -p "/tmp/live_branch/channels/\${CHANNEL_SLUG}"
              echo "\${PAYLOAD}" > "/tmp/live_branch/channels/\${CHANNEL_SLUG}/status.json"
              echo "\${PAYLOAD}" > "/tmp/live_branch/channels/\${CHANNEL_SLUG}/slot-\${CURRENT_SLOT}.json"
            fi

            # Push signal to Vercel Stream API if configured
            if [ -n "\${VERCEL_API}" ]; then
              curl -sS -m 8 -X POST "\${VERCEL_API}/api/signal" \\
                -H "Content-Type: application/json" \\
                -H "X-Stream-Token: \${STREAM_API_SECRET:-streamforge-24x7}" \\
                -d "\${PAYLOAD}" >/dev/null 2>&1 || true
            fi
          }

          # Helper: Trigger the next workflow run at the 4-Hour mark (with zero-queue check)
          trigger_next_loop() {
            echo "⚡ [4-HOUR RELAY SIGNAL] Checking queue & dispatching Slot \${NEXT_SLOT} (Gen #\${NEXT_GEN})..."

            # Check if there is already a queued run for this workflow to prevent any queue buildup
            QUEUED_COUNT=\$(curl -sS -H "Authorization: Bearer \${API_TOKEN}" \\
              -H "Accept: application/vnd.github+json" \\
              "https://api.github.com/repos/\${GITHUB_REPOSITORY}/actions/workflows/\${WORKFLOW_FILE}/runs?status=queued" \\
              | jq '.total_count // 0' 2>/dev/null || echo "0")

            if [ "\${QUEUED_COUNT}" -gt 0 ]; then
              echo "ℹ️ A run is already queued (count=\${QUEUED_COUNT}). Skipping duplicate dispatch to keep queue at zero."
              return 0
            fi

            DISPATCH_BODY=\$(jq -n \\
              --arg ref "\${TARGET_BRANCH}" \\
              --arg slot "\${NEXT_SLOT}" \\
              --arg gen "\${NEXT_GEN}" \\
              --arg src "\${SOURCE_URL}" \\
              --arg api "\${VERCEL_API}" \\
              '{
                ref: \$ref,
                inputs: {
                  slot: \$slot,
                  generation: \$gen,
                  source_override: \$src,
                  vercel_api_override: \$api
                }
              }')

            HTTP_CODE=\$(curl -sS -o /tmp/dispatch_resp.json -w "%{http_code}" \\
              -X POST "https://api.github.com/repos/\${GITHUB_REPOSITORY}/actions/workflows/\${WORKFLOW_FILE}/dispatches" \\
              -H "Authorization: Bearer \${API_TOKEN}" \\
              -H "Accept: application/vnd.github+json" \\
              -H "X-GitHub-Api-Version: 2022-11-28" \\
              -d "\${DISPATCH_BODY}")

            if [ "\${HTTP_CODE}" = "204" ] || [ "\${HTTP_CODE}" = "200" ]; then
              echo "✅ Successfully triggered Next 24/7 Loop: Slot \${NEXT_SLOT} (Gen #\${NEXT_GEN})!"
              send_signal "HANDOVER_OVERLAP" "4h mark reached. Triggered Slot \${NEXT_SLOT} (Gen #\${NEXT_GEN}). Overlapping for 5 minutes."
            else
              echo "⚠️ Dispatch returned HTTP \${HTTP_CODE}:"
              cat /tmp/dispatch_resp.json || true
            fi
          }

          # Background Process: Continuous FFmpeg Smooth Stream Supervisor
          # Automatically reconnects within 1s if source m3u8 has any micro-drop
          run_ffmpeg_supervisor() {
            while [ ! -f "/tmp/stop_stream_\${CHANNEL_SLUG}" ]; do
              HEADER_ARGS=()
              if [ -n "\${CUSTOM_USER_AGENT}" ]; then
                HEADER_ARGS+=(-user_agent "\${CUSTOM_USER_AGENT}")
              fi
              if [ -n "\${CUSTOM_REFERER}" ]; then
                HEADER_ARGS+=(-referer "\${CUSTOM_REFERER}")
              fi

              RTMP_TEE_ARGS=()
              if [ -n "\${CUSTOM_RTMP_URL}" ]; then
                RTMP_TEE_ARGS=(-c copy -f flv "\${CUSTOM_RTMP_URL}")
              fi

              ffmpeg -hide_banner -loglevel warning -y \\
                "\${HEADER_ARGS[@]}" \\
                -reconnect 1 \\
                -reconnect_at_eof 1 \\
                -reconnect_streamed 1 \\
                -reconnect_on_network_error 1 \\
                -reconnect_delay_max 5 \\
                -rw_timeout 15000000 \\
                -fflags +genpts+igndts+discardcorrupt \\
                -thread_queue_size 4096 \\
                -i "\${SOURCE_URL}" \\
                ${ffmpegCodecArgs} \\
                -f hls \\
                -hls_time "\${HLS_SEGMENT_TIME}" \\
                -hls_list_size "\${HLS_LIST_SIZE}" \\
                -hls_flags independent_segments+delete_segments+append_list+program_date_time+temp_file \\
                -hls_segment_filename "\${RAM_DIR}/seg_%05d.ts" \\
                "\${RAM_DIR}/index.m3u8" \\
                "\${RTMP_TEE_ARGS[@]}"

              if [ -f "/tmp/stop_stream_\${CHANNEL_SLUG}" ]; then
                break
              fi
              echo "🔄 [FFmpeg Supervisor] Stream input hiccup detected. Instant auto-reconnect in 1s..."
              sleep 1
            done
          }

          # Start FFmpeg supervisor in background
          send_signal "STARTING" "Initializing FFmpeg smooth stream buffer on Slot \${CURRENT_SLOT}..."
          run_ffmpeg_supervisor &
          SUPERVISOR_PID=\$!

          # Main 24/7 Lifecycle Controller Loop
          LAST_GIT_SYNC=0
          while true; do
            NOW=\$(date +%s)
            ELAPSED=\$((NOW - START_EPOCH))

            # 1. Check if 4-Hour (14,400s) mark reached -> Trigger Next Loop!
            if [ "\${HANDOVER_TRIGGERED}" -eq 0 ] && [ "\${ELAPSED}" -ge "\${LOOP_DURATION_SEC}" ]; then
              HANDOVER_TRIGGERED=1
              trigger_next_loop
            fi

            # 2. Check if 4-Hour + 5-Minute Overlap (14,700s) completed -> Stop self cleanly!
            if [ "\${NOW}" -ge "\${STOP_AT_EPOCH}" ] || [ "\${ELAPSED}" -ge "\${MAX_LIFETIME_SEC}" ]; then
              echo "🛑 [HANDOVER COMPLETE] 4h + 5m Overlap finished (\${ELAPSED}s). Slot \${NEXT_SLOT} is now primary. Stopping Slot \${CURRENT_SLOT}..."
              touch "/tmp/stop_stream_\${CHANNEL_SLUG}"
              pkill -TERM -P "\${SUPERVISOR_PID}" 2>/dev/null || true
              kill -TERM "\${SUPERVISOR_PID}" 2>/dev/null || true
              pkill -f "ffmpeg.*hls_\${CHANNEL_SLUG}" 2>/dev/null || true
              send_signal "HANDOVER_COMPLETED" "Slot \${CURRENT_SLOT} completed 4h + 5m overlap and handed over to Slot \${NEXT_SLOT}."
              break
            fi

            # 3. Sync live HLS manifest & segments + send heartbeat every 10 seconds
            if [ \$((NOW - LAST_GIT_SYNC)) -ge 10 ]; then
              LAST_GIT_SYNC=\${NOW}
              if [ "\${HANDOVER_TRIGGERED}" -eq 1 ]; then
                REMAINING_OVERLAP=\$((STOP_AT_EPOCH - NOW))
                send_signal "HANDOVER_OVERLAP" "5-Min Handover Overlap active (\${REMAINING_OVERLAP}s remaining). Slot \${NEXT_SLOT} warming up."
              else
                UNTIL_HANDOVER=\$((TRIGGER_AT_EPOCH - NOW))
                send_signal "LIVE" "Streaming smoothly on Slot \${CURRENT_SLOT} (Gen #\${CURRENT_GEN}). Next relay in \${UNTIL_HANDOVER}s."
              fi

              # Sync latest segments to live-streams branch
              if [ -f "\${RAM_DIR}/index.m3u8" ] && [ -d "/tmp/live_branch" ]; then
                cp -f "\${RAM_DIR}/index.m3u8" "/tmp/live_branch/channels/\${CHANNEL_SLUG}/index.m3u8" 2>/dev/null || true
                cp -f "\${RAM_DIR}"/seg_*.ts "/tmp/live_branch/channels/\${CHANNEL_SLUG}/" 2>/dev/null || true
                # Clean old segments not in index.m3u8
                cd "/tmp/live_branch/channels/\${CHANNEL_SLUG}"
                for seg in seg_*.ts; do
                  [ -e "\$seg" ] || continue
                  if ! grep -q "\$seg" index.m3u8 2>/dev/null; then
                    rm -f "\$seg"
                  fi
                done
                cd /tmp/live_branch
                git add "channels/\${CHANNEL_SLUG}" 2>/dev/null || true
                if ! git diff --cached --quiet; then
                  git commit -m "live(\${CHANNEL_SLUG}): slot \${CURRENT_SLOT} gen #\${CURRENT_GEN} @ \${ELAPSED}s" >/dev/null 2>&1 || true
                  git pull --rebase origin live-streams >/dev/null 2>&1 || true
                  git push origin live-streams --force >/dev/null 2>&1 || true
                fi
              fi
            fi

            sleep 3
          done

          echo "✨ Workflow cycle for \${CHANNEL_NAME} (Slot \${CURRENT_SLOT}, Gen #\${CURRENT_GEN}) exited cleanly at 4h 05m."
          exit 0
`;
}

function generateWatchdogWorkflowYaml(config = {}) {
  const branch = config.branch || 'main';
  return `# ============================================================================
# 🛡️ STREAMFORGE 24/7 — ZERO-QUEUE WATCHDOG GUARDIAN WORKFLOW
# ============================================================================
# Checks every 30 minutes if any enabled channel's 24/7 relay loop accidentally
# stopped (e.g., due to a GitHub infrastructure outage). If and ONLY if a channel
# has ZERO active ('in_progress') and ZERO 'queued' runs, it restarts Slot A.
# ============================================================================

name: "🛡️ 24/7 Stream Watchdog Guardian"

on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:

concurrency:
  group: streamforge-watchdog-guardian
  cancel-in-progress: true

permissions:
  actions: write
  contents: read

jobs:
  verify_active_channels:
    name: "🔍 Verify 24/7 Channel Loops (Zero-Queue Check)"
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: "📦 Checkout Channel Registry"
        uses: actions/checkout@v4

      - name: "🔄 Auto-Heal Any Stopped Channel Workflows"
        env:
          GH_PAT: \${{ secrets.GH_PAT }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TARGET_BRANCH: "${branch}"
        run: |
          TOKEN="\${GH_PAT:-\${GITHUB_TOKEN}}"
          if [ ! -f "data/channels.json" ]; then
            echo "No data/channels.json found."
            exit 0
          fi

          CHANNELS=\$(jq -r '.channels[] | select(.enabled == true) | .slug' data/channels.json)
          for SLUG in \${CHANNELS}; do
            WF_FILE="channel-\${SLUG}.yml"
            if [ ! -f ".github/workflows/\${WF_FILE}" ]; then
              continue
            fi

            ACTIVE=\$(curl -sS -H "Authorization: Bearer \${TOKEN}" \\
              "https://api.github.com/repos/\${GITHUB_REPOSITORY}/actions/workflows/\${WF_FILE}/runs?status=in_progress" \\
              | jq '.total_count // 0' 2>/dev/null || echo "0")

            QUEUED=\$(curl -sS -H "Authorization: Bearer \${TOKEN}" \\
              "https://api.github.com/repos/\${GITHUB_REPOSITORY}/actions/workflows/\${WF_FILE}/runs?status=queued" \\
              | jq '.total_count // 0' 2>/dev/null || echo "0")

            echo "Channel [\${SLUG}] -> in_progress=\${ACTIVE}, queued=\${QUEUED}"

            if [ "\${ACTIVE}" -eq 0 ] && [ "\${QUEUED}" -eq 0 ]; then
              echo "⚡ Restarting 24/7 loop for [\${SLUG}] on Slot A..."
              curl -sS -X POST "https://api.github.com/repos/\${GITHUB_REPOSITORY}/actions/workflows/\${WF_FILE}/dispatches" \\
                -H "Authorization: Bearer \${TOKEN}" \\
                -H "Accept: application/vnd.github+json" \\
                -d "{\\"ref\\":\\"\${TARGET_BRANCH}\\",\\"inputs\\":{\\"slot\\":\\"A\\",\\"generation\\":\\"1\\"}}" || true
            fi
          done
`;
}

module.exports = {
  sanitizeSlug,
  generateChannelWorkflowYaml,
  generateWatchdogWorkflowYaml
};
