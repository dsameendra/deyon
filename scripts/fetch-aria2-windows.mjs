// Downloads the official prebuilt aria2c.exe (win-64bit static build) from
// aria2's GitHub releases and drops it into resources/bin/win/aria2c.exe.
// Run on the Windows CI runner (or any machine with a `tar` that understands
// zip, which both bsdtar-on-Windows and macOS/Linux tar provide).

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'resources', 'bin', 'win');
const TMP_DIR = path.join(ROOT, '.tmp-aria2-win');

function get(url, redirects = 5) {
  const headers = { 'User-Agent': 'deyon-build-script' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && url.includes('api.github.com')) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          resolve(get(res.headers.location, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Request to ${url} failed: ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    ).on('error', reject);
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function main() {
  console.log('Fetching aria2 latest release metadata...');
  const releaseJson = await get('https://api.github.com/repos/aria2/aria2/releases/latest');
  const release = JSON.parse(releaseJson.toString('utf-8'));

  const asset = release.assets.find(
    (a) => /win-64bit-build\d*\.zip$/i.test(a.name)
  );
  if (!asset) {
    throw new Error(
      `Could not find a win-64bit build asset in release ${release.tag_name}. ` +
        `Available assets: ${release.assets.map((a) => a.name).join(', ')}`
    );
  }

  console.log(`Downloading ${asset.name} (${release.tag_name})...`);
  const zipBuf = await get(asset.browser_download_url);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, asset.name);
  fs.writeFileSync(zipPath, zipBuf);

  console.log('Extracting...');
  execFileSync('tar', ['-xf', zipPath, '-C', TMP_DIR]);

  const exePath = findFile(TMP_DIR, 'aria2c.exe');
  if (!exePath) throw new Error('aria2c.exe not found inside the downloaded archive.');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(exePath, path.join(OUT_DIR, 'aria2c.exe'));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`aria2c.exe (${release.tag_name}) placed at ${path.join(OUT_DIR, 'aria2c.exe')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
