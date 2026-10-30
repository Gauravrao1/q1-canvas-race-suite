// Circuit-breaker macro wrapped around the interaction layer.
// CLOSED  : run the fast path using cached coordinates.
// failure : record it, force re-calibration from fresh pixels (updates target grid offsets), retry.
// OPEN    : after `threshold` consecutive failures stop hammering the UI and fail loudly.
class CircuitBreaker {
  constructor({ threshold = 3, log = console.log } = {}) {
    this.threshold = threshold; this.failures = 0; this.state = 'CLOSED'; this.log = log;
  }
  async run(label, attempt, recalibrate) {
    for (let i = 1; ; i++) {
      if (this.state === 'OPEN') throw new Error(`[breaker] OPEN - refusing to run "${label}"`);
      const result = await attempt(i);
      if (result.ok) { this.failures = 0; this.state = 'CLOSED'; return { ...result, attempts: i }; }
      this.failures++;
      this.log(`[breaker] "${label}" attempt ${i} failed: ${result.reason}  (consecutive failures ${this.failures}/${this.threshold})`);
      if (this.failures >= this.threshold) { this.state = 'OPEN'; throw new Error(`[breaker] OPEN after ${this.failures} failures`); }
      this.state = 'HALF_OPEN';
      await recalibrate(result);        // update grid offsets from fresh pixels
    }
  }
}
module.exports = { CircuitBreaker };
