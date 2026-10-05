#!/usr/bin/env node
'use strict';
// Mock claude CLI for pipeline testing (CANVAS_MOCK=1).
// Emits stream-json events like the real `claude -p --output-format stream-json`.
// The Forest emulation really calls canvasctl, so the orchestration machinery
// (spawn API, parallel jobs, report files, auto-review trigger) is exercised.

const { execFileSync } = require('child_process');

const prompt = process.argv[process.argv.length - 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));
const text = (t) => emit({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const tool = (name, input) => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const result = (r, s) => emit({ type: 'result', subtype: 'success', result: r, duration_ms: s * 1000, total_cost_usd: Number(process.env.CANVAS_MOCK_COST || 0), usage: { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 } });

async function main() {
  emit({ type: 'system', subtype: 'init', model: 'mock' });
  await sleep(600);

  if (prompt.includes('深掘り調査ワーカー')) {
    // ---- worker emulation
    const name = (prompt.match(/「(.+?)」/) || [])[1] || 'Worker';
    const focus = (prompt.match(/担当フォーカス: (.+)/) || [])[1] || 'general';
    tool('Glob', { pattern: 'src/**/*.js' });
    await sleep(1200);
    tool('Read', { file_path: 'src/server.js' });
    await sleep(1200);
    tool('Grep', { pattern: 'TODO|FIXME' });
    await sleep(1200);
    text('主要ファイルの読み込みを完了。レポートを作成中…');
    await sleep(1500);
    result(`## ARCHITECTURE\n- (モック) src/server.js を中心とした構成 — 実モデル実行時に実レポートに置き換わります\n\n## FEATURES\n- (モック) ${name} が検出した機能一覧\n\n## QUALITY\n- (モック) 品質所見\n\n## BUGS\n- (モック) フォーカス「${focus}」の観点の指摘`, 6);
  } else if (prompt.includes('全ワーカーの調査が完了しました')) {
    // ---- Forest review turn
    const paths = [...prompt.matchAll(/: (\/\S+\.md)/g)].map((m) => m[1]);
    for (const p of paths.slice(0, 4)) { tool('Read', { file_path: p }); await sleep(500); }
    await sleep(800);
    const review = '# 統合レビュー (モック)\n\n■ 重複して指摘された事項: 4体のレポートを正常に読込・統合\n■ 食い違い: なし (モックデータ)\n■ 優先度TOP5: 実モデル実行時にここへ本物の統合レビューが出ます';
    const findings = prompt.includes('```json') ? '\n\n```json\n' + JSON.stringify({ findings: [
      { id: 1, title: '(モック) 入力値の検証が無い', files: ['src/app.js:10'], detail: '数値でない入力がそのまま計算に使われる。受け取った直後に検証する。' },
      { id: 2, title: '(モック) 例外で処理全体が止まる', files: ['src/batch.js:42'], detail: '1件の失敗でループ全体が止まる。1件ずつ例外を分離する。' },
      { id: 3, title: '(モック) 設定値の直書き', files: ['src/config.js:3'], detail: '絶対パスが直書きされている。設定に集約する。' },
    ] }) + '\n```' : '';
    text(review);
    await sleep(400);
    result(review + findings, 4);
  } else if (prompt.includes('コードレビュー指摘の修正係')) {
    // ---- Fixer emulation: cwd is the git worktree. Make one trivial commit.
    const fs = require('fs');
    tool('Read', { file_path: 'README.md' });
    await sleep(800);
    text('指摘1を検証しました。実際に検証が無いため修正します。指摘2・3は誤指摘と判定。');
    tool('Edit', { file_path: 'MOCK_FIX.md' });
    fs.writeFileSync('MOCK_FIX.md', '(モック) 修正係が作ったファイル\n');
    // コミットは本物と同じくサーバー側が行う
    await sleep(800);
    let pushBlocked = 'push 遮断: 未確認';
    try { execFileSync('git', ['push', '--dry-run', 'origin', 'HEAD'], { stdio: 'pipe' }); pushBlocked = 'push 遮断: 失敗(pushできてしまった)'; } catch { pushBlocked = 'push 遮断: 有効'; }
    result(`### 判定\n| # | 指摘 | 判定 | 理由 |\n|---|---|---|---|\n| 1 | 入力値の検証 | 修正 | (モック) |\n| 2 | 例外で停止 | 誤指摘 | (モック) |\n\n### 追加で見つけた問題\nなし\n\n### テスト結果\n(モック) 実行なし\n\n### 未確認のこと\n${pushBlocked}`, 5);
  } else {
    // ---- Forest first turn: actually spawn 4 workers via canvasctl
    text('CNVSキャンバスの状態を確認し、ワーカー4体をスポーンします。');
    await sleep(800);
    const roster = [
      ['Oak', 'architecture'], ['Cedar', 'features'],
      ['Pine', 'quality'], ['Maple', 'bugs'],
    ];
    for (const [name, focus] of roster) {
      tool('Bash', { command: `canvasctl spawn --name ${name} --focus ${focus}` });
      execFileSync('canvasctl', ['spawn', '--name', name, '--focus', focus], { stdio: 'pipe' });
      await sleep(400);
    }
    result('4体のワーカー (Oak/Cedar/Pine/Maple) をスポーンしました。完了したら統合レビューを行います。', 3);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
