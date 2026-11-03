import { describe, expect, it } from 'vitest';

import { encodeKeyPath, signRequest, signS3Get, UNSIGNED_PAYLOAD } from './sigv4.ts';

/** The empty-body sha-256 every AWS vector below uses as its payload hash. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * AWS SigV4 test suite (`aws-sig-v4-test-suite`, "get-vanilla"): the credentials, clock, region
 * and service every case in that suite shares.
 */
const SUITE = {
  credentials: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  },
  now: () => new Date('2015-08-30T12:36:00Z'),
  region: 'us-east-1',
  service: 'service',
} as const;

describe('signRequest: AWS SigV4 test suite', () => {
  it('get-vanilla: canonical request, string to sign and signature', () => {
    const signed = signRequest({
      ...SUITE,
      host: 'example.amazonaws.com',
      method: 'GET',
      path: '/',
    });

    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(signed.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      ].join('\n'),
    );
    expect(signed.signature).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(signed.headers).toEqual({
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
      host: 'example.amazonaws.com',
      'x-amz-date': '20150830T123600Z',
    });
  });

  it('get-utf8: a non-ASCII path segment is UTF-8 percent-encoded once', () => {
    const signed = signRequest({
      ...SUITE,
      host: 'example.amazonaws.com',
      method: 'GET',
      path: '/ሴ',
    });

    expect(signed.canonicalRequest.split('\n')[1]).toBe('/%E1%88%B4');
    expect(signed.signature).toBe(
      '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85',
    );
  });
});

describe('signRequest: AWS S3 documentation, "Example: GET Object"', () => {
  it('reproduces the published canonical request, string to sign and signature', () => {
    const signed = signRequest({
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      extraHeaders: { Range: 'bytes=0-9' },
      host: 'examplebucket.s3.amazonaws.com',
      method: 'GET',
      now: () => new Date('2013-05-24T00:00:00Z'),
      path: '/test.txt',
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      service: 's3',
    });

    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_SHA256}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(signed.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20130524T000000Z',
        '20130524/us-east-1/s3/aws4_request',
        '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
      ].join('\n'),
    );
    expect(signed.signature).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(signed.headers.range).toBe('bytes=0-9');
  });
});

describe('encodeKeyPath', () => {
  it('keeps "/" and RFC 3986 unreserved characters, and encodes everything else once', () => {
    expect(encodeKeyPath('/bucket/a b/ç+(1)*!~_-.js')).toBe(
      '/bucket/a%20b/%C3%A7%2B%281%29%2A%21~_-.js',
    );
    expect(encodeKeyPath("/b/%2F'?#&=;:@,$")).toBe('/b/%252F%27%3F%23%26%3D%3B%3A%40%2C%24');
  });
});

describe('signS3Get: path-style, UNSIGNED-PAYLOAD, injected clock', () => {
  const store = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    bucket: 'artifacts',
    endpoint: 'https://s3.example.test:9000',
    region: 'auto',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('signs a path-style key with characters that need encoding', () => {
    const signed = signS3Get(store, 'org/proj/blobs/a b+ç', () => new Date('2026-09-22T10:11:12Z'));

    expect(signed.url).toBe('https://s3.example.test:9000/artifacts/org/proj/blobs/a%20b%2B%C3%A7');
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/artifacts/org/proj/blobs/a%20b%2B%C3%A7',
        '',
        'host:s3.example.test:9000',
        `x-amz-content-sha256:${UNSIGNED_PAYLOAD}`,
        'x-amz-date:20260922T101112Z',
        '',
        'host;x-amz-content-sha256;x-amz-date',
        UNSIGNED_PAYLOAD,
      ].join('\n'),
    );
    expect(signed.stringToSign.split('\n').slice(0, 3)).toEqual([
      'AWS4-HMAC-SHA256',
      '20260922T101112Z',
      '20260922/auto/s3/aws4_request',
    ]);
    // Cross-checked once against @smithy/signature-v4 (the AWS SDK's signer) for the same input.
    expect(signed.signature).toBe(
      '1aa09f1676a8be28556bf4929fa541eac4b79afb703ec05e8ca3ef3287c2f7ad',
    );
    expect(signed.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
  });

  it('keeps an endpoint path prefix and drops the default port from Host', () => {
    const signed = signS3Get(
      { ...store, endpoint: 'https://s3.example.test/prefix/' },
      'k/index.html',
      () => new Date('2026-09-22T10:11:12Z'),
    );

    expect(signed.url).toBe('https://s3.example.test/prefix/artifacts/k/index.html');
    expect(signed.headers.host).toBe('s3.example.test');
  });

  it('dates the request from the injected clock, not the wall clock', () => {
    const a = signS3Get(store, 'k', () => new Date('2020-01-01T00:00:00Z'));
    const b = signS3Get(store, 'k', () => new Date('2020-01-02T00:00:00Z'));

    expect(a.headers['x-amz-date']).toBe('20200101T000000Z');
    expect(b.headers['x-amz-date']).toBe('20200102T000000Z');
    expect(a.signature).not.toBe(b.signature);
  });
});
