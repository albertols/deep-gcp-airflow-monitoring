/** Host names that always mean this machine (WHATWG URL `hostname` form, IPv6 in brackets). */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}
