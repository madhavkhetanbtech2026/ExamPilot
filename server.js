
// ExamPilot server: serves the website and a safe /api/chat proxy. No npm packages needed (Node 18+).
// PROVIDER = gemini (default) | groq | anthropic.  Set API_KEY and MODEL as environment variables.
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;
const PROVIDER = (process.env.PROVIDER || "gemini").toLowerCase();
const KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const LIMIT = +(process.env.PER_MINUTE || 8);
const hits = new Map();
function limited(ip) {
  const now = Date.now(), r = (hits.get(ip) || []).filter(t => now - t < 60000);
  r.push(now); hits.set(ip, r); return r.length > LIMIT;
}
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" });
  res.end(JSON.stringify(obj));
}
async function ask(msgs, model) {
  let url, headers = { "content-type": "application/json" }, body, pick;
  if (PROVIDER === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
    headers["x-goog-api-key"] = KEY;
    body = { contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: 1200 } };
    pick = d => ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
  } else if (PROVIDER === "groq") {
    url = "https://api.groq.com/openai/v1/chat/completions";
    headers.authorization = "Bearer " + KEY;
    body = { model: model, messages: msgs, max_tokens: 1200 };
    pick = d => d.choices?.[0]?.message?.content || "";
  } else {
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = KEY; headers["anthropic-version"] = "2023-06-01";
    body = { model: model, max_tokens: 1000, messages: msgs };
    pick = d => (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw { status: r.status, d };
  return pick(d);
}
async function robust(msgs) {
  const models = [MODEL, process.env.FALLBACK_MODEL].filter(Boolean);
  let last;
  for (const m of models) {
    for (let i = 0; i < 3; i++) {
      try { return await ask(msgs, m); }
      catch (e) { last = e; if (![429, 500, 502, 503, 504].includes(e.status)) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
    }
  }
  throw last;
}
http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.url === "/api/chat" && req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress;
    if (!KEY || !MODEL) return send(res, 500, { error: "Server needs API_KEY and MODEL environment variables" });
    if (limited(ip)) return send(res, 429, { error: "Too many requests, wait a minute" });
    let body = "";
    req.on("data", c => { body += c; if (body.length > 50000) req.destroy(); });
    req.on("end", async () => {
      try {
        const b = JSON.parse(body);
        const msgs = (b.messages || []).slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 6000) }));
        if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send(res, 400, { error: "Bad messages" });
        send(res, 200, { text: await robust(msgs) });
      } catch (e) { console.error(JSON.stringify(e.d || String(e))); send(res, e.status || 400, { error: e.d || "Request failed" }); }
    });
    return;
  }
  if (req.url === "/health") return send(res, 200, { ok: true, provider: PROVIDER, model: MODEL || null });
  fs.readFile(path.join(__dirname, "public", "index.html"), (e, data) => {
    if (e) { res.writeHead(500); return res.end("Missing public/index.html"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(data);
  });
}).listen(PORT, () => console.log("ExamPilot running on port " + PORT + " using " + PROVIDER));
