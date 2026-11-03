import { validateEnvironment } from './environment.ts';

const MTLS = {
  BROKER_TLS_CA: '-----BEGIN CERTIFICATE-----ca',
  BROKER_TLS_CERT: '-----BEGIN CERTIFICATE-----cert',
  BROKER_TLS_KEY: '-----BEGIN PRIVATE KEY-----key',
  BROKER_TRANSPORT: 'mtls',
};
// The schema only checks shape, not cryptographic validity — that is jose's job in
// route-verify.ts — so a hand-built key is enough to exercise PREVIEW_PUBLIC_JWKS.
const JWKS = JSON.stringify({
  keys: [{ alg: 'EdDSA', crv: 'Ed25519', kid: 'k1', kty: 'OKP', use: 'sig', x: 'AAAA' }],
});

// Spec 027 R11: a gateway that serves sites holds a read-only key for the artifacts bucket.
const SITES = {
  ARTIFACT_STORE_ACCESS_KEY_ID: 'placeholder-read-only-key',
  ARTIFACT_STORE_BUCKET: 'forge-artifacts',
  ARTIFACT_STORE_ENDPOINT: 'http://localhost:9000',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'placeholder-read-only-secret',
  SITE_DOMAIN: 'forge-site.localhost',
};
const ARTIFACT_STORE_KEYS = [
  'ARTIFACT_STORE_ACCESS_KEY_ID',
  'ARTIFACT_STORE_BUCKET',
  'ARTIFACT_STORE_ENDPOINT',
  'ARTIFACT_STORE_SECRET_ACCESS_KEY',
] as const;

/** A copy of `record` without `key` — a variable left unset. */
function without<T extends Record<string, unknown>>(record: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...record };
  delete copy[key];
  return copy;
}

function validEnvironment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DEPLOY_ENV: 'local',
    PREVIEW_PUBLIC_JWKS: JWKS,
    ...overrides,
  };
}

describe('validateEnvironment', () => {
  it('TLS_ASK_PORT is an optional port', () => {
    expect(validateEnvironment(validEnvironment({ TLS_ASK_PORT: '3201' })).TLS_ASK_PORT).toBe(3201);
    expect(() => validateEnvironment(validEnvironment({ TLS_ASK_PORT: '0' }))).toThrow();
  });

  it('defaults to a plain broker on :3001 and PORT 3200 under local', () => {
    const result = validateEnvironment(validEnvironment());

    expect(result.BROKER_TRANSPORT).toBe('plain');
    expect(result.BROKER_HOST).toBe('localhost');
    expect(result.BROKER_PORT).toBe(3001);
    expect(result.BROKER_ORIGIN).toBe('http://localhost:3001');
    expect(result.PREVIEW_UPSTREAM_DIAL).toBeUndefined();
    expect(result.BROKER_SHARED_SECRET).toBe('local-broker-secret');
    expect(result.PORT).toBe(3200);
    expect(result.PREVIEW_DOMAIN).toBe('forge-preview.localhost');
    expect(result.PRODUCT_ORIGIN).toBe('http://localhost:5173');
    expect(result.ROUTE_CACHE_MAX).toBe(1_000);
    expect(result.ROUTE_CACHE_TTL_MS).toBe(5_000);
    expect(result.GATEWAY_UPSTREAM_TIMEOUT_MS).toBe(30_000);
    expect(result.GATEWAY_SOCKET_MAX_MS).toBe(3_600_000);
    expect(result.GATEWAY_WAKE_BUDGET_MS).toBe(90_000);
    expect(result.TLS_ASK_PORT).toBeUndefined();
  });

  it('names the missing variable when DEPLOY_ENV is absent', () => {
    const environment = validEnvironment();
    delete environment.DEPLOY_ENV;

    expect(() => validateEnvironment(environment)).toThrow(/DEPLOY_ENV/);
  });

  describe('PREVIEW_PUBLIC_JWKS', () => {
    it('is required even under DEPLOY_ENV=local — the gateway is verify-only and has no way to reach an ephemeral key the API generated in its own process', () => {
      const environment = validEnvironment();
      delete environment.PREVIEW_PUBLIC_JWKS;

      expect(() => validateEnvironment(environment)).toThrow(/PREVIEW_PUBLIC_JWKS/);
    });

    it('parses a JWKS and keeps its keys', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.PREVIEW_PUBLIC_JWKS.keys).toEqual([
        expect.objectContaining({ crv: 'Ed25519', kid: 'k1', kty: 'OKP' }),
      ]);
    });

    it('refuses a value that is not JSON and a JWKS shaped wrong', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ PREVIEW_PUBLIC_JWKS: 'not-json' })),
      ).toThrow(/PREVIEW_PUBLIC_JWKS/);
      expect(() =>
        validateEnvironment(validEnvironment({ PREVIEW_PUBLIC_JWKS: '{"keys":"no"}' })),
      ).toThrow(/PREVIEW_PUBLIC_JWKS/);
    });
  });

  describe('broker transport', () => {
    it('refuses a plain broker without its shared secret', () => {
      expect(() => validateEnvironment(validEnvironment({ BROKER_SHARED_SECRET: '' }))).toThrow(
        /BROKER_SHARED_SECRET/,
      );
    });

    it('builds the broker origin from the transport scheme, BROKER_HOST and BROKER_PORT', () => {
      const result = validateEnvironment(
        validEnvironment({ ...MTLS, BROKER_HOST: 'broker', BROKER_PORT: '4431' }),
      );

      expect(result.BROKER_ORIGIN).toBe('https://broker:4431');
    });

    it('accepts mtls under local', () => {
      const result = validateEnvironment(validEnvironment(MTLS));

      expect(result.BROKER_TRANSPORT).toBe('mtls');
      expect(result.BROKER_SHARED_SECRET).toBeUndefined();
    });

    it('refuses mtls material set by halves', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ BROKER_TLS_CA: MTLS.BROKER_TLS_CA })),
      ).toThrow(/BROKER_TLS_CERT.*BROKER_TLS_KEY/s);
    });

    it('refuses mtls without its material', () => {
      expect(() => validateEnvironment(validEnvironment({ BROKER_TRANSPORT: 'mtls' }))).toThrow(
        /BROKER_TLS_CA/,
      );
    });

    it.each(['staging', 'production'])('refuses a plain broker outside local (%s)', (deploy) => {
      expect(() =>
        validateEnvironment(
          validEnvironment({ ...MTLS, DEPLOY_ENV: deploy, BROKER_TRANSPORT: 'plain' }),
        ),
      ).toThrow(/BROKER_TRANSPORT/);
    });

    it.each(['staging', 'production'])('accepts mtls outside local (%s)', (deploy) => {
      const result = validateEnvironment(validEnvironment({ ...MTLS, DEPLOY_ENV: deploy }));

      expect(result.BROKER_TRANSPORT).toBe('mtls');
    });
  });

  describe('site serving (spec 027)', () => {
    it('boots a preview-only gateway with no SITE_DOMAIN, locally and outside local', () => {
      const local = validateEnvironment(validEnvironment());
      const staging = validateEnvironment(validEnvironment({ ...MTLS, DEPLOY_ENV: 'staging' }));

      expect(local.SITE_DOMAIN).toBeUndefined();
      expect(local.ARTIFACT_STORE_ENDPOINT).toBeUndefined();
      expect(staging.SITE_DOMAIN).toBeUndefined();
    });

    it('accepts the full set under local, lowercasing SITE_DOMAIN', () => {
      const result = validateEnvironment(
        validEnvironment({ ...SITES, SITE_DOMAIN: ' Forge-Site.Localhost ' }),
      );

      expect(result.SITE_DOMAIN).toBe('forge-site.localhost');
      expect(result.ARTIFACT_STORE_BUCKET).toBe('forge-artifacts');
      expect(result.ARTIFACT_STORE_ENDPOINT).toBe('http://localhost:9000');
    });

    it.each(ARTIFACT_STORE_KEYS)('requires %s when SITE_DOMAIN is set', (key) => {
      const partial = without(SITES, key);

      expect(() => validateEnvironment(validEnvironment(partial))).toThrow(
        new RegExp(`is required when SITE_DOMAIN is set\\n\\s*→ at ${key}`),
      );
    });

    it('refuses an artifact store configured without SITE_DOMAIN', () => {
      const storeOnly = without(SITES, 'SITE_DOMAIN');

      expect(() => validateEnvironment(validEnvironment(storeOnly))).toThrow(/→ at SITE_DOMAIN/);
    });

    it('refuses an endpoint that is not a URL', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ ...SITES, ARTIFACT_STORE_ENDPOINT: 'not a url' })),
      ).toThrow(/ARTIFACT_STORE_ENDPOINT/);
    });

    it.each(['staging', 'production'])(
      'refuses an http: endpoint outside local and accepts https: (%s)',
      (deploy) => {
        const real = { ...MTLS, ...SITES, DEPLOY_ENV: deploy, SITE_DOMAIN: 'forge-sites.example' };

        expect(() => validateEnvironment(validEnvironment(real))).toThrow(
          /http:[^\n]*\n\s*→ at ARTIFACT_STORE_ENDPOINT/,
        );
        expect(
          validateEnvironment(
            validEnvironment({ ...real, ARTIFACT_STORE_ENDPOINT: 'https://acct.r2.example' }),
          ).ARTIFACT_STORE_ENDPOINT,
        ).toBe('https://acct.r2.example');
      },
    );

    it('refuses a SITE_DOMAIN equal to or under PREVIEW_DOMAIN, and the reverse', () => {
      for (const overrides of [
        { SITE_DOMAIN: 'forge-preview.localhost' },
        { SITE_DOMAIN: 'sites.forge-preview.localhost' },
        { PREVIEW_DOMAIN: 'preview.forge-site.localhost' },
      ]) {
        expect(() => validateEnvironment(validEnvironment({ ...SITES, ...overrides }))).toThrow(
          /PREVIEW_DOMAIN[^\n]*\n\s*→ at SITE_DOMAIN/,
        );
      }
    });

    it('refuses a SITE_DOMAIN equal to, under or above the product host', () => {
      for (const site of ['app.forge.example', 'sites.app.forge.example', 'forge.example']) {
        expect(() =>
          validateEnvironment(
            validEnvironment({
              ...SITES,
              PRODUCT_ORIGIN: 'https://app.forge.example',
              SITE_DOMAIN: site,
            }),
          ),
        ).toThrow(/PRODUCT_ORIGIN[^\n]*\n\s*→ at SITE_DOMAIN/);
      }
    });

    it('compares whole labels, and does not treat a single-label product host as a parent', () => {
      expect(
        validateEnvironment(
          validEnvironment({
            ...SITES,
            PRODUCT_ORIGIN: 'https://app.forge.example',
            SITE_DOMAIN: 'xapp.forge.example',
          }),
        ).SITE_DOMAIN,
      ).toBe('xapp.forge.example');
      // The local defaults: `forge-site.localhost` beside a product on `localhost`.
      expect(validateEnvironment(validEnvironment(SITES)).SITE_DOMAIN).toBe('forge-site.localhost');
    });
  });

  describe('edge origin secret (spec 028 R15)', () => {
    const SECRET = 'a'.repeat(32);

    // Without the secret the gateway serves no custom hostname, and nothing else changes: the
    // pipeline and site-serve specs build their gateways from exactly this environment.
    it('boots with no EDGE_ORIGIN_SECRET and still serves previews and sites', () => {
      const previewOnly = validateEnvironment(validEnvironment());
      const withSites = validateEnvironment(validEnvironment(SITES));
      const staging = validateEnvironment(
        validEnvironment({
          ...MTLS,
          ...SITES,
          ARTIFACT_STORE_ENDPOINT: 'https://objects.forge.example',
          DEPLOY_ENV: 'staging',
          SITE_DOMAIN: 'forge-sites.example',
        }),
      );

      expect(previewOnly.EDGE_ORIGIN_SECRET).toBeUndefined();
      expect(previewOnly.PREVIEW_DOMAIN).toBe('forge-preview.localhost');
      expect(withSites.EDGE_ORIGIN_SECRET).toBeUndefined();
      expect(withSites.SITE_DOMAIN).toBe('forge-site.localhost');
      expect(staging.EDGE_ORIGIN_SECRET).toBeUndefined();
    });

    it('accepts a secret of at least 32 characters beside SITE_DOMAIN', () => {
      const result = validateEnvironment(
        validEnvironment({ ...SITES, EDGE_ORIGIN_SECRET: SECRET }),
      );

      expect(result.EDGE_ORIGIN_SECRET).toBe(SECRET);
    });

    it('refuses a secret shorter than 32 characters', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ ...SITES, EDGE_ORIGIN_SECRET: 'a'.repeat(31) })),
      ).toThrow(/→ at EDGE_ORIGIN_SECRET/);
    });

    it('refuses the secret on a gateway with no SITE_DOMAIN', () => {
      expect(() => validateEnvironment(validEnvironment({ EDGE_ORIGIN_SECRET: SECRET }))).toThrow(
        /SITE_DOMAIN[^\n]*\n\s*→ at EDGE_ORIGIN_SECRET/,
      );
    });
  });

  describe('PREVIEW_UPSTREAM_DIAL', () => {
    it('accepts an origin under local and refuses a non-URL', () => {
      expect(
        validateEnvironment(validEnvironment({ PREVIEW_UPSTREAM_DIAL: 'http://127.0.0.1:4000' }))
          .PREVIEW_UPSTREAM_DIAL,
      ).toBe('http://127.0.0.1:4000');
      expect(() =>
        validateEnvironment(validEnvironment({ PREVIEW_UPSTREAM_DIAL: 'not a url' })),
      ).toThrow(/PREVIEW_UPSTREAM_DIAL/);
    });

    it('is refused outside local', () => {
      expect(() =>
        validateEnvironment(
          validEnvironment({ ...MTLS, DEPLOY_ENV: 'staging', PREVIEW_UPSTREAM_DIAL: 'http://x' }),
        ),
      ).toThrow(/PREVIEW_UPSTREAM_DIAL/);
    });
  });
});
