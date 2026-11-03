import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for the gateway's object reads (contracts/site-serving.md § 4, research
 * R11). Hand-written over `node:crypto` because the `gateway-runtime-deps` boundary rule lets the
 * gateway link only `jose` and `zod`: `@aws-sdk/*` would break it, and presigning in the broker
 * would cost a round trip per asset. Header-signed, never query-signed. It is checked against
 * AWS's published vectors in `sigv4.spec.ts`; change nothing here without them passing.
 */

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SignRequestInput {
  readonly credentials: SigV4Credentials;
  /** Further headers to sign and send (names are lowercased). `host`/`x-amz-*` are ours. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** `Host` as sent: hostname, plus `:port` when it is not the scheme's default. */
  readonly host: string;
  readonly method: 'GET' | 'HEAD';
  readonly now: () => Date;
  /** The decoded path; each segment is percent-encoded exactly once (S3 semantics). */
  readonly path: string;
  /**
   * When set, sent and signed as `x-amz-content-sha256` and used as the payload hash (S3). When
   * absent, the empty body's hash is used and no such header is sent (the generic suite).
   */
  readonly payloadHash?: string;
  readonly region: string;
  readonly service: string;
}

export interface SignedRequest {
  readonly canonicalRequest: string;
  /** Lowercased names; send exactly these. */
  readonly headers: Readonly<Record<string, string>>;
  readonly signature: string;
  readonly stringToSign: string;
}

const sha256Hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding of one segment: unreserved characters kept, every UTF-8 byte else `%XX`. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The canonical URI for a decoded path: `/` kept, every segment encoded once. */
export function encodeKeyPath(path: string): string {
  return path.split('/').map(encodeSegment).join('/');
}

/** `20150830T123600Z` */
function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function signRequest(input: SignRequestInput): SignedRequest {
  const date = amzDate(input.now());
  const day = date.slice(0, 8);
  const payloadHash = input.payloadHash ?? EMPTY_SHA256;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  headers.host = input.host;
  headers['x-amz-date'] = date;
  if (input.payloadHash !== undefined) headers['x-amz-content-sha256'] = input.payloadHash;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    encodeKeyPath(input.path),
    '',
    ...names.map((name) => `${name}:${headers[name]}`),
    '',
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { canonicalRequest, headers, signature, stringToSign };
}

/** The read-only artifacts bucket (gateway env `ARTIFACT_STORE_*`). */
export interface ObjectStoreTarget {
  readonly accessKeyId: string;
  readonly bucket: string;
  /** `https://host[:port][/prefix]`; `http:` only in `local` (enforced by config). */
  readonly endpoint: string;
  readonly region: string;
  readonly secretAccessKey: string;
}

export interface SignedS3Get extends SignedRequest {
  readonly url: string;
}

/** A path-style `GET {endpoint}/{bucket}/{key}`, `UNSIGNED-PAYLOAD`, service `s3`. */
export function signS3Get(
  target: ObjectStoreTarget,
  key: string,
  now: () => Date = () => new Date(),
  method: 'GET' | 'HEAD' = 'GET',
): SignedS3Get {
  const endpoint = new URL(target.endpoint);
  const prefix = decodeURIComponent(endpoint.pathname).replace(/\/+$/, '');
  const path = `${prefix}/${target.bucket}/${key}`;
  const signed = signRequest({
    credentials: target,
    host: endpoint.host,
    method,
    now,
    path,
    payloadHash: UNSIGNED_PAYLOAD,
    region: target.region,
    service: 's3',
  });
  return { ...signed, url: `${endpoint.protocol}//${endpoint.host}${encodeKeyPath(path)}` };
}
