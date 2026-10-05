'use strict';

// Mac 標準のフォルダ選択ダイアログを osascript で開き、選ばれたフォルダの絶対パスを返す。
// ブラウザの <input type=file> は絶対パスを返さないため、サーバー側で開く。
// AppleScript は固定文字列のみ(ユーザー入力は一切埋め込まない)。
// `activate` は osascript 自身を前面に出すだけなので、Automation 権限の確認は出ない
// (System Events や他アプリへの tell は使わない)。
const { execFile } = require('child_process');

const PICK_SCRIPT = [
  'activate',
  'POSIX path of (choose folder with prompt "調べるフォルダを選んでください")',
].join('\n');
const PICK_TIMEOUT_MS = 5 * 60 * 1000;

let picking = false;

function pickerError(status, message) { const e = new Error(message); e.status = status; return e; }

// 戻り値: { path } / { cancelled: true }。失敗時は status 付きの Error を投げる。
// execFileImpl は単体確認用の差し替え口(ダイアログを出さずに分岐を確かめる)。
function pickFolder({ platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'darwin') {
    return Promise.reject(pickerError(501, 'フォルダ選択はmacOSでのみ使えます。パスを直接入力してください'));
  }
  if (picking) return Promise.reject(pickerError(409, 'フォルダ選択のダイアログがすでに開いています'));
  picking = true;
  return new Promise((resolve, reject) => {
    execFileImpl('osascript', ['-e', PICK_SCRIPT],
      { timeout: PICK_TIMEOUT_MS, killSignal: 'SIGTERM', encoding: 'utf8' },
      (err, stdout, stderr) => {
        picking = false;
        if (err) {
          if (/\(-128\)/.test(String(stderr || '')) || /-128/.test(String(err.message || ''))) {
            return resolve({ cancelled: true });
          }
          if (err.killed) return reject(pickerError(504, 'フォルダ選択が時間切れになりました(5分)'));
          return reject(pickerError(500, `フォルダ選択に失敗しました: ${String(stderr || err.message).trim().slice(0, 200)}`));
        }
        let p = String(stdout || '').replace(/\r?\n$/, '');
        if (p.length > 1) p = p.replace(/\/+$/, '');
        if (!p.startsWith('/')) return reject(pickerError(500, 'フォルダ選択の結果を読み取れませんでした'));
        return resolve({ path: p });
      });
  });
}

module.exports = { pickFolder, PICK_SCRIPT, canPick: process.platform === 'darwin' };
