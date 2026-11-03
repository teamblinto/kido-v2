import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { environmentSchema, type PreviewJwks, validateEnvironment } from './environment';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

// What spec 017 requires outside local: an Ed25519 signing key and an mTLS broker.
const { privateKey: PREVIEW_PRIVATE_KEY, publicKey: PREVIEW_PUBLIC_KEY } =
  generateKeyPairSync('ed25519');
const PREVIEW_SIGNING = {
  PREVIEW_SIGNING_KEY: PREVIEW_PRIVATE_KEY.export({ format: 'der', type: 'pkcs8' }).toString(
    'base64',
  ),
  PREVIEW_SIGNING_KEY_ID: 'k1',
};
const BROKER_MTLS = {
  BROKER_CLIENT_CNS: 'forge-gateway, forge-gateway-2',
  BROKER_TLS_CA: '-----BEGIN CERTIFICATE-----ca',
  BROKER_TLS_CERT: '-----BEGIN CERTIFICATE-----cert',
  BROKER_TLS_KEY: '-----BEGIN PRIVATE KEY-----key',
  BROKER_TRANSPORT: 'mtls',
};
// What spec 025 requires outside local: the build identity baked into the image (FR-033).
const BUILD_IDENTITY = {
  BUILD_AT: '2026-09-22T11:04:19.000Z',
  BUILD_COMMIT: '38c99c8f1ab4e0c6d2f5a7b9c1e3d5f7a9b1c3d5',
  BUILD_DIGEST: 'sha256:9c1f0ab2cd3ef45678901234567890abcdef1234567890abcdef1234567890ab',
};
const REAL_DEPLOYMENT_PREVIEW = {
  ...PREVIEW_SIGNING,
  ...BROKER_MTLS,
  ...BUILD_IDENTITY,
  SANDBOX_CALLBACK_URL: 'https://api.forge.example/api/v1/internal/sandbox-callbacks',
  // What spec 027 requires outside local: the domain deployed sites are served under (R10).
  SITE_DOMAIN: 'forge-sites.example',
  // What spec 029 requires outside local: the host inbound webhooks arrive at (R2).
  HOOKS_HOST: 'hooks.forge.example',
};

/** A copy of `record` without `key` — a variable left unset. */
function without<T extends Record<string, unknown>>(record: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...record };
  delete copy[key];
  return copy;
}

function validEnvironment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DATABASE_MIGRATION_URL: 'postgres://forge_migrator:dev@localhost:5432/forge',
    DATABASE_URL: 'postgres://forge_app:dev@localhost:5432/forge',
    DATABASE_URL_BYPASS_RLS: 'postgres://forge_bypass:dev@localhost:5432/forge',
    DEPLOY_ENV: 'local',
    GITHUB_WEBHOOK_SECRET: 'not-the-published-example',
    KEK_ENV_MASTER_KEY: MASTER_KEY,
    NODE_ENV: 'test',
    REDIS_CACHE_URL: 'redis://localhost:6380',
    REDIS_QUEUE_URL: 'redis://localhost:6381',
    REDIS_SESSION_URL: 'redis://localhost:6379',
    REDIS_STREAM_URL: 'redis://localhost:6382',
    RUN_PROFILES: 'api',
    ...overrides,
  };
}

describe('validateEnvironment', () => {
  describe('connection URLs', () => {
    it('accepts a fully specified environment', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.DATABASE_URL).toBe('postgres://forge_app:dev@localhost:5432/forge');
      expect(result.REDIS_SESSION_URL).toBe('redis://localhost:6379');
    });

    it('names the missing variable when a database URL is absent', () => {
      const environment = validEnvironment();
      delete environment.DATABASE_URL;

      expect(() => validateEnvironment(environment)).toThrow(/DATABASE_URL/);
    });

    it('reports every missing variable at once rather than only the first', () => {
      let message = '';

      try {
        validateEnvironment({ NODE_ENV: 'test' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('DATABASE_MIGRATION_URL');
      expect(message).toContain('DATABASE_URL_BYPASS_RLS');
      expect(message).toContain('REDIS_SESSION_URL');
      expect(message).toContain('REDIS_CACHE_URL');
      expect(message).toContain('REDIS_QUEUE_URL');
      expect(message).toContain('REDIS_STREAM_URL');
      expect(message).toContain('DEPLOY_ENV');
    });

    /**
     * The third Redis role (§09's `queue`) is required, not defaulted, for the reason the other two
     * are: a relay that silently fell back to the session instance would put BullMQ keys on an
     * instance whose eviction policy was chosen for a different reason.
     */
    it('names the missing variable when the queue redis URL is absent', () => {
      const environment = validEnvironment();
      delete environment.REDIS_QUEUE_URL;

      expect(() => validateEnvironment(environment)).toThrow(/REDIS_QUEUE_URL/);
    });

    it('rejects a database URL that is not a postgres URL', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ DATABASE_URL: 'mysql://localhost:3306/forge' })),
      ).toThrow(/DATABASE_URL/);
    });

    it('rejects a redis URL that is not parseable', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ REDIS_CACHE_URL: 'localhost:6380' })),
      ).toThrow(/REDIS_CACHE_URL/);
    });

    it('accepts a TLS redis URL', () => {
      const result = validateEnvironment(
        validEnvironment({ REDIS_SESSION_URL: 'rediss://localhost:6379' }),
      );

      expect(result.REDIS_SESSION_URL).toBe('rediss://localhost:6379');
    });
  });

  describe('session cookie', () => {
    it('defaults the session cookie to the __Host- prefixed name the architecture requires', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.SESSION_COOKIE_NAME).toBe('__Host-forge_session');
    });

    it('rejects a session cookie name without the __Host- prefix', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ SESSION_COOKIE_NAME: 'forge_session' })),
      ).toThrow(/SESSION_COOKIE_NAME/);
    });
  });

  describe('KEK provider', () => {
    it('requires a master key when the env provider is selected', () => {
      const environment = validEnvironment();
      delete environment.KEK_ENV_MASTER_KEY;

      expect(() => validateEnvironment(environment)).toThrow(/KEK_ENV_MASTER_KEY/);
    });

    it('rejects a master key that does not decode to 32 bytes', () => {
      expect(() =>
        validateEnvironment(
          validEnvironment({ KEK_ENV_MASTER_KEY: Buffer.alloc(16, 7).toString('base64') }),
        ),
      ).toThrow(/KEK_ENV_MASTER_KEY/);
    });

    it.each(['staging', 'production'])('refuses the env provider in a %s deployment', (deploy) => {
      expect(() =>
        validateEnvironment(validEnvironment({ DEPLOY_ENV: deploy, KEK_PROVIDER: 'env' })),
      ).toThrow(/KEK_PROVIDER/);
    });

    // The local compose stack runs the production *build* — NODE_ENV=production, because the
    // runner image is deployed --prod and has no pino-pretty — while being a local deployment.
    // Keying the refusal on NODE_ENV would make that stack unbootable without OpenBao.
    it('allows the env provider in a local deployment running a production build', () => {
      const result = validateEnvironment(
        validEnvironment({ DEPLOY_ENV: 'local', NODE_ENV: 'production' }),
      );

      expect(result.KEK_PROVIDER).toBe('env');
    });

    it('requires an address and token when the openbao provider is selected', () => {
      const environment = validEnvironment({ KEK_PROVIDER: 'openbao' });
      delete environment.KEK_ENV_MASTER_KEY;

      expect(() => validateEnvironment(environment)).toThrow(/OPENBAO_ADDR/);
    });

    it('accepts the openbao provider when fully configured', () => {
      const result = validateEnvironment(
        validEnvironment({
          ...REAL_DEPLOYMENT_PREVIEW,
          DEPLOY_ENV: 'production',
          KEK_PROVIDER: 'openbao',
          NODE_ENV: 'production',
          OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
          OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
          OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
          OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
          OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
          OPENBAO_ADDR: 'https://openbao.internal:8200',
          OPENBAO_TOKEN: 'placeholder-token',
        }),
      );

      expect(result.KEK_PROVIDER).toBe('openbao');
    });
  });

  describe('mail provider', () => {
    it('defaults to the console mailer', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.MAIL_PROVIDER).toBe('console');
    });

    it('requires an API key when the resend provider is selected', () => {
      expect(() => validateEnvironment(validEnvironment({ MAIL_PROVIDER: 'resend' }))).toThrow(
        /RESEND_API_KEY/,
      );
    });
  });

  describe('OAuth providers', () => {
    it('treats an absent provider as disabled rather than invalid', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
      expect(result.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    });

    it('rejects a client id without its secret', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ GITHUB_OAUTH_CLIENT_ID: 'placeholder-id' })),
      ).toThrow(/GITHUB_OAUTH_CLIENT_SECRET/);
    });

    it('rejects a client secret without its id', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ GOOGLE_OAUTH_CLIENT_SECRET: 'placeholder-secret' })),
      ).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
    });
  });

  describe('GitHub App (spec 018)', () => {
    const { privateKey: APP_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const GITHUB_APP = {
      GITHUB_APP_CLIENT_ID: 'Iv1.example',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: APP_KEY.export({ format: 'pem', type: 'pkcs1' }),
      GITHUB_APP_SLUG: 'forge-local',
    };

    it('defaults the API and install URLs to GitHub and coerces the App id', () => {
      const result = validateEnvironment(validEnvironment(GITHUB_APP));

      expect(result.GITHUB_API_URL).toBe('https://api.github.com');
      expect(result.GITHUB_INSTALL_URL).toBe('https://github.com');
      expect(result.GITHUB_APP_ID).toBe(12_345);
    });

    it('treats an absent App as disabled rather than invalid', () => {
      expect(validateEnvironment(validEnvironment()).GITHUB_APP_ID).toBeUndefined();
    });

    it('refuses a slug that is not lowercase-hyphenated', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ ...GITHUB_APP, GITHUB_APP_SLUG: 'Forge App' })),
      ).toThrow(/GITHUB_APP_SLUG/);
    });

    it('refuses the four GITHUB_APP_* by halves', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ ...GITHUB_APP, GITHUB_APP_SLUG: undefined })),
      ).toThrow(/GITHUB_APP_SLUG/);
      expect(() =>
        validateEnvironment(validEnvironment({ GITHUB_APP_ID: GITHUB_APP.GITHUB_APP_ID })),
      ).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    });

    it('refuses a private key that does not import as RSA', () => {
      const ed = PREVIEW_PRIVATE_KEY.export({ format: 'pem', type: 'pkcs8' });

      expect(() =>
        validateEnvironment(validEnvironment({ ...GITHUB_APP, GITHUB_APP_PRIVATE_KEY: ed })),
      ).toThrow(/GITHUB_APP_PRIVATE_KEY/);
      expect(() =>
        validateEnvironment(validEnvironment({ ...GITHUB_APP, GITHUB_APP_PRIVATE_KEY: 'not-pem' })),
      ).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    });

    it('accepts a PEM whose newlines arrive escaped, as a shell exports it', () => {
      const escaped = GITHUB_APP.GITHUB_APP_PRIVATE_KEY.replace(/\n/g, '\n');
      const result = validateEnvironment(
        validEnvironment({ ...GITHUB_APP, GITHUB_APP_PRIVATE_KEY: escaped }),
      );

      expect(result.GITHUB_APP_PRIVATE_KEY).toBe(GITHUB_APP.GITHUB_APP_PRIVATE_KEY.trim());
    });

    it('refuses the published example key outside local and accepts it locally', () => {
      const example = /^# GITHUB_APP_PRIVATE_KEY="(.+)"$/m.exec(
        readFileSync(join(__dirname, '../../.env.example'), 'utf8'),
      )?.[1];
      const staging = {
        ...REAL_DEPLOYMENT_PREVIEW,
        ...GITHUB_APP,
        DEPLOY_ENV: 'staging',
        KEK_PROVIDER: 'openbao',
        OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
        OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
        OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
        OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
        OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
        OPENBAO_ADDR: 'https://openbao.internal:8200',
        OPENBAO_TOKEN: 'placeholder-token',
      };

      expect(example).toBeDefined();
      expect(validateEnvironment(validEnvironment(staging)).GITHUB_APP_ID).toBe(12_345);
      expect(() =>
        validateEnvironment(validEnvironment({ ...staging, GITHUB_APP_PRIVATE_KEY: example })),
      ).toThrow(/example.*GITHUB_APP_PRIVATE_KEY/s);
      expect(
        validateEnvironment(validEnvironment({ ...GITHUB_APP, GITHUB_APP_PRIVATE_KEY: example }))
          .GITHUB_APP_PRIVATE_KEY,
      ).toContain('BEGIN RSA PRIVATE KEY');
    });
  });

  describe('GitHub webhook secret (spec 026)', () => {
    /** The staging shape the GitHub App block uses, so only DEPLOY_ENV and the secret vary here. */
    const staging = {
      ...REAL_DEPLOYMENT_PREVIEW,
      DEPLOY_ENV: 'staging',
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
    };
    /** Read from the file it is published in, so the two cannot drift apart silently. */
    const example = /^GITHUB_WEBHOOK_SECRET=(.+)$/m.exec(
      readFileSync(join(__dirname, '../../.env.example'), 'utf8'),
    )?.[1];

    it('refuses the published example secret outside local', () => {
      expect(example).toBeDefined();
      expect(() =>
        validateEnvironment(validEnvironment({ ...staging, GITHUB_WEBHOOK_SECRET: example })),
      ).toThrow(/example.*GITHUB_WEBHOOK_SECRET/s);
    });

    it('accepts the published example secret in local', () => {
      expect(
        validateEnvironment(validEnvironment({ GITHUB_WEBHOOK_SECRET: example }))
          .GITHUB_WEBHOOK_SECRET,
      ).toBe(example);
    });

    it('accepts a secret that is not the published example outside local', () => {
      expect(validateEnvironment(validEnvironment(staging)).GITHUB_WEBHOOK_SECRET).toBe(
        'not-the-published-example',
      );
    });

    it('refuses a missing secret in local and outside it alike', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ GITHUB_WEBHOOK_SECRET: undefined })),
      ).toThrow(/GITHUB_WEBHOOK_SECRET/);
      expect(() =>
        validateEnvironment(validEnvironment({ ...staging, GITHUB_WEBHOOK_SECRET: undefined })),
      ).toThrow(/GITHUB_WEBHOOK_SECRET/);
    });
  });

  describe('argon2 parameters', () => {
    it('defaults to the parameters the architecture mandates', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.ARGON2_MEMORY_KIB).toBe(65_536);
      expect(result.ARGON2_TIME_COST).toBe(3);
      expect(result.ARGON2_PARALLELISM).toBe(1);
    });

    it('allows a cheaper cost outside production so tests stay fast', () => {
      const result = validateEnvironment(validEnvironment({ ARGON2_MEMORY_KIB: '8192' }));

      expect(result.ARGON2_MEMORY_KIB).toBe(8192);
    });

    it('refuses parameters below the mandated floor in a real deployment', () => {
      expect(() =>
        validateEnvironment(
          validEnvironment({
            ARGON2_MEMORY_KIB: '8192',
            DEPLOY_ENV: 'production',
            KEK_PROVIDER: 'openbao',
            OPENBAO_ADDR: 'https://openbao.internal:8200',
            OPENBAO_TOKEN: 'placeholder-token',
          }),
        ),
      ).toThrow(/ARGON2_MEMORY_KIB/);
    });
  });

  describe('password reset', () => {
    /**
     * §11 names thirty minutes for a reset link and nothing else names it. A default that drifted
     * would move the window without anybody editing the paragraph that specifies it.
     */
    it('defaults the reset token to the thirty-minute window §11 specifies', () => {
      expect(validateEnvironment(validEnvironment()).PASSWORD_RESET_TTL_SECONDS).toBe(1_800);
    });

    it('defaults to a throttle tighter per address than per client', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.PASSWORD_RESET_ACCOUNT_BURST).toBeLessThan(result.PASSWORD_RESET_IP_BURST);
    });

    /** Same check as the other two buckets: a ceiling below the first delay is a flat limit that looks configured. */
    it('refuses a delay ceiling below the first delay', () => {
      expect(() =>
        validateEnvironment(
          validEnvironment({
            PASSWORD_RESET_DELAY_SECONDS: '120',
            PASSWORD_RESET_MAX_DELAY_SECONDS: '60',
          }),
        ),
      ).toThrow(/PASSWORD_RESET_MAX_DELAY_SECONDS/);
    });
  });

  describe('Daytona (spec 010)', () => {
    const DAYTONA = {
      DAYTONA_API_KEY: 'dtn_placeholder',
      DAYTONA_API_URL: 'http://localhost:3100',
    };
    const OPENBAO = {
      KEK_PROVIDER: 'openbao',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
    };

    it('accepts no Daytona configuration', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.DAYTONA_API_URL).toBeUndefined();
      expect(result.DAYTONA_API_KEY).toBeUndefined();
    });

    it('refuses DAYTONA_API_URL without DAYTONA_API_KEY and the reverse', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ DAYTONA_API_URL: DAYTONA.DAYTONA_API_URL })),
      ).toThrow(/DAYTONA_API_KEY/);
      expect(() =>
        validateEnvironment(validEnvironment({ DAYTONA_API_KEY: DAYTONA.DAYTONA_API_KEY })),
      ).toThrow(/DAYTONA_API_URL/);
    });

    it('accepts both under DEPLOY_ENV=local', () => {
      const result = validateEnvironment(validEnvironment(DAYTONA));

      expect(result.DAYTONA_API_URL).toBe(DAYTONA.DAYTONA_API_URL);
      expect(result.DAYTONA_API_KEY).toBe(DAYTONA.DAYTONA_API_KEY);
    });

    // Same refusal, same shape, same reason as `KEK_PROVIDER === 'env'`: a secret held in the
    // process environment is local-only (ADR 027). The issue sits on the key, not the URL.
    it.each(['staging', 'production'])(
      "refuses both outside local with the env KEK refusal's shape (%s)",
      (deploy) => {
        const result = environmentSchema.safeParse(
          validEnvironment({ ...DAYTONA, ...OPENBAO, DEPLOY_ENV: deploy }),
        );

        expect(result.success).toBe(false);
        const daytona = result.error?.issues.find((issue) => issue.path[0] === 'DAYTONA_API_KEY');
        expect(daytona).toMatchObject({ code: 'custom', path: ['DAYTONA_API_KEY'] });

        // The KEK refusal is the template: both messages end in the same words.
        const kek = environmentSchema.safeParse(validEnvironment({ DEPLOY_ENV: deploy }));
        const kekIssue = kek.error?.issues.find((issue) => issue.path[0] === 'KEK_PROVIDER');
        expect(kekIssue?.message).toMatch(/is local-only$/);
        expect(daytona?.message).toMatch(/is local-only \(ADR 027\)$/);
      },
    );

    describe('DAYTONA_API_KEY_FILE', () => {
      const FILE = {
        DAYTONA_API_KEY_FILE: '/run/secrets/sandboxd-key',
        DAYTONA_API_URL: 'http://sandboxd.internal:3986',
      };

      it.each(['staging', 'production'])(
        'accepts URL + key file on a real deployment (%s)',
        (deploy) => {
          const result = environmentSchema.safeParse(
            validEnvironment({ ...FILE, ...OPENBAO, DEPLOY_ENV: deploy }),
          );
          // Other real-deployment requirements fail here; none may name a Daytona key.
          expect(
            result.error?.issues.filter((issue) => String(issue.path[0]).startsWith('DAYTONA')),
          ).toEqual([]);
        },
      );

      it('still refuses URL + env key on a real deployment', () => {
        expect(() =>
          validateEnvironment(
            validEnvironment({ ...DAYTONA, ...OPENBAO, DEPLOY_ENV: 'production' }),
          ),
        ).toThrow(/is local-only \(ADR 027\)/);
      });

      it('refuses both key forms', () => {
        expect(() =>
          validateEnvironment(
            validEnvironment({ ...DAYTONA, DAYTONA_API_KEY_FILE: FILE.DAYTONA_API_KEY_FILE }),
          ),
        ).toThrow(/mutually exclusive/);
      });

      it('refuses a key file without the URL', () => {
        expect(() =>
          validateEnvironment(
            validEnvironment({ DAYTONA_API_KEY_FILE: FILE.DAYTONA_API_KEY_FILE }),
          ),
        ).toThrow(/DAYTONA_API_URL/);
      });
    });
  });

  describe('build identity (spec 025 FR-033)', () => {
    it('answers dev, dev and a boot time under DEPLOY_ENV=local', () => {
      const before = Date.now();
      const result = validateEnvironment(validEnvironment());

      expect(result.BUILD_DIGEST).toBe('dev');
      expect(result.BUILD_COMMIT).toBe('dev');
      expect(Date.parse(result.BUILD_AT)).toBeGreaterThanOrEqual(before - 1000);
    });

    it.each(['BUILD_AT', 'BUILD_COMMIT', 'BUILD_DIGEST'])(
      'refuses a real deployment missing %s',
      (key) => {
        const environment = validEnvironment({
          ...REAL_DEPLOYMENT_PREVIEW,
          DEPLOY_ENV: 'staging',
          KEK_PROVIDER: 'openbao',
          OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
          OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
          OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
          OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
          OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
          OPENBAO_ADDR: 'https://openbao.internal:8200',
          OPENBAO_TOKEN: 'placeholder-token',
        });
        delete environment[key];

        expect(() => validateEnvironment(environment)).toThrow(new RegExp(key));
        expect(() => validateEnvironment(environment)).toThrow(/FR-033/);
      },
    );

    it('keeps the values a build baked in rather than defaulting over them', () => {
      const result = validateEnvironment(validEnvironment(BUILD_IDENTITY));

      expect(result.BUILD_DIGEST).toBe(BUILD_IDENTITY.BUILD_DIGEST);
      expect(result.BUILD_COMMIT).toBe(BUILD_IDENTITY.BUILD_COMMIT);
      expect(result.BUILD_AT).toBe(BUILD_IDENTITY.BUILD_AT);
    });

    // `apps/api/Dockerfile` declares the three as build arguments; Docker bakes one that was never
    // passed as an empty string. Locally that must still boot, and it must not look like a build
    // that identified itself.
    it('reads an unpassed build argument as unset rather than as an identity', () => {
      const result = validateEnvironment(
        validEnvironment({ BUILD_AT: '', BUILD_COMMIT: '', BUILD_DIGEST: '' }),
      );

      expect(result.BUILD_DIGEST).toBe('dev');
      expect(result.BUILD_COMMIT).toBe('dev');
      expect(Number.isNaN(Date.parse(result.BUILD_AT))).toBe(false);
    });

    it('still refuses an unpassed build argument outside local', () => {
      expect(() =>
        validateEnvironment(
          validEnvironment({
            ...REAL_DEPLOYMENT_PREVIEW,
            BUILD_DIGEST: '',
            DEPLOY_ENV: 'staging',
            KEK_PROVIDER: 'openbao',
            OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
            OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
            OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
            OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
            OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
            OPENBAO_ADDR: 'https://openbao.internal:8200',
            OPENBAO_TOKEN: 'placeholder-token',
          }),
        ),
      ).toThrow(/FR-033/);
    });

    it('refuses a BUILD_AT that is not an ISO 8601 instant', () => {
      expect(() => validateEnvironment(validEnvironment({ BUILD_AT: 'yesterday' }))).toThrow(
        /BUILD_AT/,
      );
    });
  });
  describe('object-store credentials (spec 016 FR-024)', () => {
    const OBJECT_STORE = {
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
    };
    const OPENBAO = {
      KEK_PROVIDER: 'openbao',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
    };

    it('accepts no object-store configuration under DEPLOY_ENV=local', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.OBJECT_STORE_ENDPOINT).toBeUndefined();
    });

    it('accepts all five under DEPLOY_ENV=local', () => {
      const result = validateEnvironment(validEnvironment(OBJECT_STORE));

      expect(result.OBJECT_STORE_BUCKET_REPOS).toBe(OBJECT_STORE.OBJECT_STORE_BUCKET_REPOS);
    });

    it('refuses a partial set', () => {
      expect(() =>
        validateEnvironment(
          validEnvironment({ OBJECT_STORE_ENDPOINT: OBJECT_STORE.OBJECT_STORE_ENDPOINT }),
        ),
      ).toThrow(/OBJECT_STORE_ACCESS_KEY_ID/);
    });

    it.each(['staging', 'production'])(
      'refuses the mirror left unconfigured outside local (%s)',
      (deploy) => {
        expect(() =>
          validateEnvironment(validEnvironment({ ...OPENBAO, DEPLOY_ENV: deploy })),
        ).toThrow(/FR-024/);
      },
    );

    // Spec 027 R7: the artifacts bucket joins the group on the same terms as the other four.
    it.each(['staging', 'production'])(
      'requires the artifacts bucket with the others outside local (%s)',
      (deploy) => {
        const withoutArtifacts = without(OBJECT_STORE, 'OBJECT_STORE_BUCKET_ARTIFACTS');

        expect(() =>
          validateEnvironment(
            validEnvironment({
              ...withoutArtifacts,
              ...OPENBAO,
              ...REAL_DEPLOYMENT_PREVIEW,
              DEPLOY_ENV: deploy,
            }),
          ),
        ).toThrow(/OBJECT_STORE_BUCKET_ARTIFACTS/);
      },
    );

    it('names the missing bucket when the set is partial', () => {
      const withoutArtifacts = without(OBJECT_STORE, 'OBJECT_STORE_BUCKET_ARTIFACTS');
      const artifacts = OBJECT_STORE.OBJECT_STORE_BUCKET_ARTIFACTS;
      const withoutRepos = without(OBJECT_STORE, 'OBJECT_STORE_BUCKET_REPOS');

      expect(() => validateEnvironment(validEnvironment(withoutArtifacts))).toThrow(
        /is required when any OBJECT_STORE_\* variable is set\n\s*→ at OBJECT_STORE_BUCKET_ARTIFACTS/,
      );
      expect(() => validateEnvironment(validEnvironment(withoutRepos))).toThrow(
        /is required when any OBJECT_STORE_\* variable is set\n\s*→ at OBJECT_STORE_BUCKET_REPOS/,
      );
      expect(() =>
        validateEnvironment(validEnvironment({ OBJECT_STORE_BUCKET_ARTIFACTS: artifacts })),
      ).toThrow(/OBJECT_STORE_ENDPOINT/);
    });

    it.each(['staging', 'production'])(
      'accepts all five configured outside local (%s)',
      (deploy) => {
        const result = validateEnvironment(
          validEnvironment({
            ...OBJECT_STORE,
            ...OPENBAO,
            ...REAL_DEPLOYMENT_PREVIEW,
            DEPLOY_ENV: deploy,
          }),
        );

        expect(result.OBJECT_STORE_ENDPOINT).toBe(OBJECT_STORE.OBJECT_STORE_ENDPOINT);
        expect(result.OBJECT_STORE_BUCKET_ARTIFACTS).toBe('forge-artifacts');
      },
    );
  });

  describe('site domain (spec 027 R10)', () => {
    const REAL = {
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
      ...REAL_DEPLOYMENT_PREVIEW,
      APP_URL: 'https://app.forge.example',
      DEPLOY_ENV: 'staging',
      PREVIEW_DOMAIN: 'preview.forge.example',
    };

    it('defaults to forge-site.localhost under local, beside the preview default', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.SITE_DOMAIN).toBe('forge-site.localhost');
    });

    // The local product host is `localhost`, one label: a cookie cannot be scoped to it from a
    // subdomain, so the two defaults sharing it is not the overlap the rule is about. Equal is
    // still equal.
    it('does not treat a single-label product host as a shared parent, but refuses equality', () => {
      expect(
        validateEnvironment(validEnvironment({ APP_URL: 'http://localhost:5173' })).SITE_DOMAIN,
      ).toBe('forge-site.localhost');
      expect(() =>
        validateEnvironment(validEnvironment({ APP_URL: 'http://forge-site.localhost:5173' })),
      ).toThrow(/APP_URL[^\n]*\n\s*→ at SITE_DOMAIN/);
    });

    it('lowercases the configured domain', () => {
      const result = validateEnvironment(
        validEnvironment({ SITE_DOMAIN: ' Sites.Forge.Example ' }),
      );

      expect(result.SITE_DOMAIN).toBe('sites.forge.example');
    });

    it.each(['staging', 'production'])('is required outside local (%s)', (deploy) => {
      const withoutSite = without(REAL, 'SITE_DOMAIN');

      expect(() =>
        validateEnvironment(validEnvironment({ ...withoutSite, DEPLOY_ENV: deploy })),
      ).toThrow(/is required outside DEPLOY_ENV=local[^\n]*\n\s*→ at SITE_DOMAIN/);
      expect(
        validateEnvironment(validEnvironment({ ...REAL, DEPLOY_ENV: deploy })).SITE_DOMAIN,
      ).toBe('forge-sites.example');
    });

    it('refuses a SITE_DOMAIN equal to PREVIEW_DOMAIN', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ ...REAL, SITE_DOMAIN: 'preview.forge.example' })),
      ).toThrow(/PREVIEW_DOMAIN[^\n]*\n\s*→ at SITE_DOMAIN/);
    });

    it('refuses a SITE_DOMAIN under PREVIEW_DOMAIN, and the reverse', () => {
      expect(() =>
        validateEnvironment(
          validEnvironment({ ...REAL, SITE_DOMAIN: 'sites.preview.forge.example' }),
        ),
      ).toThrow(/PREVIEW_DOMAIN[^\n]*\n\s*→ at SITE_DOMAIN/);
      expect(() =>
        validateEnvironment(
          validEnvironment({
            ...REAL,
            PREVIEW_DOMAIN: 'preview.forge-sites.example',
            SITE_DOMAIN: 'forge-sites.example',
          }),
        ),
      ).toThrow(/PREVIEW_DOMAIN[^\n]*\n\s*→ at SITE_DOMAIN/);
    });

    it('refuses a SITE_DOMAIN equal to, under or above the product host', () => {
      for (const site of ['app.forge.example', 'sites.app.forge.example', 'forge.example']) {
        expect(() => validateEnvironment(validEnvironment({ ...REAL, SITE_DOMAIN: site }))).toThrow(
          /APP_URL[^\n]*\n\s*→ at SITE_DOMAIN/,
        );
      }
    });

    it('compares whole labels, not characters', () => {
      // `xapp.forge.example` ends with the characters of `app.forge.example` but is its sibling.
      const result = validateEnvironment(
        validEnvironment({ ...REAL, SITE_DOMAIN: 'xapp.forge.example' }),
      );

      expect(result.SITE_DOMAIN).toBe('xapp.forge.example');
      expect(
        validateEnvironment(validEnvironment({ ...REAL, SITE_DOMAIN: 'pp.forge.example' }))
          .SITE_DOMAIN,
      ).toBe('pp.forge.example');
    });
  });

  describe('custom domains (spec 028 R15)', () => {
    const CLOUDFLARE = {
      CLOUDFLARE_API_TOKEN: 'placeholder-cloudflare-token',
      CLOUDFLARE_ZONE_ID: '023e105f4ecef8ad9ca31a8372d0c353',
      CUSTOM_HOSTNAME_TARGET: 'edge.forge-saas.example',
    };
    const REAL = {
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
      ...REAL_DEPLOYMENT_PREVIEW,
      APP_URL: 'https://app.forge.example',
      DEPLOY_ENV: 'staging',
      PREVIEW_DOMAIN: 'preview.forge.example',
    };

    it('boots with the whole CLOUDFLARE_* group absent, and defaults the rest', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(result.CLOUDFLARE_ZONE_ID).toBeUndefined();
      expect(result.CUSTOM_HOSTNAME_TARGET).toBeUndefined();
      expect(result.CLOUDFLARE_API_URL).toBe('https://api.cloudflare.com/client/v4');
      expect(result.CUSTOM_HOSTNAME_CA).toBe('lets_encrypt');
      expect(result.DNS_RESOLVERS).toEqual(['1.1.1.1', '8.8.8.8']);
      expect(result.RESERVED_DOMAINS).toEqual([]);
      expect(validateEnvironment(validEnvironment(REAL)).CLOUDFLARE_API_TOKEN).toBeUndefined();
    });

    it('accepts the whole group, outside local too', () => {
      const result = validateEnvironment(validEnvironment({ ...REAL, ...CLOUDFLARE }));

      expect(result.CLOUDFLARE_ZONE_ID).toBe(CLOUDFLARE.CLOUDFLARE_ZONE_ID);
      expect(result.CUSTOM_HOSTNAME_TARGET).toBe('edge.forge-saas.example');
    });

    it('refuses a partial CLOUDFLARE_* set, naming every missing key', () => {
      const error = (() => {
        try {
          validateEnvironment(
            validEnvironment({ CLOUDFLARE_ZONE_ID: CLOUDFLARE.CLOUDFLARE_ZONE_ID }),
          );
        } catch (caught) {
          return (caught as Error).message;
        }
        return '';
      })();

      expect(error).toMatch(/→ at CLOUDFLARE_API_TOKEN/);
      expect(error).toMatch(/→ at CUSTOM_HOSTNAME_TARGET/);
      expect(error).not.toMatch(/→ at CLOUDFLARE_ZONE_ID/);
      expect(() =>
        validateEnvironment(validEnvironment(without(CLOUDFLARE, 'CLOUDFLARE_API_TOKEN'))),
      ).toThrow(/is required when any[^\n]*\n\s*→ at CLOUDFLARE_API_TOKEN/);
    });

    it('refuses an http: CLOUDFLARE_API_URL outside local, and allows it under local', () => {
      const plain = { CLOUDFLARE_API_URL: 'http://localhost:8787/client/v4' };

      expect(() =>
        validateEnvironment(validEnvironment({ ...REAL, ...CLOUDFLARE, ...plain })),
      ).toThrow(/https[^\n]*\n\s*→ at CLOUDFLARE_API_URL/);
      expect(validateEnvironment(validEnvironment(plain)).CLOUDFLARE_API_URL).toBe(
        plain.CLOUDFLARE_API_URL,
      );
    });

    it('refuses a CUSTOM_HOSTNAME_CA outside the enum', () => {
      expect(
        validateEnvironment(validEnvironment({ CUSTOM_HOSTNAME_CA: 'google' })).CUSTOM_HOSTNAME_CA,
      ).toBe('google');
      expect(() =>
        validateEnvironment(validEnvironment({ CUSTOM_HOSTNAME_CA: 'digicert' })),
      ).toThrow(/CUSTOM_HOSTNAME_CA/);
    });

    it('refuses a CUSTOM_HOSTNAME_TARGET that overlaps a preview, site or product domain', () => {
      for (const target of [
        'preview.forge.example',
        'edge.preview.forge.example',
        'forge-sites.example',
        'edge.forge-sites.example',
        'app.forge.example',
        'forge.example',
      ]) {
        expect(() =>
          validateEnvironment(
            validEnvironment({ ...REAL, ...CLOUDFLARE, CUSTOM_HOSTNAME_TARGET: target }),
          ),
        ).toThrow(/must not equal, sit under or sit above[^\n]*\n\s*→ at CUSTOM_HOSTNAME_TARGET/);
      }
    });

    it('lowercases CUSTOM_HOSTNAME_TARGET', () => {
      const result = validateEnvironment(
        validEnvironment({ ...CLOUDFLARE, CUSTOM_HOSTNAME_TARGET: ' Edge.Forge-SaaS.Example ' }),
      );

      expect(result.CUSTOM_HOSTNAME_TARGET).toBe('edge.forge-saas.example');
    });

    it('parses DNS_RESOLVERS as ip[:port] and refuses a non-IP entry', () => {
      expect(
        validateEnvironment(
          validEnvironment({
            DNS_RESOLVERS: ' 9.9.9.9:53, 2606:4700:4700::1111,[2001:4860:4860::8888]:53 ',
          }),
        ).DNS_RESOLVERS,
      ).toEqual(['9.9.9.9:53', '2606:4700:4700::1111', '[2001:4860:4860::8888]:53']);

      for (const resolvers of ['1.1.1.1,dns.google', '1.1.1.1:99999', '']) {
        expect(() => validateEnvironment(validEnvironment({ DNS_RESOLVERS: resolvers }))).toThrow(
          /DNS_RESOLVERS/,
        );
      }
    });

    it('parses RESERVED_DOMAINS and lower-cases each entry', () => {
      const result = validateEnvironment(
        validEnvironment({ RESERVED_DOMAINS: ' Forge.Example, , bank.EXAMPLE ' }),
      );

      expect(result.RESERVED_DOMAINS).toEqual(['forge.example', 'bank.example']);
    });
  });

  describe('preview gateway routing (spec 017)', () => {
    const OPENBAO = {
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
    };
    const SIGNING = PREVIEW_SIGNING;
    const MTLS = BROKER_MTLS;
    const JWKS = JSON.stringify({
      keys: [
        { ...PREVIEW_PUBLIC_KEY.export({ format: 'jwk' }), alg: 'EdDSA', kid: 'k1', use: 'sig' },
      ],
    });
    const REAL = { ...OPENBAO, ...REAL_DEPLOYMENT_PREVIEW, DEPLOY_ENV: 'staging' };

    it('defaults to a plain broker on :3001 under local', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.BROKER_TRANSPORT).toBe('plain');
      expect(result.BROKER_PORT).toBe(3001);
      expect(result.BROKER_SHARED_SECRET).toBe('local-broker-secret');
      expect(result.PREVIEW_DOMAIN).toBe('forge-preview.localhost');
      expect(result.ROUTE_CACHE_MAX).toBe(1_000);
      expect(result.ROUTE_CACHE_TTL_MS).toBe(5_000);
      expect(result.GATEWAY_UPSTREAM_TIMEOUT_MS).toBe(30_000);
      expect(result.GATEWAY_SOCKET_MAX_MS).toBe(3_600_000);
    });

    it('generates an ephemeral Ed25519 pair under local and derives the JWKS from it', () => {
      const result = validateEnvironment(validEnvironment());
      const key = createPrivateKey({
        format: 'der',
        key: Buffer.from(result.PREVIEW_SIGNING_KEY, 'base64'),
        type: 'pkcs8',
      });

      expect(key.asymmetricKeyType).toBe('ed25519');
      expect(result.PREVIEW_SIGNING_KEY_ID).toBe('local-ephemeral');
      expect(result.PREVIEW_PUBLIC_JWKS.keys).toEqual([
        expect.objectContaining({
          alg: 'EdDSA',
          crv: 'Ed25519',
          kid: 'local-ephemeral',
          kty: 'OKP',
        }),
      ]);
      expect(validateEnvironment(validEnvironment()).PREVIEW_SIGNING_KEY).not.toBe(
        result.PREVIEW_SIGNING_KEY,
      );
    });

    it('derives the JWKS from an explicit key and keeps an explicit JWKS', () => {
      const derived = validateEnvironment(validEnvironment(SIGNING));
      const explicit = validateEnvironment(
        validEnvironment({ ...SIGNING, PREVIEW_PUBLIC_JWKS: JWKS }),
      );

      expect(derived.PREVIEW_PUBLIC_JWKS).toEqual(JSON.parse(JWKS));
      expect(explicit.PREVIEW_PUBLIC_JWKS).toEqual(JSON.parse(JWKS));
    });

    it('refuses a signing key that is not Ed25519 PKCS8, a key without an id, and a JWKS missing the id', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ ...SIGNING, PREVIEW_SIGNING_KEY: MASTER_KEY })),
      ).toThrow(/PREVIEW_SIGNING_KEY/);
      expect(() =>
        validateEnvironment(validEnvironment({ PREVIEW_SIGNING_KEY: SIGNING.PREVIEW_SIGNING_KEY })),
      ).toThrow(/PREVIEW_SIGNING_KEY_ID/);
      expect(() =>
        validateEnvironment(
          validEnvironment({ ...SIGNING, PREVIEW_SIGNING_KEY_ID: 'k2', PREVIEW_PUBLIC_JWKS: JWKS }),
        ),
      ).toThrow(/PREVIEW_PUBLIC_JWKS/);
      expect(() =>
        validateEnvironment(validEnvironment({ PREVIEW_PUBLIC_JWKS: '{"keys":"no"}' })),
      ).toThrow(/PREVIEW_PUBLIC_JWKS/);
    });

    it('refuses a plain broker without its shared secret', () => {
      expect(() => validateEnvironment(validEnvironment({ BROKER_SHARED_SECRET: '' }))).toThrow(
        /BROKER_SHARED_SECRET/,
      );
    });

    it('accepts mtls under local and splits BROKER_CLIENT_CNS', () => {
      const result = validateEnvironment(validEnvironment(MTLS));

      expect(result.BROKER_CLIENT_CNS).toEqual(['forge-gateway', 'forge-gateway-2']);
      expect(result.BROKER_SHARED_SECRET).toBeUndefined();
    });

    it('refuses mtls material set by halves', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ BROKER_TLS_CA: MTLS.BROKER_TLS_CA })),
      ).toThrow(/BROKER_TLS_CERT.*BROKER_TLS_KEY.*BROKER_CLIENT_CNS/s);
    });

    it('refuses mtls without its material', () => {
      expect(() => validateEnvironment(validEnvironment({ BROKER_TRANSPORT: 'mtls' }))).toThrow(
        /BROKER_TLS_CA/,
      );
    });

    it.each(['staging', 'production'])('accepts the full real-deployment set (%s)', (deploy) => {
      const result = validateEnvironment(validEnvironment({ ...REAL, DEPLOY_ENV: deploy }));

      expect(result.PREVIEW_SIGNING_KEY_ID).toBe('k1');
      expect(result.PREVIEW_PUBLIC_JWKS.keys[0]?.kid).toBe('k1');
    });

    it.each(['staging', 'production'])(
      'refuses the published example signing key id outside local (%s)',
      (deploy) => {
        expect(() =>
          validateEnvironment(
            validEnvironment({
              ...REAL,
              DEPLOY_ENV: deploy,
              PREVIEW_SIGNING_KEY_ID: 'local-example',
            }),
          ),
        ).toThrow(/local-example.*PREVIEW_SIGNING_KEY_ID/s);
        expect(
          validateEnvironment(
            validEnvironment({ ...SIGNING, PREVIEW_SIGNING_KEY_ID: 'local-example' }),
          ).PREVIEW_SIGNING_KEY_ID,
        ).toBe('local-example');
      },
    );

    it.each(['staging', 'production'])(
      'refuses the localhost callback URL default outside local (%s)',
      (deploy) => {
        expect(() =>
          validateEnvironment(
            validEnvironment({ ...REAL, DEPLOY_ENV: deploy, SANDBOX_CALLBACK_URL: undefined }),
          ),
        ).toThrow(/SANDBOX_CALLBACK_URL/);
        expect(validateEnvironment(validEnvironment()).SANDBOX_CALLBACK_URL).toBe(
          'http://localhost:3000/api/v1/internal/sandbox-callbacks',
        );
      },
    );

    it('holds an explicit JWKS beside the ephemeral local pair to the resolved id', () => {
      // No key configured: the pair is generated and named `local-ephemeral`, so a JWKS that names
      // anything else would verify nothing the process mints.
      expect(() => validateEnvironment(validEnvironment({ PREVIEW_PUBLIC_JWKS: JWKS }))).toThrow(
        /local-ephemeral.*PREVIEW_PUBLIC_JWKS/s,
      );
      const ephemeral = JSON.stringify({
        keys: [{ ...(JSON.parse(JWKS) as PreviewJwks).keys[0], kid: 'local-ephemeral' }],
      });
      expect(
        validateEnvironment(validEnvironment({ PREVIEW_PUBLIC_JWKS: ephemeral }))
          .PREVIEW_PUBLIC_JWKS.keys[0]?.kid,
      ).toBe('local-ephemeral');
    });

    it.each(['staging', 'production'])('refuses a plain broker outside local (%s)', (deploy) => {
      expect(() =>
        validateEnvironment(
          validEnvironment({
            ...REAL,
            BROKER_SHARED_SECRET: 'x',
            BROKER_TRANSPORT: 'plain',
            DEPLOY_ENV: deploy,
          }),
        ),
      ).toThrow(/BROKER_TRANSPORT/);
    });

    it.each(['staging', 'production'])(
      'refuses an absent signing key outside local (%s)',
      (deploy) => {
        const environment = validEnvironment({ ...REAL, DEPLOY_ENV: deploy });
        delete environment.PREVIEW_SIGNING_KEY;
        delete environment.PREVIEW_SIGNING_KEY_ID;

        expect(() => validateEnvironment(environment)).toThrow(/PREVIEW_SIGNING_KEY/);
      },
    );

    it('refuses any of its names carried by a VITE_* variable', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ VITE_PREVIEW_SIGNING_KEY: 'leak' })),
      ).toThrow(/VITE_PREVIEW_SIGNING_KEY/);
      expect(() =>
        validateEnvironment(validEnvironment({ VITE_BROKER_SHARED_SECRET: 'leak' })),
      ).toThrow(/VITE_BROKER_SHARED_SECRET/);
    });

    it('keeps the web app example free of them', () => {
      const web = readFileSync(join(__dirname, '../../../web/.env.example'), 'utf8');

      expect(web).not.toMatch(/VITE_\w*(BROKER_|PREVIEW_|ROUTE_CACHE|GATEWAY_)/);
    });
  });

  describe('SANDBOX_OWNER (spec 014)', () => {
    it('derives the owner label from DEPLOY_ENV when unset', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.SANDBOX_OWNER).toBe('forge-local');
    });

    it('keeps an explicit owner', () => {
      const result = validateEnvironment(validEnvironment({ SANDBOX_OWNER: 'forge-abu' }));

      expect(result.SANDBOX_OWNER).toBe('forge-abu');
    });
  });

  describe('local agent bridge (spec 040)', () => {
    const staging = {
      ...REAL_DEPLOYMENT_PREVIEW,
      DEPLOY_ENV: 'staging',
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
    };

    it('is on under local and off elsewhere unless set', () => {
      expect(validateEnvironment(validEnvironment()).LOCAL_AGENT_ENABLED).toBe(true);
      expect(validateEnvironment(validEnvironment(staging)).LOCAL_AGENT_ENABLED).toBe(false);
      expect(
        validateEnvironment(validEnvironment({ ...staging, LOCAL_AGENT_ENABLED: 'true' }))
          .LOCAL_AGENT_ENABLED,
      ).toBe(true);
    });

    it('caps one subscription turn at six hours unless set, and refuses less than a minute', () => {
      expect(validateEnvironment(validEnvironment()).LOCAL_AGENT_MAX_RUN_SECONDS).toBe(21_600);
      expect(
        validateEnvironment(validEnvironment({ LOCAL_AGENT_MAX_RUN_SECONDS: '3600' }))
          .LOCAL_AGENT_MAX_RUN_SECONDS,
      ).toBe(3_600);
      expect(() =>
        validateEnvironment(validEnvironment({ LOCAL_AGENT_MAX_RUN_SECONDS: '5' })),
      ).toThrow(/LOCAL_AGENT_MAX_RUN_SECONDS/);
    });
  });

  describe('Anthropic (spec 011)', () => {
    it('accepts no Anthropic key', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('accepts the key under DEPLOY_ENV=local', () => {
      // The key rides with the agent profile (spec 013 R10); the fixture's bare `api` would refuse it.
      const result = validateEnvironment(
        validEnvironment({ ANTHROPIC_API_KEY: 'sk-ant-placeholder', RUN_PROFILES: 'api,agent' }),
      );

      expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-placeholder');
    });

    // Same refusal, same shape, same reason as `KEK_PROVIDER === 'env'` and Daytona: a secret
    // held in the process environment is local-only (ADR 027).
    it.each(['staging', 'production'])(
      "refuses the key outside local with the env KEK refusal's shape (%s)",
      (deploy) => {
        const result = environmentSchema.safeParse(
          validEnvironment({
            ANTHROPIC_API_KEY: 'sk-ant-placeholder',
            DEPLOY_ENV: deploy,
            KEK_PROVIDER: 'openbao',
            OPENBAO_ADDR: 'https://openbao.internal:8200',
            OPENBAO_TOKEN: 'placeholder-token',
            RUN_PROFILES: 'agent',
          }),
        );

        expect(result.success).toBe(false);
        const anthropic = result.error?.issues.find(
          (issue) => issue.path[0] === 'ANTHROPIC_API_KEY',
        );
        expect(anthropic).toMatchObject({ code: 'custom', path: ['ANTHROPIC_API_KEY'] });

        const kek = environmentSchema.safeParse(validEnvironment({ DEPLOY_ENV: deploy }));
        const kekIssue = kek.error?.issues.find((issue) => issue.path[0] === 'KEK_PROVIDER');
        expect(kekIssue?.message).toMatch(/is local-only$/);
        expect(anthropic?.message).toMatch(/is local-only \(ADR 027\)$/);
      },
    );

    it('refuses PREVIEW_GATEWAY_PORT outside local', () => {
      expect(
        validateEnvironment(validEnvironment({ PREVIEW_GATEWAY_PORT: '3200' }))
          .PREVIEW_GATEWAY_PORT,
      ).toBe(3200);

      const result = environmentSchema.safeParse(
        validEnvironment({
          DEPLOY_ENV: 'production',
          KEK_PROVIDER: 'openbao',
          OPENBAO_ADDR: 'https://openbao.internal:8200',
          OPENBAO_TOKEN: 'placeholder-token',
          PREVIEW_GATEWAY_PORT: '3200',
        }),
      );
      const issue = result.error?.issues.find((c) => c.path[0] === 'PREVIEW_GATEWAY_PORT');
      expect(issue?.message).toBe('a plain-HTTP preview gateway port is local-only');
    });

    it.each(['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL_PREFIX', 'ANTHROPIC_TOOL_SUFFIX'] as const)(
      'refuses the proxy override %s outside local',
      (key) => {
        const value = key === 'ANTHROPIC_BASE_URL' ? 'http://localhost:20128' : '_x';
        expect(validateEnvironment(validEnvironment({ [key]: value }))[key]).toBe(value);

        const result = environmentSchema.safeParse(
          validEnvironment({
            [key]: value,
            DEPLOY_ENV: 'production',
            KEK_PROVIDER: 'openbao',
            OPENBAO_ADDR: 'https://openbao.internal:8200',
            OPENBAO_TOKEN: 'placeholder-token',
          }),
        );
        const issue = result.error?.issues.find((candidate) => candidate.path[0] === key);
        expect(issue?.message).toMatch(/is local-only \(ADR 027\)$/);
      },
    );
  });

  describe('run profiles (spec 013)', () => {
    it('requires RUN_PROFILES', () => {
      const environment = validEnvironment();
      delete environment.RUN_PROFILES;

      expect(() => validateEnvironment(environment)).toThrow(/RUN_PROFILES/);
      expect(() => validateEnvironment(validEnvironment({ RUN_PROFILES: ' , ' }))).toThrow(
        'RUN_PROFILES is required: one or more of api, agent, events, cron',
      );
    });

    it('refuses an unknown profile', () => {
      expect(() => validateEnvironment(validEnvironment({ RUN_PROFILES: 'api,agnet' }))).toThrow(
        'RUN_PROFILES contains "agnet"; valid profiles are api, agent, events, cron',
      );
    });

    it('refuses api combined with a worker profile outside DEPLOY_ENV=local', () => {
      const result = environmentSchema.safeParse(
        validEnvironment({
          DEPLOY_ENV: 'production',
          KEK_PROVIDER: 'openbao',
          OPENBAO_ADDR: 'https://openbao.internal:8200',
          OPENBAO_TOKEN: 'placeholder-token',
          RUN_PROFILES: 'api,events',
        }),
      );

      expect(result.success).toBe(false);
      const issue = result.error?.issues.find((candidate) => candidate.path[0] === 'RUN_PROFILES');
      expect(issue?.message).toContain('blue/green');
      expect(issue?.message).toContain('§13');
    });

    it('accepts api combined with a worker profile under DEPLOY_ENV=local', () => {
      const result = validateEnvironment(
        validEnvironment({ RUN_PROFILES: 'api,agent,events,cron' }),
      );

      expect(result.RUN_PROFILES).toEqual(new Set(['api', 'agent', 'events', 'cron']));
    });
  });

  describe('hooks host (spec 029 R2)', () => {
    const REAL = {
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
      ...REAL_DEPLOYMENT_PREVIEW,
      APP_URL: 'https://app.forge.example',
      DEPLOY_ENV: 'staging',
      PREVIEW_DOMAIN: 'preview.forge.example',
    };

    it.each(['staging', 'production'])(
      'refuses a missing HOOKS_HOST outside local (%s)',
      (deploy) => {
        expect(() =>
          validateEnvironment(
            validEnvironment({ ...without(REAL, 'HOOKS_HOST'), DEPLOY_ENV: deploy }),
          ),
        ).toThrow(/is required outside DEPLOY_ENV=local[^\n]*\n\s*→ at HOOKS_HOST/);
        expect(
          validateEnvironment(validEnvironment({ ...REAL, DEPLOY_ENV: deploy })).HOOKS_HOST,
        ).toBe('hooks.forge.example');
      },
    );

    it('defaults to hooks.localhost under local and trims and lowercases a configured host', () => {
      expect(validateEnvironment(validEnvironment()).HOOKS_HOST).toBe('hooks.localhost');
      expect(
        validateEnvironment(validEnvironment({ HOOKS_HOST: ' Hooks.Forge.Example ' })).HOOKS_HOST,
      ).toBe('hooks.forge.example');
    });

    it('refuses a HOOKS_HOST equal to the product host', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ ...REAL, HOOKS_HOST: 'app.forge.example' })),
      ).toThrow(/must not equal the product host[^\n]*\n\s*→ at HOOKS_HOST/);
    });

    it('parses WEBHOOK_LEGACY_ADDRESS as a boolean defaulting to true', () => {
      expect(validateEnvironment(validEnvironment()).WEBHOOK_LEGACY_ADDRESS).toBe(true);
      expect(
        validateEnvironment(validEnvironment({ WEBHOOK_LEGACY_ADDRESS: 'false' }))
          .WEBHOOK_LEGACY_ADDRESS,
      ).toBe(false);
      expect(() =>
        validateEnvironment(validEnvironment({ WEBHOOK_LEGACY_ADDRESS: 'yes' })),
      ).toThrow(/WEBHOOK_LEGACY_ADDRESS/);
    });
  });

  describe('remaining connectors (spec 030 R12)', () => {
    const REAL = {
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
      ...REAL_DEPLOYMENT_PREVIEW,
      APP_URL: 'https://app.forge.example',
      DEPLOY_ENV: 'staging',
      PREVIEW_DOMAIN: 'preview.forge.example',
    };
    const URLS = {
      CONNECTOR_RESEND_API_URL: 'https://api.resend.com',
      NEON_API_URL: 'https://console.neon.tech/api/v2',
      NETLIFY_API_URL: 'https://api.netlify.com/api/v1',
      SUPABASE_API_URL: 'https://api.supabase.com',
    } as const;

    it('defaults each provider base URL', () => {
      const result = validateEnvironment(validEnvironment());

      for (const [key, value] of Object.entries(URLS)) {
        expect(result[key as keyof typeof URLS]).toBe(value);
      }
      expect(result.SUPABASE_OAUTH_CLIENT_ID).toBeUndefined();
      expect(result.SUPABASE_OAUTH_CLIENT_SECRET).toBeUndefined();
    });

    it.each(Object.keys(URLS))(
      'refuses an http: %s outside local, and allows it under local',
      (key) => {
        const plain = { [key]: 'http://localhost:8790' };

        expect(() => validateEnvironment(validEnvironment({ ...REAL, ...plain }))).toThrow(
          new RegExp(`https[^\\n]*\\n\\s*→ at ${key}`),
        );
        expect(validateEnvironment(validEnvironment(plain))[key as keyof typeof URLS]).toBe(
          'http://localhost:8790',
        );
      },
    );

    it('refuses a Supabase OAuth client by halves, either way round', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ SUPABASE_OAUTH_CLIENT_ID: 'client-id' })),
      ).toThrow(/SUPABASE_OAUTH_CLIENT_SECRET/);
      expect(() =>
        validateEnvironment(validEnvironment({ SUPABASE_OAUTH_CLIENT_SECRET: 'real-secret' })),
      ).toThrow(/SUPABASE_OAUTH_CLIENT_ID/);
    });

    it('refuses the published example Supabase secret outside local only', () => {
      const example = {
        SUPABASE_OAUTH_CLIENT_ID: 'client-id',
        SUPABASE_OAUTH_CLIENT_SECRET: 'local-example-supabase-secret',
      };

      expect(() => validateEnvironment(validEnvironment({ ...REAL, ...example }))).toThrow(
        /local-only[^\n]*\n\s*→ at SUPABASE_OAUTH_CLIENT_SECRET/,
      );
      expect(validateEnvironment(validEnvironment(example)).SUPABASE_OAUTH_CLIENT_ID).toBe(
        'client-id',
      );
      expect(
        validateEnvironment(
          validEnvironment({ ...REAL, ...example, SUPABASE_OAUTH_CLIENT_SECRET: 'a-real-secret' }),
        ).SUPABASE_OAUTH_CLIENT_SECRET,
      ).toBe('a-real-secret');
    });
  });

  describe('BYOS provider clients (spec 032)', () => {
    const REAL = {
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
      ...REAL_DEPLOYMENT_PREVIEW,
      APP_URL: 'https://app.forge.example',
      DEPLOY_ENV: 'staging',
      PREVIEW_DOMAIN: 'preview.forge.example',
    };
    const ANTHROPIC = {
      BYOS_ANTHROPIC_API_BASE_URL: 'https://api.anthropic.example',
      BYOS_ANTHROPIC_AUTHORIZE_URL: 'https://auth.anthropic.example/authorize',
      BYOS_ANTHROPIC_CLIENT_ID: 'client-id',
      BYOS_ANTHROPIC_SCOPES: 'user:inference user:profile',
      BYOS_ANTHROPIC_TOKEN_URL: 'https://auth.anthropic.example/token',
    };

    it('leaves every provider unset and defaults the refresh timeout', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.BYOS_ANTHROPIC_CLIENT_ID).toBeUndefined();
      expect(result.BYOS_OPENAI_CLIENT_ID).toBeUndefined();
      expect(result.BYOS_REFRESH_TIMEOUT_MS).toBe(10_000);
    });

    it('accepts a complete redirect set, and a device set without AUTHORIZE_URL', () => {
      expect(
        validateEnvironment(validEnvironment({ ...REAL, ...ANTHROPIC })).BYOS_ANTHROPIC_SCOPES,
      ).toBe('user:inference user:profile');
      expect(
        validateEnvironment(
          validEnvironment({
            BYOS_OPENAI_API_BASE_URL: 'https://api.openai.example',
            BYOS_OPENAI_CLIENT_ID: 'client-id',
            BYOS_OPENAI_DEVICE_URL: 'https://auth.openai.example/device',
            BYOS_OPENAI_SCOPES: 'openid',
            BYOS_OPENAI_TOKEN_URL: 'https://auth.openai.example/token',
          }),
        ).BYOS_OPENAI_DEVICE_URL,
      ).toBe('https://auth.openai.example/device');
    });

    it.each(['CLIENT_ID', 'TOKEN_URL', 'API_BASE_URL', 'SCOPES'])(
      'refuses a set missing %s',
      (name) => {
        const partial: Record<string, string> = { ...ANTHROPIC };
        delete partial[`BYOS_ANTHROPIC_${name}`];

        expect(() => validateEnvironment(validEnvironment(partial))).toThrow(
          new RegExp(`→ at BYOS_ANTHROPIC_${name}`),
        );
      },
    );

    it('refuses a set with neither AUTHORIZE_URL nor DEVICE_URL', () => {
      const partial: Record<string, string> = { ...ANTHROPIC };
      delete partial.BYOS_ANTHROPIC_AUTHORIZE_URL;

      expect(() => validateEnvironment(validEnvironment(partial))).toThrow(
        /DEVICE_URL is required[^\n]*\n\s*→ at BYOS_ANTHROPIC_AUTHORIZE_URL/,
      );
    });

    it('refuses a lone secret, since it implies the rest of the set', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ BYOS_OPENAI_CLIENT_SECRET: 'secret' })),
      ).toThrow(/BYOS_OPENAI_CLIENT_ID/);
    });

    it('refuses an http: URL outside local, and allows it under local', () => {
      const plain = { ...ANTHROPIC, BYOS_ANTHROPIC_TOKEN_URL: 'http://localhost:8791/token' };

      expect(() => validateEnvironment(validEnvironment({ ...REAL, ...plain }))).toThrow(
        /https[^\n]*\n\s*→ at BYOS_ANTHROPIC_TOKEN_URL/,
      );
      expect(validateEnvironment(validEnvironment(plain)).BYOS_ANTHROPIC_TOKEN_URL).toBe(
        'http://localhost:8791/token',
      );
    });
  });

  describe('the default model', () => {
    it('refuses AGENT_DEFAULT_MODEL outside the catalogue', () => {
      expect(() =>
        validateEnvironment(validEnvironment({ AGENT_DEFAULT_MODEL: 'not-a-real-model' })),
      ).toThrow(/AGENT_DEFAULT_MODEL/);
    });
  });

  describe('agent homes (spec 041)', () => {
    const REAL = {
      ...REAL_DEPLOYMENT_PREVIEW,
      AGENT_HOME_ENABLED: 'true',
      AGENT_HOME_SERVER_URL: 'https://api.forge.example',
      DEPLOY_ENV: 'staging',
      KEK_PROVIDER: 'openbao',
      OBJECT_STORE_ACCESS_KEY_ID: 'placeholder-access-key',
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
      OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'placeholder-secret-key',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'placeholder-token',
    };

    it('pins Claude Code to an exact version outside local when homes are on', () => {
      for (const loose of [undefined, 'stable', 'latest']) {
        expect(() =>
          validateEnvironment(validEnvironment({ ...REAL, AGENT_HOME_CLAUDE_VERSION: loose })),
        ).toThrow(/AGENT_HOME_CLAUDE_VERSION/);
      }
      expect(
        validateEnvironment(validEnvironment({ ...REAL, AGENT_HOME_CLAUDE_VERSION: '2.1.3' }))
          .AGENT_HOME_CLAUDE_VERSION,
      ).toBe('2.1.3');
      expect(validateEnvironment(validEnvironment()).AGENT_HOME_CLAUDE_VERSION).toBe('stable');
    });
  });

  describe('existing configuration', () => {
    it('keeps the defaults the scaffold already relied on', () => {
      const result = validateEnvironment(validEnvironment());

      expect(result.PORT).toBe(3000);
      expect(result.API_PREFIX).toBe('api');
      expect(result.THROTTLE_LIMIT).toBe(100);
    });
  });
});
