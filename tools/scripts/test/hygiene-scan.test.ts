import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { GENERIC_PATTERNS, parseDenylist, scanText } from '../hygiene-scan.mjs';

type Finding = { line: number; id: string; sample: string };
const scan = (text: string, extra = ''): Finding[] =>
  scanText(text, [...GENERIC_PATTERNS, ...parseDenylist(extra)]) as Finding[];

describe('NFR-OSS-02 public-repository hygiene scan (spec §18.12)', () => {
  it('flags real-looking service accounts and Airflow hosts, but not placeholders', () => {
    expect(scan('sa: dcam-reader@corp-data-prd.iam.gserviceaccount.com')).toHaveLength(1); // hygiene-scan: allow (fixture)
    expect(scan('sa: dcam-reader@acme-data-prod.iam.gserviceaccount.com')).toHaveLength(0);
    expect(scan('sa: dcam-reader@PROJECT_ID.iam.gserviceaccount.com')).toHaveLength(0);
    expect(scan('url: https://f3a9c1-dot-europe-west3.composer.googleusercontent.com')).toHaveLength(1); // hygiene-scan: allow (fixture)
    expect(scan('url: https://abc123-dot-europe-west1.composer.googleusercontent.com')).toHaveLength(0);
  });

  it('always flags secrets, and redacts what it reports', () => {
    const [finding] = scan('token = ya29.a0AfB_byC1234567890abcdefghijklmnop'); // hygiene-scan: allow (fixture)
    expect(finding?.id).toBe('oauth-access-token');
    expect(finding?.sample).not.toContain('1234567890');
    expect(scan('-----BEGIN PRIVATE KEY-----')).toHaveLength(1); // hygiene-scan: allow (fixture)
  });

  it('skips lines that carry the explicit allow marker', () => {
    // The token is assembled at runtime so this source line never contains a contiguous token.
    const line = `token = ${'ya29.'}${'a0AfB_byC1234567890abcdefghijklmnop'} // ${'hygiene-scan'}: allow`;
    expect(scan(line)).toHaveLength(0);
  });

  it('applies the personal denylist (literals and /regex/)', () => {
    const denylist = '# my environments\ncorp-data-prd\n/orders_[a-z]+_v2/';
    expect(scan('projectId: corp-data-prd', denylist)).toHaveLength(1);
    expect(scan('dag: orders_mart_v2', denylist)).toHaveLength(1);
    expect(scan('projectId: acme-data-prod', denylist)).toHaveLength(0);
  });
});
