import type { AccessTokenSource, HttpResponse, ReadOnlyHttp } from '@dcam/ports';

export interface FakeReply {
  readonly status: number;
  /** A string is sent as is; anything else as JSON. */
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

/** A ReadOnlyHttp that answers from a queue and records every request. */
export function fakeHttp(...replies: FakeReply[]) {
  const queue = [...replies];
  const requests: RecordedRequest[] = [];
  const http: ReadOnlyHttp = {
    async request(req) {
      requests.push({ method: req.method, url: new URL(req.url), headers: { ...req.headers } });
      const reply = queue.shift();
      if (!reply) throw new Error(`fakeHttp: no reply queued for ${req.url}`);
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const response: HttpResponse = {
        status: reply.status,
        headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
        text: async () => text,
      };
      return response;
    },
  };
  return { http, requests, pending: () => queue.length };
}

/** Tokens `acme-token-1`, `acme-token-2`, … ; invalidating the current one moves to the next. */
export function fakeTokens() {
  let n = 1;
  const invalidated: Array<string | undefined> = [];
  const tokens: AccessTokenSource = {
    async accessToken() {
      return `acme-token-${n}`;
    },
    invalidate(token?: string) {
      invalidated.push(token);
      if (token === undefined || token === `acme-token-${n}`) n += 1;
    },
  };
  return { tokens, invalidations: () => invalidated.length, invalidated: () => [...invalidated] };
}
