/**
 * By-hand BYOS walk (spec 032 quickstart § "Walk record — T064"): the real AppModule on :3000
 * against the provider double (both providers), a fake Daytona and a loopback platform Anthropic.
 * Never reaches a real provider. Run from the repo root (then `pnpm --filter @repo/web dev`):
 *
 *   node apps/api/test/manual/byos-dev.ts
 *
 * Plain node hands the file to Vite's SSR runner (via vitest/node, already installed): Nest needs
 * the decorator metadata Vite's oxc emits and tsx's esbuild does not.
 *
 * Seeds a fresh org owner A and member B (editor on one project, sandbox registered) per start,
 * enrols a TOTP for each, and serves a control port for the double (printed on boot).
 */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';

import type * as RepoDb from '@repo/db' with { 'resolution-mode': 'require' };
import { Secret, TOTP } from 'otpauth';

const DOUBLE_PORT = 4010;
const CONTROL_PORT = 4011;

async function main(): Promise<void> {
  const { startFakeAnthropic } = await import('../support/fake-anthropic.js');
  const { startFakeByosProvider } = await import('../support/fake-byos-provider.js');
  const { startFakeDaytona } = await import('../support/fake-daytona.js');
  const { fakeGit } = await import('../support/fake-git.js');

  const double = startFakeByosProvider({ port: DOUBLE_PORT });
  await double.start();
  const daytona = await startFakeDaytona({ sandboxId: `sandbox-byos-${randomUUID()}` });
  fakeGit(daytona, (request) => ({ exitCode: 0, result: `ran: ${request.command}\n` }));
  const platform = startFakeAnthropic();
  await platform.start();
  // ponytail: the platform fake has no default reply, so pre-queue plenty; restart when spent.
  for (let i = 0; i < 1000; i += 1) {
    platform.script({
      reply: {
        stopReason: 'end_turn',
        text: 'ok (platform fake)',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
  }

  // Set before `.env` is read, so these win over it (ConfigModule never overrides a set variable).
  const byos = (prefix: string, scopes: string) => {
    process.env[`${prefix}_CLIENT_ID`] = double.clientId;
    process.env[`${prefix}_AUTHORIZE_URL`] = double.authorizeURL;
    process.env[`${prefix}_TOKEN_URL`] = double.tokenURL;
    process.env[`${prefix}_REVOKE_URL`] = double.revokeURL;
    process.env[`${prefix}_API_BASE_URL`] = double.apiBaseURL;
    process.env[`${prefix}_SCOPES`] = scopes;
  };
  byos('BYOS_ANTHROPIC', 'user:inference');
  byos('BYOS_OPENAI', 'openid email');
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'sk-ant-fake-byos-dev',
    ANTHROPIC_BASE_URL: platform.baseURL,
    DAYTONA_API_KEY: daytona.apiKey,
    DAYTONA_API_URL: daytona.apiUrl,
    DEPLOY_ENV: 'local',
    NODE_ENV: 'development',
    RUN_PROFILES: 'api,agent,events',
  });
  await import('../support/developer-dotenv.js');
  process.env.REDIS_QUEUE_URL ??= 'redis://localhost:6381';
  process.env.REDIS_STREAM_URL ??= 'redis://localhost:6382';
  process.env.GITHUB_WEBHOOK_SECRET ??= 'local-example-webhook-secret';

  const { NestFactory } = await import('@nestjs/core');
  const { Logger } = await import('nestjs-pino');
  // Typed as src/ sees it (CommonJS): this file is ESM, and the `import` build of @repo/db
  // carries its own drizzle types, which `tx` below will not accept. One copy at runtime.
  const { schema } = (await import('@repo/db')) as unknown as typeof RepoDb;
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApplication } = await import('../../src/bootstrap.js');
  const { TenantTransactionRunner } = await import('../../src/database/tenant-transaction.js');
  const { MfaService } = await import('../../src/modules/identity/services/mfa.service.js');
  const { SandboxService } = await import('../../src/modules/sandbox/sandbox.service.js');
  const { run: byosProvider } = await import('../../src/scripts/byos-provider.js');
  const { createTwoTenantWorld, FIXTURE_PASSWORD, signUpAndIn } =
    await import('../support/two-tenant-fixture.js');

  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  configureApplication(app);
  await app.listen(3000, '0.0.0.0');

  // The record path is only stored as a string; the sheets need not exist.
  for (const provider of ['anthropic', 'openai'] as const) {
    await byosProvider(app, { provider, record: `docs/byos/${provider}.md`, status: 'in-force' });
  }

  const world = await createTwoTenantWorld(app);
  const { orgId, projectId } = world.alpha;
  const a = world.alpha.owner;
  const b = await signUpAndIn(app, 'byos-member-b');
  const transactions = app.get(TenantTransactionRunner);
  await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
    app.get(SandboxService).register(tx, { daytonaId: daytona.sandboxId, orgId, projectId }),
  );
  await transactions.runInTenantTransaction(orgId, async (tx) => {
    await tx
      .insert(schema.memberships)
      .values({ acceptedAt: new Date(), orgId, role: 'member', userId: b.userId });
    await tx
      .insert(schema.projectGrants)
      .values({ orgId, projectId, role: 'editor', userId: b.userId });
  });

  const mfa = app.get(MfaService);
  const secrets = new Map<string, Secret>();
  for (const person of [a, b]) {
    const { otpauthUri } = await mfa.beginEnrolment(person.userId);
    const secret = Secret.fromBase32(
      new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')!,
    );
    await mfa.confirmEnrolment(person.userId, TOTP.generate({ secret }));
    secrets.set(person.email, secret);
  }
  const codes = () =>
    Object.fromEntries([...secrets].map(([email, secret]) => [email, TOTP.generate({ secret })]));

  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const q = url.searchParams;
    const act: Record<string, () => unknown> = {
      '/totp': codes,
      '/sign-in-as': () => double.signInAs(q.get('email') ?? 'ada@example.com'),
      '/deny': () => double.deny(),
      '/revoke': () => double.revoke(q.get('email') ?? 'ada@example.com'),
      '/rate-limit': () =>
        double.rateLimit(q.has('seconds') ? { resetInSeconds: Number(q.get('seconds')) } : {}),
      '/clear-limit': () => double.rateLimit(false),
      '/calls': () => double.callLog().map((bearer) => bearer?.slice(0, 12) ?? null),
    };
    const handler = act[url.pathname];
    response.writeHead(handler ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(handler ? (handler() ?? 'ok') : Object.keys(act)));
  }).listen(CONTROL_PORT, '127.0.0.1');

  const c = `http://127.0.0.1:${CONTROL_PORT}`;
  console.log(`
=== BYOS dev walk ready ===
web  http://localhost:5173   api http://localhost:3000   double ${double.baseURL}
password (both): ${FIXTURE_PASSWORD}
A (org owner): ${a.email}
B (member, editor on "Project alpha"): ${b.email}
TOTP secrets (add to an authenticator, or: curl ${c}/totp):
${[...secrets].map(([email, secret]) => `  ${email}  ${secret.base32}`).join('\n')}
Double controls (label = the provider account the next connect signs in as, default ada@example.com):
  curl "${c}/sign-in-as?email=ada-claude@example.com"
  curl "${c}/revoke?email=ada-claude@example.com"     # provider-side revoke of that label's grants
  curl "${c}/rate-limit?seconds=7200"                  # model calls answer 429 + retry-after
  curl "${c}/clear-limit"
  curl "${c}/deny"                                     # next authorise answers access_denied
  curl "${c}/calls"                                    # bearer prefixes the double saw
Pick a Claude model (e.g. claude-sonnet-5): the double speaks only the Anthropic Messages wire.
Ctrl+C to stop.`);
}

const fail = (error: unknown) => {
  console.error(error);
  process.exit(1);
};

if (process.env.BYOS_DEV_IN_VITE === undefined) {
  process.env.BYOS_DEV_IN_VITE = '1';
  const root = join(import.meta.dirname, '..', '..');
  process.chdir(root); // `.env`, the templates dir and the fixtures resolve from apps/api
  const { createViteServer } = await import('vitest/node');
  const vite = await createViteServer({
    appType: 'custom',
    configFile: false,
    // The runner gives modules `import.meta.dirname`, not CommonJS `__dirname`, which src/ reads.
    plugins: [
      {
        name: 'byos-dev-dirname',
        transform: (code: string, id: string) =>
          id.includes('node_modules')
            ? undefined
            : code.replace(/\b__dirname\b/g, 'import.meta.dirname'),
      },
    ],
    root,
    server: { hmr: false, middlewareMode: true, ws: false },
  });
  await vite.ssrLoadModule('/test/manual/byos-dev.ts').catch(fail);
} else {
  await main().catch(fail);
}
