import { describe, expect, it } from 'vitest';
import { csvCell, exportFileName, isoUtc, toCsv, type CsvColumn } from '../src/components/csv';

interface Row {
  readonly dag_id: string;
  readonly slot_seconds: number;
  readonly share: number | null;
  readonly at: string | null;
  readonly paused: boolean;
}

const COLUMNS: readonly CsvColumn<Row>[] = [
  { name: 'dag_id', value: (r) => r.dag_id },
  { name: 'executor_slot_seconds', value: (r) => r.slot_seconds },
  { name: 'share_ratio', value: (r) => r.share },
  { name: 'last_start_utc', value: (r) => isoUtc(r.at) },
  { name: 'paused', value: (r) => r.paused },
];

describe('FR-STORE-04 CSV writer', () => {
  it('FR-STORE-04: writes a header with units and one RFC 4180 line per row, CRLF line ends', () => {
    const csv = toCsv(COLUMNS, [
      { dag_id: 'acme_orders', slot_seconds: 1234.5, share: 0.25, at: '2026-11-05T12:00:00Z', paused: false },
      { dag_id: 'acme_idle', slot_seconds: 0, share: null, at: null, paused: true },
    ]);
    expect(csv).toBe(
      'dag_id,executor_slot_seconds,share_ratio,last_start_utc,paused\r\n' +
        'acme_orders,1234.5,0.25,2026-11-05T12:00:00.000Z,false\r\n' +
        'acme_idle,0,,,true\r\n',
    );
  });

  it('FR-STORE-04: an empty view is the header row only', () => {
    expect(toCsv(COLUMNS, [])).toBe('dag_id,executor_slot_seconds,share_ratio,last_start_utc,paused\r\n');
  });

  it('FR-STORE-04: quotes fields with commas, quotes, CR or LF and doubles the quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('plain text')).toBe('plain text');
  });

  it('FR-STORE-04: defuses text a spreadsheet would run as a formula', () => {
    // A leading CR also makes the field quoted, so the prefix follows the opening quote.
    for (const lead of ['=', '+', '-', '@', '\t', '\r'])
      expect(
        csvCell(`${lead}cmd|' /C calc'!A0`).replace(/^"/, '').startsWith(`'${lead}`),
        JSON.stringify(lead),
      ).toBe(true);
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-starts_with_dash')).toBe("'-starts_with_dash");
    // Numbers stay plain numbers, negative or not.
    expect(csvCell(-5)).toBe('-5');
  });

  it('FR-STORE-04: numbers are plain, missing values are empty, never 0', () => {
    expect(csvCell(1_234_567.891)).toBe('1234567.891');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('FR-STORE-04: times are ISO 8601 UTC from ISO strings or epoch milliseconds', () => {
    expect(isoUtc('2026-11-05T13:00:00+01:00')).toBe('2026-11-05T12:00:00.000Z');
    expect(isoUtc(Date.UTC(2026, 10, 5, 12))).toBe('2026-11-05T12:00:00.000Z');
    expect(isoUtc(null)).toBeNull();
    expect(isoUtc('not a time')).toBeNull();
  });
});

describe('FR-STORE-04 export file name', () => {
  it('FR-STORE-04: names the view, environment, range and data as of (UTC, minutes)', () => {
    expect(
      exportFileName('dags', { envId: 'acme-prod', range: '24h', asOf: '2026-11-05T12:34:56.000Z' }),
    ).toBe('dcam-dags-acme-prod-24h-2026-11-05T1234Z.csv');
  });

  it('FR-STORE-04: falls back to the range end, then to "undated"; leaves out what is not known', () => {
    expect(
      exportFileName('runs', {
        envId: 'acme-prod',
        range: '7d',
        asOf: null,
        rangeEnd: '2026-11-05T13:00:00+01:00',
      }),
    ).toBe('dcam-runs-acme-prod-7d-2026-11-05T1200Z.csv');
    expect(exportFileName('collectors', { envId: null, range: null, asOf: null })).toBe(
      'dcam-collectors-undated.csv',
    );
  });

  it('FR-STORE-04: names the page subject, such as the DAG, before the view', () => {
    expect(
      exportFileName('runs', {
        subject: 'dag-acme_orders',
        envId: 'acme-prod',
        range: '24h',
        asOf: '2026-11-05T12:00:00Z',
      }),
    ).toBe('dcam-dag-acme_orders-runs-acme-prod-24h-2026-11-05T1200Z.csv');
  });

  it('FR-STORE-04: replaces characters that are unsafe in file names', () => {
    expect(
      exportFileName('dag acme/orders:daily', {
        envId: 'acme prod',
        range: '1h',
        asOf: '2026-11-05T12:00:00Z',
      }),
    ).toBe('dcam-dag_acme_orders_daily-acme_prod-1h-2026-11-05T1200Z.csv');
  });
});
