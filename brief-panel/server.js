#!/usr/bin/env node
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const bb = require('../../../../project/blackboard-server');

const DIR = __dirname;
const OUTPUT = path.join(DIR, 'output');
const OPENCLAW = process.env.OPENCLAW_CMD || 'openclaw';

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

const ctx = bb.createContext({
  dir: DIR,
  boardPath: path.join(DIR, 'brief.json'),
  logPath: path.join(DIR, 'brief-log.jsonl'),
  port: Number(process.env.PORT || 3456),
  boardType: 'brief-panel',
});

const { json } = bb;
const readBoard = () => bb.readBoard(ctx);
const writeBoard = (b) => bb.writeBoard(ctx, b);

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return downloadFile(r.headers.location, dest).then(resolve).catch(reject);
      }
      const ws = fs.createWriteStream(dest);
      r.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(dest); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

// --- HTTP Server (built on blackboard-server core) ---
// bb auto-handles: CORS, OPTIONS, /api/events (SSE), /api/board (GET/POST), static files
// /api/board → reads/writes brief.json (via ctx.boardPath)

const server = bb.createServer(ctx, (req, res) => {

  // GET /api/brief — backward-compatible alias for /api/board
  if (req.method === 'GET' && req.url.startsWith('/api/brief')) {
    try { return json(res, 200, readBoard()); }
    catch (e) { return json(res, 404, { error: 'brief.json not found' }); }
  }

  // POST /api/brief — replace with meta guard (boardType/version preserved)
  if (req.method === 'POST' && req.url === '/api/brief') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        writeBoard(parsed);
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // POST /api/dispatch — write brief + wake OpenClaw
  if (req.method === 'POST' && req.url === '/api/dispatch') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { brief: briefData, message } = payload;

        if (briefData) writeBoard(briefData);

        if (message) {
          const escaped = message.replace(/"/g, '\\"');
          const cmd = `${OPENCLAW} agent --agent main --message "${escaped}" --channel webchat --timeout 120`;
          console.log(`[dispatch] ${cmd}`);
          exec(cmd, { timeout: 130000 }, (err, stdout, stderr) => {
            if (err) console.error(`[dispatch error] ${err.message}`);
            if (stdout) console.log(`[dispatch stdout] ${stdout}`);
            if (stderr) console.error(`[dispatch stderr] ${stderr}`);
          });
        }

        json(res, 200, { ok: true, dispatched: !!message });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // POST /api/download — download image URL to local output/ folder
  if (req.method === 'POST' && req.url === '/api/download') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { shotId, version, url } = JSON.parse(body);
        if (!url || !shotId) throw new Error('Missing shotId or url');
        const ext = (url.match(/\.(jpg|jpeg|png|webp)/) || [, 'jpg'])[1];
        const filename = `${shotId}_v${version || 1}.${ext}`;
        const dest = path.join(OUTPUT, filename);
        await downloadFile(url, dest);
        console.log(`[download] ${filename} saved`);
        json(res, 200, { ok: true, local_path: `output/${filename}`, filename });
      } catch (e) {
        console.error(`[download error] ${e.message}`);
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // GET /output/* — serve downloaded images
  if (req.method === 'GET' && req.url.startsWith('/output/')) {
    const imgPath = path.join(DIR, decodeURIComponent(req.url.split('?')[0]));
    if (!imgPath.startsWith(OUTPUT)) { res.writeHead(403); return res.end(); }
    fs.readFile(imgPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(imgPath);
      res.writeHead(200, { 'Content-Type': bb.MIME[ext] || 'image/jpeg' });
      res.end(data);
    });
    return;
  }

  return false; // fall through to bb static file serving
});

bb.listen(server, ctx);
