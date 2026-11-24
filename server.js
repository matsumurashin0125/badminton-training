'use strict';
/* =========================================================
   KOSO REN TRAINING サーバー
   - public/ の静的ファイル配信
   - /api/* : アカウント（追加・名前変更・削除）、データ同期、メンバー閲覧
     ※ パスワードなし。最初にアカウントを選ぶだけの簡易方式
   保存先: Cloud Run 上では Cloud Storage（環境変数 BUCKET）、ローカルでは data/db.json
   ========================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 900 * 1024;

/* ---------------- storage ---------------- */
function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  let db = { users: {}, userdata: {} };
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
    async deleteUser(id) { delete db.users[id]; delete db.userdata[id]; persist(); },
  };
}

// Cloud Storage: バケットに users/<id>.json と userdata/<id>.json を置く
function gcsStore(bucketName) {
  const { Storage } = require('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  const uFile = id => bucket.file(`users/${id}.json`);
  const dFile = id => bucket.file(`userdata/${id}.json`);
  const opts = { contentType: 'application/json; charset=utf-8', resumable: false, metadata: { cacheControl: 'no-store' } };
  async function read(file) {
    try { const [buf] = await file.download(); return JSON.parse(buf.toString('utf8')); }
    catch (e) { if (e.code === 404) return null; throw e; }
  }
  const write = (file, obj) => file.save(JSON.stringify(obj), opts);
  return {
    getUser: id => read(uFile(id)),
    async createUser(u) {
      // ifGenerationMatch: 0 = まだ存在しないときだけ作成（同じIDの上書き防止）
      try { await uFile(u.id).save(JSON.stringify(u), { ...opts, preconditionOpts: { ifGenerationMatch: 0 } }); return true; }
      catch (e) { if (e.code === 412) return false; throw e; }
    },
    async updateUser(id, patch) {
      const u = await read(uFile(id));
      if (u) await write(uFile(id), { ...u, ...patch });
    },
    async listUsers() {
      const [files] = await bucket.getFiles({ prefix: 'users/' });
      const list = await Promise.all(files.filter(f => f.name.endsWith('.json')).map(f => read(f).catch(() => null)));
      return list.filter(Boolean);
    },
    getData: id => read(dFile(id)),
    setData: (id, data) => write(dFile(id), data),
    async deleteUser(id) {
      await dFile(id).delete({ ignoreNotFound: true });
      await uFile(id).delete({ ignoreNotFound: true });
    },
  };
}

// 保存先の決定: BUCKET があれば Cloud Storage、ローカルではファイル。
// Cloud Run で BUCKET 未設定だとデータが消えるので、API を止めて知らせる
const BUCKET = process.env.BUCKET;
const STORE = process.env.STORE || (BUCKET ? 'gcs' : process.env.K_SERVICE ? 'none' : 'file');
const store = STORE === 'gcs' ? gcsStore(BUCKET) : STORE === 'file' ? fileStore() : null;
console.log(`storage: ${STORE}${BUCKET ? ' (' + BUCKET + ')' : ''}`);

/* ---------------- helpers ---------------- */
const ID_RE = /^[a-z0-9_-]{3,20}$/;
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

/* ---------------- API ---------------- */
const userPath = /^\/api\/users\/([a-z0-9_-]{3,20})(\/data)?$/;
const newId = () => 'u' + crypto.randomBytes(4).toString('hex');

async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  if (!store) throw new HttpError(503, '保存先が設定されていません。Cloud Run の環境変数 BUCKET に Cloud Storage のバケット名を設定してください');

  // アカウント一覧
  if (p === '/api/users' && M === 'GET') {
    const list = (await store.listUsers()).map(publicUser)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return send(res, 200, { users: list });
  }

  // アカウント追加 { name, id?, data? }
  if (p === '/api/users' && M === 'POST') {
    const b = await readBody(req);
    const name = str(b.name, 30).trim();
    if (!name) throw new HttpError(400, '名前を入力してください');
    let id = str(b.id, 40).trim().toLowerCase();
    if (id && !ID_RE.test(id)) throw new HttpError(400, 'IDは半角英数字・_・- の3〜20文字にしてください（空欄なら自動で決めます）');
    const data = cleanData(b.data || {});
    for (let i = 0; i < 5; i++) {
      const uidv = id || newId();
      const user = { id: uidv, name, createdAt: Date.now(), summary: summarize(data) };
      if (await store.createUser(user)) {
        await store.setData(uidv, { ...data, updatedAt: Date.now() });
        return send(res, 200, { user: publicUser(user) });
      }
      if (id) throw new HttpError(409, 'そのIDはすでに使われています');
    }
    throw new HttpError(500, 'IDを作れませんでした。もう一度試してください');
  }

  const m = userPath.exec(p);
  if (m) {
    const id = m[1], isData = !!m[2];
    const u = await store.getUser(id);
    if (!u) throw new HttpError(404, 'そのアカウントは見つかりません（削除された可能性があります）');

    if (!isData && M === 'GET') {          // その人のメニューと記録
      const data = (await store.getData(id)) || cleanData({});
      return send(res, 200, { user: publicUser(u), programs: data.programs, history: data.history, settings: data.settings });
    }
    if (!isData && M === 'PUT') {          // 名前変更
      const b = await readBody(req);
      const name = str(b.name, 30).trim();
      if (!name) throw new HttpError(400, '名前を入力してください');
      await store.updateUser(id, { name });
      return send(res, 200, { user: publicUser({ ...u, name }) });
    }
    if (!isData && M === 'DELETE') {       // アカウント削除（記録も消える）
      await store.deleteUser(id);
      return send(res, 200, { ok: true });
    }
    if (isData && M === 'PUT') {           // データ保存
      const data = cleanData(await readBody(req));
      const updatedAt = Date.now();
      await store.setData(id, { ...data, updatedAt });
      await store.updateUser(id, { summary: summarize(data) });
      return send(res, 200, { ok: true, updatedAt });
    }
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
