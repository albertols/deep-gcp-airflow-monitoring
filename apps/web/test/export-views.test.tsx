import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import type { ComponentType } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDcamTheme } from '@dcam/ui-kit';
import type { DcamApi } from '../src/api';
import { PageParamsContext } from '../src/components/view';
import { DagsPage } from '../src/pages/dags/DagsPage';
import type { PageProps } from '../src/pages/types';
import { linkTo, type PageParams, type Route } from '../src/router';
import { DETAIL, LEAGUE } from './dag-fixtures';

/** Whole-page tests: jsdom renders MUI slowly on a loaded machine. */
const UI_TIMEOUT_MS = 30_000;

// jsdom has no layout: give scroll containers a viewport so the virtualised league renders its rows.
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 560 });
});
afterAll(() => {
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
});

const notYet = () => Promise.reject(new Error('not in this test'));
function fakeApi(overrides: Partial<DcamApi> = {}): DcamApi {
  return {
    getMeta: notYet,
    getOverview: notYet,
    getDagLeague: async () => LEAGUE,
    getDagDetail: async () => DETAIL,
    getBottlenecks: notYet,
    getSchedule: notYet,
    getFindings: notYet,
    getAlerts: notYet,
    getFleet: notYet,
    getCollection: notYet,
    ...overrides,
  };
}

/** Renders a page with fixed page parameters, as a shared link with filters and sort opens it. */
function renderPage(Page: ComponentType<PageProps>, api: DcamApi, route: Route, params: PageParams = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider theme={createDcamTheme('dark')}>
      <QueryClientProvider client={client}>
        <PageParamsContext.Provider value={{ params, set: () => {} }}>
          <Page
            api={api}
            envId="acme-prod"
            route={route}
            linkTo={(r) => linkTo(r, 'acme-prod')}
            navigate={vi.fn()}
          />
        </PageParamsContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

interface Download {
  readonly name: string;
  readonly text: string;
}

/** Captures what the export buttons save: the file name and the text of each blob. */
function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      blobs.push(b);
      return `blob:dcam/${blobs.length}`;
    }),
    revokeObjectURL: vi.fn(),
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return {
    async files(): Promise<Download[]> {
      return Promise.all(blobs.map(async (b, i) => ({ name: names[i] ?? '', text: await b.text() })));
    },
    restore: () => click.mockRestore(),
  };
}
let downloads: ReturnType<typeof captureDownloads>;
afterEach(() => downloads?.restore());

/** A small RFC 4180 reader for the tests: quoted fields, doubled quotes, CRLF records. */
function parseCsv(text: string): { header: string[]; records: string[][] } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i++;
    } else field += c;
  }
  const [header = [], ...rest] = records;
  return { header, records: rest };
}

/** One column of a CSV file by its header name. */
function csvColumn(text: string, name: string): string[] {
  const { header, records } = parseCsv(text);
  const at = header.indexOf(name);
  if (at === -1) throw new Error(`no column ${name} in ${header.join(',')}`);
  return records.map((r) => r[at] ?? '');
}

const bodyRows = (name: string) =>
  within(screen.getByRole('table', { name }))
    .getAllByRole('row')
    .filter((r) => within(r).queryAllByRole('cell').length > 0);

/** The text of one cell in each body row of a rendered table. */
const tableColumn = (name: string, cellIndex: number): string[] =>
  bodyRows(name).map((r) => within(r).getAllByRole('cell')[cellIndex]?.textContent ?? '');

/** The first link of each body row (DAG IDs link to the DAG). */
const linkColumn = (name: string): string[] =>
  bodyRows(name).map((r) => within(r).queryAllByRole('link')[0]?.textContent ?? '');

async function exportCsv(what: string): Promise<Download> {
  await userEvent.click(screen.getByRole('button', { name: `Export CSV, ${what}` }));
  const files = await downloads.files();
  const file = files.at(-1);
  if (!file) throw new Error('nothing was downloaded');
  return file;
}

describe('FR-STORE-04 the export equals the filtered view', { timeout: UI_TIMEOUT_MS }, () => {
  it('FR-STORE-04: the DAG league exports its filtered, sorted rows in their order', async () => {
    downloads = captureDownloads();
    renderPage(DagsPage, fakeApi(), { page: 'dags' }, { tag: 'hourly', sort: 'dag_id.desc' });
    await screen.findByRole('table', { name: 'DAG league table' });
    const shown = linkColumn('DAG league table');
    expect(shown).toEqual(['partner_crm_sync', 'fraud_scoring_hourly']);

    const file = await exportCsv('DAG league table');
    expect(file.name).toBe('dcam-dags-acme-prod-24h-2026-11-05T1200Z.csv');
    expect(csvColumn(file.text, 'dag_id')).toEqual(shown);
    // Machine-readable values, not the table's formatted text.
    expect(csvColumn(file.text, 'executor_slot_seconds')).toEqual(['12000', '36000']);
    expect(csvColumn(file.text, 'share_ratio')).toEqual(['0.1', '0.3']);
    expect(csvColumn(file.text, 'run_duration_p95_seconds')).toEqual(['1500', '900']);
    expect(csvColumn(file.text, 'run_duration_p95_low_sample')).toEqual(['true', 'false']);
  });
});
