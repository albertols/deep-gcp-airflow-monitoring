/**
 * TEST-ONLY public key infrastructure for loopback TLS tests. Each call creates a fresh certificate
 * authority and a server certificate for 127.0.0.1, ::1 and localhost, in memory, valid for two days.
 * Nothing is written to disk by this module and no key is committed to the repository: the keys live
 * only as long as the test process. Never use these certificates outside tests.
 *
 * The certificates are X.509 v3 (RFC 5280) with ECDSA P-256 and SHA-256, encoded in DER by hand
 * because Node.js can sign but not build certificates.
 */
import { X509Certificate, createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

// ---- Minimal DER encoder (ITU-T X.690) -----------------------------------------------------------

function tlv(tag: number, content: Buffer): Buffer {
  const n = content.length;
  let length: Buffer;
  if (n < 0x80) length = Buffer.from([n]);
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const octets = (b: Buffer) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner);

function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1] ?? 0) < 0x80) b = b.subarray(1);
  return tlv(0x02, (b[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number);
  const out = [a * 40 + b];
  for (const v of rest) {
    const chunk: number[] = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const name = (commonName: string) =>
  seq(set(seq(oid('2.5.4.10'), utf8('DCAM tests'))), set(seq(oid('2.5.4.3'), utf8(commonName))));

const extension = (id: string, critical: boolean, value: Buffer) =>
  critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function keyId(publicKey: KeyObject): Buffer {
  return createHash('sha1')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest();
}

function certificate(input: {
  subject: string;
  issuer: string;
  subjectKey: KeyObject;
  issuerKey: KeyObject;
  issuerPublicKey: KeyObject;
  ca: boolean;
}): string {
  const now = Date.now();
  const extensions = [
    extension('2.5.29.19', true, input.ca ? seq(bool(true)) : seq()),
    // keyUsage: keyCertSign + cRLSign for the CA, digitalSignature for the server.
    extension(
      '2.5.29.15',
      true,
      input.ca ? tlv(0x03, Buffer.from([1, 0x06])) : tlv(0x03, Buffer.from([7, 0x80])),
    ),
    extension('2.5.29.14', false, octets(keyId(input.subjectKey))),
    extension('2.5.29.35', false, seq(tlv(0x80, keyId(input.issuerPublicKey)))),
  ];
  if (!input.ca) {
    extensions.push(extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));
    extensions.push(
      extension(
        '2.5.29.17',
        false,
        seq(
          tlv(0x87, Buffer.from([127, 0, 0, 1])),
          tlv(0x87, Buffer.from([...Array<number>(15).fill(0), 1])),
          tlv(0x82, Buffer.from('localhost', 'ascii')),
        ),
      ),
    );
  }
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(createHash('sha256').update(`${input.subject}${now}${Math.random()}`).digest().subarray(0, 16)),
    ECDSA_SHA256,
    name(input.issuer),
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    name(input.subject),
    input.subjectKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, input.issuerKey);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

export interface TestPki {
  /** PEM of the test-only CA certificate (public). */
  readonly caCert: string;
  /** PEM of the server certificate for 127.0.0.1, ::1 and localhost, signed by the CA. */
  readonly serverCert: string;
  /** The server's private key (PKCS #8 PEM), in memory only. */
  readonly serverKey: string;
}

/** A fresh test-only CA and server certificate. */
export function createTestPki(label = 'DCAM test-only CA (never trust)'): TestPki {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const server = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caCert = certificate({
    subject: label,
    issuer: label,
    subjectKey: ca.publicKey,
    issuerKey: ca.privateKey,
    issuerPublicKey: ca.publicKey,
    ca: true,
  });
  const serverCert = certificate({
    subject: '127.0.0.1',
    issuer: label,
    subjectKey: server.publicKey,
    issuerKey: ca.privateKey,
    issuerPublicKey: ca.publicKey,
    ca: false,
  });
  // Fail fast if the encoder is wrong, rather than with a confusing TLS error later.
  if (!new X509Certificate(serverCert).verify(ca.publicKey)) throw new Error('test PKI: bad signature');
  const serverKey = server.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { caCert, serverCert, serverKey };
}
