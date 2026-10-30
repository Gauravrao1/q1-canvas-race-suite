// WebSocket stream corruption & jitter via Playwright's network proxy (page.routeWebSocket).
// Delay model: delay(n) = min(1000ms * Fib(n), 8000ms) for the n-th server->page message on a connection.
// Optional corruption: replace the `balance` field of the Nth tick with a malformed numeric string.

const fib = (n) => { let a = 1, b = 1; for (let i = 2; i <= n; i++) [a, b] = [b, a + b]; return a; };
const delayFor = (n) => Math.min(1000 * fib(n), 8000);

async function installWsJitter(page, { corruptTickIndex = null, corruptValue = '1e+7', log = console.log } = {}) {
  await page.routeWebSocket(/\/stream$/, (ws) => {
    const server = ws.connectToServer();
    let n = 0, ticks = 0;
    server.onMessage((raw) => {
      n++;
      let out = raw;
      try {
        const m = JSON.parse(raw);
        if (m.type === 'tick') {
          if (corruptTickIndex !== null && ticks === corruptTickIndex) {
            m.balance = corruptValue;
            out = JSON.stringify(m);
            log(`[ws] message #${n} (tick ${ticks}) CORRUPTED -> balance=${corruptValue}`);
          }
          ticks++;
        }
      } catch { /* binary frame: pass through, still delayed */ }
      const d = delayFor(n);
      log(`[ws] message #${n} delayed ${d} ms (1000 x Fib(${n}) capped 8000)`);
      setTimeout(() => ws.send(out), d);   // monotonic delays keep ordering intact
    });
    ws.onMessage((msg) => server.send(msg)); // page -> server untouched
  });
}

module.exports = { installWsJitter, fib, delayFor };
