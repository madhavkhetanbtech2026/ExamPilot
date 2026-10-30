// ExamPilot server: serves the website and a safe /api/chat proxy. No npm packages needed (Node 18+).
// PROVIDER = gemini (default) | groq | anthropic.  Set API_KEY and MODEL as environment variables.
// Optional: FALLBACK_MODEL, PER_MINUTE (default 12 per visitor), THINKING_LEVEL (minimal|low|medium|high|off), TIMEOUT_MS.
// Shared leaderboard storage (optional but recommended on Render free tier, whose disk is wiped on restart):
//   UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (free database at upstash.com). Without them, profiles are kept in
//   memory and in data.json, which can reset when Render restarts the service.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const PROVIDER = (process.env.PROVIDER || "gemini").toLowerCase();
const KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL, FALLBACK = process.env.FALLBACK_MODEL;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const LIMIT = +(process.env.PER_MINUTE || 12);
const THINK = (process.env.THINKING_LEVEL || "minimal").toLowerCase();
const TIMEOUT = +(process.env.TIMEOUT_MS || 25000);
const GBASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta/models/";
const noThink = new Set(); // models that rejected the thinking setting
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- rate limiting (rejected requests are not counted) ---- */
const buckets = new Map();
function rate(key, limit, ms = 60000) {
  const now = Date.now(), r = (buckets.get(key) || []).filter(t => now - t < ms);
  if (r.length >= limit) { buckets.set(key, r); return true; }
  r.push(now); buckets.set(key, r); return false;
}
const limited = ip => rate("chat:" + ip, LIMIT);
setInterval(() => { const n = Date.now(); for (const [k, v] of buckets) if (!v.some(t => n - t < 60000)) buckets.delete(k); }, 60000).unref();

/* ---- profiles + shared leaderboard storage ----
   A profile holds ONLY: display name, a hash of the browser's secret token, and activity counters. No PRN, no email. */
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const KV_URL = process.env.UPSTASH_REDIS_REST_URL, KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const sha = x => crypto.createHash("sha256").update(String(x)).digest("hex");
let profiles = {};
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: "Bearer " + KV_TOKEN, "content-type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(8000) });
  const d = await r.json(); if (d.error) throw new Error(d.error); return d.result;
}
const STORAGE = KV_URL && KV_TOKEN ? "database" : "file";
(async () => {
  try {
    if (STORAGE === "database") { const v = await kv(["GET", "ep:profiles"]); if (v) profiles = JSON.parse(v); }
    else if (fs.existsSync(DATA_FILE)) profiles = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    console.log("profiles loaded:", Object.keys(profiles).length, "(storage: " + STORAGE + ")");
  } catch (e) { console.error("load failed:", e.message); }
})();
let saveT = null;
function saveSoon() {
  if (saveT) return;
  saveT = setTimeout(async () => {
    saveT = null; const data = JSON.stringify(profiles);
    try { if (STORAGE === "database") await kv(["SET", "ep:profiles", data]); else fs.writeFileSync(DATA_FILE, data); }
    catch (e) { console.error("save failed:", e.message); }
  }, 2000);
}
const blank = () => ({ q: 0, g: 0, f: 0, quiz: 0, pyq: 0, grp: 0, rs: 0, rn: 0 });
// Same formula as the website: active-thinking points x autonomy ratio, so volume AND quality both matter.
function calc(st) {
  const qf = st.rn > 0 ? Math.max(0.2, (st.rs / st.rn) / 5) : 1;
  const w = st.g * 1.5 + st.quiz * 1.2 * qf + st.pyq * 2 + st.grp * 2.5, pen = st.f * 2, tot = w + pen;
  const ratio = tot > 0 ? Math.min(100, Math.max(10, Math.round(w / tot * 100))) : null;
  return { ratio, pts: ratio === null ? 0 : Math.round(w * ratio / 10) };
}
const okId = x => typeof x === "string" && /^[a-f0-9]{16}$/.test(x);
const okTok = x => typeof x === "string" && x.length >= 24 && x.length <= 128;
const cleanName = n => String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 30);
const cleanText = (n, max) => String(n || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
function authProfile(id, tok) { const p = okId(id) && okTok(tok) ? profiles[id] : null; return p && p.h === sha(tok) ? p : null; }
// Activity is counted by the SERVER, only when a real AI call succeeds, so it cannot be inflated by editing the page.
function bump(pr, kind, text) {
  if (!pr) return; const p = authProfile(pr.id, pr.token); if (!p) return; const s = p.stats;
  if (kind === "guided") { s.g++; s.q++; }
  else if (kind === "full") { s.f++; s.q++; }
  else if (kind === "pyq") s.pyq++;
  else if (kind === "quiz") {
    s.quiz++;
    try { const r = +JSON.parse(String(text).replace(/```json|```/g, "").trim()).rating; if (r >= 1 && r <= 5) { s.rs += r; s.rn++; } } catch (_) {}
  } else return;
  p.updated = Date.now(); saveSoon();
}

/* ---- live peer rooms (Six Thinking Hats) - kept in memory, expire after 6 hours of silence ---- */
const rooms = new Map();
const HATS = ["Blue", "White", "Red", "Black", "Yellow", "Green"]; // host starts as Blue (process control)
function newCode() { const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; for (;;) { let c = ""; for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)]; if (!rooms.has(c)) return c; } }
const hatOf = (r, i) => HATS[(i + r.rot) % 6];
function roomView(r, since) {
  return { code: r.code, topic: r.topic, rot: r.rot, total: r.msgs.length,
    members: r.members.map((m, i) => ({ id: m.id, name: m.name, hat: hatOf(r, i), host: i === 0 })), msgs: r.msgs.slice(since) };
}
setInterval(() => { const n = Date.now(); for (const [k, r] of rooms) if (n - r.last > 6 * 3600e3) rooms.delete(k); }, 600e3).unref();
function joinRoom(r, uid, tok, name) {
  let m = r.members.find(x => x.id === uid);
  if (m) { if (m.h !== sha(tok)) throw { status: 403, msg: "That name in this room belongs to another browser." }; m.name = name; return false; }
  if (r.members.length >= 6) throw { status: 409, msg: "This room already has 6 members (one per hat)." };
  r.members.push({ id: uid, name, h: sha(tok) });
  const p = authProfile(uid, tok);
  if (p && !(p.rooms || []).includes(r.code)) { p.stats.grp++; p.rooms = (p.rooms || []).concat(r.code).slice(-50); p.updated = Date.now(); saveSoon(); }
  return true;
}
function needMember(r, uid, tok) {
  const m = okId(uid) && okTok(tok) ? r.members.find(x => x.id === uid) : null;
  if (!m || m.h !== sha(tok)) throw { status: 403, msg: "You are not a member of this room." };
  return m;
}
function addMsg(r, o) { if (r.msgs.length >= 400) throw { status: 409, msg: "This room is full of messages. Start a new room." }; r.msgs.push({ n: r.msgs.length, t: Date.now(), ...o }); r.last = Date.now(); }

async function api(req, res, url, q) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  if (rate("api:" + ip, 120)) throw { status: 429, msg: "Too many requests. Wait a moment." };
  if (url === "/api/leaderboard") {
    const rows = Object.entries(profiles).map(([id, p]) => { const c = calc(p.stats); return { id, name: p.name, ratio: c.ratio, rooms: p.stats.grp, pts: c.pts, rated: p.stats.rn }; })
      .sort((a, b) => b.pts - a.pts).slice(0, 50);
    return send(res, 200, { rows, storage: STORAGE });
  }
  if (url === "/api/room/state") {
    const r = rooms.get(String(q.get("code") || "").toUpperCase());
    if (!r) throw { status: 404, msg: "Room not found or expired." };
    return send(res, 200, roomView(r, Math.max(0, parseInt(q.get("since")) || 0)));
  }
  const b = await readJson(req), uid = b.uid || (b.profile && b.profile.id);
  if (url === "/api/profile/register") {
    const name = cleanName(b.name);
    if (name.length < 2) throw { status: 400, msg: "Enter a display name of at least 2 characters." };
    if (!okId(b.uid) || !okTok(b.token)) throw { status: 400, msg: "Bad identity." };
    const ex = profiles[b.uid];
    if (ex) { if (ex.h !== sha(b.token)) throw { status: 403, msg: "Identity mismatch." }; ex.name = name; }
    else { if (Object.keys(profiles).length >= 3000) throw { status: 503, msg: "Leaderboard is full." }; profiles[b.uid] = { name, h: sha(b.token), stats: blank(), created: Date.now(), updated: Date.now() }; }
    saveSoon(); return send(res, 200, { ok: true });
  }
  if (url === "/api/profile/delete") {
    if (!authProfile(b.uid, b.token)) throw { status: 403, msg: "Profile not found." };
    delete profiles[b.uid]; saveSoon(); return send(res, 200, { ok: true });
  }
  if (url === "/api/room/create") {
    if (rate("room:" + ip, 10)) throw { status: 429, msg: "Too many rooms created. Wait a minute." };
    const name = cleanName(b.name), topic = cleanText(b.topic, 150);
    if (name.length < 2) throw { status: 400, msg: "Enter your display name first." };
    if (topic.length < 3) throw { status: 400, msg: "Enter a topic to debate." };
    if (!okId(b.uid) || !okTok(b.token)) throw { status: 400, msg: "Bad identity." };
    if (rooms.size > 500) throw { status: 503, msg: "Server is busy. Try again later." };
    const r = { code: newCode(), topic, rot: 0, members: [], msgs: [], last: Date.now() };
    joinRoom(r, b.uid, b.token, name); rooms.set(r.code, r);
    addMsg(r, { sys: true, text: name + " opened the room. Host wears the Blue Hat (process). Share code " + r.code + "." });
    return send(res, 200, roomView(r, 0));
  }
  const r = rooms.get(String(b.code || "").toUpperCase());
  if (url.startsWith("/api/room/")) {
    if (!r) throw { status: 404, msg: "Room not found or expired." };
    if (url === "/api/room/join") {
      const name = cleanName(b.name); if (name.length < 2) throw { status: 400, msg: "Enter your display name first." };
      if (!okId(b.uid) || !okTok(b.token)) throw { status: 400, msg: "Bad identity." };
      if (joinRoom(r, b.uid, b.token, name)) addMsg(r, { sys: true, text: name + " joined as " + hatOf(r, r.members.length - 1) + " Hat." });
      return send(res, 200, roomView(r, 0));
    }
    const m = needMember(r, b.uid, b.token), i = r.members.indexOf(m);
    if (url === "/api/room/say") {
      if (rate("say:" + b.uid, 20)) throw { status: 429, msg: "You are sending messages too fast." };
      const text = cleanText(b.text, 600); if (!text) throw { status: 400, msg: "Write something first." };
      addMsg(r, { id: m.id, name: m.name, hat: hatOf(r, i), text }); return send(res, 200, { ok: true });
    }
    if (url === "/api/room/rotate") {
      if (i !== 0) throw { status: 403, msg: "Only the host can rotate hats." };
      r.rot = (r.rot + 1) % 6; addMsg(r, { sys: true, text: "Hats rotated. Everyone now wears the next hat." }); return send(res, 200, { ok: true });
    }
  }
  throw { status: 404, msg: "Unknown endpoint." };
}
function readJson(req) {
  return new Promise((ok, no) => {
    let b = ""; req.on("data", c => { b += c; if (b.length > 50000) { req.destroy(); no({ status: 413, msg: "Too large" }); } });
    req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch (_) { no({ status: 400, msg: "Bad JSON" }); } });
    req.on("error", () => no({ status: 400, msg: "Bad request" }));
  });
}

const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify(obj));
}
function norm(e) { // turn timeouts / network errors into a status code
  if (e && e.status) return e;
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return { status: 504, d: "timeout" };
  return { status: 502, d: String(e && e.message || e) };
}
function friendly(e) {
  switch (e.status) {
    case 429: return "The AI is busy right now (free-tier limit). Wait about 30 seconds and try again.";
    case 504: return "The AI took too long to respond. Please try again.";
    case 401: case 403: return "The server's API key was rejected. The site owner needs to check API_KEY.";
    case 404: return "AI model not found. The site owner needs to check MODEL / FALLBACK_MODEL.";
    case 400: return "The AI could not process that request. Try rephrasing it.";
    default: return "AI request failed. Please try again shortly.";
  }
}

/* ---- build the provider request ---- */
function build(msgs, model, opt) {
  const headers = { "content-type": "application/json" };
  const maxTok = opt.json ? 3500 : 1500;
  if (PROVIDER === "gemini") {
    const gc = { maxOutputTokens: maxTok };
    if (opt.json) gc.responseMimeType = "application/json";
    if (THINK !== "off" && !noThink.has(model)) gc.thinkingConfig = { thinkingLevel: THINK };
    headers["x-goog-api-key"] = KEY;
    return {
      url: GBASE + model + (opt.stream ? ":streamGenerateContent?alt=sse" : ":generateContent"), headers,
      body: { contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: gc },
      pick: d => ((d.candidates || [])[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("")
    };
  }
  if (PROVIDER === "groq") {
    headers.authorization = "Bearer " + KEY;
    return { url: "https://api.groq.com/openai/v1/chat/completions", headers, body: { model, messages: msgs, max_tokens: maxTok }, pick: d => d.choices?.[0]?.message?.content || "" };
  }
  headers["x-api-key"] = KEY; headers["anthropic-version"] = "2023-06-01";
  return { url: "https://api.anthropic.com/v1/messages", headers, body: { model, max_tokens: maxTok, messages: msgs }, pick: d => (d.content || []).filter(c => c.type === "text").map(c => c.text).join("") };
}
async function call(msgs, model, opt) {
  for (let pass = 0; pass < 2; pass++) {
    const q = build(msgs, model, opt);
    const r = await fetch(q.url, { method: "POST", headers: q.headers, body: JSON.stringify(q.body), signal: AbortSignal.timeout(opt.stream ? 60000 : TIMEOUT) });
    if (r.ok) return { r, q };
    let d = null; try { d = await r.json(); } catch (_) {}
    // model does not support the thinking setting: remember it and retry once without it
    if (r.status === 400 && PROVIDER === "gemini" && !noThink.has(model) && /think/i.test(JSON.stringify(d))) { noThink.add(model); continue; }
    throw { status: r.status, d };
  }
}

/* ---- normal (non-streaming) answer with fast fallback ---- */
async function robust(msgs, opt = {}) {
  const models = [MODEL, FALLBACK].filter(Boolean);
  let last;
  for (const m of models) {
    for (let i = 0; i < 2; i++) {
      try {
        const { r, q } = await call(msgs, m, opt);
        const t = q.pick(await r.json());
        if (!t.trim()) throw { status: 502, d: "empty answer" };
        return t;
      } catch (e) {
        e = norm(e); last = e; console.error(m, e.status, JSON.stringify(e.d || "").slice(0, 300));
        if (e.status === 429 || e.status === 404) break;            // quota used up or bad name: go to fallback model now
        if (![500, 502, 503, 504].includes(e.status)) throw e;       // other errors (400, 401...) will not fix themselves
        await sleep(500);
      }
    }
  }
  throw last;
}

/* ---- streaming answer (text appears while it is being written) ---- */
async function streamAnswer(res, msgs, onDone) {
  if (PROVIDER !== "gemini") { // other providers: send the whole answer as one chunk
    const t = await robust(msgs);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors });
    res.write("data: " + JSON.stringify({ t }) + "\n\ndata: {\"done\":true}\n\n"); if (onDone) onDone(t); return res.end();
  }
  const models = [MODEL, FALLBACK].filter(Boolean);
  let last = { status: 500 };
  for (const m of models) {
    try {
      const { r } = await call(msgs, m, { stream: true });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...cors });
      const dec = new TextDecoder(); let buf = "", any = false;
      try {
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const d = JSON.parse(line.slice(5));
              const t = ((d.candidates || [])[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
              if (t) { any = true; res.write("data: " + JSON.stringify({ t }) + "\n\n"); }
            } catch (_) {}
          }
        }
      } catch (e) { e = norm(e); console.error("stream", m, e.status); res.write("data: " + JSON.stringify({ error: friendly(e), status: e.status }) + "\n\n"); return res.end(); }
      if (!any) res.write("data: " + JSON.stringify({ error: "The AI returned an empty answer. Please try again.", status: 502 }) + "\n\n");
      else { res.write("data: {\"done\":true}\n\n"); if (onDone) onDone(""); }
      return res.end();
    } catch (e) {
      e = norm(e); last = e; console.error(m, e.status, JSON.stringify(e.d || "").slice(0, 300));
      if (![429, 404, 500, 502, 503, 504].includes(e.status)) break;
    }
  }
  send(res, last.status || 500, { error: friendly(last) });
}

/* ---- HTTP server ---- */
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost"), url = u.pathname;
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (url === "/health") return send(res, 200, { ok: true, provider: PROVIDER, model: MODEL || null, fallback: FALLBACK || null, storage: STORAGE });
    if (url === "/api/chat" || url === "/api/chat/stream") {
      if (req.method !== "POST") throw { status: 405, msg: "Use POST" };
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
      if (!KEY || !MODEL) return send(res, 500, { error: "Server needs API_KEY and MODEL environment variables" });
      if (limited(ip)) return send(res, 429, { error: "Too many requests from your connection. Wait a minute and try again." });
      const b = await readJson(req);
      const msgs = (b.messages || []).slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 6000) }));
      if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send(res, 400, { error: "Bad messages" });
      if (url.endsWith("/stream")) return await streamAnswer(res, msgs, t => bump(b.profile, b.kind, t));
      const text = await robust(msgs, { json: !!b.json });
      bump(b.profile, b.kind, text);
      return send(res, 200, { text });
    }
    if (url.startsWith("/api/")) return await api(req, res, url, u.searchParams);
  } catch (e) {
    if (e && e.msg) { if (!res.headersSent) return send(res, e.status || 400, { error: e.msg }); return res.end(); }
    e = norm(e); console.error(JSON.stringify(e.d || String(e)).slice(0, 300));
    if (!res.headersSent) return send(res, e.status || 400, { error: friendly(e) }); return res.end();
  }
  fs.readFile(path.join(__dirname, "public", "index.html"), (e, data) => {
    if (e) { res.writeHead(500); return res.end("Missing public/index.html"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(data);
  });
}).listen(PORT, () => console.log("ExamPilot running on port " + PORT + " using " + PROVIDER));
