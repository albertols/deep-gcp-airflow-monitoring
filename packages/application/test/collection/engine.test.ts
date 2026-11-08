import { describe, expect, it } from 'vitest';
import { SourceError, type AirflowApi, type EnvironmentEntry, type WorkspaceConfig } from '@dcam/ports';
import { createCollectionEngine, type Collector } from '../../src/index';
import {
  FakeSources,
  FakeTime,
  T0,
  airflowEnv,
  collector,
  composerEnv,
  cycling,
  greedy,
  greedyFive,
  manifest,
  maxInWindow,
  unusedStore,
  workspace,
  type Call,
} from './engine-harness';

const setup = (opts: {
  environments: readonly EnvironmentEntry[];
  collectors: readonly Collector[];
  budgets?: Partial<WorkspaceConfig['budgets']>;
  random?: () => number;
  behave?: (call: Call) => Promise<void> | void;
}) => {
  const time = new FakeTime();
  const fake = new FakeSources(time, opts.behave);
  const engine = createCollectionEngine({
    config: workspace(opts.environments, opts.budgets),
    store: unusedStore,
    clock: time,
    sleeper: time,
    random: opts.random ?? (() => 0.5),
    sources: (env) => fake.for(env),
    collectors: opts.collectors,
  });
  return { time, fake, engine };
};

/** A collector that makes one Airflow call per cycle. */
const oneCall = (id: 'af.live' | 'af.facts' | 'af.inventory', call: (api: AirflowApi) => Promise<unknown>) =>
  collector(manifest({ id }), async (ctx) => {
    await call(ctx.airflow());
    return { dataAsOf: ctx.now() };
  });

const at = (calls: readonly Call[], filter: (c: Call) => boolean = () => true) =>
  calls.filter(filter).map((c) => c.at - T0);

const statusOf = (engine: ReturnType<typeof setup>['engine'], envId: string, collectorId: string) => {
  const env = engine.status().environments.find((e) => e.env_id === envId);
  const status = env?.collectors.find((c) => c.id === collectorId);
  if (!env || !status) throw new Error(`no status for ${envId}/${collectorId}`);
  return { env, status };
};

describe('collector registration (FR-COLL-01)', () => {
  const register =
    (...collectors: Collector[]) =>
    () =>
      setup({ environments: [airflowEnv('acme-emulator')], collectors });

  it('FR-COLL-01: refuses a collector without a request budget', () => {
    expect(register(collector(manifest({ id: 'af.live', maxRequestsPerCycle: 0 })))).toThrow(
      /af\.live.*maxRequestsPerCycle/,
    );
    expect(register(collector(manifest({ id: 'af.live', maxRequestsPerCycle: Infinity })))).toThrow(
      /maxRequestsPerCycle/,
    );
  });

  it('FR-COLL-01: refuses a collector without an output', () => {
    expect(register(collector(manifest({ id: 'af.facts', outputs: [] })))).toThrow(/af\.facts.*output/);
  });

  it('FR-COLL-01: refuses two collectors with the same ID', () => {
    expect(register(collector(manifest({ id: 'af.live' })), collector(manifest({ id: 'af.live' })))).toThrow(
      /af\.live.*twice/,
    );
  });
});

describe('scheduler (FR-COLL-02)', () => {
  it('FR-COLL-02: repeats cycles at the profile cadence with ±10 % jitter', async () => {
    const starts: number[] = [];
    const { time, engine } = setup({
      environments: [airflowEnv('acme-emulator', 'live')],
      random: cycling(0, 1, 0.5),
      collectors: [
        collector(manifest({ id: 'af.live' }), async (ctx) => {
          starts.push(ctx.now() - T0);
          return { dataAsOf: null };
        }),
      ],
    });
    engine.start();
    await time.advance(40_000);
    await engine.stop();
    // The live profile's `airflowLive` cadence is 10 s: × 0.9, × 1.1, × 1.0, × 0.9.
    expect(starts).toEqual([0, 9_000, 20_000, 30_000, 39_000]);
  });

  it('FR-COLL-02: a cycle never overlaps itself', async () => {
    let running = 0;
    let peak = 0;
    const starts: number[] = [];
    const { time, engine } = setup({
      environments: [airflowEnv('acme-emulator', 'live')],
      collectors: [
        collector(manifest({ id: 'af.live' }), async (ctx) => {
          starts.push(ctx.now() - T0);
          peak = Math.max(peak, ++running);
          await time.sleep(25_000);
          running--;
          return { dataAsOf: null };
        }),
      ],
    });
    engine.start();
    await time.advance(100_000);
    await time.settle(engine.stop());
    expect(peak).toBe(1);
    // Each 25 s cycle overruns the 10 s cadence: the next one starts when it ends.
    expect(starts).toEqual([0, 25_000, 50_000, 75_000, 100_000]);
    expect(time.pending).toBe(0);
  });

  it('FR-COLL-02: serves the higher-priority collector first when collectors compete for the Airflow API', async () => {
    const { time, fake, engine } = setup({
      environments: [airflowEnv('acme-emulator', 'live')],
      budgets: { airflowApi: { live: 60, standard: 12, eco: 4, background: 2, maxConcurrent: 1 } },
      behave: async (call) => {
        if (call.api === 'airflow') await time.sleep(1_000);
      },
      // Registered lowest priority first: the inventory takes the only slot, the others queue behind it.
      collectors: [
        oneCall('af.inventory', (a) => a.dags({ limit: 100, offset: 0 })),
        oneCall('af.facts', (a) => a.taskInstances({ limit: 100, offset: 0 })),
        oneCall('af.live', (a) => a.pools()),
      ],
    });
    engine.start();
    await time.advance(3_000);
    await time.settle(engine.stop());
    expect(fake.calls.slice(0, 3).map((c) => `${c.method}@${c.at - T0}`)).toEqual([
      'dags@0',
      'pools@1000',
      'taskInstances@2000',
    ]);
  });

  it('FR-COLL-02: profile off disables every collector, and collectors whose source does not apply are disabled', async () => {
    const { time, fake, engine } = setup({
      environments: [composerEnv('acme-composer-off', 'off'), airflowEnv('acme-emulator', 'live')],
      collectors: greedyFive(),
    });
    engine.start();
    await time.advance(600_000);
    await time.settle(engine.stop());
    expect(fake.calls.filter((c) => c.envId === 'acme-composer-off')).toEqual([]);
    expect(new Set(fake.calls.map((c) => c.api))).toEqual(new Set(['airflow']));
    const states = (envId: string) =>
      Object.fromEntries(
        engine
          .status()
          .environments.find((e) => e.env_id === envId)!
          .collectors.map((c) => [c.id, c.state]),
      );
    expect(states('acme-composer-off')).toEqual({
      'composer.config': 'disabled',
      'af.inventory': 'disabled',
      'af.live': 'disabled',
      'af.facts': 'disabled',
      'mon.core': 'disabled',
    });
    expect(states('acme-emulator')['composer.config']).toBe('disabled');
    expect(states('acme-emulator')['mon.core']).toBe('disabled');
    expect(states('acme-emulator')['af.live']).not.toBe('disabled');
    expect(time.pending).toBe(0);
  });

  it('FR-COLL-02: stop() aborts the waits and lets running cycles finish', async () => {
    const { time, fake, engine } = setup({
      environments: [composerEnv('acme-composer-prod', 'standard'), airflowEnv('acme-emulator', 'live')],
      collectors: greedyFive(),
      behave: async (call) => {
        if (call.api === 'composer') await time.sleep(3_000);
      },
    });
    engine.start();
    await time.advance(301_000);
    await time.settle(engine.stop());
    expect(time.pending).toBe(0);
    const made = fake.calls.length;
    await time.advance(600_000);
    expect(fake.calls.length).toBe(made);
  });
});

describe('budgets (FR-COLL-06, NFR-OBS-05)', () => {
  it('NFR-OBS-05: greedy collectors never exceed a budget in any 60 s window', async () => {
    const shared = 'acme-prod-123';
    const environments = [
      composerEnv('acme-composer-prod', 'live', shared),
      composerEnv('acme-composer-etl', 'standard', shared),
      composerEnv('acme-composer-dev', 'eco', 'acme-dev-456'),
      airflowEnv('acme-emulator', 'live'),
    ];
    const { time, fake, engine } = setup({
      environments,
      random: cycling(0.1, 0.9, 0.5, 0.3),
      // composer.config learns the Airflow URL first, then every collector asks for all it can get.
      collectors: greedyFive({ maxRequestsPerCycle: 1_000 }).map((c) =>
        c.manifest.id !== 'composer.config'
          ? c
          : collector(c.manifest, async (ctx) => {
              ctx.shared.airflowBaseUrl = `https://${ctx.env.id}.composer.example.test`;
              return c.collect(ctx);
            }),
      ),
    });
    engine.start();
    await time.advance(20 * 60_000);
    await time.settle(engine.stop());
    const times = (f: (c: Call) => boolean) => fake.calls.filter(f).map((c) => c.at);
    const airflow = (envId: string) => times((c) => c.envId === envId && c.api === 'airflow');
    // Airflow budgets by profile (live 60, standard 12, eco 4), each used up, never exceeded.
    expect(maxInWindow(airflow('acme-composer-prod'))).toBe(60);
    expect(maxInWindow(airflow('acme-composer-etl'))).toBe(12);
    expect(maxInWindow(airflow('acme-composer-dev'))).toBe(4);
    expect(maxInWindow(airflow('acme-emulator'))).toBe(60);
    for (const [envId, peak] of fake.airflowPeak) expect(peak, envId).toBeLessThanOrEqual(2);
    // Composer per environment (6/min, eco 2/min); Monitoring per project (30/min, shared by prod and etl;
    // 10/min for the eco environment's own project), as §7.11 lowers them per profile.
    for (const env of environments.slice(0, 2))
      expect(maxInWindow(times((c) => c.envId === env.id && c.api === 'composer'))).toBeLessThanOrEqual(6);
    expect(maxInWindow(times((c) => c.envId === 'acme-composer-dev' && c.api === 'composer'))).toBe(2);
    expect(
      maxInWindow(
        times(
          (c) =>
            (c.envId === 'acme-composer-prod' || c.envId === 'acme-composer-etl') && c.api === 'monitoring',
        ),
      ),
    ).toBe(30);
    expect(maxInWindow(times((c) => c.envId === 'acme-composer-dev' && c.api === 'monitoring'))).toBe(10);
    const budgetOf = (envId: string, api: string) =>
      engine
        .status()
        .environments.find((e) => e.env_id === envId)
        ?.footprint.find((f) => f.api === api)?.budget_per_minute;
    expect(budgetOf('acme-composer-dev', 'monitoring')).toBe(10);
    expect(budgetOf('acme-composer-dev', 'composer')).toBe(2);
    expect(budgetOf('acme-composer-etl', 'monitoring')).toBe(30);
    expect(time.pending).toBe(0);
  });

  it('FR-COLL-06: a project whose environments all run eco gets the eco Monitoring budget', async () => {
    const environments = [
      composerEnv('acme-composer-dev', 'eco', 'acme-dev-456'),
      composerEnv('acme-composer-test', 'eco', 'acme-dev-456'),
    ];
    const { time, fake, engine } = setup({
      environments,
      collectors: [greedy(manifest({ id: 'mon.core', maxRequestsPerCycle: 1_000 }))],
    });
    engine.start();
    await time.advance(10 * 60_000);
    await time.settle(engine.stop());
    expect(maxInWindow(fake.calls.filter((c) => c.api === 'monitoring').map((c) => c.at))).toBe(10);
  });

  it('FR-COLL-06: a cycle stops at its request maximum and reports reduced fidelity, not a failure', async () => {
    const { time, fake, engine } = setup({
      environments: [airflowEnv('acme-emulator', 'live')],
      collectors: [greedy(manifest({ id: 'af.live' }))],
    });
    engine.start();
    await time.advance(25_000);
    // af.live may make 3 requests per cycle; the 10 s cadence restarts when the shortened cycle ends.
    expect(at(fake.calls)).toEqual([0, 0, 0, 10_000, 10_000, 10_000, 20_000, 20_000, 20_000]);
    const { env, status } = statusOf(engine, 'acme-emulator', 'af.live');
    expect(status).toMatchObject({ state: 'degraded', consecutive_failures: 0, last_error: null });
    expect(env.reduced_fidelity).toBe(true);
    expect(env.failing).toBe(false);
    await time.settle(engine.stop());
  });
});

describe('circuit breaker and errors (FR-COLL-06, FR-AUTH-06)', () => {
  it('FR-COLL-06: a 429 opens the circuit until Retry-After; one probe goes first, then the others follow', async () => {
    let first = true;
    const { time, fake, engine } = setup({
      environments: [airflowEnv('acme-emulator', 'live')],
      behave: async (call) => {
        if (call.api !== 'airflow') return;
        if (first) {
          first = false;
          throw new SourceError('rate-limited', 'Too many requests.', { status: 429, retryAfterMs: 120_000 });
        }
        if (call.at === T0 + 120_000) await time.sleep(1_000);
      },
      collectors: [oneCall('af.live', (a) => a.pools()), oneCall('af.facts', (a) => a.health())],
    });
    engine.start();
    await time.advance(125_000);
    const calls = at(fake.calls);
    expect(calls.filter((t) => t > 0 && t < 120_000)).toEqual([]);
    // The probe at 120 s is alone while it runs; the waiting collector follows once it succeeds.
    expect(calls.filter((t) => t >= 120_000 && t < 121_000)).toEqual([120_000]);
    expect(calls).toContain(121_000);
    expect(statusOf(engine, 'acme-emulator', 'af.live').status.state).toBe('ok');
    await time.settle(engine.stop());
  });

  it('FR-COLL-06: repeated 5xx responses back off exponentially with full jitter, capped at 15 min', async () => {
    const { time, fake, engine } = setup({
      environments: [airflowEnv('acme-emulator', 'live')],
      random: () => 1,
      behave: (call) => {
        if (call.api === 'airflow')
          throw new SourceError('unavailable', 'Service unavailable.', { status: 503 });
      },
      collectors: [oneCall('af.live', (a) => a.pools())],
    });
    engine.start();
    await time.advance(2 * 3_600_000);
    await time.settle(engine.stop());
    const calls = at(fake.calls);
    const gaps = calls.slice(1).map((t, i) => (t - (calls[i] as number)) / 1_000);
    // 11 s is the cadence (10 s × 1.1); then 10 s × 2^(n−1) × random(), capped at 900 s.
    expect(gaps.slice(0, 9)).toEqual([11, 20, 40, 80, 160, 320, 640, 900, 900]);
    expect(Math.max(...gaps)).toBe(900);
  });

  it('FR-COLL-06: a non-transient error marks the collector degraded with its fix hint and retries every 5 min', async () => {
    const fixHint = 'Ask an Airflow administrator to grant your account the Viewer role.';
    const { time, fake, engine } = setup({
      environments: [airflowEnv('acme-emulator', 'live')],
      behave: (call) => {
        if (call.method === 'pools')
          throw new SourceError('forbidden', 'The account lacks an Airflow role.', { status: 403, fixHint });
      },
      collectors: [oneCall('af.live', (a) => a.pools()), oneCall('af.facts', (a) => a.health())],
    });
    engine.start();
    await time.advance(60_000);
    expect(statusOf(engine, 'acme-emulator', 'af.live').status).toMatchObject({
      state: 'degraded',
      consecutive_failures: 1,
      last_error: { kind: 'forbidden', message: 'The account lacks an Airflow role.', fix_hint: fixHint },
    });
    await time.advance(600_000);
    expect(at(fake.calls, (c) => c.method === 'pools')).toEqual([0, 300_000, 600_000]);
    // The circuit stays closed: the other collector keeps its 30 s cadence.
    expect(at(fake.calls, (c) => c.method === 'health')).toHaveLength(23);
    const { env, status } = statusOf(engine, 'acme-emulator', 'af.live');
    expect(status.state).toBe('failing');
    expect(env.failing).toBe(true);
    await time.settle(engine.stop());
  });

  it('FR-AUTH-06: a VPC Service Controls denial is not retried until the check is run again', async () => {
    let denied = true;
    const { time, fake, engine } = setup({
      environments: [composerEnv('acme-composer-prod', 'live')],
      behave: (call) => {
        if (call.api === 'composer' && denied)
          throw new SourceError('vpc-sc', 'Request is prohibited by organization policy.', {
            status: 403,
            vpcScId: 'acme-vpcsc-0001',
            fixHint: 'Connect from a network inside the perimeter, then run the check again.',
          });
      },
      collectors: [
        collector(manifest({ id: 'composer.config' }), async (ctx) => {
          await ctx.composer!.environment({
            projectId: 'acme-prod-123',
            location: 'europe-west1',
            environment: 'acme-composer-prod',
          });
          return { dataAsOf: ctx.now() };
        }),
      ],
    });
    engine.start();
    await time.advance(2 * 3_600_000);
    expect(fake.calls).toHaveLength(1);
    expect(statusOf(engine, 'acme-composer-prod', 'composer.config').status).toMatchObject({
      state: 'degraded',
      next_run_at: null,
      last_error: { kind: 'vpc-sc' },
    });
    denied = false;
    engine.recheck('acme-composer-prod');
    await time.advance(1_000);
    expect(fake.calls).toHaveLength(2);
    expect(statusOf(engine, 'acme-composer-prod', 'composer.config').status.state).toBe('ok');
    await time.settle(engine.stop());
  });
});

describe('Airflow base URL (FR-COLL-01)', () => {
  it('FR-COLL-01: Airflow collectors wait for the web server URL from Composer, then use it', async () => {
    const errors: string[] = [];
    const { time, fake, engine } = setup({
      environments: [composerEnv('acme-composer-prod', 'live'), airflowEnv('acme-emulator', 'live')],
      behave: async (call) => {
        if (call.api === 'composer') await time.sleep(5_000);
      },
      collectors: [
        collector(manifest({ id: 'composer.config' }), async (ctx) => {
          const env = await ctx.composer!.environment({
            projectId: 'acme-prod-123',
            location: 'europe-west1',
            environment: 'acme-composer-prod',
          });
          ctx.shared.airflowBaseUrl = env.airflowUri;
          return { dataAsOf: ctx.now() };
        }),
        collector(manifest({ id: 'mon.core' }), async (ctx) => {
          try {
            ctx.airflow();
          } catch (e) {
            errors.push(e instanceof SourceError ? `${e.kind}@${ctx.now() - T0}` : 'other');
          }
          return { dataAsOf: null };
        }),
        oneCall('af.live', (a) => a.pools()),
      ],
    });
    engine.start();
    await time.advance(30_000);
    await time.settle(engine.stop());
    expect(errors[0]).toBe('not-found@0');
    const composerAirflow = fake.calls.filter((c) => c.envId === 'acme-composer-prod' && c.api === 'airflow');
    // Woken as soon as composer.config learnt the URL, then every 10 s.
    expect(at(composerAirflow)).toEqual([5_000, 15_000, 25_000]);
    expect(new Set(composerAirflow.map((c) => c.baseUrl))).toEqual(
      new Set(['https://acme-composer-prod.composer.example.test']),
    );
    // A self-managed Airflow has its URL in the configuration from the start.
    expect(at(fake.calls, (c) => c.envId === 'acme-emulator')).toEqual([0, 10_000, 20_000, 30_000]);
    // One client per environment and URL.
    expect(fake.airflowFactories).toEqual([
      'acme-emulator http://127.0.0.1:8080/api/v1',
      'acme-composer-prod https://acme-composer-prod.composer.example.test',
    ]);
  });

  it('FR-UI-04: the engine reports the Airflow web server URL for the "Open in" links once it knows it', async () => {
    const { time, engine } = setup({
      environments: [composerEnv('acme-composer-prod', 'live'), airflowEnv('acme-emulator', 'live')],
      collectors: [
        collector(manifest({ id: 'composer.config' }), async (ctx) => {
          const env = await ctx.composer!.environment({
            projectId: 'acme-prod-123',
            location: 'europe-west1',
            environment: 'acme-composer-prod',
          });
          ctx.shared.airflowBaseUrl = env.airflowUri;
          return { dataAsOf: ctx.now() };
        }),
      ],
    });
    // Before composer.config has run, Composer's airflowUri is not known; the configured URL is.
    expect(engine.airflowUri('acme-composer-prod')).toBeNull();
    expect(engine.airflowUri('acme-emulator')).toBe('http://127.0.0.1:8080/api/v1');
    expect(engine.airflowUri('acme-unknown')).toBeNull();
    engine.start();
    await time.advance(1_000);
    expect(engine.airflowUri('acme-composer-prod')).toBe('https://acme-composer-prod.composer.example.test');
    await time.settle(engine.stop());
  });
});
