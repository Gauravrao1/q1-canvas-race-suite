// Q1 - HTML5 Canvas state drift + async race interception suite (Playwright, Node).
// Run:  node q1-canvas-suite.js            (strict frontend: expects structured exception boundary)
//       NAIVE=1 node q1-canvas-suite.js    (naive frontend: should be flagged as silent client-side corruption)
const { chromium } = require('playwright-core');
const { server } = require('./testbed/server');
const { installWsJitter } = require('./lib/fibJitter');
const { PAGE_WATCHER, calibrate, readPixel } = require('./lib/pixelEngine');
const { CircuitBreaker } = require('./lib/circuitBreaker');

const PORT = 4020;
const NAIVE = process.env.NAIVE === '1';
const TARGET_CELL = { nominalProbe: { x: 315, y: 275 }, activeRGB: [0xff, 0xd6, 0x00], confirmRGB: [0x29, 0x62, 0xff] };
const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}] ${m}`);
let failures = 0;
const check = (cond, ok, bad) => { if (cond) log(`PASS  ${ok}`); else { failures++; log(`FAIL  ${bad}`); } };
const near = (a, b, t = 30) => a.every((v, i) => Math.abs(v - b[i]) <= t);

// Deliberate race-offset (the "trap" window 30-100 ms). Busy-wait on a high-res clock: this is NOT a readiness wait.
const raceOffset = (ms) => { const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6)); while (process.hrtime.bigint() < end); };

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  // event-driven hooks (no polling)
  let onBoundary; const boundarySeen = new Promise((r) => (onBoundary = r));
  page.on('console', (m) => { if (m.text().startsWith('[BOUNDARY]')) { log(`console: ${m.text()}`); onBoundary(); } });
  let onActive; const pixelFlip = new Promise((r) => (onActive = r));
  await page.exposeFunction('__onPixelActive', (info) => onActive({ ...info, nodeAt: process.hrtime.bigint() }));
  await page.addInitScript(PAGE_WATCHER);

  // ===== Spec 1: WebSocket jitter (Fibonacci) + corruption of the 3rd tick =====
  await installWsJitter(page, { corruptTickIndex: 2, corruptValue: '1e+7', log });
  await page.goto(`http://localhost:${PORT}/${NAIVE ? '?naive=1' : ''}`);
  await page.evaluate(([x, y]) => window.__startPixelWatch(x, y), [TARGET_CELL.nominalProbe.x, TARGET_CELL.nominalProbe.y]);
  log('rAF pixel watcher armed on target cell (gray = loading)');

  // ===== Spec 2: wait for gray -> active pixel flip (event-driven; Fibonacci jitter makes this ~1.3 s) =====
  const flip = await pixelFlip;
  log(`PIXEL FLIP detected rgb=${JSON.stringify(flip.rgb)} at frame ${flip.frame}`);
  // FAST PATH: the 30-100 ms budget leaves no time for a full-canvas scan, so attempt 1 uses the cached probe coordinates
  // from the detection frame. If the layout drifted meanwhile (late reflow), the breaker refreshes offsets via a full pixel scan.
  const canvasBox = await page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left, y: r.top }; });
  let cal = { found: true, cx: TARGET_CELL.nominalProbe.x, cy: TARGET_CELL.nominalProbe.y, originX: canvasBox.x, originY: canvasBox.y };
  log(`cached fast-path coordinates from detection frame: canvas (${cal.cx}, ${cal.cy})`);

  // ===== Spec 3: race injection - chained Hover -> Drag 15px -> Click within 30-100 ms of the flip =====
  const offset = 30 + Math.random() * 70;
  const breaker = new CircuitBreaker({ threshold: 3, log });
  const t0 = flip.nodeAt;
  const remaining = offset - Number(process.hrtime.bigint() - t0) / 1e6;
  if (remaining > 0) raceOffset(remaining);
  const sinceFlip = Number(process.hrtime.bigint() - t0) / 1e6;
  log(`chain fired ${sinceFlip.toFixed(1)} ms after pixel flip (target window 30-100 ms, chosen offset ${offset.toFixed(1)})`);

  const result = await breaker.run('hover-drag-click', async (attempt) => {
    const px = cal.originX + cal.cx, py = cal.originY + cal.cy;
    await page.evaluate(() => { window.__events.length = 0; });
    await page.mouse.move(px, py);                                   // hover
    await page.mouse.down();                                         // drag +15 px on X
    await page.mouse.move(px + 15, py, { steps: 3 });
    await page.mouse.up();
    await page.mouse.click(px + 15, py);                             // click
    const events = await page.evaluate(() => window.__events.slice());
    const ok = events.includes('down') && events.includes('up:15') && events.includes('click');
    return { ok, reason: ok ? '' : `stale coordinates, events=${JSON.stringify(events)}`, events };
  }, async () => { cal = await calibrate(page, TARGET_CELL.activeRGB); log(`[breaker] grid offsets refreshed -> (${cal.cx}, ${cal.cy})`); });

  check(result.ok, `chained actions landed after ${result.attempts} attempt(s): ${JSON.stringify(result.events)}`, 'chained actions never landed');
  const after = await calibrate(page, TARGET_CELL.confirmRGB);
  check(after.found, 'pixel verification: target cell repainted to CONFIRM blue', 'pixel verification failed: no CONFIRM colour on canvas');

  // ===== Spec 4: mismatched server boundary - corrupted "1e+7" balance injected into the stream =====
  log('waiting for corrupted tick (event-driven, 25 s safety cap)');
  const gotBoundary = await Promise.race([boundarySeen.then(() => true), new Promise((r) => setTimeout(() => r(false), 25000))]);
  if (gotBoundary) {
    const px = await readPixel(page, 300, 10);
    check(near(px, [0xd5, 0x00, 0x00]), 'frontend raised structured exception boundary (red integrity banner painted)', `banner pixel was ${px}`);
    const errs = await page.evaluate(() => window.__boundaryErrors);
    check(errs >= 1, `boundary error counter = ${errs}`, 'boundary counter is 0');
  } else {
    // wait for the corrupted tick to be rendered, then confirm nothing was raised
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    const errs = await page.evaluate(() => window.__boundaryErrors);
    failures++;
    log(`FAIL  SILENT CLIENT-SIDE CORRUPTION: corrupted balance "1e+7" accepted without exception boundary (boundaryErrors=${errs}). HIGH RISK.`);
  }

  await browser.close(); server.close();
  log(failures === 0 ? 'SUMMARY: ALL CHECKS PASSED' : `SUMMARY: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
