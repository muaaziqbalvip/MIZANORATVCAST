/**
 * StreamForge 24/7 — Dynamic Project & Workflows ZIP Exporter (/api/download-zip)
 * Allows downloading either a single channel's .yml workflow or the entire project .zip
 * including all newly created channel-<slug>.yml workflows right from the Web UI!
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  ROOT_DIR,
  ensureFilesInitialized,
  syncLocalWorkflowFiles
} = require('./_lib/store');
const {
  sanitizeSlug,
  generateChannelWorkflowYaml
} = require('./_lib/workflow-generator');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const store = ensureFilesInitialized();
  syncLocalWorkflowFiles(store);

  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const baseUrl = (store.settings?.vercelUrl || `${proto}://${host}`).replace(/\/+$/, '');
  const urlObj = new URL(req.url, baseUrl);
  const slug = urlObj.searchParams.get('slug');

  // If ?slug=... is passed, download that specific channel's .yml file
  if (slug) {
    const cleanSlug = sanitizeSlug(slug);
    const ch = (store.channels || []).find(c => c.slug === cleanSlug);
    if (!ch) {
      res.statusCode = 404;
      return res.end('Channel not found');
    }
    const yml = generateChannelWorkflowYaml(ch, {
      branch: store.settings?.githubBranch || 'main',
      vercelUrl: baseUrl
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="channel-${cleanSlug}.yml"`);
    return res.end(yml);
  }

  // Otherwise, package and stream the entire project .zip
  const prebuiltZip = path.resolve(ROOT_DIR, '..', 'live-tv-github-vercel-system.zip');
  const tmpZip = '/tmp/streamforge-24x7-github-vercel.zip';

  try {
    execSync(`cd "${ROOT_DIR}" && zip -r -q "${tmpZip}" . -x "node_modules/*" ".git/*"`, {
      timeout: 15000
    });
    const zipBuffer = fs.readFileSync(tmpZip);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="streamforge-24x7-github-vercel-system.zip"');
    return res.end(zipBuffer);
  } catch (_) {
    if (fs.existsSync(prebuiltZip)) {
      const zipBuffer = fs.readFileSync(prebuiltZip);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="streamforge-24x7-github-vercel-system.zip"');
      return res.end(zipBuffer);
    }
    res.statusCode = 500;
    return res.end('Failed to build zip archive');
  }
};
