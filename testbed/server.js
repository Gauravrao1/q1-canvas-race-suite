// Q1 testbed: serves a canvas-only "live terminal" page and streams state over a real WebSocket (ws://.../stream).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4020;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/stream')) { res.writeHead(426); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws) => {
  let seq = 0;
  // m1: init (cells still gray / loading on client)
  ws.send(JSON.stringify({ type: 'init', seq: seq++ }));
  // m2: ready -> cells become active colours
  setTimeout(() => ws.send(JSON.stringify({
    type: 'ready', seq: seq++,
    cells: ['#00c853', '#ff9100', '#d500f9', '#00b8d4', '#ffd600', '#76ff03'],
  })), 300);
  // m3+: ticks carrying balance as a STRING with exactly 2 decimals + layout drift
  const t = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return clearInterval(t);
    ws.send(JSON.stringify({ type: 'tick', seq, balance: (1234.5 + seq).toFixed(2), drift: (seq * 3) % 12 }));
    seq++;
  }, 400);
  ws.on('close', () => clearInterval(t));
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`[testbed] http://localhost:${PORT}  ws://localhost:${PORT}/stream`));
}
module.exports = { server };
