'use strict';

// 調べる対象フォルダの中身をざっと数え、「コードが少ない／重い」フォルダなら警告を返す。
// 例: 紹介動画のフォルダ(連番PNG 2,700枚＋node_modules)を本体と取り違えて選ぶと、
// ワーカーが画像の山を探索して極端に遅くなる。上限付きで歩くのでサーバーを長く止めない。
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'target', '.cache', 'Pods', 'DerivedData',
]);
const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.m', '.c', '.h',
  '.cc', '.cpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.html', '.css', '.scss', '.vue', '.svelte', '.lua', '.pl', '.r',
]);
const MEDIA_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tif', '.tiff', '.bmp', '.svg', '.ico', '.psd',
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg',
  '.pdf', '.zip', '.gz', '.tar', '.dmg', '.pkg', '.xlsx', '.docx', '.pptx', '.ttf', '.otf', '.woff', '.woff2',
]);
const MAX_ENTRIES = 30000;
const MAX_MS = 1500;
const LIMIT_FILES = 3000; // 除外後のファイル数がこれを超えたら「重い」

function scanTarget(root) {
  const t0 = Date.now();
  const r = { files: 0, codeFiles: 0, mediaFiles: 0, bytes: 0, skippedDirs: [], truncated: false, warning: null };
  const skipped = new Set();
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    if (seen > MAX_ENTRIES || Date.now() - t0 > MAX_MS) { r.truncated = true; break; }
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      seen += 1;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { skipped.add(e.name); continue; }
        stack.push(p);
      } else if (e.isFile()) {
        r.files += 1;
        const ext = path.extname(e.name).toLowerCase();
        if (CODE_EXT.has(ext)) r.codeFiles += 1;
        else if (MEDIA_EXT.has(ext)) r.mediaFiles += 1;
        try { r.bytes += fs.statSync(p).size; } catch { /* 消えた */ }
      }
    }
  }
  r.skippedDirs = [...skipped].sort();
  const why = [];
  if (r.codeFiles === 0) why.push('コードのファイルが見当たりません');
  else if (r.codeFiles < 5 && r.mediaFiles > r.codeFiles * 20) why.push(`コードは ${r.codeFiles} 個だけで、画像・動画などが ${r.mediaFiles} 個あります`);
  if (r.truncated || r.files > LIMIT_FILES) why.push(`ファイル数が多すぎます(${r.truncated ? `${r.files}個以上` : `${r.files}個`})`);
  if (why.length) r.warning = `${why.join('。')}。調べたいコードのフォルダか確認してください`;
  return r;
}

module.exports = { scanTarget, SKIP_DIRS };
