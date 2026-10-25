// ExamPilot server: serves the website and a safe /api/chat proxy. No npm packages needed (Node 18+).
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const hits = new Map();
function limited(ip) {
  const now = Date.now(), r = (hits.get(ip) || []).filter(t => now - t < 60000);
  r.push(now); hits.set(ip, r); return r.length > 20; // 20 requests per minute per visitor
}
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" });
  res.end(JSON.stringify(obj));
}
http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.url === "/api/chat" && req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress;
    if (!KEY) return send(res, 500, { error: "Server has no API key set" });
    if (limited(ip)) return send(res, 429, { error: "Too many requests, wait a minute" });
    let body = "";
    req.on("data", c => { body += c; if (body.length > 50000) req.destroy(); });
    req.on("end", async () => {
      try {
        const b = JSON.parse(body);
        const msgs = (b.messages || []).slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 6000) }));
        if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send(res, 400, { error: "Bad messages" });
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: msgs })
        });
        const d = await r.json();
        if (!r.ok) return send(res, r.status, { error: d });
        send(res, 200, { text: (d.content || []).filter(c => c.type === "text").map(c => c.text).join("") });
      } catch (e) { send(res, 400, { error: "Bad request" }); }
    });
    return;
  }
  if (req.url === "/health") return send(res, 200, { ok: true });
  fs.readFile(path.join(__dirname, "public", "index.html"), (e, data) => {
    if (e) { res.writeHead(500); return res.end("Missing public/index.html"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(data);
  });
}).listen(PORT, () => console.log("ExamPilot running on port " + PORT));
