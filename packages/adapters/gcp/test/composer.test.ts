import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceError } from '@dcam/ports';
import { createComposerApi } from '../src/index';
import { fakeHttp, fakeTokens } from './support/fakes';

const ENVIRONMENT = readFileSync(new URL('./fixtures/composer-environment-v1.json', import.meta.url), 'utf8');
const REF = { projectId: 'acme-prod-123', location: 'europe-west1', environment: 'acme-composer-prod' };
const URL_V1 =
  'https://composer.googleapis.com/v1/projects/acme-prod-123/locations/europe-west1/environments/acme-composer-prod';

describe('FR-AUTH-04 Composer environments.get', () => {
  it('FR-AUTH-04: GETs the v1 environment with a bearer token and the environment project as quota project', async () => {
    const { http, requests } = fakeHttp({ status: 200, body: ENVIRONMENT });
    const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    await api.environment(REF);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url.toString()).toBe(URL_V1);
    expect(requests[0]?.headers).toMatchObject({
      authorization: 'Bearer acme-token-1',
      'x-goog-user-project': 'acme-prod-123',
    });
  });

  it('FR-AUTH-04: auth.quotaProjectId replaces the environment project in x-goog-user-project', async () => {
    const { http, requests } = fakeHttp({ status: 200, body: ENVIRONMENT });
    const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: 'acme-billing-456' });
    await api.environment(REF);
    expect(requests[0]?.headers['x-goog-user-project']).toBe('acme-billing-456');
  });

  it('FR-COLL-01: maps state, Airflow URI, image, overrides, workers and schedulers', async () => {
    const { http } = fakeHttp({ status: 200, body: ENVIRONMENT });
    const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    expect(await api.environment(REF)).toEqual({
      state: 'RUNNING',
      airflowUri: 'https://abc123-dot-europe-west1.composer.googleusercontent.com',
      imageVersion: 'composer-3-airflow-2.11.1-build.22',
      airflowConfigOverrides: { 'core-parallelism': '120', 'celery-worker_concurrency': '12' },
      worker: { minCount: 2, maxCount: 10, cpu: 2, memoryGb: 7.5 },
      schedulerCount: 2,
    });
  });

  it('FR-COLL-01: omitted fields (proto3 JSON drops defaults) become null, unknown states are kept', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: { name: 'projects/p/locations/l/environments/e', state: 'HIBERNATED_ACME' },
    });
    const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    expect(await api.environment(REF)).toEqual({
      state: 'HIBERNATED_ACME',
      airflowUri: null,
      imageVersion: null,
      airflowConfigOverrides: {},
      worker: { minCount: null, maxCount: null, cpu: null, memoryGb: null },
      schedulerCount: null,
    });
    const empty = fakeHttp({ status: 200, body: {} });
    const api2 = createComposerApi({ http: empty.http, tokens: fakeTokens().tokens, quotaProjectId: null });
    expect((await api2.environment(REF)).state).toBe('STATE_UNSPECIFIED');
  });

  it('FR-COLL-01: accepts integer fields encoded as strings', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: { state: 'RUNNING', config: { workloadsConfig: { worker: { minCount: '1', maxCount: '6' } } } },
    });
    const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    expect((await api.environment(REF)).worker).toMatchObject({ minCount: 1, maxCount: 6 });
  });

  it('FR-COLL-01: a body that does not match the schema is invalid-response', async () => {
    for (const body of [
      '<html>proxy</html>',
      { state: 7 },
      { config: { workloadsConfig: { worker: { minCount: 'x' } } } },
    ]) {
      const { http } = fakeHttp({ status: 200, body });
      const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
      await expect(api.environment(REF)).rejects.toMatchObject({
        name: 'SourceError',
        kind: 'invalid-response',
      });
    }
  });

  it('FR-AUTH-01: a 401 invalidates the token and retries once with a fresh one', async () => {
    const unauthorized = {
      status: 401,
      body: {
        error: {
          code: 401,
          message: 'Request had invalid authentication credentials.',
          status: 'UNAUTHENTICATED',
        },
      },
    };
    const { http, requests } = fakeHttp(unauthorized, { status: 200, body: ENVIRONMENT });
    const tokens = fakeTokens();
    const api = createComposerApi({ http, tokens: tokens.tokens, quotaProjectId: null });
    expect((await api.environment(REF)).state).toBe('RUNNING');
    expect(tokens.invalidations()).toBe(1);
    // It names the rejected token, so a refresh by a concurrent caller is not thrown away.
    expect(tokens.invalidated()).toEqual(['acme-token-1']);
    expect(requests.map((r) => r.headers['authorization'])).toEqual([
      'Bearer acme-token-1',
      'Bearer acme-token-2',
    ]);
  });

  it('FR-AUTH-01: a second 401 is unauthenticated with the login command', async () => {
    const unauthorized = {
      status: 401,
      body: {
        error: {
          code: 401,
          message: 'Request had invalid authentication credentials.',
          status: 'UNAUTHENTICATED',
        },
      },
    };
    const { http } = fakeHttp(unauthorized, unauthorized);
    const tokens = fakeTokens();
    const api = createComposerApi({ http, tokens: tokens.tokens, quotaProjectId: null });
    const error: unknown = await api.environment(REF).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: 'unauthenticated', details: { status: 401 } });
    expect((error as SourceError).details.fixHint).toContain('gcloud auth application-default login');
    expect(tokens.invalidations()).toBe(2);
  });

  it('FR-AUTH-06: a VPC Service Controls denial is classified and not retried', async () => {
    const { http, requests } = fakeHttp({
      status: 403,
      body: {
        error: {
          code: 403,
          message:
            "Request is prohibited by organization's policy. vpcServiceControlsUniqueIdentifier: acmeVpcScId0001",
          status: 'PERMISSION_DENIED',
        },
      },
    });
    const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    await expect(api.environment(REF)).rejects.toMatchObject({
      kind: 'vpc-sc',
      details: { vpcScId: 'acmeVpcScId0001' },
    });
    expect(requests).toHaveLength(1);
  });

  it('FR-AUTH-04: rejects environment references that would change the path', async () => {
    const { http, requests } = fakeHttp();
    const api = createComposerApi({ http, tokens: fakeTokens().tokens, quotaProjectId: null });
    for (const ref of [
      { ...REF, environment: 'acme/../x' },
      { ...REF, location: '' },
      { ...REF, projectId: 'acme:restart' },
    ]) {
      await expect(api.environment(ref)).rejects.toBeInstanceOf(RangeError);
    }
    expect(requests).toHaveLength(0);
  });
});
