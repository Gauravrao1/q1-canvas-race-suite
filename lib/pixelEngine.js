// Custom coordinate-calculation engine: reads raw pixels from the canvas 2D context inside a requestAnimationFrame loop.
// No static sleeps, no DOM visibility polls, no bounding-box checks.

// Installed in the page. Watches one probe point; fires window.__onPixelActive(info) when it flips from gray (loading) to saturated colour.
const PAGE_WATCHER = `
(() => {
  window.__startPixelWatch = (probeX, probeY) => {
    const cv = document.querySelector('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const isGray = (r, g, b) => Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 90 && r < 170;
    const isActive = (r, g, b) => (Math.max(r, g, b) - Math.min(r, g, b)) > 80;
    let wasGray = false, done = false;
    const tick = () => {
      if (done) return;
      const [r, g, b] = ctx.getImageData(probeX, probeY, 1, 1).data;
      if (isGray(r, g, b)) wasGray = true;
      else if (wasGray && isActive(r, g, b)) {
        done = true;
        window.__onPixelActive({ t: performance.now(), frame: window.__frame, rgb: [r, g, b] });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
})();
`;

// Full-canvas pixel scan: finds the centroid of all pixels close to targetRGB. Returns canvas-space centre + fresh frame id.
async function calibrate(page, targetRGB, tol = 24) {
  return page.evaluate(([rgb, tolerance]) => new Promise((resolve) => {
    // wait for two fresh animation frames so we never read a stale/half-painted frame
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const cv = document.querySelector('canvas');
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
      for (let y = 70; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          if (Math.abs(data[i] - rgb[0]) < tolerance && Math.abs(data[i + 1] - rgb[1]) < tolerance && Math.abs(data[i + 2] - rgb[2]) < tolerance) {
            if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; n++;
          }
        }
      }
      const r = cv.getBoundingClientRect();
      resolve({ found: n > 0, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, pixels: n, frame: window.__frame, originX: r.left, originY: r.top });
    }));
  }), [targetRGB, tol]);
}

// Reads one pixel AFTER two fresh animation frames, so a just-changed state has been repainted (avoids stale-frame reads).
const readPixel = (page, x, y) =>
  page.evaluate(([px, py]) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
    resolve(Array.from(document.querySelector('canvas').getContext('2d', { willReadFrequently: true }).getImageData(px, py, 1, 1).data).slice(0, 3))))), [x, y]);

module.exports = { PAGE_WATCHER, calibrate, readPixel };
