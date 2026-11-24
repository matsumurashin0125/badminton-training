'use strict';
/* =========================================================
   バド基礎トレ  — カウントダウン式トレーニング記録アプリ
   ログインするとサーバー(Firestore)に同期、未ログインなら端末だけに保存
   ========================================================= */

const KEY = 'badtore.v1';                 // ログインなし（この端末のみ）で使うときの保存先
const SESSION_KEY = 'badtore.session';    // { token, id, name } または { local: true }
const PREP_SEC = 5;          // 開始前カウント
const REST_COUNT_FROM = 5;   // インターバル残り何秒から音声カウントするか
const WORK_COUNT_FROM = 3;   // トレーニング残り何秒から音声カウントするか

const CAT = {
  core: { label: '体幹', emoji: '🧘' },
  foot: { label: 'フットワーク', emoji: '🏸' },
  mix:  { label: 'ミックス', emoji: '🔥' },
};
const PRESETS = {
  core: ['プランク', 'サイドプランク(右)', 'サイドプランク(左)', 'バックブリッジ', 'バードドッグ', 'ドローイン', 'レッグレイズ', 'クランチ', 'マウンテンクライマー'],
  foot: ['前後フットワーク', 'サイドステップ', '6点フットワーク', '4点フットワーク', 'シャドー', '反復横跳び', 'もも上げ', 'ランジ', 'スプリットステップ'],
};

/* ---------------- storage ---------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function seed() {
  const it = (category, name, sec, interval) => ({ id: uid(), category, name, sec, interval });
  return {
    settings: { voice: true },
    history: [],
    programs: [
      { id: uid(), name: '体幹ベーシック', items: [
        it('core', 'プランク', 30, 15), it('core', 'サイドプランク(右)', 30, 15),
        it('core', 'サイドプランク(左)', 30, 15), it('core', 'バックブリッジ', 30, 0) ] },
      { id: uid(), name: 'フットワーク基礎', items: [
        it('foot', '前後フットワーク', 30, 20), it('foot', 'サイドステップ', 30, 20),
        it('foot', '6点フットワーク', 45, 30), it('foot', 'シャドー', 60, 0) ] },
    ],
  };
}
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

let session = lsGet(SESSION_KEY);   // null = 未選択（ログイン画面を出す）
const online = () => !!(session && session.token);
const cacheKey = () => online() ? `badtore.u.${session.id}` : KEY;
const dirtyKey = () => `badtore.dirty.${session.id}`;

function normalize(d) {
  if (!d || !Array.isArray(d.programs)) return null;
  return { programs: d.programs, history: Array.isArray(d.history) ? d.history : [], settings: Object.assign({ voice: true }, d.settings) };
}
function load() { return normalize(lsGet(cacheKey())) || seed(); }
function save() {
  lsSet(cacheKey(), db);
  if (online()) { lsSet(dirtyKey(), 1); scheduleSync(); }
}
let db = load();

/* ---------------- server API / 同期 ---------------- */
async function api(path, opt = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opt.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, session && session.token ? { Authorization: 'Bearer ' + session.token } : {}),
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
  } catch (e) { const er = new Error('通信できませんでした。電波の良いところで試してください'); er.offline = true; throw er; }
  let json = {};
  try { json = await res.json(); } catch (e) {}
  if (!res.ok) {
    const er = new Error(json.error || `エラーが発生しました (${res.status})`); er.status = res.status;
    if (res.status === 401 && online() && !opt.noLogout) { forceLogout(); }
    throw er;
  }
  return json;
}
let syncTimer = null, syncing = false;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 800); }
async function syncNow() {
  if (!online() || syncing || !lsGet(dirtyKey())) return;
  syncing = true; setSync('…');
  const snapshot = JSON.stringify(db);
  try {
    await api('/api/me/data', { method: 'PUT', body: db });
    if (JSON.stringify(db) === snapshot) lsSet(dirtyKey(), null);   // 送信中の変更がなければ同期完了
    setSync('ok');
  } catch (e) { setSync('err'); }
  syncing = false;
  if (online() && lsGet(dirtyKey()) && navigator.onLine !== false) scheduleSync();
}
function setSync(st) {
  const el = document.getElementById('sync');
  if (!el) return;
  el.textContent = st === 'ok' ? '☁ 同期済み' : st === 'err' ? '⚠ 未同期' : '☁ 同期中…';
  el.className = 'sync ' + st;
}
window.addEventListener('online', syncNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });

async function pullFromServer() {
  if (!online()) return;
  try {
    if (lsGet(dirtyKey())) { await syncNow(); return; }   // 未送信の変更があれば先に送る
    const r = await api('/api/me');
    session.name = r.user.name; lsSet(SESSION_KEY, session);
    db = normalize(r.data) || seed();
    lsSet(cacheKey(), db);
    if (view === 'home' || view === 'history') render();
    setSync('ok');
  } catch (e) { setSync('err'); }
}
function setSession(s) {
  session = s; lsSet(SESSION_KEY, s);
}
function forceLogout(msg) {
  stopPlayer && P && stopPlayer();
  setSession(null);
  view = 'login'; render();
  toast(msg || 'もう一度ログインしてください');
}

/* ---------------- dates / streak ---------------- */
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const doneDays = () => new Set(db.history.map(h => h.day));
function streak(s = doneDays()) {
  let d = new Date();
  if (!s.has(dayKey(d))) d = addDays(d, -1);   // 今日まだでも昨日までの連続は維持
  let n = 0;
  while (s.has(dayKey(d))) { n++; d = addDays(d, -1); }
  return n;
}
function bestStreak(set = doneDays()) {
  const days = [...set].sort();
  let best = 0, cur = 0, prev = null;
  for (const k of days) {
    cur = (prev && dayKey(addDays(prev, 1)) === k) ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = new Date(k + 'T00:00:00');
  }
  return best;
}
const fmt = sec => { const m = Math.floor(sec / 60), s = sec % 60; return m ? `${m}分${s ? s + '秒' : ''}` : `${s}秒`; };
const totalSec = p => p.items.reduce((a, it, i) => a + it.sec + (i < p.items.length - 1 ? (it.interval || PREP_SEC) : 0), PREP_SEC);
const progCat = p => { const c = new Set(p.items.map(i => i.category)); return c.size === 1 ? [...c][0] : 'mix'; };

/* ---------------- audio / voice ---------------- */
let ac = null, jaVoice = null;
function pickVoice() {
  try {
    const vs = speechSynthesis.getVoices();
    jaVoice = vs.find(v => /^ja[-_]JP/i.test(v.lang)) || vs.find(v => (v.lang || '').startsWith('ja')) || null;
  } catch (e) {}
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function unlockAudio() {   // iOSはタップ操作の中で一度鳴らす必要がある
  try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch (e) {}
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) {}
  pickVoice();
}
function speak(text, cancel = false) {
  if (!db.settings.voice) return;
  try {
    if (cancel) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; if (jaVoice) u.voice = jaVoice; u.rate = 1.1;
    speechSynthesis.speak(u);
  } catch (e) {}
}
function beep(freq = 880, dur = 0.12, vol = 0.3) {
  if (!ac) return;
  try {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.connect(g).connect(ac.destination);
    o.start(); o.stop(ac.currentTime + dur);
  } catch (e) {}
}
const vib = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };
const KANA = ['', 'いち', 'に', 'さん', 'よん', 'ご'];
function countVoice(s) { beep(s === 1 ? 990 : 660, 0.1, 0.25); speak(KANA[s] || String(s), true); }

let wakeLock = null;
async function requestWake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (P && document.visibilityState === 'visible') requestWake(); });

/* ---------------- dialogs (確認・アクションシート・トースト) ---------------- */
function dialog({ title = '', msg = '', buttons = [], fields = [] }) {
  return new Promise(resolve => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet card" role="dialog" aria-modal="true">
      ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
      ${msg ? `<div class="sheet-msg">${esc(msg)}</div>` : ''}
      ${fields.map(f => `<div class="field" style="margin:12px 0 0"><label>${esc(f.label)}</label>
        <input class="input ${f.pin ? 'pin' : ''}" data-f="${f.key}" value="${esc(f.value || '')}" ${f.pin ? 'type="password" inputmode="numeric" maxlength="4" autocomplete="off"' : 'autocomplete="off"'}></div>`).join('')}
      <div class="sheet-btns">${buttons.map((b, i) => `<button class="btn ${b.style || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    const close = v => {
      dialog.values = {};
      m.querySelectorAll('[data-f]').forEach(i => { dialog.values[i.dataset.f] = i.value.trim(); });
      m.classList.add('out'); setTimeout(() => m.remove(), 150); resolve(v);
    };
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-i]');
      if (b) close(buttons[+b.dataset.i].value);
      else if (e.target === m) close(null);
    });
    document.body.appendChild(m);
    const first = m.querySelector('[data-f]'); if (first) setTimeout(() => first.focus(), 50);
  });
}
async function formDialog(title, fields, ok = '保存') {
  const v = await dialog({ title, fields, buttons: [{ label: ok, value: true }, { label: 'キャンセル', value: false, style: 'white' }] });
  return v === true ? dialog.values : null;
}
const confirmDlg = (title, msg, ok = 'OK', danger = false) =>
  dialog({ title, msg, buttons: [{ label: ok, value: true, style: danger ? 'danger' : '' }, { label: 'キャンセル', value: false, style: 'white' }] })
    .then(v => v === true);
function toast(text) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- program actions ---------------- */
async function programMenu(id) {
  const p = db.programs.find(x => x.id === id);
  if (!p) return;
  const v = await dialog({
    title: p.name,
    msg: `${p.items.length}種目・約${fmt(totalSec(p))}`,
    buttons: [
      { label: '▶ 開始', value: 'start' },
      { label: '✎ 編集', value: 'edit', style: 'blue' },
      { label: '⧉ 複製', value: 'dup', style: 'white' },
      { label: '🗑 削除', value: 'del', style: 'red' },
      { label: '閉じる', value: null, style: 'ghost' },
    ],
  });
  if (v === 'start') startProgram(id);
  else if (v === 'edit') openEditor(id);
  else if (v === 'dup') duplicateProgram(id);
  else if (v === 'del') { if (await deleteProgram(id)) render(); }
}
function duplicateProgram(id) {
  const p = db.programs.find(x => x.id === id);
  const copy = { id: uid(), name: p.name + '（コピー）', items: p.items.map(i => ({ ...i, id: uid() })) };
  db.programs.splice(db.programs.indexOf(p) + 1, 0, copy);
  save(); render(); toast('複製しました');
}
async function deleteProgram(id) {
  const p = db.programs.find(x => x.id === id);
  if (!p) return false;
  if (!(await confirmDlg('メニューを削除', `「${p.name}」を削除しますか？\n（これまでの記録は残ります）`, '削除する', true))) return false;
  db.programs = db.programs.filter(x => x.id !== id);
  save(); toast('削除しました');
  return true;
}

/* ---------------- router ---------------- */
const app = document.getElementById('app');
let view = 'home', homeFilter = 'all', calMonth = new Date(), lastDone = null;
let E = null;   // editor state
let P = null;   // player state

function render() {
  if (!session && view !== 'login') view = 'login';
  if (view === 'login') renderLogin();
  else if (view === 'members') renderMembers();
  else if (view === 'member') renderMember();
  else if (view === 'home') renderHome();
  else if (view === 'editor') renderEditor();
  else if (view === 'history') renderHistory();
  else if (view === 'done') renderDone();
  window.scrollTo(0, 0);
}
function nav(active) {
  return `<nav class="nav"><div class="nav-in">
    <button data-act="go-home" class="${active === 'home' ? 'on' : ''}"><span>🏠</span>ホーム</button>
    <button data-act="go-members" class="${active === 'members' ? 'on' : ''}"><span>👥</span>みんな</button>
    <button data-act="go-history" class="${active === 'history' ? 'on' : ''}"><span>📅</span>記録</button>
  </div></nav>`;
}

/* ---------------- home ---------------- */
function renderHome() {
  const st = streak(), days = doneDays(), today = new Date(), doneToday = days.has(dayKey());
  const W = '日月火水木金土';
  let week = '';
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i), on = days.has(dayKey(d));
    week += `<div class="day">${W[d.getDay()]}<div class="dot ${on ? 'on' : ''} ${i === 0 ? 'today' : ''}">${on ? '✓' : ''}</div></div>`;
  }
  const msg = doneToday ? '今日のトレーニング達成！この調子！'
    : st > 0 ? `今日やれば ${st + 1}日連続！記録を途切れさせないで` : '今日から連続記録をスタートしよう';
  const list = db.programs.filter(p => homeFilter === 'all' || progCat(p) === homeFilter);
  const progs = list.length ? list.map(p => {
    const c = progCat(p);
    return `<div class="card prog" data-act="start" data-id="${p.id}">
      <div class="prog-ic ${c}">${CAT[c].emoji}</div>
      <div class="prog-body">
        <div class="prog-name">${esc(p.name)}</div>
        <div class="prog-meta"><span class="badge ${c}">${CAT[c].label}</span>　${p.items.length}種目・約${fmt(totalSec(p))}${p.from ? `・👤${esc(p.from.name)}` : ''}</div>
      </div>
      <button class="edit" data-act="more" data-id="${p.id}" aria-label="編集・削除">⋯</button>
      <div class="play">▶</div>
    </div>`;
  }).join('') : `<div class="empty">メニューがありません。<br>右下の＋から作成しよう</div>`;

  app.innerHTML = `
    <div class="top"><h1>🏸 バド基礎トレ</h1>
      ${online() ? `<button class="me-chip" data-act="go-history"><span id="sync" class="sync">☁</span> ${esc(session.name)}</button>` : `<button class="me-chip" data-act="to-login">ログイン</button>`}</div>
    <div class="card streak">
      <div class="flame ${doneToday ? 'on' : ''}">🔥</div>
      <div><div class="streak-num">${st}<small>日連続</small></div><div class="streak-msg">${msg}</div></div>
    </div>
    <div class="card week">${week}</div>
    <div class="sec-title">メニュー（タップで開始）</div>
    <div class="tabs">
      ${[['all', 'すべて'], ['core', '体幹'], ['foot', 'フットワーク'], ['mix', 'ミックス']].map(([k, l]) =>
        `<button class="tab ${homeFilter === k ? 'on' : ''}" data-act="filter" data-id="${k}">${l}</button>`).join('')}
    </div>
    <div class="wrap">${progs}</div>
    <button class="fab" data-act="new" aria-label="新規作成">＋</button>
    ${nav('home')}`;
}

/* ---------------- editor ---------------- */
function openEditor(id) {
  const p = id ? db.programs.find(x => x.id === id) : null;
  E = {
    id: p ? p.id : null,
    name: p ? p.name : '',
    items: p ? p.items.map(i => ({ ...i })) : [],
    form: blankForm(p && p.items.length ? p.items[p.items.length - 1].category : 'core'),
    editIndex: null,   // 種目を編集中ならその番号
  };
  view = 'editor'; render();
}
function blankForm(category = 'core') { return { category, name: '', sec: 30, useInt: true, intSec: 15 }; }
function readForm() {
  const f = E.form;
  const q = s => app.querySelector(s);
  if (q('#f-name')) f.name = q('#f-name').value.trim();
  if (q('#f-sec')) f.sec = Math.max(0, parseInt(q('#f-sec').value, 10) || 0);
  if (q('#f-int')) f.intSec = Math.max(0, parseInt(q('#f-int').value, 10) || 0);
  if (q('#p-name')) E.name = q('#p-name').value.trim();
}
function renderEditor() {
  const f = E.form;
  const editing = E.editIndex !== null;
  const items = E.items.map((it, i) => `
    <div class="card item ${E.editIndex === i ? 'editing' : ''}" data-act="edit-item" data-id="${i}">
      <div class="item-n">${i + 1}</div>
      <div class="item-body"><div class="item-name">${esc(it.name)}</div>
        <div class="item-sub"><span class="badge ${it.category}">${CAT[it.category].label}</span>　${it.sec}秒${E.editIndex === i ? '　<b class="edit-tag">編集中</b>' : ''}</div></div>
      <button data-act="edit-item" data-id="${i}" aria-label="編集">✎</button>
      <button data-act="up" data-id="${i}" aria-label="上へ" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button data-act="down" data-id="${i}" aria-label="下へ" ${i === E.items.length - 1 ? 'disabled' : ''}>▼</button>
      <button data-act="del-item" data-id="${i}" aria-label="削除">🗑</button>
    </div>
    ${i < E.items.length - 1 ? `<div class="int-line">${it.interval ? `⏸ インターバル ${it.interval}秒` : `⏱ 準備 ${PREP_SEC}秒`}</div>` : ''}`).join('');

  app.innerHTML = `
    <div class="top"><button class="x" data-act="cancel-edit" aria-label="閉じる">✕</button>
      <h1>${E.id ? 'メニューを編集' : 'メニューを作成'}</h1><div style="width:40px"></div></div>
    <div class="wrap">
      <div class="field"><label>トレーニング名</label>
        <input id="p-name" class="input" placeholder="例：朝の体幹セット" value="${esc(E.name)}"></div>

      ${E.items.length ? `<div class="sec-title">追加済み（${E.items.length}種目）<span class="muted">タップで編集</span></div><div class="items">${items}</div>` : ''}

      <div class="sec-title" id="form-title">${editing ? `${E.editIndex + 1}番目のメニューを編集` : E.items.length ? '次のメニュー' : '1つ目のメニュー'}</div>
      <div class="card form-box ${editing ? 'editing' : ''}">
        <div class="field"><label>種類</label>
          <div class="seg">
            <button class="core ${f.category === 'core' ? 'on' : ''}" data-act="cat" data-id="core">🧘 体幹</button>
            <button class="foot ${f.category === 'foot' ? 'on' : ''}" data-act="cat" data-id="foot">🏸 フットワーク</button>
          </div></div>
        <div class="field"><label>メニュー名</label>
          <input id="f-name" class="input" placeholder="メニュー名を入力" value="${esc(f.name)}">
          <div class="chips">${PRESETS[f.category].map(n => `<button class="chip" data-act="preset" data-id="${esc(n)}">${esc(n)}</button>`).join('')}</div>
        </div>
        <div class="field"><label>秒数</label>
          <div class="stepper"><button data-act="sec" data-id="-5">−</button>
            <input id="f-sec" class="input" type="number" inputmode="numeric" min="1" value="${f.sec}">
            <button data-act="sec" data-id="5">＋</button></div>
          <div class="quick">${[20, 30, 45, 60, 90].map(s => `<button data-act="sec-set" data-id="${s}">${s}秒</button>`).join('')}</div>
        </div>
        <div class="field" style="margin-bottom:${f.useInt ? 14 : 0}px"><label>次のメニューまでのインターバル</label>
          <div class="seg">
            <button class="plain ${!f.useInt ? 'on' : ''}" data-act="int" data-id="0">なし</button>
            <button class="plain ${f.useInt ? 'on' : ''}" data-act="int" data-id="1">あり</button>
          </div></div>
        ${f.useInt ? `<div class="field" style="margin:0"><label>インターバル秒数</label>
          <div class="stepper"><button data-act="isec" data-id="-5">−</button>
            <input id="f-int" class="input" type="number" inputmode="numeric" min="1" value="${f.intSec}">
            <button data-act="isec" data-id="5">＋</button></div>
          <div class="quick">${[10, 15, 20, 30, 60].map(s => `<button data-act="isec-set" data-id="${s}">${s}秒</button>`).join('')}</div>
        </div>` : ''}
      </div>

      <div class="actions">
        ${editing
          ? `<button class="btn blue" data-act="update-item">✓ この種目を更新</button>
             <button class="btn white" data-act="cancel-item">編集をやめる</button>`
          : `<button class="btn blue" data-act="add-next">＋ 次のメニューを追加</button>`}
        <button class="btn" data-act="finish-edit">終了して保存</button>
        ${E.id ? `<button class="btn red" data-act="del-prog">このトレーニングを削除</button>` : ''}
      </div>
    </div>`;
}
function formToItem() {
  readForm();
  const f = E.form;
  if (!f.name || f.sec <= 0) return null;
  return { id: uid(), category: f.category, name: f.name, sec: f.sec, interval: f.useInt ? f.intSec : 0 };
}
function addNext() {
  const it = formToItem();
  if (!it) { toast('メニュー名と秒数を入力してください'); return; }
  E.items.push(it);
  E.form.name = '';
  render();
  setTimeout(() => { const el = document.querySelector('#f-name'); el && el.scrollIntoView({ block: 'center' }); }, 50);
}
function startEditItem(i) {
  readForm();
  const it = E.items[i];
  E.editIndex = i;
  E.form = { category: it.category, name: it.name, sec: it.sec, useInt: it.interval > 0, intSec: it.interval || 15 };
  render();
  setTimeout(() => { const el = document.getElementById('form-title'); el && el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 50);
}
function updateItem() {
  const it = formToItem();
  if (!it) { toast('メニュー名と秒数を入力してください'); return false; }
  it.id = E.items[E.editIndex].id;
  E.items[E.editIndex] = it;
  E.editIndex = null; E.form = blankForm(it.category);
  return true;
}
function cancelItem() { readForm(); E.editIndex = null; E.form = blankForm(E.form.category); render(); }
function moveItem(i, d) {
  readForm();
  const j = i + d;
  if (j < 0 || j >= E.items.length) return;
  [E.items[i], E.items[j]] = [E.items[j], E.items[i]];
  if (E.editIndex === i) E.editIndex = j; else if (E.editIndex === j) E.editIndex = i;
  render();
}
async function deleteItem(i) {
  readForm();
  if (!(await confirmDlg('種目を削除', `「${E.items[i].name}」をこのトレーニングから削除しますか？`, '削除する', true))) return;
  E.items.splice(i, 1);
  if (E.editIndex === i) { E.editIndex = null; E.form = blankForm(E.form.category); }
  else if (E.editIndex !== null && E.editIndex > i) E.editIndex--;
  render();
}
function finishEdit() {
  if (E.editIndex !== null) { if (!updateItem()) return; }
  else { const it = formToItem(); if (it) E.items.push(it); }
  if (!E.items.length) { toast('メニューを1つ以上追加してください'); return; }
  const d = new Date();
  const name = E.name || `トレーニング ${d.getMonth() + 1}/${d.getDate()}`;
  if (E.id) {
    const p = db.programs.find(x => x.id === E.id);
    p.name = name; p.items = E.items;
  } else {
    db.programs.unshift({ id: uid(), name, items: E.items });
  }
  save(); E = null; view = 'home'; render();
}

/* ---------------- player ---------------- */
function buildPhases(p) {
  const ph = [{ type: 'prep', sec: PREP_SEC, item: p.items[0], idx: 0, first: true }];
  p.items.forEach((item, i) => {
    ph.push({ type: 'work', sec: item.sec, item, idx: i });
    const nx = p.items[i + 1];
    if (!nx) return;
    if (item.interval > 0) ph.push({ type: 'rest', sec: item.interval, item: nx, idx: i + 1 });
    else ph.push({ type: 'prep', sec: PREP_SEC, item: nx, idx: i + 1 });
  });
  return ph;
}
const C = 2 * Math.PI * 140;
function startProgram(id) {
  const p = db.programs.find(x => x.id === id);
  if (!p || !p.items.length) return;
  unlockAudio(); requestWake();
  P = { p, phases: buildPhases(p), i: 0, end: 0, remain: 0, paused: false, lastSec: null, timer: null, startedAt: Date.now() };
  view = 'player';
  app.innerHTML = `
    <div class="player prep" id="pl">
      <div class="bar">
        <button data-act="quit" aria-label="中止">✕</button>
        <div class="prog-bar"><i id="pl-bar" style="width:0"></i></div>
        <button data-act="voice" id="pl-voice" aria-label="音声">${db.settings.voice ? '🔊' : '🔇'}</button>
      </div>
      <div class="ph-label" id="pl-label">準備</div>
      <div class="ph-name" id="pl-name"></div>
      <div class="ring">
        <svg viewBox="0 0 300 300"><circle cx="150" cy="150" r="140" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="16"/>
          <circle id="pl-ring" cx="150" cy="150" r="140" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>
        <div class="num" id="pl-num"></div>
        <div class="paused-tag" id="pl-paused" hidden>一時停止中</div>
      </div>
      <div class="ph-next" id="pl-next"></div>
      <div class="ph-step" id="pl-step"></div>
      <div class="ctrls">
        <button data-act="pause" id="pl-pause">一時停止</button>
        <button data-act="skip">スキップ ⏭</button>
      </div>
    </div>`;
  enterPhase(0);
  P.timer = setInterval(tick, 100);
}
function enterPhase(i) {
  P.i = i;
  const ph = P.phases[i];
  P.end = performance.now() + ph.sec * 1000;
  P.lastSec = null;
  const pl = document.getElementById('pl');
  pl.className = 'player ' + ph.type;
  document.getElementById('pl-label').textContent = ph.type === 'prep' ? (ph.first ? 'まもなく開始' : '次のメニュー') : ph.type === 'work' ? (CAT[ph.item.category].label) : 'インターバル';
  document.getElementById('pl-name').textContent = ph.type === 'rest' ? '休憩' : ph.item.name;
  const nextWork = P.p.items[ph.type === 'work' ? ph.idx + 1 : ph.idx];
  document.getElementById('pl-next').textContent =
    ph.type === 'work' ? (nextWork ? `次：${nextWork.name}` : 'これがラスト！') : `次：${ph.item.name}（${ph.item.sec}秒）`;
  document.getElementById('pl-step').textContent = `${ph.idx + 1} / ${P.p.items.length} 種目`;
  const done = P.phases.slice(0, i).filter(x => x.type === 'work').length;
  document.getElementById('pl-bar').style.width = (done / P.p.items.length * 100) + '%';
  onPhaseStart(ph);
  tick();
}
function onPhaseStart(ph) {
  vib(ph.type === 'work' ? [200] : [80]);
  if (ph.type === 'prep') {
    beep(520, 0.15);
    speak(ph.first ? `${ph.item.name}、${ph.item.sec}秒。準備してください` : `終了。次は、${ph.item.name}、${ph.item.sec}秒`, true);
  } else if (ph.type === 'work') {
    beep(1200, 0.35, 0.35);
    speak('スタート', true);
  } else {
    beep(520, 0.3);
    speak(ph.sec > REST_COUNT_FROM + 2 ? `終了。インターバル、${ph.sec}秒。次は、${ph.item.name}` : 'インターバル', true);
  }
}
function onSecond(ph, s) {
  if (ph.type === 'prep') {
    if (s <= 3) countVoice(s); else beep(440, 0.06, 0.15);
  } else if (ph.type === 'work') {
    if (s <= WORK_COUNT_FROM) countVoice(s);
    else if (s === 10 && ph.sec >= 20) speak('ラスト10秒', true);
  } else {
    if (s <= REST_COUNT_FROM) countVoice(s);
  }
}
function tick() {
  if (!P || P.paused) return;
  const rem = P.end - performance.now();
  if (rem <= 0) { nextPhase(); return; }
  const ph = P.phases[P.i];
  const s = Math.ceil(rem / 1000);
  const num = document.getElementById('pl-num');
  if (s !== P.lastSec) {
    if (P.lastSec !== null) onSecond(ph, s);   // フェーズ開始直後は開始アナウンスを優先
    P.lastSec = s;
    num.textContent = s;
    num.classList.remove('beat'); void num.offsetWidth; num.classList.add('beat');
  }
  document.getElementById('pl-ring').setAttribute('stroke-dashoffset', C * (1 - rem / (ph.sec * 1000)));
}
function nextPhase() {
  if (P.i + 1 >= P.phases.length) { finishProgram(); return; }
  enterPhase(P.i + 1);
}
function togglePause() {
  if (!P) return;
  P.paused = !P.paused;
  if (P.paused) { P.remain = P.end - performance.now(); try { speechSynthesis.cancel(); } catch (e) {} }
  else { P.end = performance.now() + P.remain; }
  document.getElementById('pl-pause').textContent = P.paused ? '再開 ▶' : '一時停止';
  document.getElementById('pl-paused').hidden = !P.paused;
}
function stopPlayer() {
  if (P) clearInterval(P.timer);
  try { speechSynthesis.cancel(); } catch (e) {}
  releaseWake(); P = null;
}
function finishProgram() {
  const p = P.p, sec = Math.round((Date.now() - P.startedAt) / 1000);
  const hadToday = doneDays().has(dayKey());
  stopPlayer();
  beep(880, 0.15); setTimeout(() => beep(1320, 0.4), 160);
  vib([100, 80, 300]);
  speak('終了。お疲れさまでした');
  db.history.push({ id: uid(), day: dayKey(), at: Date.now(), programId: p.id, name: p.name, sec, items: p.items.length });
  save();
  lastDone = { name: p.name, sec, items: p.items.length, newDay: !hadToday };
  view = 'done'; render();
}

/* ---------------- done ---------------- */
function renderDone() {
  const st = streak(), d = lastDone || { name: '', sec: 0, items: 0, newDay: false };
  app.innerHTML = `
    <div class="done">
      <div class="big">${d.newDay ? '🔥' : '🎉'}</div>
      <h2>${d.newDay ? `${st}日連続 達成！` : 'トレーニング完了！'}</h2>
      <div class="muted">${d.newDay ? (st === 1 ? '連続記録スタート！明日も続けよう' : '連続記録を更新しました') : `今日も${st}日連続をキープ中`}</div>
      <div class="stats">
        <div class="card"><span class="muted">メニュー</span><b>${d.items}種目</b></div>
        <div class="card"><span class="muted">時間</span><b>${fmt(d.sec)}</b></div>
        <div class="card"><span class="muted">累計</span><b>${db.history.length}回</b></div>
      </div>
      <div class="muted" style="margin-bottom:24px">${esc(d.name)}</div>
      <button class="btn" data-act="go-home">続ける</button>
    </div>`;
}

/* ---------------- history ---------------- */
function renderHistory() {
  const days = doneDays(), totalS = db.history.reduce((a, h) => a + (h.sec || 0), 0);
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate(), tk = dayKey();
  let cal = '日月火水木金土'.split('').map(w => `<div class="w">${w}</div>`).join('');
  for (let i = 0; i < first; i++) cal += '<div></div>';
  for (let d = 1; d <= last; d++) {
    const k = `${y}-${pad(m + 1)}-${pad(d)}`;
    cal += `<div class="c ${days.has(k) ? 'on' : ''} ${k === tk ? 'today' : ''}">${d}</div>`;
  }
  const logs = db.history.slice().reverse().slice(0, 50).map(h => {
    const dt = new Date(h.at);
    return `<div class="card log"><div><b>${esc(h.name)}</b><div class="muted">${dt.getMonth() + 1}/${dt.getDate()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}・${h.items}種目</div></div>
      <div class="log-r"><span class="muted">${fmt(h.sec || 0)}</span><button class="log-del" data-act="del-log" data-id="${h.id}" aria-label="記録を削除">🗑</button></div></div>`;
  }).join('') || '<div class="empty">まだ記録がありません</div>';

  app.innerHTML = `
    <div class="top"><h1>📅 記録</h1></div>
    <div class="wrap">
      <div class="tiles">
        <div class="card tile"><div class="v" style="color:var(--orange)">🔥 ${streak()}</div><div class="k">現在の連続日数</div></div>
        <div class="card tile"><div class="v">🏆 ${bestStreak()}</div><div class="k">最高連続日数</div></div>
        <div class="card tile"><div class="v">${db.history.length}</div><div class="k">合計トレーニング回数</div></div>
        <div class="card tile"><div class="v">${Math.round(totalS / 60)}<small style="font-size:14px">分</small></div><div class="k">合計時間</div></div>
      </div>
      <div class="sec-title">カレンダー</div>
      <div class="card cal">
        <div class="cal-head"><button data-act="cal" data-id="-1">‹</button>${y}年${m + 1}月<button data-act="cal" data-id="1">›</button></div>
        <div class="cal-grid">${cal}</div>
      </div>
      <div class="sec-title">アカウント</div>
      ${accountCard()}
      <div class="sec-title">設定</div>
      <div class="card switch"><b>音声ガイド</b>
        <button class="tab ${db.settings.voice ? 'on' : ''}" data-act="voice-set">${db.settings.voice ? 'ON' : 'OFF'}</button></div>
      <div class="sec-title">履歴</div>
      ${logs}
    </div>
    ${nav('history')}`;
}

/* ---------------- login ---------------- */
let loginTab = 'login', loginErr = '', loginBusy = false, loginId = null, loginName = '';
function renderLogin() {
  const local = normalize(lsGet(KEY));
  const hasLocal = local && local.history.length > 0;
  const reg = loginTab === 'register';
  app.innerHTML = `
    <div class="login">
      <div class="login-hero"><img src="icon.svg" alt="" width="84" height="84"><h1>バド基礎トレ</h1>
        <p class="muted">IDと数字4桁のパスワードでログイン</p></div>
      <div class="seg" style="margin-bottom:18px">
        <button class="plain ${!reg ? 'on' : ''}" data-act="login-tab" data-id="login">ログイン</button>
        <button class="plain ${reg ? 'on' : ''}" data-act="login-tab" data-id="register">新規登録</button>
      </div>
      <form id="login-form" class="card form-box" autocomplete="off">
        <div class="field"><label>ユーザーID（半角英数字 3〜20文字）</label>
          <input id="l-id" class="input" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="例：shin" value="${esc(loginId != null ? loginId : (lsGet('badtore.lastId') || ''))}"></div>
        ${reg ? `<div class="field"><label>表示名（みんなに見える名前）</label>
          <input id="l-name" class="input" placeholder="例：しん" value="${esc(loginName)}"></div>` : ''}
        <div class="field"><label>パスワード（数字4桁）</label>
          <input id="l-pin" class="input pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="••••"></div>
        ${reg ? `<div class="field"><label>パスワード（確認）</label>
          <input id="l-pin2" class="input pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="••••"></div>
          ${hasLocal ? `<div class="note">この端末の記録（${local.history.length}回分）とメニューを新しいアカウントに引き継ぎます</div>` : ''}` : ''}
        ${loginErr ? `<div class="err">${esc(loginErr)}</div>` : ''}
        <button class="btn" type="submit" ${loginBusy ? 'disabled' : ''}>${loginBusy ? '通信中…' : reg ? '登録してはじめる' : 'ログイン'}</button>
      </form>
      <button class="local-link" data-act="use-local">ログインせずにこの端末だけで使う</button>
    </div>`;
  app.querySelector('#login-form').addEventListener('submit', e => { e.preventDefault(); doLogin(); });
}
async function doLogin() {
  const reg = loginTab === 'register';
  const q = s => app.querySelector(s);
  const id = q('#l-id').value.trim().toLowerCase(), pin = q('#l-pin').value.trim();
  const name = q('#l-name') ? q('#l-name').value.trim() : '';
  loginId = id; loginName = name;
  loginErr = '';
  if (!/^[a-z0-9_-]{3,20}$/.test(id)) loginErr = 'IDは半角英数字・_・- の3〜20文字にしてください';
  else if (!/^\d{4}$/.test(pin)) loginErr = 'パスワードは数字4桁です';
  else if (reg && pin !== q('#l-pin2').value.trim()) loginErr = '確認用パスワードが一致しません';
  if (loginErr) { renderLogin(); return; }
  loginBusy = true; renderLogin();
  try {
    const body = reg
      ? { id, pin, name, data: normalize(lsGet(KEY)) || seed() }
      : { id, pin };
    const r = await api(reg ? '/api/register' : '/api/login', { method: 'POST', body });
    lsSet('badtore.lastId', id);
    setSession({ token: r.token, id: r.user.id, name: r.user.name });
    if (reg) { db = normalize(body.data); lsSet(cacheKey(), db); }
    else { db = load(); lsSet(dirtyKey(), null); }
    loginBusy = false; view = 'home'; render();
    toast(reg ? `ようこそ、${r.user.name}さん！` : `おかえりなさい、${r.user.name}さん`);
    if (!reg) pullFromServer();
  } catch (e) {
    loginBusy = false;
    loginErr = e.message + (e.status >= 500 ? '\n（サーバーの準備ができていない可能性があります。下の「ログインせずに使う」なら端末だけで使えます）' : '');
    renderLogin();
  }
}

/* ---------------- account ---------------- */
async function editName() {
  const v = await formDialog('表示名を変更', [{ key: 'name', label: '表示名', value: session.name }]);
  if (!v || !v.name) return;
  try { const r = await api('/api/me/profile', { method: 'PUT', body: { name: v.name } }); session.name = r.user.name; setSession(session); render(); toast('変更しました'); }
  catch (e) { toast(e.message); }
}
async function changePin() {
  const v = await formDialog('パスワードを変更', [
    { key: 'oldPin', label: '今のパスワード', pin: true },
    { key: 'newPin', label: '新しいパスワード（数字4桁）', pin: true },
    { key: 'newPin2', label: '新しいパスワード（確認）', pin: true },
  ], '変更する');
  if (!v) return;
  if (!/^\d{4}$/.test(v.newPin)) { toast('新しいパスワードは数字4桁です'); return; }
  if (v.newPin !== v.newPin2) { toast('確認用パスワードが一致しません'); return; }
  try { await api('/api/me/profile', { method: 'PUT', body: { oldPin: v.oldPin, newPin: v.newPin }, noLogout: true }); toast('パスワードを変更しました'); }
  catch (e) { toast(e.message); }
}
async function logout() {
  if (!(await confirmDlg('ログアウト', `${session.name}（@${session.id}）からログアウトしますか？`, 'ログアウト'))) return;
  if (lsGet(dirtyKey())) await syncNow();
  try { await api('/api/logout', { method: 'POST', noLogout: true }); } catch (e) {}
  lsSet(cacheKey(), null); lsSet(dirtyKey(), null);
  setSession(null); view = 'login'; loginTab = 'login'; loginErr = ''; render();
}
function accountCard() {
  if (online()) {
    return `<div class="card acct">
      <div class="avatar">${esc((session.name || session.id).slice(0, 1))}</div>
      <div style="flex:1;min-width:0"><b>${esc(session.name)}</b><div class="muted">@${esc(session.id)}</div></div>
    </div>
    <div class="acct-btns">
      <button class="btn white" data-act="acct-name">表示名を変更</button>
      <button class="btn white" data-act="acct-pin">パスワード変更</button>
      <button class="btn red" data-act="acct-logout">ログアウト</button>
    </div>`;
  }
  return `<div class="card acct"><div style="flex:1"><b>この端末だけで使っています</b>
      <div class="muted">ログインすると、みんなの記録を見たりメニューをもらえます。今の記録は新規登録で引き継げます。</div></div></div>
    <div class="acct-btns"><button class="btn blue" data-act="to-login">ログイン / 新規登録</button></div>`;
}

/* ---------------- members ---------------- */
let members = null, membersErr = '', memberQuery = '', member = null, memberOpen = {};
const ago = t => {
  if (!t) return 'まだ記録なし';
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? '今日' : d === 1 ? '昨日' : `${d}日前`;
};
const avatar = (u, big) => `<div class="avatar ${big ? 'big' : ''}" style="background:hsl(${[...u.id].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360} 70% 55%)">${esc((u.name || u.id).slice(0, 1))}</div>`;

async function loadMembers() {
  membersErr = '';
  try { members = (await api('/api/users')).users; }
  catch (e) { membersErr = e.message; }
  if (view === 'members') renderMemberList();
}
function renderMembers() {
  if (!online()) {
    app.innerHTML = `<div class="top"><h1>👥 みんな</h1></div>
      <div class="wrap"><div class="card empty">ログインすると、ほかの人のメニューや記録を見られます。
        <div style="margin-top:16px"><button class="btn blue" data-act="to-login">ログイン / 新規登録</button></div></div></div>${nav('members')}`;
    return;
  }
  app.innerHTML = `
    <div class="top"><h1>👥 みんな</h1><button class="tab" data-act="reload-members">更新</button></div>
    <div class="wrap">
      <input id="m-q" class="input" placeholder="IDか名前で探す" value="${esc(memberQuery)}" autocapitalize="off">
      <div id="m-list"></div>
    </div>${nav('members')}`;
  const qi = app.querySelector('#m-q');
  qi.addEventListener('input', () => { memberQuery = qi.value; renderMemberList(); });
  renderMemberList();
}
function renderMemberList() {
  const box = document.getElementById('m-list');
  if (!box) return;
  const qq = memberQuery.trim().toLowerCase();
  const list = (members || []).filter(u => !qq || u.id.includes(qq) || (u.name || '').toLowerCase().includes(qq));
  const rows = list.map(u => {
    const st = streak(new Set(u.summary.days));
    return `<div class="card member" data-act="open-member" data-id="${esc(u.id)}">
      ${avatar(u)}
      <div class="prog-body"><div class="prog-name">${esc(u.name)} ${u.id === session.id ? '<span class="badge mix">あなた</span>' : ''}</div>
        <div class="prog-meta">@${esc(u.id)}・合計${u.summary.total}回・最終 ${ago(u.summary.lastAt)}</div></div>
      <div class="m-streak ${st ? '' : 'off'}">🔥${st}</div>
    </div>`;
  }).join('');
  box.innerHTML = `
      <div class="sec-title">メンバー${members ? `（${list.length}人）` : ''}</div>
      ${membersErr ? `<div class="err">${esc(membersErr)}</div>` : ''}
      ${members ? (rows || '<div class="empty">見つかりませんでした</div>') : (membersErr ? '' : '<div class="empty">読み込み中…</div>')}`;
}
async function openMember(id) {
  member = { id, loading: true }; memberOpen = {};
  view = 'member'; render();
  try { member = await api('/api/users/' + encodeURIComponent(id)); }
  catch (e) { member = { id, error: e.message }; }
  if (view === 'member') renderMember();
}
function renderMember() {
  const back = `<div class="top"><button class="x" data-act="go-members" aria-label="戻る">‹</button><h1>メンバー</h1><div style="width:40px"></div></div>`;
  if (!member || member.loading || member.error) {
    app.innerHTML = back + `<div class="wrap"><div class="${member && member.error ? 'err' : 'empty'}">${esc(member && member.error ? member.error : '読み込み中…')}</div></div>${nav('members')}`;
    return;
  }
  const u = member.user, days = new Set(u.summary.days), me = u.id === session.id;
  const W = '日月火水木金土', today = new Date();
  let week = '';
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i), on = days.has(dayKey(d));
    week += `<div class="day">${W[d.getDay()]}<div class="dot ${on ? 'on' : ''} ${i === 0 ? 'today' : ''}">${on ? '✓' : ''}</div></div>`;
  }
  const progs = member.programs.map(p => {
    const c = progCat(p), open = memberOpen[p.id];
    return `<div class="card mprog">
      <div class="mprog-head" data-act="toggle-mprog" data-id="${esc(p.id)}">
        <div class="prog-ic ${c}">${CAT[c].emoji}</div>
        <div class="prog-body"><div class="prog-name">${esc(p.name)}</div>
          <div class="prog-meta"><span class="badge ${c}">${CAT[c].label}</span>　${p.items.length}種目・約${fmt(totalSec(p))}</div></div>
        <div class="chev">${open ? '▲' : '▼'}</div>
      </div>
      ${open ? `<ol class="mitems">${p.items.map(i => `<li><span class="badge ${i.category}">${CAT[i.category].label}</span> ${esc(i.name)} <b>${i.sec}秒</b>${i.interval ? `<span class="muted">（休${i.interval}秒）</span>` : ''}</li>`).join('')}</ol>` : ''}
      ${me ? '' : `<button class="btn blue small" data-act="copy-prog" data-id="${esc(p.id)}">＋ 自分のメニューに追加</button>`}
    </div>`;
  }).join('') || '<div class="empty">メニューはありません</div>';
  const logs = member.history.slice().reverse().slice(0, 30).map(h => {
    const dt = new Date(h.at);
    return `<div class="card log"><div><b>${esc(h.name)}</b><div class="muted">${dt.getMonth() + 1}/${dt.getDate()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}・${h.items}種目</div></div>
      <div class="muted">${fmt(h.sec || 0)}</div></div>`;
  }).join('') || '<div class="empty">まだ記録がありません</div>';
  app.innerHTML = back + `
    <div class="wrap">
      <div class="card profile">${avatar(u, true)}<div><div class="p-name">${esc(u.name)} ${me ? '<span class="badge mix">あなた</span>' : ''}</div><div class="muted">@${esc(u.id)}</div></div></div>
      <div class="tiles" style="margin-top:12px">
        <div class="card tile"><div class="v" style="color:var(--orange)">🔥 ${streak(days)}</div><div class="k">現在の連続日数</div></div>
        <div class="card tile"><div class="v">🏆 ${bestStreak(days)}</div><div class="k">最高連続日数</div></div>
        <div class="card tile"><div class="v">${u.summary.total}</div><div class="k">合計トレーニング回数</div></div>
        <div class="card tile"><div class="v">${Math.round(u.summary.totalSec / 60)}<small style="font-size:14px">分</small></div><div class="k">合計時間</div></div>
      </div>
      <div class="card week" style="margin:12px 0 0">${week}</div>
      <div class="sec-title">メニュー（${member.programs.length}）</div>
      ${progs}
      <div class="sec-title">最近の記録</div>
      ${logs}
    </div>${nav('members')}`;
}
async function copyProgram(pid) {
  const p = member.programs.find(x => x.id === pid);
  if (!p) return;
  if (!(await confirmDlg('自分のメニューに追加', `${member.user.name}さんの「${p.name}」（${p.items.length}種目）を自分のメニューに追加しますか？`, '追加する'))) return;
  db.programs.unshift({ id: uid(), name: p.name, items: p.items.map(i => ({ ...i, id: uid() })), from: { id: member.user.id, name: member.user.name } });
  save(); toast(`「${p.name}」を追加しました`);
}

/* ---------------- events ---------------- */
app.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  e.stopPropagation();
  const act = t.dataset.act, id = t.dataset.id;
  switch (act) {
    case 'go-home': view = 'home'; render(); break;
    case 'go-history': view = 'history'; render(); break;
    case 'go-members': view = 'members'; render(); if (online()) loadMembers(); break;
    case 'reload-members': members = null; renderMemberList(); loadMembers(); break;
    case 'open-member': openMember(id); break;
    case 'toggle-mprog': memberOpen[id] = !memberOpen[id]; { const y = window.scrollY; renderMember(); window.scrollTo(0, y); } break;
    case 'copy-prog': copyProgram(id); break;
    case 'login-tab': loginTab = id; loginErr = ''; renderLogin(); break;
    case 'use-local': setSession({ local: true }); db = load(); view = 'home'; render(); break;
    case 'to-login': setSession(null); view = 'login'; loginErr = ''; render(); break;
    case 'acct-name': editName(); break;
    case 'acct-pin': changePin(); break;
    case 'acct-logout': logout(); break;
    case 'filter': homeFilter = id; render(); break;
    case 'start': startProgram(id); break;
    case 'edit': openEditor(id); break;
    case 'more': programMenu(id); break;
    case 'new': openEditor(null); break;
    // editor
    case 'cat': readForm(); E.form.category = id; render(); break;
    case 'preset': app.querySelector('#f-name').value = id; break;
    case 'sec': { const el = app.querySelector('#f-sec'); el.value = Math.max(5, (parseInt(el.value, 10) || 0) + +id); break; }
    case 'sec-set': app.querySelector('#f-sec').value = id; break;
    case 'isec': { const el = app.querySelector('#f-int'); el.value = Math.max(5, (parseInt(el.value, 10) || 0) + +id); break; }
    case 'isec-set': app.querySelector('#f-int').value = id; break;
    case 'int': readForm(); E.form.useInt = id === '1'; render(); break;
    case 'add-next': addNext(); break;
    case 'finish-edit': finishEdit(); break;
    case 'edit-item': startEditItem(+id); break;
    case 'update-item': if (updateItem()) { render(); toast('更新しました'); } break;
    case 'cancel-item': cancelItem(); break;
    case 'up': moveItem(+id, -1); break;
    case 'down': moveItem(+id, 1); break;
    case 'del-item': deleteItem(+id); break;
    case 'cancel-edit':
      confirmDlg('編集をやめる', '保存せずにホームに戻りますか？', '戻る').then(ok => { if (ok) { E = null; view = 'home'; render(); } });
      break;
    case 'del-prog':
      deleteProgram(E.id).then(ok => { if (ok) { E = null; view = 'home'; render(); } });
      break;
    // player
    case 'pause': togglePause(); break;
    case 'skip': if (P && !P.paused) nextPhase(); break;
    case 'quit':
      if (P && !P.paused) togglePause();
      confirmDlg('トレーニングを中止', '中止しますか？（記録は残りません）', '中止する', true)
        .then(ok => { if (ok) { stopPlayer(); view = 'home'; render(); } else if (P && P.paused) togglePause(); });
      break;
    case 'voice':
      db.settings.voice = !db.settings.voice; save();
      if (!db.settings.voice) try { speechSynthesis.cancel(); } catch (er) {}
      t.textContent = db.settings.voice ? '🔊' : '🔇'; break;
    case 'voice-set': db.settings.voice = !db.settings.voice; save(); render(); break;
    case 'del-log': {
      const h = db.history.find(x => x.id === id);
      if (!h) break;
      const dt = new Date(h.at);
      confirmDlg('記録を削除', `${dt.getMonth() + 1}/${dt.getDate()}「${h.name}」の記録を削除しますか？\n連続日数にも反映されます。`, '削除する', true)
        .then(ok => { if (ok) { db.history = db.history.filter(x => x.id !== id); save(); render(); toast('記録を削除しました'); } });
      break;
    }
    case 'cal': calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + +id, 1); render(); break;
  }
});

if (!session) view = 'login';
render();
pullFromServer();

/* ---------------- PWA ---------------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.__NO_SW__) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
