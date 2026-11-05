/**
 * Rolling counters of the DCAM health page: DCAM's own requests per API (HM-030, §7.11 item 9), Cloud
 * Monitoring series returned (NFR-OBS-06) and collector cycles. Everything is kept in minute buckets on a
 * fixed ring, so memory stays bounded whatever the request rate.
 *
 * - Windows: "1 h" is the current minute bucket and the 59 before it; "24 h" is the current one and the
 *   1,439 before it. A window therefore covers between 59 and 60 minutes (1,439 and 1,440).
 * - Errors are requests without a response (`status` null: timeout, network) or with a status ≥ 400.
 * - p95 latency is the nearest-rank 95th percentile of the latencies of the last hour, failed requests
 *   included (a slow failure is load as well). Each minute keeps at most {@link LATENCY_SAMPLES_PER_MINUTE}
 *   latencies, a uniform reservoir sample beyond that. That is five times the highest hard maximum (120
 *   requests per minute), so within the budgets the percentile is exact.
 *
 * @implements HM-030, FR-SELF-01, NFR-OBS-06
 */
import type { ApiFootprint } from '@dcam/contracts';

const MINUTE_MS = 60_000;
export const HOUR_MINUTES = 60;
export const DAY_MINUTES = 24 * 60;
export const LATENCY_SAMPLES_PER_MINUTE = 600;

/** A ring of per-minute buckets over a fixed horizon. */
export class MinuteBuckets<T> {
  private readonly slots: Array<{ readonly minute: number; readonly value: T } | undefined>;

  constructor(
    private readonly horizon: number,
    private readonly create: () => T,
  ) {
    this.slots = Array.from({ length: horizon }, () => undefined);
  }

  /** The bucket of the minute containing `at`; `null` when that minute is already beyond the horizon. */
  bucket(at: number): T | null {
    const minute = Math.floor(at / MINUTE_MS);
    const index = ((minute % this.horizon) + this.horizon) % this.horizon;
    const slot = this.slots[index];
    if (slot?.minute === minute) return slot.value;
    if (slot && slot.minute > minute) return null;
    const value = this.create();
    this.slots[index] = { minute, value };
    return value;
  }

  /** The buckets of the last `minutes` minutes up to `now`, the current minute included. */
  recent(now: number, minutes = this.horizon): T[] {
    const current = Math.floor(now / MINUTE_MS);
    const after = current - Math.min(minutes, this.horizon);
    const out: T[] = [];
    for (const slot of this.slots)
      if (slot && slot.minute > after && slot.minute <= current) out.push(slot.value);
    return out;
  }

  /** Every bucket held, current or stale (at most the horizon). */
  all(): T[] {
    return this.slots.flatMap((slot) => (slot ? [slot.value] : []));
  }
}

/** A sum over the last 24 h, for example of Cloud Monitoring time series returned. */
export class RollingSum {
  private readonly buckets = new MinuteBuckets(DAY_MINUTES, () => ({ total: 0 }));

  add(at: number, n: number): void {
    if (!(Number.isFinite(n) && n > 0)) return;
    const bucket = this.buckets.bucket(at);
    if (bucket) bucket.total += n;
  }

  total(now: number, minutes = DAY_MINUTES): number {
    return this.buckets.recent(now, minutes).reduce((sum, b) => sum + b.total, 0);
  }
}

/** One HTTP request as the http-guard hook reports it. */
export interface RequestRecord {
  readonly at: number;
  /** HTTP status, or `null` when no response arrived (timeout, network). */
  readonly status: number | null;
  readonly latencyMs: number;
  readonly bytes: number;
}

export type FootprintSummary = Omit<ApiFootprint, 'api' | 'budget_per_minute'>;

interface Counts {
  requests: number;
  errors: number;
  bytes: number;
}

interface Latencies {
  seen: number;
  readonly samples: number[];
}

/** DCAM's requests to one API of one environment. */
export class FootprintCounter {
  private readonly counts = new MinuteBuckets<Counts>(DAY_MINUTES, () => ({
    requests: 0,
    errors: 0,
    bytes: 0,
  }));
  private readonly latencies = new MinuteBuckets<Latencies>(HOUR_MINUTES, () => ({ seen: 0, samples: [] }));

  constructor(private readonly random: () => number) {}

  record(r: RequestRecord): void {
    const counts = this.counts.bucket(r.at);
    if (!counts) return;
    counts.requests++;
    if (r.status === null || r.status >= 400) counts.errors++;
    if (Number.isFinite(r.bytes) && r.bytes > 0) counts.bytes += r.bytes;
    const latencies = this.latencies.bucket(r.at);
    if (!latencies || !(Number.isFinite(r.latencyMs) && r.latencyMs >= 0)) return;
    latencies.seen++;
    if (latencies.samples.length < LATENCY_SAMPLES_PER_MINUTE) {
      latencies.samples.push(r.latencyMs);
      return;
    }
    // Reservoir sampling (algorithm R): every latency of the minute is kept with the same probability.
    const slot = Math.floor(this.random() * latencies.seen);
    if (slot < LATENCY_SAMPLES_PER_MINUTE) latencies.samples[slot] = r.latencyMs;
  }

  summary(now: number): FootprintSummary {
    const day = this.counts.recent(now);
    const hour = this.counts.recent(now, HOUR_MINUTES);
    const total = (buckets: readonly Counts[], key: keyof Counts) => buckets.reduce((s, b) => s + b[key], 0);
    const samples = this.latencies
      .recent(now)
      .flatMap((l) => l.samples)
      .sort((a, b) => a - b);
    return {
      requests_1h: total(hour, 'requests'),
      requests_24h: total(day, 'requests'),
      errors_24h: total(day, 'errors'),
      bytes_24h: Math.round(total(day, 'bytes')),
      p95_latency_ms: samples.length === 0 ? null : (samples[Math.ceil(0.95 * samples.length) - 1] ?? null),
    };
  }

  /** Latencies held in memory (bounded by an hour of minute samples). */
  get latencySamples(): number {
    return this.latencies.all().reduce((sum, l) => sum + l.samples.length, 0);
  }

  /** Minute buckets held in memory (at most 24 h). */
  get minuteBuckets(): number {
    return this.counts.all().length;
  }
}
