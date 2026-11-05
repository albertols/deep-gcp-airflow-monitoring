/**
 * Circuit breaker per (environment, API) (§7.11 item 5). Transient failures (429, 5xx, timeouts, network)
 * open it for the longer of `Retry-After` and an exponential backoff with full jitter:
 * `random() × min(15 min, 10 s × 2^(n−1))` after the n-th consecutive failure. Once that time has passed it
 * is half-open: exactly one call (the probe) goes ahead and the others wait for its outcome. A probe that
 * gets an answer closes the circuit; a probe that fails transiently opens it again for longer.
 *
 * The 10 s base is DCAM's choice (the spec fixes the method, not the constants); the 15 min cap keeps a
 * recovered environment from waiting long for DCAM to come back.
 *
 * @implements FR-COLL-06
 */

export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_CAP_MS = 15 * 60_000;

export type BreakerVerdict =
  /** Closed: call. */
  | { readonly kind: 'go' }
  /** Half-open: this call is the probe; report its outcome with `answered` or `failed`. */
  | { readonly kind: 'probe' }
  | { readonly kind: 'open'; readonly until: number }
  /** Half-open with a probe in flight: ask again once it settles. */
  | { readonly kind: 'wait'; readonly settled: Promise<void> };

export class CircuitBreaker {
  private failures = 0;
  private until = 0;
  private probe: { readonly settled: Promise<void>; readonly resolve: () => void } | null = null;

  constructor(private readonly random: () => number) {}

  /** Consecutive transient failures since the circuit last closed. */
  get consecutiveFailures(): number {
    return this.failures;
  }

  state(now: number): 'closed' | 'open' | 'half-open' {
    if (this.failures === 0) return 'closed';
    return now < this.until ? 'open' : 'half-open';
  }

  /** When the circuit half-opens, if it is open now. */
  openUntil(now: number): number | null {
    return this.state(now) === 'open' ? this.until : null;
  }

  enter(now: number): BreakerVerdict {
    const state = this.state(now);
    if (state === 'closed') return { kind: 'go' };
    if (state === 'open') return { kind: 'open', until: this.until };
    if (this.probe) return { kind: 'wait', settled: this.probe.settled };
    let resolve = () => {};
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    this.probe = { settled, resolve };
    return { kind: 'probe' };
  }

  /** The API answered (with data, or an error that is not about load). A probe closes the circuit. */
  answered(probe: boolean): void {
    if (!probe) return;
    this.failures = 0;
    this.settle();
  }

  /** A transient failure; returns when the circuit half-opens. */
  failed(now: number, retryAfterMs: number, probe: boolean): number {
    if (this.state(now) === 'open') {
      // A call that started before the circuit opened: honour its Retry-After, do not count it twice.
      this.until = Math.max(this.until, now + retryAfterMs);
    } else {
      this.failures++;
      const bound = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
      this.until = now + Math.max(retryAfterMs, this.random() * bound);
    }
    if (probe) this.settle();
    return this.until;
  }

  /** The probe never reached the API (no budget, or DCAM is stopping): let another call probe. */
  abandon(): void {
    this.settle();
  }

  private settle(): void {
    const probe = this.probe;
    this.probe = null;
    probe?.resolve();
  }
}
