'use strict';

// 統合レビュー → 修正係(Fixer) の部品。
// - レビュー本文末尾の ```json ブロックから「直すべき指摘」を取り出す
// - 対象リポジトリの外に git worktree を切り、その中だけで修正させる(本体の作業ツリーには触れない)
// - 修正係のプロンプトはサーバーが保存済みの指摘から組み立てる(ブラウザから来た文字列は入れない)
// - 完了・提案は Mac のダイアログでも知らせる
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_FINDINGS = 8;

// 修正係に許す Bash。git の参照と、よくあるテスト実行だけ(コミットはサーバーが隔離の外で行う)。
// Bash は OS のサンドボックス内で動く(ネットワーク不可・書き込みは作業場所のみ)。
// 足りないプロジェクトは CANVAS_FIX_BASH="Bash(make test:*),Bash(cargo test:*)" のように追加する。
const FIX_BASH_ALLOW = [
  'git status', 'git diff', 'git log', 'git show', 'ls',
  'python3 -m pytest', 'pytest', '/usr/local/bin/python3.14 -m pytest',
  'npm test', 'npm run test', 'node --test',
].map((c) => `Bash(${c}:*)`).concat(
  String(process.env.CANVAS_FIX_BASH || '').split(',').map((x) => x.trim()).filter((x) => /^Bash\([^()]+\)$/.test(x)),
);
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+$/g, '').slice(0, n);

// レビュー用プロンプトに足す指示。人が読む本文はこれまで通りで、最後に機械可読の一覧を付けさせる。
const FINDINGS_INSTRUCTION = `

最後に、修正が必要な指摘(優先度TOP5のうちコード修正で対応できるもの。良い点や感想は含めない)を、次の形式のjsonコードブロック1つで出力してください。説明文は不要です:
\`\`\`json
{"findings":[{"id":1,"title":"短い見出し","files":["path/to/file.py:12"],"detail":"何が問題で、どう直すべきか(2〜3文)"}]}
\`\`\``;

// 最後の ```json フェンスを取り出して検証する。戻り値 { findings, body } / { error, body }
function parseFindings(text) {
  const src = String(text || '');
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let last = null;
  for (let m; (m = re.exec(src));) last = m;
  if (!last) return { error: '修正候補の一覧(jsonブロック)が見つかりませんでした', body: src };
  const body = (src.slice(0, last.index) + src.slice(last.index + last[0].length)).trimEnd();
  let data;
  try { data = JSON.parse(last[1]); } catch (e) { return { error: `修正候補の一覧を読めませんでした: ${e.message}`, body }; }
  const list = Array.isArray(data) ? data : data && data.findings;
  if (!Array.isArray(list)) return { error: '修正候補の一覧の形が想定と違います', body };
  const findings = list.slice(0, MAX_FINDINGS).map((f, i) => ({
    id: i + 1,
    title: clip(f && f.title, 120),
    files: (Array.isArray(f && f.files) ? f.files : []).slice(0, 10).map((x) => clip(x, 200)),
    detail: clip(f && f.detail, 1200),
  })).filter((f) => f.title);
  return { findings, body };
}

function buildFixPrompt(findings, { target, reviewText }) {
  const items = findings.map((f) => `${f.id}. ${f.title}\n   対象: ${f.files.join(', ') || '(未記載)'}\n   内容: ${f.detail}`).join('\n');
  return `あなたは「Fixer」、コードレビュー指摘の修正係です。カレントディレクトリは対象リポジトリ ${target} の git worktree(作業用の別ブランチ)です。

## 修正を依頼された指摘
${items}

## 参考: 統合レビュー全文(安価なモデルの調査をまとめたもの。誤りを含みうる)
${clip(reviewText, 12000)}

## 進め方(必ず守る)
0. まずリポジトリ直下の CLAUDE.md / README があれば読み、規約に従う(全体設定は読み込まれていない)。
1. 各指摘を実際のコードで検証し、「修正」「誤指摘」「見送り」のどれかに判定する。レビューは誤りを含む前提で疑うこと。
2. 同じ弱点を持つ兄弟コード・本番経路(launchd/cron等の自動実行スクリプト、CLI と自動処理の両方など)が無いかも確認し、より深刻な方があればそちらを優先する。
3. 修正は最小限の差分で、周囲のコードの書き方・コメント量に合わせる。必要ならテストを追加する。
4. プロジェクトのテストを実行して結果を確認する(変更前後)。
5. Bash はサンドボックス内で動きます(ネットワーク不可・作業場所の外へは書けない)。使えるのは次だけです(それ以外は自動で拒否されます): ${FIX_BASH_ALLOW.map((x) => x.slice(5, -1).replace(/:\*$/, '')).join(' / ')}。テストを動かせない場合は無理に回避せず「未確認」として報告する。
6. 禁止: 本番スクリプトの実行、実データ・受信箱フォルダ・worktree外のファイルへの書き込み、パッケージのインストール、git push、launchctl。環境が壊れていて動かせない場合は直さずに報告する。
7. コミットはしない(終了後にサーバーが変更をまとめてコミットする)。ファイルを編集した状態で終えること。

## 最後の出力(日本語・この形式)
### 判定
| # | 指摘 | 判定 | 理由 |
### 追加で見つけた問題
### テスト結果
(実行したコマンドと結果。変更前→変更後の件数)
### 未確認のこと
`;
}

// 対象リポジトリのフックや fsmonitor をサーバー側の git 操作で動かさない
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
function git(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...GIT_SAFE, ...args], { encoding: 'utf8', maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message = String(stderr || err.message).trim(); return reject(err); }
      resolve(String(stdout).trim());
    });
  });
}

async function isGitRepo(dir) {
  try { return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true'; } catch { return false; }
}

// runs/<runId>/fix-<HHMMSS>/ に worktree を切る。ブランチ名は実行ごとに一意。
async function createWorktree(target, runDir, runId) {
  const top = await git(target, ['rev-parse', '--show-toplevel']);
  const base = await git(top, ['rev-parse', 'HEAD']);
  const dirty = (await git(top, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
  const hms = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const branch = `canvas-fix/${runId}-${hms}`;
  const wt = path.join(runDir, `fix-${hms}`);
  fs.mkdirSync(runDir, { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, wt, base]);
  // worktree 内の .git(ファイル)は修正係が書き換えられる。作成直後の本物の git ディレクトリを記録し、
  // 以後のサーバー側 git は必ずこれを明示して使う(.git を偽の設定に向け直されてフィルタ等を
  // 隔離の外で実行させられるのを防ぐ)。
  const gitDir = await git(wt, ['rev-parse', '--absolute-git-dir']);
  return { repo: top, wt, gitDir, branch, base, dirty };
}

// 記録済みの git ディレクトリを明示して worktree を操作する
function wtGit(job, args) {
  return git(job.wt, ['--git-dir', job.gitDir, '--work-tree', job.wt, ...args]);
}

// 修正係の変更をまとめて1コミットにする(変更が無ければ何もしない)。戻り値: コミットしたか
// 修正係が作業場所に入れ子のリポジトリ(.git)を作ると、その設定(fsmonitor・フィルタ等)を
// サーバー側の git status/add が隔離の外で実行してしまう。入れ子の .git があれば一切 git を触らない。
function findNestedGit(wt) {
  const stack = [wt];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.name === '.git' && dir !== wt) return p;
      if (e.isDirectory() && !e.isSymbolicLink() && e.name !== '.git') stack.push(p);
    }
  }
  return null;
}
function assertNoNestedGit(job) {
  const p = findNestedGit(job.wt);
  if (p) throw new Error(`作業場所に入れ子のリポジトリがあるため、安全のため git 操作をしません: ${p}`);
}

async function commitWorktree(job, message) {
  assertNoNestedGit(job);
  await wtGit(job, ['add', '-A']);
  if (!(await wtGit(job, ['status', '--porcelain']))) return false;
  await wtGit(job, ['-c', 'user.name=agent-canvas Fixer', '-c', 'user.email=fixer@agent-canvas.invalid', 'commit', '-q', '-m', message]);
  return true;
}

// 修正係の claude に渡す権限まわりの引数。編集は作業場所の配下だけ、Bash は許可リスト＋サンドボックス。
function fixerPermissionArgs(wt) {
  const sandbox = { sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } };
  return [
    '--setting-sources', '', '--settings', JSON.stringify(sandbox),
    '--allowedTools', ['Read', 'Glob', 'Grep', `Edit(/${wt}/**)`, `Write(/${wt}/**)`, ...FIX_BASH_ALLOW].join(','),
    '--disallowedTools', 'Bash(git push:*),Bash(gh:*),Bash(launchctl:*)',
  ];
}

async function summarizeWorktree(job) {
  try { assertNoNestedGit(job); } catch (e) { return { log: '', stat: '', status: e.message }; }
  const safe = (p) => p.catch((e) => `(取得失敗: ${e.message})`);
  const [log, stat, status] = await Promise.all([
    safe(wtGit(job, ['log', '--oneline', `${job.base}..HEAD`])),
    safe(wtGit(job, ['diff', '--stat', '--no-ext-diff', '--no-textconv', `${job.base}..HEAD`])),
    safe(wtGit(job, ['status', '--short'])),
  ]);
  return { log, stat, status };
}

// 修正係のプロセスだけ push 先 URL を壊す(リポジトリの設定ファイルには書かない。worktree は設定を共有するため)
function pushBlockEnv() {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.agent-canvas-push-blocked://.pushInsteadOf',
    GIT_CONFIG_VALUE_0: '',
  };
}

// Mac のダイアログ。「キャンバスを開く」でブラウザを開く。文字列は argv で渡す。
// display notification はクリックで URL を開けないので display dialog を使う(5分で自動的に閉じる)。
const DIALOG_SCRIPT = [
  'on run argv',
  '  set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"あとで", "キャンバスを開く"} default button 2 giving up after 300',
  '  if button returned of r is "キャンバスを開く" then do shell script "open " & quoted form of (item 3 of argv)',
  'end run',
];
function showDialog(title, message, url) {
  if (process.platform !== 'darwin') return;
  const args = DIALOG_SCRIPT.flatMap((l) => ['-e', l]);
  const child = spawn('osascript', [...args, title, message, url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

module.exports = {
  FINDINGS_INSTRUCTION, FIX_BASH_ALLOW, parseFindings, buildFixPrompt,
  isGitRepo, createWorktree, commitWorktree, fixerPermissionArgs, summarizeWorktree, pushBlockEnv, showDialog,
};
