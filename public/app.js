'use strict';

const world = document.getElementById('world');
const viewport = document.getElementById('viewport');
const zoomLabel = document.getElementById('zoom-label');
const promptInput = document.getElementById('prompt');
const targetLabel = document.getElementById('target-label');
const toast = document.getElementById('toast');

// ------------------------------------------------------------- pan / zoom
let view = { x: 24, y: 24, scale: 1 };
function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
}
applyView();

viewport.addEventListener('mousedown', (e) => {
  if (e.target !== viewport && e.target !== world) return;
  viewport.classList.add('panning');
  const start = { x: e.clientX - view.x, y: e.clientY - view.y };
  const move = (ev) => { userViewed = true; view.x = ev.clientX - start.x; view.y = ev.clientY - start.y; applyView(); };
  const up = () => {
    viewport.classList.remove('panning');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

function zoomBy(f) { if (!paneEls.size) return; userViewed = true; view.scale = Math.min(2, Math.max(0.3, view.scale * f)); applyView(); }
// +/− ボタンは 100% を通る決まった段階を上下する(掛け算だと 86%→99%→114% と半端になり 100% に戻れない)
const ZOOM_STEPS = [0.3, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
// 全ペインを囲む範囲(キャンバス上の座標)
function paneBounds() {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const { el } of paneEls.values()) {
    const x = parseFloat(el.style.left); const y = parseFloat(el.style.top);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + el.offsetWidth); maxY = Math.max(maxY, y + el.offsetHeight);
  }
  return { minX, minY, maxX, maxY };
}
// 横幅が画面に収まる倍率なら左右の中央に置く(左に寄って右が空くのを防ぐ)
function centerIfFits(b) {
  const w = (b.maxX - b.minX) * view.scale;
  if (w <= viewport.clientWidth - 48) view.x = (viewport.clientWidth - w) / 2 - b.minX * view.scale;
}
// 倍率を変える。基準はペイン全体の左上(画面の中央を基準にすると、左寄せの全体表示から拡大したとき左が切れた)。
// reset のときは起動直後と同じ、左上をそろえた表示にする
function zoomTo(scale, reset = false) {
  if (!paneEls.size) return;
  userViewed = true;
  const b = paneBounds();
  const sx = reset ? 24 : view.x + b.minX * view.scale;
  const sy = reset ? 24 : view.y + b.minY * view.scale;
  view.scale = scale;
  view.x = sx - b.minX * scale;
  view.y = sy - b.minY * scale;
  centerIfFits(b);
  applyView();
}
function zoomStep(dir) {
  // 今の倍率とほぼ同じ段階(差3%未満。例: 全体表示の66%から67%)は飛ばす。押しても変わらないように見えるため
  const cur = view.scale;
  const next = dir > 0 ? ZOOM_STEPS.find((v) => v > cur * 1.03) : [...ZOOM_STEPS].reverse().find((v) => v < cur / 1.03);
  if (next !== undefined) zoomTo(next);
}
document.getElementById('zoom-in').onclick = () => zoomStep(1);
document.getElementById('zoom-out').onclick = () => zoomStep(-1);
zoomLabel.onclick = () => zoomTo(1, true);
viewport.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08);
    return;
  }
  // ペインのログ上ではログをスクロール、それ以外ではキャンバスを上下左右に移動
  const body = e.target.closest && e.target.closest('.pane .body');
  if (body && body.scrollHeight > body.clientHeight) return;
  e.preventDefault();
  userViewed = true;
  view.x -= e.deltaX;
  view.y -= e.deltaY;
  applyView();
}, { passive: false });

// 全ペインが画面に収まる倍率と位置にする
function fitAll() {
  if (!paneEls.size) return;
  const b = paneBounds();
  const { minX, minY, maxX, maxY } = b;
  const availW = viewport.clientWidth - 48;
  const availH = viewport.clientHeight - 24 - bottomReserve(); // 下部バーの分を空ける
  view.scale = Math.max(0.3, Math.min(1, availW / (maxX - minX), availH / (maxY - minY)));
  view.x = 24 - minX * view.scale;
  view.y = 24 - minY * view.scale;
  centerIfFits(b);
  applyView();
}
document.getElementById('zoom-fit').onclick = fitAll;

// --------------------------------------------------------------- layout
// 1画面に5枚(Forest+4体)が収まるよう、画面の幅と高さからペインの大きさを決める。
//   広い(>=1100px): 左に縦長の Forest、右にワーカーを2列
//   中(>=700px)   : 上に横長の Forest、下にワーカーを2列
// 修正係(Fixer)はワーカーではなく Forest と同じ幅の枠に置く(広い画面では左の列を上下に分ける)
//   狭い          : 1列に縦積み(ホイールで上下に移動)
// 手でドラッグしたペインは位置を保つ。
const ORDER = ['Forest', 'Fixer', 'Oak', 'Cedar', 'Pine', 'Maple'];
const LEADS = ['Forest', 'Fixer'];
const GAP = 16;
const MARGIN = 24;
const MIN_H = 220;
function bottomReserve() {
  const c = document.getElementById('composer');
  const top = c ? c.getBoundingClientRect().top : window.innerHeight - 70;
  return Math.max(70, window.innerHeight - top + 12);
}
function layoutPanes() {
  const w = viewport.clientWidth - MARGIN * 2;
  const availH = Math.max(MIN_H, viewport.clientHeight - MARGIN - bottomReserve());
  const names = [...paneEls.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const leads = LEADS.filter((n) => names.includes(n));
  const lead = leads.length ? leads[0] : null;
  const workers = names.filter((n) => !leads.includes(n));
  const place = (name, x, y, pw, ph) => {
    const e = paneEls.get(name);
    e.layoutH = ph;
    e.layoutTop = y;
    if (e.el.dataset.moved) return;
    e.el.style.left = `${x}px`;
    e.el.style.width = `${pw}px`;
    sizePane(e);
  };
  if (w >= 1100 - MARGIN * 2) {
    const leadW = lead ? Math.round(Math.min(640, (w - GAP) * 0.42)) : 0;
    const restX = lead ? leadW + GAP : 0;
    const cols = workers.length > 1 ? 2 : 1;
    const ww = Math.floor((w - restX - (cols - 1) * GAP) / cols);
    const rows = Math.max(1, Math.ceil(workers.length / cols));
    const wh = Math.max(MIN_H, Math.floor((availH - (rows - 1) * GAP) / rows));
    if (lead) {
      const lh = Math.floor((Math.max(availH, wh) - (leads.length - 1) * GAP) / leads.length);
      leads.forEach((n, i) => place(n, 0, i * (lh + GAP), leadW, lh));
    }
    workers.forEach((n, i) => place(n, restX + (i % cols) * (ww + GAP), Math.floor(i / cols) * (wh + GAP), ww, wh));
  } else if (w >= 700 - MARGIN * 2) {
    const rows = leads.length + Math.ceil(workers.length / 2);
    const ph = Math.max(MIN_H, Math.floor((availH - (rows - 1) * GAP) / Math.max(1, rows)));
    const ww = Math.floor((w - GAP) / 2);
    let y = 0;
    leads.forEach((n) => { place(n, 0, y, w, ph); y += ph + GAP; });
    workers.forEach((n, i) => place(n, (i % 2) * (ww + GAP), y + Math.floor(i / 2) * (ph + GAP), ww, ph));
  } else {
    const ph = Math.max(MIN_H, Math.min(360, availH));
    names.forEach((n, i) => place(n, 0, i * (ph + GAP), Math.max(260, w), ph));
  }
}
// 全文表示中は画面の高さいっぱいに広げる。下の段のペインは上に向かって伸ばす(画面外にはみ出さないように)
function sizePane(e) {
  const h = e.layoutH || 400;
  const top = e.layoutTop || 0;
  if (e.expanded) {
    const H = Math.max(h, expandedH());
    e.el.style.height = `${H}px`;
    if (!e.el.dataset.moved) e.el.style.top = `${Math.max(0, Math.min(top, top + h - H))}px`;
  } else {
    e.el.style.height = `${h}px`;
    if (!e.el.dataset.moved) e.el.style.top = `${top}px`;
  }
}
function expandedH() { return Math.max(MIN_H, (viewport.clientHeight - MARGIN - bottomReserve()) / view.scale); }
// 自動配置で画面に収まらないとき(背の低い窓など)だけ縮小して全体を見せる。手でズーム・移動した後は触らない
let userViewed = false;
function fitIfOverflow() {
  if (userViewed || !paneEls.size) return;
  view = { x: MARGIN, y: MARGIN, scale: 1 };
  applyView();
  const limit = viewport.clientHeight - bottomReserve();
  const over = [...paneEls.values()].some(({ el }) => {
    const r = el.getBoundingClientRect();
    return r.bottom > limit + 1 || r.right > viewport.clientWidth + 1;
  });
  if (over && viewport.clientWidth >= 700) fitAll();
}
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { userViewed = false; layoutPanes(); fitIfOverflow(); }, 150);
});

// ---------------------------------------------------------------- panes
const paneEls = new Map(); // name -> {el, body}

// ペインが0枚のときはズーム操作を無効化(背景は拡大縮小されず数字だけ変わって紛らわしいため)
const zoomBtns = ['zoom-fit', 'zoom-out', 'zoom-label', 'zoom-in'].map((id) => document.getElementById(id));
for (const b of zoomBtns) b.dataset.title = b.title;
function updateZoomEnabled() {
  const empty = paneEls.size === 0;
  for (const b of zoomBtns) {
    b.disabled = empty;
    b.title = empty ? 'エージェントのペインが表示されると使えます' : b.dataset.title;
  }
}
updateZoomEnabled();

// 担当(focus)の日本語説明。Forest が canvasctl spawn --focus で渡す英語の語を対応表で置き換える
const FOCUS_JA = {
  architecture: '構造担当：全体の構成・依存関係・データの流れを調べる',
  features: '機能担当：実装済みの機能を洗い出す',
  quality: '品質担当：コードの重複・読みやすさ・テストを調べる',
  bugs: 'バグ担当：不具合・境界ケース・セキュリティの穴を探す',
};
const LEAD_JA = '指揮役：観点を決めてワーカーに割り振り、最後に統合レビューを書く';
const FIXER_JA = '修正係：選ばれた指摘を、別の作業場所(git worktree)で直す';
const ROLE_JA = { Worker: 'ワーカー', Fixer: '修正係' };
function focusLabel(focus, role, name) {
  const f = String(focus || '').trim();
  if (role === 'Fixer') return f ? `修正係：${f}` : FIXER_JA;
  if (f) return FOCUS_JA[f.toLowerCase()] || `担当：${f}`;
  if (name === 'Forest' || (role && role !== 'Worker')) return LEAD_JA;
  return '';
}
function setPaneFocus(entry, focus) {
  if (focus !== undefined) entry.focus = focus || null;
  const line = entry.el.querySelector('.focus-line');
  const text = focusLabel(entry.focus, entry.role, entry.el.dataset.name);
  line.textContent = text;
  line.title = text + (entry.focus ? `（${entry.focus}）` : '');
  line.hidden = !text;
}

function ensurePane(p) {
  let entry = paneEls.get(p.name);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'pane';
    el.innerHTML = `
      <header>
        <span class="status-dot"></span>
        <span class="name"></span>
        <span class="role"></span>
        <span class="cost"></span>
        <button class="toggle" type="button" title="ログの全文を表示 / 最新の数行に戻す">全文 ▾</button>
      </header>
      <div class="focus-line" hidden></div>
      <div class="body"></div>`;
    el.querySelector('.name').textContent = p.name;
    el.dataset.name = p.name;
    world.appendChild(el);
    makeDraggable(el);
    entry = { el, body: el.querySelector('.body'), expanded: false };
    paneEls.set(p.name, entry);
    updateZoomEnabled();
    const btn = el.querySelector('.toggle');
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', () => setExpanded(p.name, !entry.expanded));
    // 畳んだ状態のログをクリックすると全文表示(文字を選択しただけのときは開かない)
    entry.body.addEventListener('click', () => {
      if (entry.expanded || String(window.getSelection() || '')) return;
      setExpanded(p.name, true);
    });
    layoutPanes();
  }
  entry.el.querySelector('.role').textContent = `${ROLE_JA[p.role] || '指揮役'} · ${p.model || ''}`;
  entry.role = p.role;
  setPaneFocus(entry, p.focus);
  setPaneStatus(entry, p.status || 'idle');
  if (typeof p.costUsd === 'number') setPaneCost(p.name, p.costUsd);
  return entry;
}

function setPaneStatus(entry, status) {
  entry.status = status;
  entry.el.className = `pane ${status}${entry.expanded ? ' expanded' : ' collapsed'}${LEADS.includes(entry.el.dataset.name) ? ' lead' : ''}`;
}

// 既定は最新の数行だけ表示(Forest は今のターン=統合レビューを丸ごと表示)。全文表示中は手前に出して高さを広げる
function setExpanded(name, on) {
  const entry = paneEls.get(name);
  if (!entry) return;
  entry.expanded = on;
  setPaneStatus(entry, entry.status || 'idle');
  entry.el.querySelector('.toggle').textContent = on ? '畳む ▴' : '全文 ▾';
  sizePane(entry);
  entry.el.style.zIndex = on ? '5' : '';
  entry.body.scrollTop = entry.body.scrollHeight;
}

function makeDraggable(el) {
  const header = el.querySelector('header');
  header.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const sx = e.clientX; const sy = e.clientY;
    const ox = parseFloat(el.style.left); const oy = parseFloat(el.style.top);
    const move = (ev) => {
      el.dataset.moved = '1';
      el.style.left = `${ox + (ev.clientX - sx) / view.scale}px`;
      el.style.top = `${oy + (ev.clientY - sy) / view.scale}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function addLine(name, kind, text) {
  const entry = paneEls.get(name);
  if (!entry) return;
  const div = document.createElement('div');
  div.className = `line ${kind}`;
  div.textContent = text;
  // Forest: 新しい指示が来たら、それ以前のターンの行を「過去」扱いにする(畳んだ表示では隠す)
  if (kind === 'user') for (const c of entry.body.children) c.classList.add('prev');
  entry.body.appendChild(div);
  if (entry.body.children.length > 800) entry.body.firstChild.remove();
  entry.body.scrollTop = entry.body.scrollHeight;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 2200);
}

// -------------------------------------------------------------- websocket
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'snapshot') {
      if (m.targets) renderTargets(m.targets);
      if (m.run) setRun(m.run);
      if ('fix' in m) applyFix(m.fix);
      for (const p of m.panes) {
        const entry = ensurePane(p);
        entry.body.innerHTML = '';
        for (const l of p.lines) addLine(p.name, l.kind, l.text);
      }
      fitIfOverflow();
    } else if (m.t === 'pane') {
      const entry = ensurePane(m.pane);
      entry.body.innerHTML = '';
      fitIfOverflow();
      showToast(`${m.pane.name} が作業を始めました`);
    } else if (m.t === 'targets') {
      renderTargets(m.targets);
    } else if (m.t === 'reset') {
      // 対象切替: 前の対象のペインを片付けて新しいキャンバスにする
      for (const { el } of paneEls.values()) el.remove();
      paneEls.clear();
      updateZoomEnabled();
      renderTargets(m.targets);
      if (m.run) setRun(m.run);
      applyFix(null); // サーバー側でも fix は空に戻る
      showToast(`対象を ${baseName(m.target)} に切り替えました`);
    } else if (m.t === 'cost') {
      setPaneCost(m.name, m.paneCostUsd);
      setRun(m.run);
    } else if (m.t === 'line') {
      addLine(m.name, m.kind, m.text);
    } else if (m.t === 'status') {
      const entry = paneEls.get(m.name);
      if (entry) {
        setPaneStatus(entry, m.status);
        if (m.meta && m.meta.focus) setPaneFocus(entry, m.meta.focus);
      }
      renderProgress();
    } else if (m.t === 'run') {
      setRun(m.run);
    } else if (m.t === 'fix') {
      applyFix(m.fix);
    }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
connect();

// --------------------------------------------------------------- composer
promptInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !promptInput.value.trim()) return;
  const text = promptInput.value.trim();
  promptInput.value = '';
  showToast('Forest に送信しました');
  await fetch('/api/orchestrator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
});

// ---------------------------------------------------------------- targets
const panel = document.getElementById('targets-panel');
const list = document.getElementById('targets-list');
const form = document.getElementById('targets-form');
const pathInput = document.getElementById('target-path');
const nameInput = document.getElementById('target-name');
const msg = document.getElementById('targets-msg');
const pickBtn = document.getElementById('target-pick');

function baseName(p) { return String(p).split('/').filter(Boolean).pop() || p; }
// isErr: true=エラー(赤) / 'warn'=注意(黄)
function setMsg(text, isErr) { msg.textContent = text || ''; msg.className = isErr === 'warn' ? 'warn' : isErr ? 'err' : ''; }

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return data;
}

function renderTargets(t) {
  targetLabels = Object.fromEntries(t.items.map((i) => [i.path, i.label]));
  pickBtn.hidden = !t.canPick;
  const cur = t.items.find((i) => i.path === t.current);
  const warn = t.scan && t.scan.warning;
  targetLabel.textContent = `${warn ? '⚠ ' : ''}対象: ${cur ? cur.label : baseName(t.current)} ▾`;
  targetLabel.title = warn || '調べる対象を選ぶ・登録する';
  list.innerHTML = '';
  const items = cur ? t.items : [{ path: t.current, label: baseName(t.current), exists: true, unsaved: true }, ...t.items];
  for (const it of items) {
    const li = document.createElement('li');
    if (it.path === t.current) li.className = 'current';
    if (!it.exists) li.classList.add('missing');
    li.innerHTML = '<div class="meta"><span class="label"></span><span class="path"></span></div>';
    li.querySelector('.label').textContent = it.label + (it.unsaved ? '(未登録)' : '');
    li.querySelector('.path').textContent = it.exists ? it.path : `${it.path}(見つかりません)`;
    if (it.path === t.current && warn) {
      const w = document.createElement('span');
      w.className = 'scan-warn';
      w.textContent = `⚠ ${warn}`;
      li.querySelector('.meta').appendChild(w);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (it.path === t.current) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '使用中';
      actions.appendChild(badge);
    } else if (it.exists) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'この対象にする';
      b.onclick = async () => {
        // 切替直後は別の対象のボタンがカーソル下に来るので、二度押しで戻らないよう閉じる
        b.disabled = true;
        try { await api('POST', '/api/targets/select', { path: it.path }); setMsg(''); panel.hidden = true; }
        catch (e) { setMsg(e.message, true); b.disabled = false; }
      };
      actions.appendChild(b);
    }
    if (!it.unsaved) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.title = '登録から外す(フォルダは消えません)';
      del.textContent = '×';
      del.onclick = async () => {
        try { await api('DELETE', `/api/targets?path=${encodeURIComponent(it.path)}`); setMsg(''); }
        catch (e) { setMsg(e.message, true); }
      };
      actions.appendChild(del);
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '登録';
      add.onclick = async () => {
        try { await api('POST', '/api/targets', { path: it.path }); setMsg(''); }
        catch (e) { setMsg(e.message, true); }
      };
      actions.appendChild(add);
    }
    li.appendChild(actions);
    list.appendChild(li);
  }
}

targetLabel.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) pathInput.focus(); };
document.getElementById('targets-close').onclick = () => { panel.hidden = true; };
pickBtn.onclick = async () => {
  // Mac のフォルダ選択画面はサーバー側で開く。パスを欄に入れるだけで、登録はユーザーが押す
  pickBtn.disabled = true;
  pickBtn.textContent = '選択中…';
  setMsg('');
  try {
    const r = await api('POST', '/api/targets/pick', {});
    if (r.path) {
      pathInput.value = r.path;
      nameInput.placeholder = `表示名(省略時は ${baseName(r.path)})`;
      pathInput.focus();
      // 選んだフォルダが「コードが少ない／重い」なら、登録前に知らせる
      try {
        const sc = await api('GET', `/api/targets/scan?path=${encodeURIComponent(r.path)}`);
        if (sc.warning) setMsg(`⚠ ${sc.warning}`, 'warn');
      } catch { /* 数えられなくても登録はできる */ }
    }
  } catch (err) { setMsg(err.message, true); }
  finally { pickBtn.disabled = false; pickBtn.textContent = 'フォルダを選ぶ…'; }
};
pathInput.addEventListener('input', () => { nameInput.placeholder = '表示名(省略時はフォルダ名)'; });
const addBtn = document.getElementById('target-add');
const addSelectBtn = document.getElementById('target-add-select');
let formBusy = false;
function setFormBusy(on) { formBusy = on; addBtn.disabled = on; addSelectBtn.disabled = on; }
function clearForm() {
  pathInput.value = '';
  nameInput.value = '';
  nameInput.placeholder = '表示名(省略時はフォルダ名)';
}
// 「登録」は一覧に加えるだけ。「登録して、この対象にする」(Enter もこちら)は続けて切り替える
async function submitTarget(andSelect) {
  if (formBusy) return;
  if (!pathInput.value.trim()) { setMsg('フォルダの絶対パスを入力してください', true); pathInput.focus(); return; }
  setFormBusy(true);
  setMsg('');
  const p = pathInput.value;
  try {
    try { await api('POST', '/api/targets', { path: p, label: nameInput.value }); }
    catch (err) { setMsg(`登録できませんでした: ${err.message}`, true); return; }
    clearForm();
    if (!andSelect) { setMsg('登録しました'); return; }
    try {
      await api('POST', '/api/targets/select', { path: p });
      setMsg('');
      panel.hidden = true;
    } catch (err) {
      if (err.status === 409) setMsg('登録しました。実行中のため、完了後に一覧の「この対象にする」で切り替えてください', true);
      else setMsg(`登録しましたが、切り替えできませんでした: ${err.message}`, true);
    }
  } finally { setFormBusy(false); }
}
form.addEventListener('submit', (e) => { e.preventDefault(); submitTarget(true); });
addBtn.onclick = () => submitTarget(false);

// ------------------------------------------------------------------ cost
// 費用は claude CLI が返す total_cost_usd(API従量課金に換算した額)。
// サブスクリプションでログインしている場合、実際の請求はプラン枠内で、この額がそのまま請求されるわけではない。
const costChip = document.getElementById('cost-chip');
const rateInput = document.getElementById('usd-jpy');
let serverRate = 150;
let liveRun = { costUsd: 0 };
function usdJpy() {
  let v = null;
  try { v = Number(localStorage.getItem('ac.usdJpy')); } catch { /* storage不可 */ }
  return v > 0 ? v : serverRate;
}
function fmtUsd(v) { return v == null ? '—' : `$${v.toFixed(v < 1 ? 3 : 2)}`; }
function fmtJpy(v) { return v == null ? '—' : `¥${Math.round(v * usdJpy()).toLocaleString('ja-JP')}`; }
function fmtCost(v) { return v == null ? '記録なし' : `${fmtUsd(v)}(約${fmtJpy(v)})`; }

function setRun(run) {
  if (run.usdJpy) serverRate = run.usdJpy;
  liveRun = run;
  costChip.textContent = `今回 ${fmtUsd(run.costUsd)} ≒ ${fmtJpy(run.costUsd)}`;
  if (!rateInput.value) rateInput.value = usdJpy();
  renderProgress();
}

// ---------------------------------------------------------------- progress
// 下部バーの1行進捗。経過は画面から Forest へ指示を送った時刻から(サーバーの時計で数える)
const progressEl = document.getElementById('progress');
let progressTimer = null;
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function renderProgress() {
  const r = liveRun && liveRun.round;
  const wasHidden = progressEl.hidden;
  progressEl.hidden = !r;
  if (wasHidden !== progressEl.hidden) layoutPanes(); // 狭い画面では進捗行の分だけ下部バーが高くなる
  if (!r) { clearInterval(progressTimer); progressTimer = null; return; }
  const finished = r.finishedAt != null;
  const forest = paneEls.get('Forest');
  const forestRunning = forest && forest.status === 'running';
  const bits = [];
  if (r.workersTotal) {
    let w = `ワーカー ${r.workersDone + r.workersError}/${r.workersTotal} 完了`;
    if (r.workersError) w += `(エラー ${r.workersError})`;
    bits.push(w);
  }
  if (finished) bits.unshift('完了');
  else if (forestRunning) bits.push(r.workersTotal && r.workersDone + r.workersError === r.workersTotal ? '統合レビュー中' : 'Forest 作業中');
  const end = finished ? r.finishedAt : Date.now();
  bits.push(`${finished ? '所要' : '経過'} ${fmtClock(end - r.startedAt)}`);
  progressEl.textContent = bits.join(' · ');
  progressEl.classList.toggle('idle', finished);
  if (finished) { clearInterval(progressTimer); progressTimer = null; }
  else if (!progressTimer) progressTimer = setInterval(renderProgress, 1000);
}
function setPaneCost(name, usd) {
  const entry = paneEls.get(name);
  if (!entry) return;
  entry.costUsd = usd;
  entry.el.querySelector('.cost').textContent = usd ? `${fmtUsd(usd)} ≒ ${fmtJpy(usd)}` : '';
}
rateInput.addEventListener('change', () => {
  const v = Number(rateInput.value);
  if (!(v > 0)) return;
  try { localStorage.setItem('ac.usdJpy', String(v)); } catch { /* storage不可 */ }
  setRun(liveRun);
  for (const [name, e] of paneEls) if (e.costUsd) setPaneCost(name, e.costUsd);
  if (!historyPanel.hidden) loadHistory(selectedRun);
});

// --------------------------------------------------------------- history
const historyPanel = document.getElementById('history-panel');
const runsList = document.getElementById('runs-list');
const runDetail = document.getElementById('run-detail');
let selectedRun = null;
let targetLabels = {};

function runDate(id) {
  const [d, t] = id.split('T');
  const dt = new Date(`${d}T${t.replace(/-/g, ':')}Z`);
  return dt.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function targetName(p) { return p ? (targetLabels[p] || baseName(p)) : '対象不明'; }
function fmtDur(ms) { if (!ms) return '—'; const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`; }
function fmtTok(n) { return n ? n.toLocaleString('ja-JP') : '—'; }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

async function loadHistory(keep) {
  const data = await api('GET', '/api/runs');
  serverRate = data.usdJpy || serverRate;
  runsList.innerHTML = '';
  const real = data.runs.filter((r) => !r.mock && r.costUsd != null);
  const total = real.reduce((n, r) => n + r.costUsd, 0);
  const sum = el('li', 'total');
  sum.append(el('span', 'k', '実モデル実行の累計'), el('span', 'v', fmtCost(total)));
  runsList.appendChild(sum);
  const showMock = document.getElementById('show-mock').checked;
  const visible = data.runs.filter((r) => showMock || !r.mock || r.id === data.current);
  if (!visible.length) runsList.appendChild(el('li', 'empty', 'まだ実モデルでの実行はありません'));
  for (const r of visible) {
    const li = el('li', 'run');
    li.dataset.id = r.id;
    if (r.id === keep) li.classList.add('sel');
    const top = el('div', 'row');
    top.append(el('span', 'when', runDate(r.id)), el('span', 'cost', r.mock ? '費用なし(モック)' : r.costUsd == null ? '費用記録なし' : `${fmtUsd(r.costUsd)} ≒ ${fmtJpy(r.costUsd)}${r.costPartial ? '+' : ''}`));
    const bottom = el('div', 'row sub');
    bottom.append(el('span', '', targetName(r.target)), el('span', '', `${r.files.length}件のレポート`));
    if (r.mock) bottom.append(el('span', 'tag', 'モック'));
    if (r.id === data.current) bottom.append(el('span', 'tag now', '現在のキャンバス'));
    li.append(top, bottom);
    li.onclick = () => showRun(r.id);
    runsList.appendChild(li);
  }
  if (keep) showRun(keep);
}

async function showRun(id) {
  selectedRun = id;
  for (const li of runsList.querySelectorAll('li.run')) li.classList.toggle('sel', li.dataset.id === id);
  const r = await api('GET', `/api/runs/${id}`);
  if (selectedRun !== id) return; // 読み込み中に別の実行を選んだ
  const reviewFile = r.files.find((f) => /^Forest\.md$/.test(f)) || r.files.find((f) => /^Chase\.md$/.test(f)) || null;
  const fetchMd = async (f) => (await fetch(`/api/runs/${id}/${encodeURIComponent(f)}`)).text();
  const reviewSrc = reviewFile ? await fetchMd(reviewFile).catch(() => '') : '';
  if (selectedRun !== id) return;
  runDetail.innerHTML = '';

  // 1行サマリー: 日時・対象・合計費用・所要時間
  const h = el('div', 'detail-head');
  const line = el('div', 'summary-line');
  line.append(
    el('span', 'when', runDate(r.id)),
    el('span', 'tgt', targetName(r.target)),
    el('span', 'money', r.mock ? '費用なし(モック)' : `合計 ${fmtCost(r.costUsd)}${r.costPartial && r.costUsd != null ? ' ※一部記録なし' : ''}`),
    el('span', 'dur', `所要 ${r.elapsedMs ? fmtDur(r.elapsedMs) : '記録なし'}`),
  );
  if (r.target) line.title = r.target;
  h.appendChild(line);
  if (r.note) h.append(el('p', 'note', r.note));
  if (r.mock) h.append(el('p', 'note', 'モックモードの実行です(モデルは呼んでいないため費用は0、レポートはダミー)。'));
  runDetail.appendChild(h);

  // 結論を先に: 統合レビューから「優先度TOP5」「次のアクション」を抜き出してカードで出す
  const review = reviewSrc ? splitReview(reviewSrc) : null;
  if (review && (review.top || review.actions)) {
    const cards = el('div', 'cards');
    for (const [sec, cls, fallback] of [[review.top, 'card-top', '優先度TOP5'], [review.actions, 'card-next', '次のアクション']]) {
      if (!sec) continue;
      const c = el('section', `card ${cls}`);
      c.append(el('h4', '', sec.title || fallback));
      const body = el('div', 'md');
      body.innerHTML = renderMarkdown(sec.body);
      c.appendChild(body);
      cards.appendChild(c);
    }
    runDetail.appendChild(cards);
  }

  // エージェント別の費用・トークンは既定で畳む
  if (r.agents.length) {
    const det = el('details', 'cost-breakdown');
    det.appendChild(el('summary', '', `費用の内訳(${r.agents.length}体)`));
    const table = el('table', 'agents');
    const head = el('tr');
    for (const c of ['エージェント', 'モデル', '担当', '時間', 'API費用', '円換算', '入力', '出力', 'キャッシュ読込']) head.appendChild(el('th', '', c));
    table.appendChild(head);
    for (const a of r.agents) {
      const tr = el('tr');
      const focusCell = el('td', 'focus-cell', focusLabel(a.focus, a.role, a.name));
      focusCell.title = a.focus || '';
      const cells = [a.name, a.model, focusCell, fmtDur(a.durationMs),
        fmtUsd(a.costUsd) + (a.costPartial && a.costUsd != null ? '+' : ''), fmtJpy(a.costUsd),
        fmtTok(a.tokens.input + a.tokens.cacheWrite), fmtTok(a.tokens.output), fmtTok(a.tokens.cacheRead)];
      for (const c of cells) tr.appendChild(c instanceof Node ? c : el('td', '', c));
      table.appendChild(tr);
    }
    const wrap = el('div', 'table-wrap');
    wrap.appendChild(table);
    det.appendChild(wrap);
    runDetail.appendChild(det);
  }

  if (r.files.length) {
    const tabs = el('div', 'tabs');
    const view = el('div', 'md');
    // 統合レビュー(Forest/Chase)を先頭に
    const order = [...r.files].sort((x, y) => (/^(Forest|Chase)\./.test(y) ? 1 : 0) - (/^(Forest|Chase)\./.test(x) ? 1 : 0));
    const open = async (f, btn) => {
      for (const b of tabs.children) b.classList.toggle('on', b === btn);
      if (f === reviewFile) { renderReviewInto(view, reviewSrc, review); return; }
      const text = await fetchMd(f);
      if (btn.classList.contains('on')) view.innerHTML = renderMarkdown(text);
    };
    for (const f of order) {
      const name = f.replace(/\.md$/, '');
      const label = f === reviewFile ? `${name}(統合レビュー${review && (review.top || review.actions) ? 'の続き' : ''})` : name;
      const b = el('button', '', label);
      b.type = 'button';
      b.onclick = () => open(f, b);
      tabs.appendChild(b);
    }
    runDetail.append(tabs, view);
    open(order[0], tabs.firstChild);
  }
}

// 統合レビューのタブ: カードに出した節を除いた残り。Forestへの指示文と途中のターンは畳む
function renderReviewInto(view, src, review) {
  view.innerHTML = '';
  if (!review || !(review.top || review.actions)) { view.innerHTML = renderMarkdown(src); return; } // 見出しが見つからない→全文
  const rest = el('div');
  rest.innerHTML = renderMarkdown(review.rest);
  view.appendChild(rest);
  if (review.folded.length) {
    const det = el('details', 'folded');
    det.appendChild(el('summary', '', `Forestへの指示と途中経過(${review.folded.length}件)`));
    for (const t of review.folded) {
      if (t.prompt) det.appendChild(el('blockquote', 'prompt', t.prompt));
      if (t.body.trim()) { const d = el('div'); d.innerHTML = renderMarkdown(t.body); det.appendChild(d); }
    }
    view.appendChild(det);
  }
}

// Forest.md を「ターン」に分け(各ターンは <!-- 時刻 --> と > 指示文 の2行で始まる)、
// 統合レビューのターンから見出しで節を切り出す。見出し名は緩く判定する。
const TOP_RE = /TOP\s*\d|優先度|priorit/i;
const NEXT_RE = /次の(アクション|一手|ステップ)|ネクスト\s*アクション|next\s*(action|step)|推奨アクション|今後の対応/i;
function splitReview(src) {
  const text = src.replace(/\r\n/g, '\n');
  const marker = /^<!--\s*\d{4}-\d{2}-\d{2}T[^>]*?-->\n>\s?(.*)$/gm;
  const turns = [];
  let last = 0; let prompt = null; let m;
  while ((m = marker.exec(text))) {
    turns.push({ prompt, body: text.slice(last, m.index) });
    prompt = m[1];
    last = m.index + m[0].length;
  }
  turns.push({ prompt, body: text.slice(last) });
  const real = turns.filter((t) => t.prompt != null || t.body.trim());
  if (!real.length) return null;
  const headings = (body) => body.split('\n').map(parseHeading).filter(Boolean);
  let idx = -1;
  for (let i = real.length - 1; i >= 0; i--) {
    if (headings(real[i].body).some((hd) => TOP_RE.test(hd.title) || NEXT_RE.test(hd.title))) { idx = i; break; }
  }
  if (idx < 0) return { top: null, actions: null };
  const target = real[idx];
  let lines = target.body.split('\n');
  const take = (re) => {
    const i = lines.findIndex((l) => { const hd = parseHeading(l); return hd && re.test(hd.title); });
    if (i < 0) return null;
    const lv = parseHeading(lines[i]).level;
    let j = i + 1;
    for (; j < lines.length; j++) { const hd = parseHeading(lines[j]); if (hd && hd.level <= lv) break; }
    const sec = { title: parseHeading(lines[i]).title, body: lines.slice(i + 1, j).join('\n') };
    lines = [...lines.slice(0, i), ...lines.slice(j)];
    return sec;
  };
  const actions = take(NEXT_RE); // 先に抜く(TOP5 の下にぶら下がっている場合に備えて)
  const top = take(TOP_RE);
  const folded = real.filter((t, i) => i !== idx);
  if (target.prompt) folded.push({ prompt: target.prompt, body: '' });
  return { top, actions, rest: lines.join('\n'), folded };
}
// "## 見出し" か、行全体が太字の "**見出し**" を見出しとみなす
function parseHeading(l) {
  let m = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (m) return { level: m[1].length, title: m[2].replace(/\*\*/g, '') };
  m = l.match(/^\*\*([^*]+)\*\*[:：]?\s*$/);
  if (m) return { level: 7, title: m[1] };
  return null;
}

// 依存なしの最小Markdown表示(見出し・表・リスト・引用・コード・強調)。必ず先にHTMLエスケープする
function renderMarkdown(src) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const lines = src.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`); i++; continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      let html = '<table>';
      rows.forEach((r, k) => {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(r)) return;
        const tag = k === 0 ? 'th' : 'td';
        html += `<tr>${cells(r).map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`;
      });
      out.push(`${html}</table>`); continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const startNo = ordered ? parseInt(l.trim(), 10) : 1;
      const items = [];
      for (; i < lines.length; i++) {
        const cur = lines[i];
        if (/^\s*([-*]|\d+\.)\s+/.test(cur)) items.push(cur.replace(/^\s*([-*]|\d+\.)\s+/, ''));
        // 字下げされた続きの行は直前の項目に含める(番号が 1. 1. 1. と振り直されないように)
        else if (/^\s{2,}\S/.test(cur) && items.length) items[items.length - 1] += `\n${cur.trim()}`;
        else break;
      }
      const t = ordered ? 'ol' : 'ul';
      const attr = ordered && startNo > 1 ? ` start="${startNo}"` : '';
      out.push(`<${t}${attr}>${items.map((x) => `<li>${x.split('\n').map(inline).join('<br>')}</li>`).join('')}</${t}>`); continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(l)) { out.push(`<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`); i++; continue; }
    if (!l.trim()) { i++; continue; }
    out.push(`<p>${inline(l)}</p>`); i++;
  }
  return out.join('\n');
}

document.getElementById('history-btn').onclick = async () => {
  historyPanel.hidden = !historyPanel.hidden;
  if (!historyPanel.hidden) {
    panel.hidden = true;
    try { await loadHistory(selectedRun); } catch (e) { runDetail.textContent = e.message; }
  }
};
document.getElementById('show-mock').onchange = () => loadHistory(selectedRun);
document.getElementById('history-close').onclick = () => { historyPanel.hidden = true; };

// ------------------------------------------------------------------ fixer
// 統合レビュー後の「修正しますか？」の提案と、修正係(Fixer)の結果表示。
// 状態はサーバーの fix({proposal, job})が正本。画面側で持つのは「このページで閉じたか」だけ。
const fixBackdrop = document.getElementById('fix-backdrop');
const fixProposalEl = document.getElementById('fix-proposal');
const fixResultEl = document.getElementById('fix-result');
const fixFindings = document.getElementById('fix-findings');
const fixStartBtn = document.getElementById('fix-start');
const fixSkipBtn = document.getElementById('fix-skip');
const fixProposalMsg = document.getElementById('fix-proposal-msg');
const fixResultBody = document.getElementById('fix-result-body');
const fixResultMsg = document.getElementById('fix-result-msg');
const fixCloseBtn = document.getElementById('fix-close');
const fixProgressEl = document.getElementById('fix-progress');
const fixReopenBtn = document.getElementById('fix-reopen');
let fixState = { proposal: null, job: null };
let proposalKey = null; // 一覧を作り直すのは提案そのものが変わったときだけ(チェックの状態を保つ)
let resultKey = null;
const closedProposals = new Set(); // ×/Esc で閉じた提案(このページを開いている間だけ覚える)
const closedResults = new Set();
let fixBusy = false;
let fixTimer = null;
let fixReturnFocus = null;

const proposalId = (p) => (p ? `${p.runId}|${p.createdAt}` : null);
const jobId = (j) => (j ? `${j.runId}|${j.startedAt}|${j.status}` : null);
function proposalPending() {
  const { proposal: p, job: j } = fixState;
  return !!p && (!j || j.runId !== p.runId);
}
function resultReady() {
  const j = fixState.job;
  return !!j && (j.status === 'done' || j.status === 'error');
}

function applyFix(f) {
  fixState = { proposal: (f && f.proposal) || null, job: (f && f.job) || null };
  renderFix();
}

function renderFix() {
  const { proposal: p, job: j } = fixState;
  const pk = proposalId(p);
  if (pk !== proposalKey) { proposalKey = pk; if (p) buildProposal(p); }
  const jk = jobId(j);
  if (resultReady() && jk !== resultKey) { resultKey = jk; buildResult(j); }
  if (!resultReady()) resultKey = null;

  // 同時に出すモーダルは1つだけ。新しい提案があるときは提案を優先する
  const showProposal = proposalPending() && !closedProposals.has(pk);
  const showResult = !showProposal && resultReady() && !closedResults.has(jk);
  setFixModal(fixProposalEl, showProposal);
  setFixModal(fixResultEl, showResult);
  fixBackdrop.hidden = !(showProposal || showResult);

  // 下部バー: 実行中の経過 / 閉じたモーダルの再表示ボタン
  const before = `${fixProgressEl.hidden}${fixReopenBtn.hidden}`;
  renderFixProgress();
  if (proposalPending() && !showProposal) {
    fixReopenBtn.textContent = `修正候補 ${p.findings.length}件`;
    fixReopenBtn.title = '統合レビューの修正候補をもう一度表示';
    fixReopenBtn.dataset.kind = 'proposal';
    fixReopenBtn.hidden = false;
  } else if (resultReady() && !showResult && !showProposal) {
    fixReopenBtn.textContent = j.status === 'error' ? '修正結果(停止)' : '修正結果';
    fixReopenBtn.title = '修正係の結果をもう一度表示';
    fixReopenBtn.dataset.kind = 'result';
    fixReopenBtn.hidden = false;
  } else {
    fixReopenBtn.hidden = true;
  }
  if (before !== `${fixProgressEl.hidden}${fixReopenBtn.hidden}`) layoutPanes(); // 下部バーの高さが変わりうる
}

function renderFixProgress() {
  const j = fixState.job;
  const running = !!j && j.status === 'running';
  fixProgressEl.hidden = !running;
  if (!running) { clearInterval(fixTimer); fixTimer = null; return; }
  fixProgressEl.textContent = `修正係 実行中・経過 ${fmtClock(Date.now() - j.startedAt)}`;
  if (!fixTimer) fixTimer = setInterval(renderFixProgress, 1000);
}

function setFixModal(modal, on) {
  if (modal.hidden === !on) return;
  modal.hidden = !on;
  if (on) {
    if (!fixReturnFocus) fixReturnFocus = document.activeElement;
    const first = modal.querySelector('.fix-body input:not(:disabled)') || modal.querySelector('footer .primary');
    if (first) first.focus();
  } else if (fixProposalEl.hidden && fixResultEl.hidden) {
    if (fixReturnFocus && document.contains(fixReturnFocus)) fixReturnFocus.focus();
    fixReturnFocus = null;
  }
}

// ×/Esc はこのページで閉じるだけ(提案や結果はサーバーに残り、下部バーから再表示できる)
function closeFixLocally() {
  if (!fixProposalEl.hidden) closedProposals.add(proposalId(fixState.proposal));
  else if (!fixResultEl.hidden) closedResults.add(jobId(fixState.job));
  renderFix();
}
for (const b of document.querySelectorAll('.fix-modal .fix-x')) b.onclick = closeFixLocally;
fixReopenBtn.onclick = () => {
  if (fixReopenBtn.dataset.kind === 'proposal') closedProposals.delete(proposalId(fixState.proposal));
  else closedResults.delete(jobId(fixState.job));
  renderFix();
};
document.addEventListener('keydown', (e) => {
  const modal = !fixProposalEl.hidden ? fixProposalEl : !fixResultEl.hidden ? fixResultEl : null;
  if (!modal) return;
  if (e.key === 'Escape') { e.preventDefault(); closeFixLocally(); return; }
  if (e.key !== 'Tab') return;
  // フォーカスをモーダルの中で回す
  const items = [...modal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')]
    .filter((x) => !x.disabled && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0]; const last = items[items.length - 1];
  if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ---- 提案モーダル
function buildProposal(p) {
  document.getElementById('fix-proposal-title').textContent = `統合レビューで修正候補が ${p.findings.length} 件見つかりました`;
  fixFindings.innerHTML = '';
  for (const f of p.findings) {
    const li = el('li');
    const label = el('label', 'fix-item');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = String(f.id);
    cb.checked = true;
    cb.onchange = updateFixStart;
    const text = el('div', 'fix-text');
    text.append(el('span', 'fix-title', f.title || `指摘 ${f.id}`));
    if (f.files && f.files.length) text.append(el('span', 'fix-files', f.files.join('\n')));
    if (f.detail) text.append(el('span', 'fix-detail', f.detail));
    label.append(cb, text);
    li.appendChild(label);
    fixFindings.appendChild(li);
  }
  const opus = fixProposalEl.querySelector('input[name="fix-model"][value="opus"]');
  if (opus) opus.checked = true;
  fixProposalMsg.textContent = '';
  updateFixStart();
}
function chosenIds() { return [...fixFindings.querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value)); }
function updateFixStart() {
  const n = chosenIds().length;
  fixStartBtn.disabled = fixBusy || n === 0;
  fixSkipBtn.disabled = fixBusy;
  fixStartBtn.title = n ? '' : '修正する指摘を1つ以上選んでください';
}
function setFixBusy(on, label) {
  fixBusy = on;
  fixStartBtn.textContent = on && label === 'start' ? '送信中…' : '選んだ指摘を修正係に渡す';
  fixSkipBtn.textContent = on && label === 'skip' ? '片付け中…' : '今回はしない';
  fixCloseBtn.disabled = on;
  for (const i of fixProposalEl.querySelectorAll('.fix-body input')) i.disabled = on;
  updateFixStart();
}
fixStartBtn.onclick = async () => {
  const ids = chosenIds();
  if (fixBusy || !ids.length) return;
  const model = (fixProposalEl.querySelector('input[name="fix-model"]:checked') || {}).value || 'opus';
  fixProposalMsg.textContent = '';
  setFixBusy(true, 'start');
  try {
    applyFix(await api('POST', '/api/fix', { ids, model }));
    showToast('修正係に渡しました');
  } catch (e) {
    fixProposalMsg.textContent = `始められませんでした: ${e.message}`;
  } finally { setFixBusy(false); }
};
fixSkipBtn.onclick = async () => {
  if (fixBusy) return;
  fixProposalMsg.textContent = '';
  setFixBusy(true, 'skip');
  try { applyFix(await api('POST', '/api/fix/dismiss', {})); }
  catch (e) { fixProposalMsg.textContent = e.message; }
  finally { setFixBusy(false); }
};

// ---- 結果モーダル
// コマンドに埋めるパスは " で囲み、" の中でも意味を持つ文字(\ " $ `)をエスケープする
function shQuote(s) { return `"${String(s).replace(/[\\"$`]/g, '\\$&')}"`; }
function shArg(s) { return /^[\w./@+-]+$/.test(s) ? s : shQuote(s); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* http や権限なしでは使えない */ }
  const ta = el('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
function fixSection(title, ...children) {
  const s = el('section', 'fix-sec');
  s.append(el('h4', '', title), ...children);
  return s;
}
function buildResult(j) {
  const failed = j.status === 'error';
  document.getElementById('fix-result-title').textContent = failed ? '修正係が途中で止まりました' : '修正係が終わりました';
  fixResultEl.classList.toggle('failed', failed);
  fixResultMsg.textContent = '';
  fixResultBody.innerHTML = '';
  if (j.error) fixResultBody.append(el('p', 'fix-error', j.error));

  const facts = el('dl', 'fix-facts');
  for (const [k, v] of [['対象', j.repo], ['ブランチ', j.branch], ['作業場所', j.worktree], ['モデル', j.model]]) {
    if (!v) continue;
    facts.append(el('dt', '', k), el('dd', '', v));
  }
  if (facts.children.length) fixResultBody.append(facts);
  if (j.dirty) fixResultBody.append(el('p', 'fix-note', `開始時、対象には未コミットの変更が ${j.dirty} 件あり、修正係からは見えていませんでした。`));

  const s = j.summary;
  if (s) {
    fixResultBody.append(
      fixSection('コミット', el('pre', 'fix-pre', (s.log || '').trim() || '(なし)')),
      fixSection('変更ファイル', el('pre', 'fix-pre', (s.stat || '').trim() || '(なし)')),
    );
    if (s.status && s.status.trim()) fixResultBody.append(fixSection('未コミットの変更', el('pre', 'fix-pre', s.status.trim())));
  }

  if (j.repo && j.branch && j.worktree) {
    const cmds = el('div', 'fix-cmds');
    for (const c of [`git -C ${shQuote(j.repo)} merge ${shArg(j.branch)}`, `git -C ${shQuote(j.repo)} worktree remove ${shQuote(j.worktree)}`]) {
      const row = el('div', 'fix-cmd');
      const code = el('code', '', c);
      const b = el('button', '', 'コピー');
      b.type = 'button';
      b.onclick = async () => {
        const ok = await copyText(c);
        b.textContent = ok ? 'コピーしました' : 'コピーできません';
        clearTimeout(b.t);
        b.t = setTimeout(() => { b.textContent = 'コピー'; }, 1600);
      };
      row.append(code, b);
      cmds.appendChild(row);
    }
    fixResultBody.append(fixSection('取り込むには', el('p', 'fix-hint', '内容を確かめてから、ターミナルで上から順に実行します(1つ目で取り込み、2つ目で作業場所を片付け)。'), cmds));
  }

  const report = el('div', 'md', '読み込み中…');
  fixResultBody.append(fixSection('報告本文', report));
  // worktree を作る前に止まった場合、報告(Fixer.md)は書かれない
  if (!j.worktree) { report.textContent = '報告はありません'; return; }
  const key = jobId(j);
  fetch(`/api/runs/${j.runId}/Fixer.md`)
    .then(async (r) => {
      if (resultKey !== key) return;
      if (!r.ok) { report.textContent = '報告はありません'; return; }
      report.innerHTML = renderMarkdown(await r.text());
    })
    .catch(() => { if (resultKey === key) report.textContent = '報告を読み込めませんでした'; });
}
// 「閉じる」は提案と結果をサーバー側で片付ける。ただし新しい提案が出ている間は消さないよう、画面で閉じるだけにする
fixCloseBtn.onclick = async () => {
  if (fixBusy) return;
  if (proposalPending()) { closeFixLocally(); return; }
  fixResultMsg.textContent = '';
  setFixBusy(true, 'close');
  try { applyFix(await api('POST', '/api/fix/dismiss', {})); }
  catch (e) { fixResultMsg.textContent = e.message; }
  finally { setFixBusy(false); }
};
