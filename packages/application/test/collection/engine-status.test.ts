import { describe, expect, it } from 'vitest';
import { SourceError, type EnvironmentEntry } from '@dcam/ports';
import type { ApiFootprint } from '@dcam/contracts';
import { createCollectionEngine, type Collector } from '../../src/index';
import { FootprintCounter, LATENCY_SAMPLES_PER_MINUTE } from '../../src/collection/footprint';
import {
  FakeSources,
  FakeTime,
  T0,
  airflowEnv,
  collector,
  composerEnv,
  manifest,
  unusedStore,
  workspace,
} from './engine-harness';

const HOUR = 3_600_000;

const setup = (environments: readonly EnvironmentEntry[], collectors: readonly Collector[] = []) => {
  const time = new FakeTime();
  const fake = new FakeSources(time);
  const engine = createCollectionEngine({
    config: workspace(environments),
    store: unusedStore,
    clock: time,
    sleeper: time,
    random: () => 0.5,
    sources: (env) => fake.for(env),
    collectors,
  });
  return { time, engine };
};

const environment = (engine: ReturnType<typeof setup>['engine'], envId: string) => {
  const env = engine.status().environments.find((e) => e.env_id === envId);
  if (!env) throw new Error(`no environment ${envId}`);
  return env;
};

const footprint = (engine: ReturnType<typeof setup>['engine'], envId: string) =>
  Object.fromEntries(environment(engine, envId).footprint.map((f) => [f.api, f])) as Partial<
    Record<ApiFootprint['api'], ApiFootprint>
  >;

describe('DCAM footprint (HM-030, FR-SELF-01)', () => {
  it('HM-030: counts requests, errors, bytes and p95 latency per API from the request hook', async () => {
    const { time, engine } = setup([
      composerEnv('acme-composer-prod', 'standard', 'acme-prod-123'),
      airflowEnv('acme-emulator', 'live'),
    ]);
    const record = (api: 'airflow' | 'composer' | 'monitoring', status: number | null, latencyMs: number) =>
      engine.recordRequest('acme-composer-prod', api, { at: time.now(), status, latencyMs, bytes: 100 });
    record('airflow', 200, 5_000);
    await time.advance(23 * HOUR);
    // 20 requests now: 10 … 200 ms; two 5xx, a 404 and one without a response are errors.
    for (let i = 1; i <= 20; i++)
      record('airflow', [500, 503, 404].at(i - 1) ?? (i === 4 ? null : 200), i * 10);
    record('composer', 403, 120);

    expect(footprint(engine, 'acme-composer-prod')).toEqual({
      airflow: {
        api: 'airflow',
        budget_per_minute: 12,
        requests_1h: 20,
        requests_24h: 21,
        errors_24h: 4,
        bytes_24h: 2_100,
        // Nearest rank over the last hour only: the 5 s request 23 h ago is not part of it.
        p95_latency_ms: 190,
      },
      composer: {
        api: 'composer',
        budget_per_minute: 6,
        requests_1h: 1,
        requests_24h: 1,
        errors_24h: 1,
        bytes_24h: 100,
        p95_latency_ms: 120,
      },
      monitoring: {
        api: 'monitoring',
        budget_per_minute: 30,
        requests_1h: 0,
        requests_24h: 0,
        errors_24h: 0,
        bytes_24h: 0,
        p95_latency_ms: null,
      },
    });
    // A self-managed Airflow has only the Airflow API; unknown environments and APIs are ignored.
    engine.recordRequest('acme-emulator', 'composer', {
      at: time.now(),
      status: 200,
      latencyMs: 1,
      bytes: 1,
    });
    engine.recordRequest('acme-unknown', 'airflow', { at: time.now(), status: 200, latencyMs: 1, bytes: 1 });
    expect(Object.keys(footprint(engine, 'acme-emulator'))).toEqual(['airflow']);
    expect(footprint(engine, 'acme-emulator').airflow).toMatchObject({
      budget_per_minute: 60,
      requests_24h: 0,
    });

    await time.advance(2 * HOUR);
    expect(footprint(engine, 'acme-composer-prod').airflow).toMatchObject({
      requests_1h: 0,
      requests_24h: 20,
      errors_24h: 4,
      bytes_24h: 2_000,
      p95_latency_ms: null,
    });
  });

  it('HM-030: rolling counters stay bounded whatever the request rate', () => {
    const counter = new FootprintCounter(() => 0.5);
    // Five requests per second for two days.
    for (let t = T0; t < T0 + 48 * HOUR; t += 200)
      counter.record({ at: t, status: 200, latencyMs: 50, bytes: 10 });
    const now = T0 + 48 * HOUR - 1;
    expect(counter.summary(now)).toEqual({
      requests_1h: 60 * 300,
      requests_24h: 24 * 60 * 300,
      errors_24h: 0,
      bytes_24h: 24 * 60 * 300 * 10,
      p95_latency_ms: 50,
    });
    expect(counter.minuteBuckets).toBeLessThanOrEqual(24 * 60);
    // A burst far above any budget (60,000 requests in one minute) keeps a bounded latency sample.
    const burst = T0 + 48 * HOUR;
    for (let i = 0; i < 60_000; i++) counter.record({ at: burst + i, status: 200, latencyMs: 50, bytes: 10 });
    expect(counter.summary(burst + 59_999).requests_1h).toBe(59 * 300 + 60_000);
    expect(counter.latencySamples).toBeLessThanOrEqual(60 * LATENCY_SAMPLES_PER_MINUTE);
  });
});

describe('collector health (FR-COLL-11, NFR-OBS-06)', () => {
  it('FR-COLL-11: error rate over the last hour, and lag from the newest committed data', async () => {
    let cycle = 0;
    const { time, engine } = setup(
      [airflowEnv('acme-emulator', 'live')],
      [
        collector(manifest({ id: 'af.live' }), async (ctx) => {
          if (++cycle % 2 === 0) throw new SourceError('timeout', 'The Airflow API did not answer in time.');
          return { dataAsOf: ctx.now() - 90_000 };
        }),
      ],
    );
    engine.start();
    await time.advance(55_000);
    const live = () => environment(engine, 'acme-emulator').collectors.find((c) => c.id === 'af.live')!;
    // Cycles at 0, 10, …, 50 s; every second one failed. The newest data (cycle at 40 s) is 90 s older.
    expect(live()).toMatchObject({
      state: 'degraded',
      cadence_seconds: 10,
      consecutive_failures: 1,
      error_rate_1h: 0.5,
      lag_seconds: 105,
      last_attempt_at: new Date(T0 + 50_000).toISOString(),
      last_success_at: new Date(T0 + 40_000).toISOString(),
      next_run_at: new Date(T0 + 60_000).toISOString(),
      last_error: { kind: 'timeout', fix_hint: null, at: new Date(T0 + 50_000).toISOString() },
    });
    await engine.stop();
    await time.advance(2 * HOUR);
    expect(live()).toMatchObject({ error_rate_1h: null, next_run_at: null });
  });

  it('FR-COLL-06: the environment shows reduced fidelity for 15 min after a cycle reported it', async () => {
    let first = true;
    const { time, engine } = setup(
      [airflowEnv('acme-emulator', 'live')],
      [
        collector(manifest({ id: 'af.live' }), async (ctx) => {
          if (first) ctx.reducedFidelity('Skipped the second page of queued task instances.');
          first = false;
          return { dataAsOf: ctx.now() };
        }),
      ],
    );
    engine.start();
    await time.advance(14 * 60_000);
    expect(environment(engine, 'acme-emulator').reduced_fidelity).toBe(true);
    expect(environment(engine, 'acme-emulator').collectors[0]?.state).toBe('ok');
    await time.advance(2 * 60_000);
    expect(environment(engine, 'acme-emulator').reduced_fidelity).toBe(false);
    await engine.stop();
  });

  it('NFR-OBS-06: counts the Cloud Monitoring time series returned in the last 24 h', async () => {
    const { time, engine } = setup(
      [composerEnv('acme-composer-prod', 'live'), airflowEnv('acme-emulator', 'live')],
      [
        collector(manifest({ id: 'mon.core' }), async (ctx) => {
          ctx.countSeries(7);
          return { dataAsOf: null };
        }),
      ],
    );
    engine.start();
    await time.advance(10 * 60_000);
    await engine.stop();
    // One cycle a minute, at 0 … 10 min.
    expect(environment(engine, 'acme-composer-prod').series_24h).toBe(77);
    expect(environment(engine, 'acme-emulator').series_24h).toBeNull();
    // 24 h after the cycle at 5 min, the first six have left the window.
    await time.advance(24 * HOUR - 270_000);
    expect(environment(engine, 'acme-composer-prod').series_24h).toBe(35);
  });
});
