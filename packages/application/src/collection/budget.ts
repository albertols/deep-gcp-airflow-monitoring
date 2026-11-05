/**
 * Observer budgets (§7.11 "do no harm"): request budgets per (environment, API) and per (project, API),
 * clamped to hard maxima that configuration cannot raise, with priority classes and a concurrency limit.
 *
 * - {@link TokenBucket} is a sliding-window budget: it never admits more than the per-minute budget in
 *   any 60 s window (NFR-OBS-05), which a classic refilling bucket does not guarantee (a full bucket plus
 *   the refill admits up to twice the rate in one minute). A budget below one request per minute spaces
 *   single requests out (0.5/min admits one request per 120 s).
 * - {@link BudgetGate} queues requests by priority (live > standard > background, FR-COLL-02). Background
 *   work only takes a token while the bucket is at least half full, so it always yields, and on the
 *   Airflow API it also stays within the `background` budget class. A request that cannot start before
 *   its deadline is refused at once with {@link BudgetExhaustedError}: the cycle then ends early with
 *   reduced fidelity instead of exceeding the budget (FR-COLL-06).
 *
 * @implements FR-COLL-02, FR-COLL-06, NFR-OBS-05
 */
import type { Budgets, Clock, Profile, Sleeper } from '@dcam/ports';
import { BudgetExhaustedError, type ApiId, type CollectorManifest } from './types';

const MINUTE_MS = 60_000;

/** Hard maxima of §7.11 (table "Default budgets and hard maxima"); configuration cannot raise them. */
export const HARD_MAXIMA = {
  /** Airflow API requests per minute per environment. */
  airflowPerMinute: 120,
  /** Concurrent Airflow API requests per environment. */
  airflowConcurrent: 4,
  /** Cloud Monitoring requests per minute per project (⚠️ VERIFY against the quota, §7.10). */
  monitoringPerMinute: 120,
  /** Composer API requests per minute per environment. */
  composerPerMinute: 30,
} as const;

/** The budgets that apply to one environment, after its profile is chosen and the hard maxima applied. */
export interface EffectiveBudgets {
  /** Airflow API requests per minute for the environment's profile class. */
  readonly airflow: number;
  /** Airflow API requests per minute for background work (inventory refreshes). */
  readonly airflowBackground: number;
  readonly airflowConcurrent: number;
  /** Cloud Monitoring requests per minute, shared by every environment of the project. */
  readonly monitoring: number;
  readonly composer: number;
}

const clamp = (value: number, max: number) => Math.min(Math.max(0, value), max);

/** Requests per minute by API for an environment on `profile`; `off` makes no requests. */
export function effectiveBudgets(budgets: Budgets, profile: Profile): EffectiveBudgets {
  const on = profile !== 'off';
  return {
    airflow: on ? clamp(budgets.airflowApi[profile], HARD_MAXIMA.airflowPerMinute) : 0,
    airflowBackground: on ? clamp(budgets.airflowApi.background, HARD_MAXIMA.airflowPerMinute) : 0,
    airflowConcurrent: Math.max(1, clamp(budgets.airflowApi.maxConcurrent, HARD_MAXIMA.airflowConcurrent)),
    monitoring: on ? clamp(budgets.monitoringPerProjectPerMinute, HARD_MAXIMA.monitoringPerMinute) : 0,
    composer: on ? clamp(budgets.composerApiPerMinute, HARD_MAXIMA.composerPerMinute) : 0,
  };
}

/** A sliding-window request budget; the rate is read on every call so a profile change applies at once. */
export class TokenBucket {
  /** Times tokens were taken, oldest first. */
  private taken: number[] = [];

  constructor(private readonly perMinute: () => number) {}

  /** Most tokens the window holds: the per-minute rate rounded down, one for rates below one. */
  capacity(): number {
    const rate = this.perMinute();
    if (!(rate > 0)) return 0;
    return rate >= 1 ? Math.floor(rate) : 1;
  }

  /** Tokens that may be taken at `at`. */
  available(at: number): number {
    return Math.max(0, this.capacity() - this.inWindow(at).length);
  }

  /** The earliest time at or after `at` when `n` tokens are available; `Infinity` when never. */
  availableAt(at: number, n = 1): number {
    const capacity = this.capacity();
    if (n > capacity) return Infinity;
    const inWindow = this.inWindow(at);
    const excess = inWindow.length - (capacity - n);
    if (excess <= 0) return at;
    return (inWindow[excess - 1] as number) + this.windowMs();
  }

  take(at: number, n = 1): void {
    const horizon = at - Math.max(this.windowMs(), MINUTE_MS);
    this.taken = this.taken.filter((t) => t > horizon);
    for (let i = 0; i < n; i++) this.taken.push(at);
    this.taken.sort((a, b) => a - b);
  }

  private windowMs(): number {
    const rate = this.perMinute();
    return rate >= 1 ? MINUTE_MS : MINUTE_MS / rate;
  }

  private inWindow(at: number): number[] {
    if (this.capacity() === 0) return this.taken;
    const from = at - this.windowMs();
    return this.taken.filter((t) => t > from);
  }
}

export type Priority = CollectorManifest['priority'];
const RANK: Readonly<Record<Priority, number>> = { live: 0, standard: 1, background: 2 };

export interface BudgetGateOptions {
  readonly api: ApiId;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly bucket: TokenBucket;
  /** Background requests also take a token here (the Airflow API's `background` budget class). */
  readonly backgroundBucket?: TokenBucket;
  readonly maxConcurrent: () => number;
}

export interface BudgetRequest {
  readonly priority: Priority;
  /** The request is refused if it cannot start by this time (epoch ms). */
  readonly deadline: number;
}

/** Gives back the concurrency slot; idempotent. */
export type Release = () => void;

interface Waiter extends BudgetRequest {
  readonly seq: number;
  readonly resolve: (release: Release) => void;
  readonly reject: (error: BudgetExhaustedError) => void;
}

/** Admits requests to one API within its budget, highest priority first. */
export class BudgetGate {
  private waiters: Waiter[] = [];
  private inFlight = 0;
  private seq = 0;
  private closed = false;
  private timer: { readonly at: number; readonly abort: AbortController } | null = null;

  constructor(private readonly options: BudgetGateOptions) {}

  /** Resolves with a release function once the request may start; rejects with {@link BudgetExhaustedError}. */
  acquire(request: BudgetRequest): Promise<Release> {
    if (this.closed) return Promise.reject(new BudgetExhaustedError(this.options.api, 'DCAM is stopping.'));
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { ...request, seq: this.seq++, resolve, reject };
      const at = this.waiters.findIndex(
        (w) =>
          RANK[w.priority] > RANK[waiter.priority] || (w.priority === waiter.priority && w.seq > waiter.seq),
      );
      if (at < 0) this.waiters.push(waiter);
      else this.waiters.splice(at, 0, waiter);
      this.pump();
    });
  }

  /** Refuses every waiting request (the engine is stopping or the budget changed). */
  rejectAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    this.schedule(Infinity);
    for (const w of waiters) w.reject(new BudgetExhaustedError(this.options.api));
  }

  /** Refuses every waiting and future request. */
  close(): void {
    this.closed = true;
    this.rejectAll();
  }

  /** Grants what can start now, refuses what cannot start before its deadline, and sets the next wake-up. */
  private pump(): void {
    const now = this.options.clock.now();
    for (;;) {
      const head = this.waiters[0];
      if (!head || !this.slotFree() || this.tokensAt(head.priority, now) > now) break;
      this.waiters.shift();
      this.grant(head, now);
    }
    // Nobody can start before the requests ahead of it, so the earliest start is a running maximum.
    let earliest = now;
    const hopeless: Waiter[] = [];
    for (const w of this.waiters) {
      earliest = Math.max(earliest, this.tokensAt(w.priority, now));
      if (now >= w.deadline || earliest > w.deadline) hopeless.push(w);
    }
    if (hopeless.length > 0) this.waiters = this.waiters.filter((w) => !hopeless.includes(w));
    for (const w of hopeless) w.reject(new BudgetExhaustedError(this.options.api));

    const head = this.waiters[0];
    let wake = Infinity;
    if (head && this.slotFree()) wake = this.tokensAt(head.priority, now);
    for (const w of this.waiters) wake = Math.min(wake, w.deadline);
    this.schedule(wake);
  }

  private slotFree(): boolean {
    return this.inFlight < this.options.maxConcurrent();
  }

  /** When a request of this priority could take its tokens. */
  private tokensAt(priority: Priority, now: number): number {
    const { bucket, backgroundBucket } = this.options;
    if (priority !== 'background') return bucket.availableAt(now, 1);
    const half = Math.max(1, Math.ceil(bucket.capacity() / 2));
    return Math.max(bucket.availableAt(now, half), backgroundBucket?.availableAt(now, 1) ?? now);
  }

  private grant(w: Waiter, now: number): void {
    this.options.bucket.take(now);
    if (w.priority === 'background') this.options.backgroundBucket?.take(now);
    this.inFlight++;
    let released = false;
    w.resolve(() => {
      if (released) return;
      released = true;
      this.inFlight--;
      this.pump();
    });
  }

  private schedule(at: number): void {
    if (this.timer?.at === at) return;
    this.timer?.abort.abort();
    this.timer = null;
    if (!Number.isFinite(at)) return;
    const timer = { at, abort: new AbortController() };
    this.timer = timer;
    void this.options.sleeper
      .sleep(Math.max(0, at - this.options.clock.now()), timer.abort.signal)
      .then(() => {
        if (timer.abort.signal.aborted || this.timer !== timer) return;
        this.timer = null;
        this.pump();
      });
  }
}
