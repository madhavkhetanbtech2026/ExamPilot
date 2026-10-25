# ExamPilot: deploy anywhere

Run locally:
  export ANTHROPIC_API_KEY=your_key   (Windows PowerShell: $env:ANTHROPIC_API_KEY="your_key")
  npm start      then open http://localhost:3000

Deploy on Render (free):
1. Put this folder in a GitHub repo (never commit your key).
2. Render > New > Web Service > connect the repo.
3. Build command: (leave empty)   Start command: npm start
4. Environment > add ANTHROPIC_API_KEY = your key.
5. Deploy. Open the Render URL. The badge should say "AI connected".
Also works on Railway, Fly.io, Koyeb or any Node 18+ host.

Keep the site on GitHub Pages instead? Host only server.js on Render, then in public/index.html set
  var PROXY="https://YOUR-APP.onrender.com/api/chat";
and set the ALLOWED_ORIGIN env var on Render to your GitHub Pages address.
Free Render services sleep when idle, so the first load can take about a minute.
