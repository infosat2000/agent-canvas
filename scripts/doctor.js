#!/usr/bin/env node
'use strict';
// セットアップ診断: agent-canvas が動く環境かをチェックする。
//   node scripts/doctor.js          — 環境チェックのみ (無料)
//   node scripts/doctor.js --probe  — claude CLI の実疎通も確認 (haiku 1回・数円未満)

const { spawnSync } = require('child_process');
const path = require('path');

let failures = 0;
function check(label, ok, remedy) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    failures++;
    if (remedy) console.log(`    → ${remedy}`);
  }
}

// 1. Node.js バージョン (fetch 内蔵の v18+ が必要)
const major = Number(process.versions.node.split('.')[0]);
check(`Node.js v${process.versions.node} (v18以上)`, major >= 18,
  'https://nodejs.org/ から Node.js 18 以上をインストールしてください');

// 2. 依存パッケージ (ws)
let wsOk = true;
try { require.resolve('ws'); } catch { wsOk = false; }
check('依存パッケージ ws', wsOk, 'このディレクトリで `npm install` を実行してください');

// 3. claude CLI の存在
const PATH = `${process.env.HOME}/.local/bin:${process.env.PATH || ''}`;
const ver = spawnSync('claude', ['--version'], { env: { ...process.env, PATH }, encoding: 'utf-8' });
const cliOk = ver.status === 0;
check(`claude CLI ${cliOk ? `(${ver.stdout.trim()})` : ''}`, cliOk,
  'Claude Code をインストールしてください: https://claude.com/claude-code');

// 4. CLI の実疎通 (--probe 指定時のみ。haiku 1回分の費用がかかる)
if (process.argv.includes('--probe')) {
  if (!cliOk) {
    check('claude -p 疎通', false, 'まず claude CLI をインストールしてください');
  } else {
    console.log('  (claude -p を1回実行して疎通確認中… 最大60秒)');
    const env = { ...process.env, PATH };
    // サブスクログインで動かす想定なので、APIキー系の環境変数は外して確認する
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const probe = spawnSync('claude',
      ['-p', '--setting-sources', '', '--model', 'haiku', 'reply with exactly: OK'],
      { env, encoding: 'utf-8', timeout: 60000 });
    const out = `${probe.stdout || ''}${probe.stderr || ''}`;
    if (probe.status === 0 && out.includes('OK')) {
      check('claude -p 疎通 (haiku)', true);
    } else if (out.includes('Credit balance is too low')) {
      check('claude -p 疎通', false,
        'CLI のログイン先が残高不足の Console(API課金) アカウントです。ターミナルで `claude` → `/login` を実行し、「Claude account with subscription」(サブスクリプション側) を選び直してください');
    } else if (/log ?in|authenticat/i.test(out)) {
      check('claude -p 疎通', false,
        '未ログインです。ターミナルで `claude` → `/login` を実行してください');
    } else {
      check('claude -p 疎通', false,
        `想定外の応答でした: ${out.trim().slice(-200)}`);
    }
  }
} else {
  console.log('ℹ claude CLI の実疎通確認は `node scripts/doctor.js --probe` (haiku 1回・数円未満)');
}

console.log('');
if (failures === 0) {
  console.log('環境チェック OK — `node server.js` で起動できます (お試しは CANVAS_MOCK=1 で無料)');
} else {
  console.log(`${failures} 件の問題があります。上記の → を対応してから再実行してください。`);
  process.exitCode = 1;
}
