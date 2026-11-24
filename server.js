'use strict';
/* =========================================================
   バド基礎トレ サーバー
   - public/ の静的ファイル配信
   - /api/* : ID + 4桁PIN ログイン、データ同期、メンバー閲覧
   保存先: Cloud Run 上では Firestore、ローカルでは data/db.json
   ========================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const STORE = process.env.STORE || (process.env.K_SERVICE ? 'firestore' : 'file');
const MAX_FAILS = 5;                    // PINを続けて間違えられる回数
const LOCK_MS = 15 * 60 * 1000;         // ロック時間
const SESSION_MS = 180 * 24 * 3600 * 1000;
const MAX_BODY = 900 * 1024;

/* ---------------- storage ---------------- */
function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  let db = { users: {}, userdata: {}, sessions: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(db));
    }, 50);
  };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    async getUser(id) { return clone(db.users[id]); },
    async createUser(u) { if (db.users[u.id]) return false; db.users[u.id] = u; persist(); return true; },
    async updateUser(id, patch) { Object.assign(db.users[id], patch); persist(); },
    async listUsers() { return Object.values(db.users).map(clone); },
    async getData(id) { return clone(db.userdata[id]); },
    async setData(id, data) { db.userdata[id] = data; persist(); },
    async getSession(h) { return clone(db.sessions[h]); },
    async setSession(h, s) { db.sessions[h] = s; persist(); },
    async deleteSession(h) { delete db.sessions[h]; persist(); },
  };
}

function firestoreStore() {
  const { Firestore } = require('@google-cloud/firestore');
  const fsdb = new Firestore(process.env.FIRESTORE_DATABASE ? { databaseId: process.env.FIRESTORE_DATABASE } : {});
  const users = fsdb.collection('users');
  const userdata = fsdb.collection('userdata');
  const sessions = fsdb.collection('sessions');
  const get = async ref => { const s = await ref.get(); return s.exists ? s.data() : null; };
  return {
    getUser: id => get(users.doc(id)),
    async createUser(u) {
      try { await users.doc(u.id).create(u); return true; }
      catch (e) { if (e.code === 6) return false; throw e; }   // 6 = ALREADY_EXISTS
    },
    updateUser: (id, patch) => users.doc(id).set(patch, { merge: true }),
    async listUsers() { const q = await users.get(); return q.docs.map(d => d.data()); },
    getData: id => get(userdata.doc(id)),
    setData: (id, data) => userdata.doc(id).set(data),
    getSession: h => get(sessions.doc(h)),
    setSession: (h, s) => sessions.doc(h).set(s),
    deleteSession: h => sessions.doc(h).delete(),
  };
}

const store = STORE === 'firestore' ? firestoreStore() : fileStore();
console.log(`storage: ${STORE}`);

/* ---------------- helpers ---------------- */
const ID_RE = /^[a-z0-9_-]{3,20}$/;
const PIN_RE = /^\d{4}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const checkPin = (pin, u) => {
  const a = Buffer.from(hashPin(pin, u.salt), 'hex'), b = Buffer.from(u.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'データが大きすぎます')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, 'JSONが不正です')); }
    });
    req.on('error', reject);
  });
}
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

// クライアントから来たデータを整形（想定外の値を捨てる）
function cleanItem(i) {
  return { id: str(i.id, 20), category: i.category === 'foot' ? 'foot' : 'core', name: str(i.name, 40), sec: num(i.sec, 1, 3600), interval: num(i.interval, 0, 3600) };
}
function cleanProgram(p) {
  const out = { id: str(p.id, 20), name: str(p.name, 40), items: (Array.isArray(p.items) ? p.items : []).slice(0, 50).map(cleanItem) };
  if (p.from) out.from = { id: str(p.from.id, 20), name: str(p.from.name, 30) };
  return out;
}
function cleanData(d) {
  return {
    programs: (Array.isArray(d.programs) ? d.programs : []).slice(0, 100).map(cleanProgram),
    history: (Array.isArray(d.history) ? d.history : []).slice(-3000).map(h => ({
      id: str(h.id, 20), day: str(h.day, 10), at: num(h.at, 0, 9e15), programId: str(h.programId, 20),
      name: str(h.name, 40), sec: num(h.sec, 0, 86400), items: num(h.items, 0, 100),
    })).filter(h => /^\d{4}-\d{2}-\d{2}$/.test(h.day)),
    settings: { voice: !(d.settings && d.settings.voice === false) },
  };
}
// メンバー一覧用の集計（連続日数はクライアント側で days から計算）
function summarize(data) {
  const days = [...new Set(data.history.map(h => h.day))].sort().slice(-400);
  const last = data.history.reduce((a, h) => Math.max(a, h.at), 0);
  return {
    days, total: data.history.length,
    totalSec: data.history.reduce((a, h) => a + h.sec, 0),
    lastAt: last || null, programCount: data.programs.length,
  };
}
const publicUser = u => ({
  id: u.id, name: u.name, createdAt: u.createdAt,
  summary: u.summary || { days: [], total: 0, totalSec: 0, lastAt: null, programCount: 0 },
});

async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await store.setSession(sha(token), { userId, exp: Date.now() + SESSION_MS });
  return token;
}
async function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'ログインしてください');
  const s = await store.getSession(sha(m[1]));
  if (!s || s.exp < Date.now()) throw new HttpError(401, 'ログインの有効期限が切れました');
  const u = await store.getUser(s.userId);
  if (!u) throw new HttpError(401, 'ユーザーが見つかりません');
  return { user: u, hash: sha(m[1]) };
}

// IPごとの簡易レート制限（総当たり対策の補助）
const ipHits = new Map();
function rateLimit(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (ipHits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); ipHits.set(ip, arr);
  if (arr.length > 30) throw new HttpError(429, '試行回数が多すぎます。しばらく待ってから試してください');
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const p = url.pathname, M = req.method;

  if (p === '/api/register' && M === 'POST') {
    rateLimit(req);
    const b = await readBody(req);
    const id = str(b.id, 40).trim().toLowerCase(), name = str(b.name, 30).trim() || id, pin = str(b.pin, 10);
    if (!ID_RE.test(id)) throw new HttpError(400, 'IDは半角英数字・_・- の3〜20文字にしてください');
    if (!PIN_RE.test(pin)) throw new HttpError(400, 'パスワードは数字4桁にしてください');
    const salt = crypto.randomBytes(16).toString('hex');
    const data = cleanData(b.data || {});
    const user = { id, name, salt, pinHash: hashPin(pin, salt), createdAt: Date.now(), fails: 0, lockUntil: 0, summary: summarize(data) };
    if (!(await store.createUser(user))) throw new HttpError(409, 'そのIDはすでに使われています');
    await store.setData(id, { ...data, updatedAt: Date.now() });
    return send(res, 200, { token: await newSession(id), user: publicUser(user) });
  }

  if (p === '/api/login' && M === 'POST') {
    rateLimit(req);
    const b = await readBody(req);
    const id = str(b.id, 40).trim().toLowerCase(), pin = str(b.pin, 10);
    const u = ID_RE.test(id) ? await store.getUser(id) : null;
    if (!u) throw new HttpError(401, 'IDかパスワードが違います');
    if (u.lockUntil > Date.now()) {
      throw new HttpError(423, `パスワードを${MAX_FAILS}回間違えたため、${Math.ceil((u.lockUntil - Date.now()) / 60000)}分間ロック中です`);
    }
    if (!checkPin(pin, u)) {
      const fails = (u.fails || 0) + 1;
      await store.updateUser(id, fails >= MAX_FAILS ? { fails: 0, lockUntil: Date.now() + LOCK_MS } : { fails });
      throw new HttpError(401, fails >= MAX_FAILS ? `${MAX_FAILS}回間違えたため15分間ロックしました` : `IDかパスワードが違います（あと${MAX_FAILS - fails}回）`);
    }
    if (u.fails) await store.updateUser(id, { fails: 0, lockUntil: 0 });
    return send(res, 200, { token: await newSession(id), user: publicUser(u) });
  }

  // ---- 以降はログイン必須 ----
  const { user, hash } = await auth(req);

  if (p === '/api/logout' && M === 'POST') { await store.deleteSession(hash); return send(res, 200, { ok: true }); }

  if (p === '/api/me' && M === 'GET') {
    const data = (await store.getData(user.id)) || cleanData({});
    return send(res, 200, { user: publicUser(user), data });
  }

  if (p === '/api/me/data' && M === 'PUT') {
    const data = cleanData(await readBody(req));
    const updatedAt = Date.now();
    await store.setData(user.id, { ...data, updatedAt });
    await store.updateUser(user.id, { summary: summarize(data) });
    return send(res, 200, { ok: true, updatedAt });
  }

  if (p === '/api/me/profile' && M === 'PUT') {
    const b = await readBody(req);
    const patch = {};
    if (b.name !== undefined) {
      const name = str(b.name, 30).trim();
      if (!name) throw new HttpError(400, '表示名を入力してください');
      patch.name = name;
    }
    if (b.newPin !== undefined) {
      if (!checkPin(str(b.oldPin, 10), user)) throw new HttpError(400, '今のパスワードが違います');
      if (!PIN_RE.test(str(b.newPin, 10))) throw new HttpError(400, '新しいパスワードは数字4桁にしてください');
      patch.salt = crypto.randomBytes(16).toString('hex');
      patch.pinHash = hashPin(b.newPin, patch.salt);
    }
    await store.updateUser(user.id, patch);
    return send(res, 200, { user: publicUser({ ...user, ...patch }) });
  }

  if (p === '/api/users' && M === 'GET') {
    const list = (await store.listUsers()).map(publicUser)
      .sort((a, b) => (b.summary.lastAt || 0) - (a.summary.lastAt || 0));
    return send(res, 200, { users: list });
  }

  const m = /^\/api\/users\/([a-z0-9_-]{3,20})$/.exec(p);
  if (m && M === 'GET') {
    const u = await store.getUser(m[1]);
    if (!u) throw new HttpError(404, 'そのIDのユーザーはいません');
    const data = (await store.getData(u.id)) || cleanData({});
    return send(res, 200, { user: publicUser(u), programs: data.programs, history: data.history.slice(-100) });
  }

  throw new HttpError(404, 'Not found');
}

/* ---------------- static ---------------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC, 'index.html');
  }
  const ext = path.extname(file);
  const noCache = ext === '.html' || file.endsWith('sw.js');
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------------- server ---------------- */
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'サーバーエラーが発生しました' });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
}).listen(PORT, () => console.log(`listening on :${PORT}`));
