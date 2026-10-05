#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const { pickFolder, canPick } = require('./folder-picker');
const fixer = require('./fixer');
const { scanTarget } = require('./target-scan');

const PORT = Number(process.env.CANVAS_PORT || 4923);
// 既定はこのMac内からだけ受け付ける。LANに出す場合は CANVAS_HOST=0.0.0.0 等を明示する
const HOST = process.env.CANVAS_HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const BIN_DIR = path.join(ROOT, 'bin');
const ORCH_DIR = path.join(ROOT, 'orchestrator');
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const FIX_TIMEOUT_MS = 40 * 60 * 1000;
const FIX_MODELS = new Set(['opus', 'sonnet']);
// 修正係(対象のコードを書き換える試験機能)は CANVAS_FIXER=1 のときだけ有効。既定は調査とレビューのみ
const FIXER_ENABLED = process.env.CANVAS_FIXER === '1';

// 対象を切り替えるたびに新しい runs/<stamp>/ を切る(前の対象のレポートを上書きしないため)
// フォルダは最初の書き込み時に作る(起動しただけの空フォルダを残さない)。
// run.json に対象・各エージェントの費用(API換算)・トークン数を記録し、履歴画面で読む。
const RUNS_DIR = path.join(ROOT, 'runs');
let RUN_DIR;
let runMeta;
function newRunDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  RUN_DIR = path.join(RUNS_DIR, stamp);
  runMeta = null;
}
function ensureRunDir() { fs.mkdirSync(RUN_DIR, { recursive: true }); return RUN_DIR; }
newRunDir();

// 円換算レート(画面側で上書き可)。費用は claude CLI が返す total_cost_usd = API従量課金に換算した額
const USD_JPY = Number(process.env.CANVAS_USD_JPY || 150);

// ---------------------------------------------------------------- targets
// 登録済みの深掘り対象は targets.json に保存(個人パスを含むので .gitignore 済み)。
// 起動時の対象: CANVAS_TARGET 明示 > 前回UIで選んだ対象 > サーバーを起動したディレクトリ。
const TARGETS_FILE = path.join(ROOT, 'targets.json');
let targets = { active: null, items: [] };
try { targets = { ...targets, ...JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8')) }; } catch { /* 初回 */ }
function saveTargets() { fs.writeFileSync(TARGETS_FILE, `${JSON.stringify(targets, null, 2)}\n`); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

let currentTarget = process.env.CANVAS_TARGET
  || (targets.active && isDir(targets.active) ? targets.active : null)
  || process.cwd();

// 現在の対象の規模チェック結果(対象が変わったときだけ数え直す)
let scanCache = { path: null, result: null };
function currentScan() {
  if (scanCache.path !== currentTarget) scanCache = { path: currentTarget, result: scanTarget(currentTarget) };
  return scanCache.result;
}
function publicTargets() {
  return { current: currentTarget, canPick, scan: currentScan(), items: targets.items.map((t) => ({ ...t, exists: isDir(t.path) })) };
}
function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function normalizeTargetPath(raw) {
  const p = String(raw || '').trim().replace(/^~(?=\/|$)/, process.env.HOME || '~');
  if (!path.isAbsolute(p)) throw badRequest('絶対パスで指定してください');
  const abs = path.resolve(p);
  if (!isDir(abs)) throw badRequest(`フォルダが見つかりません: ${abs}`);
  return abs;
}

// claude may not be on PATH when launched from a GUI harness
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SPAWN_PATH = `${BIN_DIR}:${process.env.HOME}/.local/bin:${process.env.PATH || ''}`;

// CANVAS_MOCK=1 swaps the real CLI for mock/fake-claude.js — same stream-json
// contract, zero model cost. The canvasctl round-trips stay real.
const MOCK = !!process.env.CANVAS_MOCK;
const MOCK_BIN = path.join(ROOT, 'mock', 'fake-claude.js');
// Mac のダイアログ: 既定は実モデル時のみ。CANVAS_DIALOG=0 で止め、=1 でモックでも出す
const DIALOG = process.env.CANVAS_DIALOG ? process.env.CANVAS_DIALOG === '1' : !MOCK;
function dialog(title, message) {
  if (DIALOG) fixer.showDialog(title, message, `http://localhost:${PORT}/`);
}
function claudeSpawn(args, opts) {
  return MOCK ? spawn(process.execPath, [MOCK_BIN, ...args], opts) : spawn(CLAUDE_BIN, args, opts);
}

// Strip API-key billing vars so child CLIs use the subscription login,
// not whatever key the launching harness happened to carry.
function spawnEnv(extra) {
  const env = { ...process.env, ...extra, PATH: SPAWN_PATH };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** name -> pane record */
const panes = new Map();
let orchSessionStarted = false;
let orchBusy = false;
const orchQueue = [];
let pendingReview = false;

// 進捗表示用の「ラウンド」= 画面から Forest へ指示を送ってから、ワーカーと統合レビューが全部終わるまで。
// 自動で走る統合レビューのターンでは時計をリセットしない。
let round = null; // { startedAt, workers: Set<name>, finishedAt }
function roundSummary() {
  if (!round) return null;
  const ws = [...round.workers].map((n) => panes.get(n)).filter(Boolean);
  return {
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    workersTotal: ws.length,
    workersDone: ws.filter((p) => p.status === 'done').length,
    workersError: ws.filter((p) => p.status === 'error').length,
    forest: (panes.get('Forest') || {}).status || null,
  };
}
function broadcastRound() { broadcast({ t: 'run', run: currentRunSummary() }); }
function maybeFinishRound() {
  if (!round || round.finishedAt || busyReason()) return;
  round.finishedAt = Date.now();
  broadcastRound();
}

// ---------------------------------------------------------------- websocket
const clients = new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

function addLine(pane, kind, text) {
  const line = { kind, text };
  pane.lines.push(line);
  if (pane.lines.length > 800) pane.lines.splice(0, pane.lines.length - 800);
  broadcast({ t: 'line', name: pane.name, ...line });
}

function setStatus(pane, status, meta) {
  pane.status = status;
  if (meta) Object.assign(pane, meta);
  broadcast({ t: 'status', name: pane.name, status, meta: meta || {} });
}

function createPane(name, role, model) {
  let pane = panes.get(name);
  if (pane) { pane.lines = []; pane.role = role; pane.model = model; pane.focus = null; }
  else {
    pane = { name, role, model, status: 'idle', lines: [], reportPath: null };
    panes.set(name, pane);
  }
  broadcast({ t: 'pane', pane: publicPane(pane) });
  return pane;
}

function publicPane(p) {
  return {
    name: p.name, role: p.role, model: p.model, status: p.status, focus: p.focus || null, lines: p.lines,
    costUsd: runMeta && Object.hasOwn(runMeta.agents, p.name) ? agentCost(runMeta.agents[p.name]) : 0,
  };
}

// エージェント名はファイル名(<Name>.md)と run.json のキーに使うため英数字に限定する
// (パス区切りや __proto__ 等の特殊キーを通さない)
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
function validName(n) { return typeof n === 'string' && NAME_RE.test(n) && !RESERVED.has(n); }

// ------------------------------------------------------------ cost ledger
function agentCost(a) { return a.turns.reduce((n, t) => n + (t.costUsd || 0), 0); }
function runCost(meta) { return Object.values(meta.agents).reduce((n, a) => n + agentCost(a), 0); }
function currentRunSummary() {
  return { id: path.basename(RUN_DIR), costUsd: runMeta ? runCost(runMeta) : 0, usdJpy: USD_JPY, round: roundSummary() };
}
function recordTurn(pane, ev) {
  if (!runMeta) {
    runMeta = {
      id: path.basename(RUN_DIR), target: currentTarget, startedAt: new Date().toISOString(),
      mock: MOCK, agents: Object.create(null),
    };
  }
  const a = (Object.hasOwn(runMeta.agents, pane.name) && runMeta.agents[pane.name]) || (runMeta.agents[pane.name] = {
    role: pane.role, model: pane.model, focus: pane.focus || null, turns: [],
  });
  if (pane.focus) a.focus = pane.focus;
  const u = ev.usage || {};
  a.turns.push({
    at: new Date().toISOString(),
    costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
    durationMs: ev.duration_ms || null,
    tokens: {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    },
  });
  fs.writeFileSync(path.join(ensureRunDir(), 'run.json'), `${JSON.stringify(runMeta, null, 2)}\n`);
  broadcast({ t: 'cost', name: pane.name, paneCostUsd: agentCost(a), run: currentRunSummary() });
}

// ------------------------------------------------------- stream-json parser
function summarizeToolUse(block) {
  const inp = block.input || {};
  const bits = inp.pattern || inp.file_path || inp.path || inp.command || inp.query || '';
  const s = String(bits).replace(/\s+/g, ' ');
  return `${block.name} ${s.slice(0, 90)}`;
}

function attachStream(child, pane, onResult) {
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (raw) => {
    if (!raw.trim()) return;
    let ev;
    try { ev = JSON.parse(raw); } catch { addLine(pane, 'text', raw.slice(0, 200)); return; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      addLine(pane, 'sys', `準備完了 · モデル ${ev.model || pane.model}`);
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          for (const l of block.text.trim().split('\n')) addLine(pane, 'text', l);
        } else if (block.type === 'tool_use') {
          addLine(pane, 'tool', summarizeToolUse(block));
        }
      }
    } else if (ev.type === 'result') {
      onResult(ev);
    }
  });
  let errBuf = '';
  child.stderr.on('data', (d) => { errBuf += d; });
  return () => errBuf;
}

// ---------------------------------------------------------------- workers
const WORKER_PROMPT = (name, focus) => `あなたは「${name}」、コードベース深掘り調査ワーカーです。対象はカレントディレクトリのコードベース。
担当フォーカス: ${focus}

Read / Glob / Grep のみで探索してください。全ファイルを読まず、重要なファイルを賢くサンプリングすること(最大40ファイル程度)。
次は読まない・探索しない: node_modules・.git・dist/build/out・仮想環境(venv等)・キャッシュ、画像・動画・音声・PDF・zip などのバイナリ、連番フレーム等の生成物。Glob はまず拡張子を絞って(例: **/*.{py,js,ts,sh})使うこと。
コードがほとんど見当たらない場合は深追いせず、その旨と見つかった主なファイルの種類を短く報告して終えること。

最終出力は日本語のMarkdownレポート1本にまとめる。セクション構成:
## ARCHITECTURE / ## FEATURES / ## QUALITY / ## BUGS
担当フォーカス「${focus}」のセクションを最も深く掘ること。指摘には必ずファイルパスを添えること。前置きや挨拶は不要、レポート本文のみ出力。`;

function spawnWorker({ name, focus, target, model, prompt }) {
  target = target || currentTarget;
  model = model || 'haiku';
  if (!fs.existsSync(target)) throw new Error(`target not found: ${target}`);
  const pane = createPane(name, 'Worker', model);
  setStatus(pane, 'running', { focus, target, startedAt: Date.now() });
  addLine(pane, 'sys', `調査対象 → ${target}`);
  addLine(pane, 'sys', `担当: ${focus}`);
  pendingReview = true;
  if (round && !round.finishedAt) { round.workers.add(name); broadcastRound(); }

  const args = [
    '-p', '--setting-sources', '',
    '--model', model,
    '--allowedTools', 'Read,Glob,Grep',
    '--output-format', 'stream-json', '--verbose',
    prompt || WORKER_PROMPT(name, focus),
  ];
  const child = claudeSpawn(args, {
    cwd: target,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spawnEnv(),
  });
  const getErr = attachStream(child, pane, (ev) => {
    const report = ev.result || '';
    const file = path.join(ensureRunDir(), `${name}.md`);
    fs.writeFileSync(file, report);
    pane.reportPath = file;
    recordTurn(pane, ev);
    const cost = ev.total_cost_usd ? ` · $${ev.total_cost_usd.toFixed(3)}` : '';
    addLine(pane, 'done', `レポート保存 (${Math.round((ev.duration_ms || 0) / 1000)}秒${cost})`);
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (code === 0 && pane.reportPath) setStatus(pane, 'done');
    else {
      setStatus(pane, 'error');
      addLine(pane, 'err', `${exitLabel(code, signal)}: ${getErr().slice(-300)}`);
    }
    maybeTriggerReview();
    if (round && round.workers.has(name)) broadcastRound();
    maybeFinishRound();
  });
  return pane;
}

function runningWorkers() {
  return [...panes.values()].filter((p) => p.role === 'Worker' && p.status === 'running');
}

function maybeTriggerReview() {
  if (!pendingReview || runningWorkers().length > 0) return;
  pendingReview = false;
  const done = [...panes.values()].filter((p) => p.role === 'Worker' && p.reportPath);
  if (!done.length) return;
  const list = done.map((p) => `- ${p.name} (${p.focus}): ${p.reportPath}`).join('\n');
  runOrchestrator(`全ワーカーの調査が完了しました。以下のレポートをReadで読み、統合レビューを日本語で出力してください。重複する指摘・食い違い・優先度TOP5を明確に:\n${list}${fixer.FINDINGS_INSTRUCTION}`, 'review');
}

// ------------------------------------------------------------ orchestrator
function runOrchestrator(text, kind = 'user') {
  if (orchBusy) { orchQueue.push({ text, kind }); return panes.get('Forest'); }
  orchBusy = true;
  const pane = createPane('Forest', 'Claude Code', process.env.ORCH_MODEL || 'sonnet');
  setStatus(pane, 'running');
  broadcastRound();
  // レビュー依頼に付けた機械向けの指示(json の書式)は画面に出さない
  addLine(pane, 'user', kind === 'review' ? text.replace(fixer.FINDINGS_INSTRUCTION, '') : text);

  const args = ['-p'];
  if (orchSessionStarted) args.push('--continue');
  args.push(
    '--allowedTools', 'Bash(canvasctl:*),Read,Glob,Grep',
    '--output-format', 'stream-json', '--verbose',
  );
  args.push('--model', process.env.ORCH_MODEL || 'sonnet');
  args.push(text);

  const child = claudeSpawn(args, {
    cwd: ORCH_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spawnEnv({
      CANVAS_SERVER: `http://127.0.0.1:${PORT}`,
      CANVAS_TARGET: currentTarget,
    }),
  });
  const getErr = attachStream(child, pane, (ev) => {
    // Forest の各ターンの最終出力(統合レビューを含む)を Forest.md に追記して残す
    const file = path.join(ensureRunDir(), 'Forest.md');
    let body = ev.result || '';
    if (kind === 'review') body = takeFindings(pane, body);
    fs.appendFileSync(file, `<!-- ${new Date().toISOString()} -->\n> ${text.split('\n')[0].slice(0, 200)}\n\n${body}\n\n`);
    pane.reportPath = file;
    recordTurn(pane, ev);
    const cost = ev.total_cost_usd ? ` · $${ev.total_cost_usd.toFixed(3)}` : '';
    addLine(pane, 'done', `ターン完了 (${Math.round((ev.duration_ms || 0) / 1000)}秒${cost})`);
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    orchSessionStarted = true;
    orchBusy = false;
    if (code === 0) setStatus(pane, 'done');
    else {
      setStatus(pane, 'error');
      addLine(pane, 'err', `${exitLabel(code, signal)}: ${getErr().slice(-300)}`);
    }
    if (orchQueue.length) { const q = orchQueue.shift(); runOrchestrator(q.text, q.kind); }
    maybeFinishRound();
  });
  return pane;
}

// ------------------------------------------------------------------ fixer
// 統合レビュー → 「修正しますか？」の提案 → 修正係(Fixer)。
// proposal はブラウザを閉じていても消えないようサーバーに持ち、snapshot で渡す。
let fix = { proposal: null, job: null };
function publicFix() {
  const j = fix.job;
  return {
    proposal: fix.proposal,
    job: j && {
      runId: j.runId, status: j.status, model: j.model, ids: j.ids, branch: j.branch, repo: j.repo,
      worktree: j.wt, base: j.base, dirty: j.dirty, startedAt: j.startedAt, finishedAt: j.finishedAt || null,
      summary: j.summary || null, error: j.error || null,
    },
  };
}
function broadcastFix() { broadcast({ t: 'fix', fix: publicFix() }); }

// レビュー本文から修正候補を取り出し、findings.json に保存して提案を出す。戻り値は Forest.md に残す本文。
function takeFindings(pane, text) {
  const r = fixer.parseFindings(text);
  if (r.error) { addLine(pane, 'err', `${r.error}。修正の提案は出しません`); return text; }
  if (!r.findings.length) { addLine(pane, 'sys', '修正が必要な指摘はありませんでした'); return r.body; }
  fs.writeFileSync(path.join(ensureRunDir(), 'findings.json'), `${JSON.stringify(r.findings, null, 2)}\n`);
  if (!FIXER_ENABLED) {
    addLine(pane, 'sys', `修正候補 ${r.findings.length}件(findings.json)。修正係は試験機能のため無効です(CANVAS_FIXER=1 で有効)`);
    return r.body;
  }
  fix.proposal = {
    runId: path.basename(RUN_DIR), target: currentTarget, findings: r.findings,
    reviewText: r.body, createdAt: new Date().toISOString(),
  };
  broadcastFix();
  addLine(pane, 'sys', `修正候補 ${r.findings.length}件 — 画面の案内から修正係に渡せます`);
  dialog('agent-canvas: 統合レビュー完了', `${path.basename(currentTarget)} に修正候補が ${r.findings.length} 件あります。修正係に渡しますか？`);
  return r.body;
}

async function startFix({ ids, model }) {
  if (!FIXER_ENABLED) throw Object.assign(new Error('修正係は無効です(CANVAS_FIXER=1 で起動すると使えます)'), { status: 403 });
  const p = fix.proposal;
  if (!p) throw Object.assign(new Error('修正候補がありません'), { status: 409 });
  const why = busyReason();
  if (why) throw Object.assign(new Error(`${why}。完了後に実行してください`), { status: 409 });
  if (!FIX_MODELS.has(model)) throw badRequest('model は opus か sonnet を指定してください');
  const want = new Set(Array.isArray(ids) ? ids.map(Number) : []);
  const chosen = p.findings.filter((f) => want.has(f.id));
  if (!chosen.length) throw badRequest('修正する指摘を1つ以上選んでください');
  if (!(await fixer.isGitRepo(p.target))) {
    throw Object.assign(new Error('対象が git リポジトリではないため、安全に修正を分離できません'), { status: 409 });
  }
  const runDir = path.join(RUNS_DIR, p.runId);
  const job = { runId: p.runId, status: 'running', model, ids: chosen.map((f) => f.id), startedAt: Date.now(), runDir };
  fix.job = job; // ここで busy にして二重起動を防ぐ
  try {
    Object.assign(job, await fixer.createWorktree(p.target, runDir, p.runId));
  } catch (e) {
    Object.assign(job, { status: 'error', error: `worktree の作成に失敗: ${e.message}`, finishedAt: Date.now() });
    broadcastFix();
    throw Object.assign(new Error(job.error), { status: 500 });
  }
  broadcastFix();

  const pane = createPane('Fixer', 'Fixer', model);
  setStatus(pane, 'running', { focus: `指摘 ${job.ids.join(', ')} の修正`, startedAt: Date.now() });
  addLine(pane, 'sys', `作業場所 → ${job.wt}`);
  addLine(pane, 'sys', `ブランチ ${job.branch}(元: ${job.base.slice(0, 7)})`);
  if (job.dirty) addLine(pane, 'sys', `注意: 対象には未コミットの変更が ${job.dirty} 件あり、修正係からは見えません`);

  // レビュー本文は対象コード由来で指示が紛れ込みうるため、修正係は閉じ込めて動かす:
  // 全体設定を読まない / 編集は worktree 配下のみ / Bash は許可リスト＋OSサンドボックス(ネット不可)。
  // コミットは終了後にサーバーが行う(サンドボックスからは worktree 外の .git に書けないため)。
  const args = [
    '-p', '--model', model,
    ...fixer.fixerPermissionArgs(job.wt),
    '--output-format', 'stream-json', '--verbose',
    fixer.buildFixPrompt(chosen, { target: p.target, reviewText: p.reviewText }),
  ];
  // cwd は worktree。--continue は付けない(Forest のセッションと混ざらないように)
  const child = claudeSpawn(args, { cwd: job.wt, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv(fixer.pushBlockEnv()) });
  let result = '';
  const getErr = attachStream(child, pane, (ev) => {
    result = ev.result || '';
    recordTurn(pane, ev);
    const cost = ev.total_cost_usd ? ` · ${ev.total_cost_usd.toFixed(3)}` : '';
    addLine(pane, 'done', `修正完了 (${Math.round((ev.duration_ms || 0) / 1000)}秒${cost})`);
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, FIX_TIMEOUT_MS);
  // 'exit' は stdout を読み切る前に来ることがあり、最終報告を取りこぼすので 'close' を待つ
  child.on('close', async (code, signal) => {
    clearTimeout(timer);
    try {
      await fixer.commitWorktree(job, `canvas-fix: 指摘 ${job.ids.join(', ')} の修正 (${model})\n\n${result.slice(0, 4000)}`);
    } catch (e) {
      addLine(pane, 'err', `コミットに失敗: ${e.message.slice(0, 200)}`);
    }
    job.summary = await fixer.summarizeWorktree(job);
    job.finishedAt = Date.now();
    job.status = code === 0 ? 'done' : 'error';
    if (code !== 0) job.error = `${exitLabel(code, signal, FIX_TIMEOUT_MS)}: ${getErr().slice(-300)}`;
    const s = job.summary;
    const md = [
      `<!-- ${new Date().toISOString()} -->`, `# 修正係の報告 (${model})`, '',
      `- 対象: ${job.repo}`, `- ブランチ: ${job.branch}(元 ${job.base.slice(0, 7)})`, `- 作業場所: ${job.wt}`, '',
      result || '(報告なし)', '', '## コミット', '```', s.log || '(なし)', '```',
      '## 変更ファイル', '```', s.stat || '(なし)', '```',
      ...(s.status ? ['## 未コミットの変更', '```', s.status, '```'] : []),
      ...(job.error ? ['## エラー', job.error] : []), '',
    ].join('\n');
    const file = path.join(job.runDir, 'Fixer.md');
    fs.writeFileSync(file, md);
    pane.reportPath = file;
    setStatus(pane, job.status);
    if (job.error) addLine(pane, 'err', job.error);
    broadcastFix();
    const n = s.log ? s.log.split('\n').filter(Boolean).length : 0;
    dialog('agent-canvas: 修正係が終わりました',
      job.status === 'done' ? `${path.basename(job.repo)} に ${n} 件のコミットを作りました(未push)。内容を確認してください。` : '修正係が途中で止まりました。キャンバスで内容を確認してください。');
  });
  return publicFix();
}

// ------------------------------------------------------------ run history
function readRun(id) {
  const dir = path.join(RUNS_DIR, id);
  if (!isDir(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch { /* 記録導入前の実行 */ }
  if (!files.length && !meta) return null;
  // run.json が無い古い実行はモックの出力かどうかを本文から判定
  const mock = meta ? !!meta.mock
    : files.some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('(モック)'));
  if (meta && (typeof meta.agents !== 'object' || meta.agents === null)) meta.agents = {};
  const agents = meta ? Object.entries(meta.agents).filter(([, a]) => a && Array.isArray(a.turns)).map(([name, a]) => ({
    name, role: a.role, model: a.model, focus: a.focus,
    costUsd: a.turns.some((t) => t.costUsd != null) ? agentCost(a) : null,
    costPartial: a.turns.some((t) => t.costUsd == null),
    durationMs: a.turns.reduce((n, t) => n + (t.durationMs || 0), 0),
    turns: a.turns.length,
    tokens: a.turns.reduce((n, t) => {
      for (const k of Object.keys(n)) n[k] += (t.tokens && t.tokens[k]) || 0;
      return n;
    }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  })) : [];
  const known = agents.filter((a) => a.costUsd != null);
  // 実行全体の所要時間 = 最初のターンの開始〜最後のターンの終了(ワーカーは並列なので合計しない)
  let start = Infinity; let end = -Infinity;
  if (meta) {
    for (const a of Object.values(meta.agents)) {
      for (const t of (a && Array.isArray(a.turns) ? a.turns : [])) {
        const at = Date.parse(t && t.at);
        if (!Number.isFinite(at)) continue;
        end = Math.max(end, at);
        start = Math.min(start, at - (Number(t.durationMs) || 0));
      }
    }
  }
  const elapsedMs = Number.isFinite(start) && end > start ? end - start : null;
  return {
    id, target: meta ? meta.target : null, note: meta ? meta.note || null : null, mock, files, agents, elapsedMs,
    costUsd: known.length ? known.reduce((n, a) => n + a.costUsd, 0) : null,
    costPartial: !meta || agents.some((a) => a.costUsd == null || a.costPartial),
  };
}
function listRuns() {
  if (!isDir(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(d))
    .sort().reverse().map(readRun).filter(Boolean)
    .map(({ id, target, mock, files, costUsd, costPartial, note }) => ({ id, target, mock, files, costUsd, costPartial, note }));
}

function busyReason() {
  if (orchBusy || orchQueue.length) return 'Forest が実行中です';
  if (runningWorkers().length) return 'ワーカーが実行中です';
  if (pendingReview) return '統合レビュー待ちです';
  if (fix.job && fix.job.status === 'running') return '修正係が実行中です';
  return null;
}

function selectTarget(abs) {
  const why = busyReason();
  if (why) { const e = new Error(`${why}。完了後に切り替えてください`); e.status = 409; throw e; }
  currentTarget = abs;
  targets.active = abs;
  saveTargets();
  // 前の対象の文脈を引きずらないよう、Forest のセッションとキャンバスを作り直す
  orchSessionStarted = false;
  panes.clear();
  fix = { proposal: null, job: null };
  round = null;
  newRunDir();
  broadcast({ t: 'reset', target: currentTarget, targets: publicTargets(), run: currentRunSummary() });
}

// ------------------------------------------------------------------ http
// 他サイトのページからの操作(CSRF/WebSocket乗っ取り)と DNS rebinding を防ぐ:
// Host は自分宛て、Origin は(ブラウザが付けた場合)このキャンバス自身のみ許可。
// canvasctl など非ブラウザのクライアントは Origin を付けないので通る。
const OK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', HOST]);
function sameOriginRequest(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
  if (!OK_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.protocol === 'http:' && OK_HOSTS.has(o.hostname) && Number(o.port || 80) === PORT;
  } catch { return false; }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 時間切れの SIGKILL では code が null になり「コード null」と出ていた
function exitLabel(code, signal, timeoutMs = JOB_TIMEOUT_MS) {
  if (code !== null) return `異常終了 (コード ${code})`;
  if (signal === 'SIGKILL') return `強制終了 (${timeoutMs / 60000}分の時間切れ、または外部からの停止)`;
  return `強制終了 (${signal || '不明なシグナル'})`;
}

// 上限超え・切断でも必ず決着させる(以前は destroy 後に 'end' が来ず Promise が残り続けた)
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; b = ''; reject(e); } };
    req.on('data', (d) => {
      if (settled) return;
      b += d;
      if (b.length > 1e6) {
        const e = new Error('リクエストが大きすぎます');
        e.status = 413;
        fail(e);
        req.resume(); // 残りは読み捨てる(413 を返せるよう接続は切らない)
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); }
    });
    req.on('error', fail);
    req.on('close', () => fail(new Error('接続が切れました')));
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!sameOriginRequest(req)) return json(res, 403, { error: 'forbidden origin' });
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return json(res, 415, { error: 'Content-Type: application/json required' });
  }
  try {
    if (req.method === 'POST' && url.pathname === '/api/spawn') {
      const body = await readBody(req);
      if (!body.name || !body.focus) return json(res, 400, { error: 'name and focus required' });
      if (!validName(body.name)) return json(res, 400, { error: 'name must match [A-Za-z][A-Za-z0-9_-]{0,31}' });
      const pane = spawnWorker(body);
      return json(res, 200, { ok: true, name: pane.name, report: path.join(RUN_DIR, `${pane.name}.md`) });
    }
    if (req.method === 'POST' && url.pathname === '/api/inject') {
      // External orchestration (e.g. harness subagents standing in for
      // claude -p) mirrors progress/results onto the canvas without spawning
      // a CLI. Never arms pendingReview, so no real claude call is triggered.
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      if (!validName(body.name)) return json(res, 400, { error: 'name must match [A-Za-z][A-Za-z0-9_-]{0,31}' });
      let pane = panes.get(body.name);
      if (!pane) pane = createPane(body.name, body.role || 'Worker', body.model || 'haiku');
      if (body.focus) pane.focus = body.focus;
      for (const l of body.lines || []) addLine(pane, l.kind || 'text', String(l.text).slice(0, 400));
      if (typeof body.report === 'string') {
        const file = path.join(ensureRunDir(), `${pane.name}.md`);
        fs.writeFileSync(file, body.report);
        pane.reportPath = file;
      }
      if (body.status) setStatus(pane, body.status, body.focus ? { focus: body.focus } : undefined);
      return json(res, 200, { ok: true, report: pane.reportPath });
    }
    if (req.method === 'POST' && url.pathname === '/api/orchestrator') {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text required' });
      if (!busyReason()) round = { startedAt: Date.now(), workers: new Set(), finishedAt: null };
      runOrchestrator(body.text);
      return json(res, 200, { ok: true, queued: orchBusy });
    }
    if (url.pathname === '/api/fix' && req.method === 'GET') {
      return json(res, 200, publicFix());
    }
    if (url.pathname === '/api/fix' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await startFix({ ids: body.ids, model: body.model }));
    }
    if (url.pathname === '/api/fix/dismiss' && req.method === 'POST') {
      // 提案を閉じる / 終わった修正の結果表示を片付ける(worktree やブランチは消さない)
      if (fix.job && fix.job.status === 'running') return json(res, 409, { error: '修正係が実行中です' });
      fix = { proposal: null, job: null };
      broadcastFix();
      return json(res, 200, publicFix());
    }
    if (url.pathname === '/api/targets' && req.method === 'GET') {
      return json(res, 200, publicTargets());
    }
    if (url.pathname === '/api/targets' && req.method === 'POST') {
      const body = await readBody(req);
      const abs = normalizeTargetPath(body.path);
      const label = String(body.label || '').trim().slice(0, 60) || path.basename(abs);
      const hit = targets.items.find((t) => t.path === abs);
      if (hit) hit.label = label; else targets.items.push({ path: abs, label });
      saveTargets();
      broadcast({ t: 'targets', targets: publicTargets() });
      return json(res, 200, publicTargets());
    }
    if (url.pathname === '/api/targets' && req.method === 'DELETE') {
      const p = url.searchParams.get('path');
      targets.items = targets.items.filter((t) => t.path !== p);
      saveTargets();
      broadcast({ t: 'targets', targets: publicTargets() });
      return json(res, 200, publicTargets());
    }
    if (url.pathname === '/api/targets/scan' && req.method === 'GET') {
      return json(res, 200, scanTarget(normalizeTargetPath(url.searchParams.get('path'))));
    }
    if (url.pathname === '/api/targets/pick' && req.method === 'POST') {
      // Mac のフォルダ選択ダイアログを開き、選ばれた絶対パスを返すだけ(登録はしない)
      return json(res, 200, await pickFolder());
    }
    if (url.pathname === '/api/targets/select' && req.method === 'POST') {
      const body = await readBody(req);
      selectTarget(normalizeTargetPath(body.path));
      return json(res, 200, publicTargets());
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      return json(res, 200, { usdJpy: USD_JPY, current: path.basename(RUN_DIR), runs: listRuns() });
    }
    let m = url.pathname.match(/^\/api\/runs\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
    if (m && req.method === 'GET') {
      const r = readRun(m[1]);
      return r ? json(res, 200, r) : json(res, 404, { error: 'run not found' });
    }
    m = url.pathname.match(/^\/api\/runs\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\/([A-Za-z0-9_-]+\.md)$/);
    if (m && req.method === 'GET') {
      const file = path.join(RUNS_DIR, m[1], m[2]);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'report not found' });
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      return res.end(fs.readFileSync(file, 'utf8'));
    }
    if (url.pathname === '/api/panes') {
      return json(res, 200, [...panes.values()].map((p) => ({
        name: p.name, role: p.role, status: p.status, focus: p.focus || null,
        report: p.reportPath,
      })));
    }
    if (url.pathname.startsWith('/api/report/')) {
      const p = panes.get(decodeURIComponent(url.pathname.split('/').pop()));
      if (!p || !p.reportPath) return json(res, 404, { error: 'no report yet' });
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      return res.end(fs.readFileSync(p.reportPath, 'utf8'));
    }
    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.join(PUBLIC_DIR, path.normalize(file));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'text/plain'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(file));
  } catch (e) {
    return json(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: String(e.message || e) });
  }
});

const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => sameOriginRequest(req) });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({
    t: 'snapshot',
    target: currentTarget,
    targets: publicTargets(),
    run: currentRunSummary(),
    panes: [...panes.values()].map(publicPane),
    fix: publicFix(),
  }));
});

server.listen(PORT, HOST, () => {
  console.log(`agent-canvas ready on http://localhost:${PORT}`);
  console.log(`target: ${currentTarget}`);
  console.log(`runs:   ${RUN_DIR}`);
});
