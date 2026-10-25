# ExamPilot: free AI, deploy anywhere

## Get a free key (pick one)
A) Google Gemini: aistudio.google.com > Get API key. PROVIDER=gemini
   Choose a Flash or Flash-Lite model that shows as free on the AI Studio rate-limit page, and use its exact name as MODEL.
B) Groq: console.groq.com > API Keys. PROVIDER=groq
   Pick a current model from their models page and use its exact name as MODEL.
Free limits change often, so check the provider's page. Free tiers can be rate limited (HTTP 429) and may use your inputs to improve their models, so never type personal data.

## Run locally
  export PROVIDER=gemini API_KEY=your_key MODEL=model_name     (PowerShell: $env:API_KEY="...")
  npm start     then open http://localhost:3000   (check http://localhost:3000/health)

## Deploy on Render (free)
1. Push this folder to GitHub (never commit your key).
2. Render > New > Web Service > connect repo. Build command empty, start command: npm start
3. Environment: PROVIDER, API_KEY, MODEL (and optional PER_MINUTE, default 8 per visitor).
4. Deploy and open the URL. The badge should say "AI connected".
Works on Railway, Koyeb, Fly.io or any Node 18+ host. Free Render sleeps when idle (first load ~1 minute).
Want the page on GitHub Pages? Host only this server, set var PROXY="https://YOUR-APP.onrender.com/api/chat" in public/index.html, and set ALLOWED_ORIGIN to your Pages address.
If you see errors, open /health and the host's logs; a wrong MODEL name is the usual cause.
