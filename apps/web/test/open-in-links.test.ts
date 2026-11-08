import { describe, expect, it } from 'vitest';
import { openInLinks, triesWindow, type LinkContext, type LinkGroup } from '../src/components/open-in-links';

const COMPOSER = {
  composer: { project_id: 'acme-prod-123', location: 'us-central1', environment: 'acme-composer-prod' },
  airflow_uri: 'https://acme-composer-prod.airflow.example',
};
const WINDOW = { from: '2026-11-05T11:00:00.000Z', to: '2026-11-06T11:00:00.000Z' };
const ctx = (place: LinkContext['place']): LinkContext => ({
  place,
  window: WINDOW,
  windowText: '5 Nov, 11:00 UTC to 6 Nov, 11:00 UTC',
});
const RUN = { runId: 'scheduled__2026-11-05T00:00:00+00:00', logicalDate: '2026-11-05T00:00:00.000Z' };

/** `label → href` for links, `label → !reason` for what is missing, per group. */
function shape(groups: readonly LinkGroup[]) {
  return Object.fromEntries(
    groups.map((g) => [
      g.title,
      Object.fromEntries(g.links.map((l) => [l.label, l.kind === 'link' ? l.href : `!${l.reason}`])),
    ]),
  );
}

describe('"Open in" menu items (FR-UI-04)', () => {
  it('FR-UI-04: an environment opens its Composer pages, its logs over the range and the Airflow DAGs', () => {
    const groups = openInLinks(ctx(COMPOSER), { page: 'environment' });
    expect(groups.map((g) => g.title)).toEqual(['Cloud console', 'Airflow UI']);
    const s = shape(groups);
    expect(Object.keys(s['Cloud console'] ?? {})).toEqual([
      'Composer environments',
      'Metrics Explorer',
      'Logs Explorer: environment logs',
    ]);
    expect(s['Cloud console']?.['Logs Explorer: environment logs']).toContain(
      encodeURIComponent('timestamp>="2026-11-05T11:00:00.000Z"'),
    );
    expect(s['Airflow UI']).toEqual({ DAGs: 'https://acme-composer-prod.airflow.example/home' });
  });

  it('FR-UI-04: pages without a range parameter say which range to set there', () => {
    const consoleLinks = openInLinks(ctx(COMPOSER), { page: 'environment' })[0]?.links ?? [];
    const hint = (label: string) => {
      const l = consoleLinks.find((x) => x.label === label);
      return l?.kind === 'link' ? l.hint : undefined;
    };
    expect(hint('Metrics Explorer')).toContain(
      'Set the time range to 5 Nov, 11:00 UTC to 6 Nov, 11:00 UTC there',
    );
    expect(hint('Composer environments')).toMatch(/Open acme-composer-prod in the list.*Monitoring tab/);
  });

  it('FR-UI-04: the bottleneck page adds the pools list', () => {
    const s = shape(openInLinks(ctx(COMPOSER), { page: 'bottlenecks' }));
    expect(s['Airflow UI']).toEqual({
      Pools: 'https://acme-composer-prod.airflow.example/pool/list/',
      DAGs: 'https://acme-composer-prod.airflow.example/home',
    });
  });

  it('FR-UI-04: a DAG opens its grid to the range end, the selected run and its worker logs', () => {
    const s = shape(openInLinks(ctx(COMPOSER), { page: 'dag', dagId: 'acme_orders_daily', run: RUN }));
    expect(s['Airflow UI']).toEqual({
      'DAG grid':
        'https://acme-composer-prod.airflow.example/dags/acme_orders_daily/grid?base_date=2026-11-06T11%3A00%3A00Z',
      'Selected run':
        'https://acme-composer-prod.airflow.example/dags/acme_orders_daily/grid?dag_run_id=scheduled__2026-11-05T00%3A00%3A00%2B00%3A00&base_date=2026-11-05T00%3A00%3A01Z',
    });
    const logs = s['Cloud console']?.['Logs Explorer: DAG worker logs'] ?? '';
    expect(decodeURIComponent(logs)).toContain('labels.workflow="acme_orders_daily"');
    expect(decodeURIComponent(logs)).toContain('log_id("airflow-worker")');
  });

  it('FR-UI-04: a DAG without a run in the range says so instead of linking a run', () => {
    const s = shape(openInLinks(ctx(COMPOSER), { page: 'dag', dagId: 'acme_orders_daily', run: null }));
    expect(s['Airflow UI']?.['Selected run']).toBe('!No run of this DAG in the range. Pick a longer range.');
  });

  it("FR-UI-04: a task opens its log in the run and the DAG's worker logs while it ran", () => {
    const tries = { from: '2026-11-05T00:04:00.000Z', to: '2026-11-05T00:12:00.000Z' };
    const groups = openInLinks(ctx(COMPOSER), {
      page: 'task',
      dagId: 'acme_orders_daily',
      taskId: 'load_orders',
      run: RUN,
      tries,
    });
    const s = shape(groups);
    expect(s['Airflow UI']?.['Task log']).toBe(
      'https://acme-composer-prod.airflow.example/dags/acme_orders_daily/grid?dag_run_id=scheduled__2026-11-05T00%3A00%3A00%2B00%3A00&task_id=load_orders&tab=logs&base_date=2026-11-05T00%3A00%3A01Z',
    );
    const logs = decodeURIComponent(s['Cloud console']?.['Logs Explorer: task worker logs'] ?? '');
    expect(logs).toContain('timestamp>="2026-11-05T00:04:00.000Z"');
    expect(logs).toContain('timestamp<"2026-11-05T00:12:00.000Z"');
    const hint = groups[0]?.links[0];
    expect(hint?.kind === 'link' && hint.hint).toMatch(/Composer documents no task label/);
  });

  it('FR-UI-04: a task without a try in the selected run links nothing and says what to do', () => {
    const s = shape(
      openInLinks(ctx(COMPOSER), {
        page: 'task',
        dagId: 'acme_orders_daily',
        taskId: 'x',
        run: RUN,
        tries: null,
      }),
    );
    const reason = '!This task has no try in the selected run. Pick another run in the Gantt chart.';
    expect(s['Airflow UI']).toEqual({ 'Task log': reason });
    expect(s['Cloud console']).toEqual({ 'Logs Explorer: task worker logs': reason });
  });

  it('FR-UI-04: a self-managed Airflow gets Airflow UI links only, and says why there are no console pages', () => {
    const s = shape(openInLinks(ctx({ airflow_uri: 'http://127.0.0.1:8080' }), { page: 'environment' }));
    expect(s['Cloud console']).toEqual({
      'Cloud console pages': '!This environment is a self-managed Airflow, so it has no Cloud console pages.',
    });
    expect(s['Airflow UI']).toEqual({ DAGs: 'http://127.0.0.1:8080/home' });
  });

  it('FR-UI-04: an Airflow address that is not known yet, or not safe to link, gives no link', () => {
    const notYet = shape(openInLinks(ctx({ ...COMPOSER, airflow_uri: null }), { page: 'environment' }));
    expect(notYet['Airflow UI']?.['Airflow UI pages']).toMatch(
      /^!DCAM learns the Airflow UI address from the Composer API on its first collection cycle/,
    );
    const unsafe = shape(
      openInLinks(ctx({ ...COMPOSER, airflow_uri: 'https://acme:secret@acme.airflow.example' }), {
        page: 'environment',
      }),
    );
    expect(unsafe['Airflow UI']?.['Airflow UI pages']).toMatch(/^!The Airflow UI address DCAM has is not/);
    expect(JSON.stringify(unsafe)).not.toContain('secret');
  });

  it('FR-UI-04: before DCAM has read where the environment lives, every group says so', () => {
    const s = shape(openInLinks(ctx(null), { page: 'environment' }));
    for (const group of Object.values(s))
      expect(Object.values(group)).toEqual([
        '!DCAM could not read where this environment lives. Reload the page.',
      ]);
  });

  it('FR-UI-04: every reason for a missing Airflow address says what to do next', () => {
    const reasons = [
      { ...COMPOSER, airflow_uri: null },
      { airflow_uri: null },
      { ...COMPOSER, airflow_uri: 'ftp://acme.airflow.example' },
    ].map(
      (place) => shape(openInLinks(ctx(place), { page: 'environment' }))['Airflow UI']?.['Airflow UI pages'],
    );
    expect(reasons[0]).toMatch(/reload the page/);
    expect(reasons[1]).toMatch(/Check baseUrl in dcam\.config\.yaml/);
    expect(reasons[2]).toMatch(/Open the Airflow UI from the environment's page in the Cloud console/);
  });

  it('FR-UI-04: a task without a run in the range says to pick a longer range in both groups', () => {
    const s = shape(
      openInLinks(ctx(COMPOSER), {
        page: 'task',
        dagId: 'acme_orders_daily',
        taskId: 'x',
        run: null,
        tries: null,
      }),
    );
    const reason = '!No run of this DAG in the range. Pick a longer range.';
    expect(s['Cloud console']).toEqual({ 'Logs Explorer: task worker logs': reason });
    expect(s['Airflow UI']).toEqual({ 'Task log': reason });
  });

  it('FR-UI-04: a run whose logical date DCAM estimates says how to find it in the grid', () => {
    const groups = openInLinks(ctx(COMPOSER), {
      page: 'dag',
      dagId: 'acme_orders_daily',
      run: { runId: 'acme_custom_run', logicalDate: '2026-11-05T00:00:00.000Z', logicalDateEstimated: true },
    });
    const run = groups[1]?.links.find((l) => l.label === 'Selected run');
    expect(run?.kind === 'link' && run.hint).toMatch(
      /does not know the logical date.*raise the number of runs/,
    );
  });

  it('FR-UI-04: a DAG ID the URL parser would collapse (. or ..) gives no Airflow link', () => {
    for (const dagId of ['.', '..']) {
      const s = shape(openInLinks(ctx(COMPOSER), { page: 'dag', dagId, run: null }));
      expect(s['Airflow UI']?.['DAG grid']).toMatch(/^!The Airflow UI cannot open a DAG whose ID is/);
    }
  });

  it('FR-UI-04: a time DCAM cannot read gives no link instead of an error', () => {
    const bad = { ...ctx(COMPOSER), window: { from: 'not a time', to: WINDOW.to } };
    const s = shape(openInLinks(bad, { page: 'dag', dagId: 'acme_orders_daily', run: null }));
    for (const group of Object.values(s))
      expect(Object.values(group)).toEqual([
        '!DCAM could not read the time range of this page. Reload the page.',
      ]);
    const badRun = shape(
      openInLinks(ctx(COMPOSER), {
        page: 'dag',
        dagId: 'acme_orders_daily',
        run: { runId: 'acme_custom_run', logicalDate: 'nope' },
      }),
    );
    expect(badRun['Airflow UI']?.['Selected run']).toMatch(/^!DCAM could not read the logical date/);
  });
});

describe('the time window of a task in a run (FR-UI-04)', () => {
  const row = (start: string | null, end: string | null, queued_at: string | null = null) => ({
    start,
    end,
    queued_at,
    ready_at: null,
  });

  it('FR-UI-04: from the first try to the last, a minute either side; a running try ends at the range end', () => {
    expect(
      triesWindow(
        [row('2026-11-05T00:05:00.000Z', '2026-11-05T00:07:00.000Z'), row('2026-11-05T00:09:00.000Z', null)],
        '2026-11-05T00:11:00.000Z',
      ),
    ).toEqual({ from: '2026-11-05T00:04:00.000Z', to: '2026-11-05T00:12:00.000Z' });
  });

  it('FR-UI-04: a try that never started counts from when it was queued; no time at all is no window', () => {
    expect(triesWindow([row(null, null, '2026-11-05T00:05:00.000Z')], '2026-11-05T00:06:00.000Z')).toEqual({
      from: '2026-11-05T00:04:00.000Z',
      to: '2026-11-05T00:07:00.000Z',
    });
    expect(triesWindow([], '2026-11-05T00:06:00.000Z')).toBeNull();
    expect(triesWindow([row(null, null)], '2026-11-05T00:06:00.000Z')).toBeNull();
  });
});
