// ExamPilot server: serves the website and a safe /api/chat proxy. No npm packages needed (Node 18+).
// PROVIDER = gemini (default) | groq | anthropic.  Set API_KEY and MODEL as environment variables.
// Optional: FALLBACK_MODEL, PER_MINUTE (default 12 per visitor), THINKING_LEVEL (minimal|low|medium|high|off), TIMEOUT_MS.
const http = require("http"), fs = require("fs"), path = require("path");
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

/* ---- per-visitor rate limit (rejected requests are not counted) ---- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), r = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (r.length >= LIMIT) { hits.set(ip, r); return true; }
  r.push(now); hits.set(ip, r); return false;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 60000)) hits.delete(k); }, 60000).unref();

const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
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
async function streamAnswer(res, msgs) {
  if (PROVIDER !== "gemini") { // other providers: send the whole answer as one chunk
    const t = await robust(msgs);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors });
    res.write("data: " + JSON.stringify({ t }) + "\n\ndata: {\"done\":true}\n\n"); return res.end();
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
      else res.write("data: {\"done\":true}\n\n");
      return res.end();
    } catch (e) {
      e = norm(e); last = e; console.error(m, e.status, JSON.stringify(e.d || "").slice(0, 300));
      if (![429, 404, 500, 502, 503, 504].includes(e.status)) break;
    }
  }
  send(res, last.status || 500, { error: friendly(last) });
}

/* ---- HTTP server ---- */
http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "OPTIONS") return send(res, 204, {});
  if ((url === "/api/chat" || url === "/api/chat/stream") && req.method === "POST") {
    const streaming = url.endsWith("/stream");
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if (!KEY || !MODEL) return send(res, 500, { error: "Server needs API_KEY and MODEL environment variables" });
    if (limited(ip)) return send(res, 429, { error: "Too many requests from your connection. Wait a minute and try again." });
    let body = "";
    req.on("data", c => { body += c; if (body.length > 50000) req.destroy(); });
    req.on("end", async () => {
      try {
        const b = JSON.parse(body);
        const msgs = (b.messages || []).slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 6000) }));
        if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send(res, 400, { error: "Bad messages" });
        if (streaming) return await streamAnswer(res, msgs);
        send(res, 200, { text: await robust(msgs, { json: !!b.json }) });
      } catch (e) {
        e = norm(e); console.error(JSON.stringify(e.d || String(e)).slice(0, 300));
        if (!res.headersSent) send(res, e.status || 400, { error: friendly(e) }); else res.end();
      }
    });
    return;
  }
  if (url === "/health") return send(res, 200, { ok: true, provider: PROVIDER, model: MODEL || null, fallback: FALLBACK || null });
  fs.readFile(path.join(__dirname, "public", "index.html"), (e, data) => {
    if (e) { res.writeHead(500); return res.end("Missing public/index.html"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(data);
  });
}).listen(PORT, () => console.log("ExamPilot running on port " + PORT + " using " + PROVIDER));
