# 📺 StreamForge 24/7 — Live TV Channel Streaming System (Vercel + GitHub Actions)

Professional **24/7 Live TV Channel Streaming Software System** built for **Vercel + GitHub Actions**.

---

## 🔥 Core System Features (Roman Urdu + English Overview)

1. **Web Dashboard se Channel Add karen (`.m3u8` Input)**:
   - Web UI me **Channel Name**, **Category**, aur **Source `.m3u8` Stream Link** enter karen.
   - System khud har channel ke liye **alag GitHub Actions workflow `.yml` file** generate karta hai:
     `.github/workflows/channel-<channel-slug>.yml`
2. **GitHub Token ke zariye Automatic Push & Run**:
   - Aapke **GitHub Personal Access Token (`GH_PAT`)** ki madad se ye `.yml` file seedha aapke GitHub repository me push hoti hai aur foran `workflow_dispatch` ke zariye live run start ho jata hai!
3. **24/7 Zero-Queue Relay Loop Architecture (4 Hours + 5 Minutes Overlap + 5 Hours Max Cap)**:
   - Kyunke ek GitHub Action ~5–6 hours tak chalta hai, har channel ki `.yml` file me ye automatic loop system laga hai:
     - **`00:00:00` → `04:00:00` (4 Hours)**: **Slot A** smooth FFmpeg buffer ke sath stream chalata hai (auto-reconnect, timestamp smoothing, RAM disk `/dev/shm` HLS segments).
     - **`04:00:00` (At 4 Hours)**: Ye workflow GitHub API ke zariye agle loop (**Slot B**) ko signal (`workflow_dispatch`) bhej kar start kar deta hai.
     - **`04:00:00` → `04:05:00` (5 Minutes Overlap)**: **5 Minute** tak purana workflow (**Slot A**) aur naya workflow (**Slot B**) dono parallel chalte hain taake naya runner boot ho kar FFmpeg stream live kar de aur stream me **1 second ka bhi drop na aaye**!
     - **`04:05:00` (Self-Stop)**: 5 minute baad purana workflow apni stream khud band (`kill -TERM`) kar ke exit ho jata hai, aur hard safety limit **`timeout-minutes: 300` (5 Hours)** lagi hui hai.
     - **Zero Queue**: Slot A aur Slot B ke alag concurrency groups hain + dispatch se pehle `status=queued` check hota hai, is liye kabhi queue jama nahi hoti!
4. **Har Channel ka Permanent Vercel `.m3u8` Link**:
   - Har channel ka apna Vercel `.m3u8` link banta hai:
     `https://<your-vercel-app>.vercel.app/api/stream/<channel-slug>/index.m3u8`
   - Aur tamam channels ki ek master IPTV playlist bhi banti hai:
     `https://<your-vercel-app>.vercel.app/api/playlist.m3u`

---

## 🚀 Step-by-Step Setup Guide (GitHub + Vercel)

### Step 1: GitHub Personal Access Token (PAT) Banayein
1. GitHub par jayein: **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**.
2. **Generate new token (classic)** par click karen.
3. Scopes me **`repo`** aur **`workflow`** dono tick karen aur token copy kar len (`ghp_...`).

### Step 2: Project ko GitHub Repo me Upload karen
1. Ek nayi GitHub Repository banayein (maslan `live-tv-stream-engine`).
2. Is ZIP file ko extract kar ke tamam files us GitHub repo me upload / push kar den.
3. GitHub Repo ke **Settings** → **Secrets and variables** → **Actions** → **New repository secret** me jayein:
   - Name: `GH_PAT`
   - Secret: Apna GitHub Token (`ghp_...`) paste kar ke save kar den (is se 4 ghante baad workflow khud agle loop ko signal de sakega).

### Step 3: Vercel par Deploy karen
1. [Vercel.com](https://vercel.com) par jayein aur **Add New Project** par click kar ke apni GitHub repo import karen.
2. (Optional) Vercel **Environment Variables** me ye add kar den (ya baad me seedha Web UI se bhi add kar sakte hain):
   - `GITHUB_OWNER` = aapka GitHub username
   - `GITHUB_REPO` = aapka repository name
   - `GITHUB_BRANCH` = `main`
   - `GITHUB_TOKEN` = aapka `ghp_...` token
3. **Deploy** par click karen!

### Step 4: Web UI se Channels Add karen
1. Apni Vercel website open karen.
2. **⚙️ GitHub Token & Repo** button par click kar ke connection verify karen.
3. **➕ Add TV Channel & Push `.yml`** par click karen, Channel ka naam aur `.m3u8` link den, aur submit karen!
4. System foran `.github/workflows/channel-<slug>.yml` push kar ke 24/7 loop chala dega aur aapko Vercel `.m3u8` link de dega!

---

## 💻 Local Run / VPS Run
```bash
npm start
# Opens on http://0.0.0.0:3000
```
