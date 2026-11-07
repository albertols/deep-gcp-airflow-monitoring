/** A fake `ReadOnlyHttp` that records requests and answers from a handler (no network). */
import { readFileSync } from 'node:fs';
import type { AccessTokenSource, HttpResponse, ReadOnlyHttp } from '@dcam/ports';

export interface SentRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number | undefined;
}

export interface Reply {
  readonly status?: number;
  /** A string is sent as is; anything else is JSON-encoded. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Handler = (req: SentRequest) => Reply | Promise<Reply>;

export function response(reply: Reply): HttpResponse {
  const body =
    typeof reply.body === 'string' ? reply.body : reply.body === undefined ? '' : JSON.stringify(reply.body);
  const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: reply.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

export function fakeHttp(handler: Handler): { http: ReadOnlyHttp; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const http: ReadOnlyHttp = {
    async request(req) {
      const recorded: SentRequest = {
        method: req.method,
        url: new URL(req.url),
        headers: { ...req.headers },
        timeoutMs: req.timeoutMs,
      };
      sent.push(recorded);
      return response(await handler(recorded));
    },
  };
  return { http, sent };
}

/** Answers by pathname; unknown paths get 404. */
export function routes(table: Readonly<Record<string, Reply | ((req: SentRequest) => Reply)>>): Handler {
  return (req) => {
    const route = table[req.url.pathname];
    if (route === undefined) return { status: 404, body: { title: 'Not Found', status: 404 } };
    return typeof route === 'function' ? route(req) : route;
  };
}

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixture(name));
}

export function fakeTokens(...tokens: string[]): AccessTokenSource & {
  readonly calls: { accessToken: number; invalidate: number };
} {
  const calls = { accessToken: 0, invalidate: 0 };
  let index = 0;
  return {
    calls,
    async accessToken() {
      calls.accessToken += 1;
      return tokens[Math.min(index, tokens.length - 1)] ?? 'acme-token';
    },
    invalidate() {
      calls.invalidate += 1;
      index += 1;
    },
  };
}
