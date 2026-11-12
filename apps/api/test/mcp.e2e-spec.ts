import { createHash, randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  mcpAuthorizationPreviewSchema,
  mcpAuthorizationRedirectSchema,
  mcpGrantListSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { DAYTONA_TIMINGS, DEFAULT_DAYTONA_TIMINGS } from '../src/modules/sandbox/sandbox.constants';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import, as `files.e2e-spec.ts`: the fake's address must be known when config loads. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.APP_URL = 'http://localhost:5173';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const ORIGIN = 'http://localhost:5173';
const RESOURCE = `${ORIGIN}/api/v1/mcp`;
const MCP = '/api/v1/mcp';
const CALLBACK = 'https://client.example.test/callback';

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
}

interface RpcResult {
  error?: { code: number; message: string };
  result?: {
    content?: { text: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    tools?: { annotations?: Record<string, unknown>; name: string }[];
  };
}

describe('MCP server and its OAuth 2.1 authorization server (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and a fake Daytona', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let fake: FakeDaytona;
    let world: TwoTenantWorld;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let clientId: string;

    const verifier = (): string => randomBytes(32).toString('base64url');
    const challenge = (value: string): string =>
      createHash('sha256').update(value).digest('base64url');

    function authorizationRequest(codeChallenge: string, scope?: string): Record<string, string> {
      return {
        clientId,
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: CALLBACK,
        resource: RESOURCE,
        responseType: 'code',
        state: 'xyz-state',
        ...(scope === undefined ? {} : { scope }),
      };
    }

    /** Consent as the web page does it, then the client's code exchange. */
    async function connect(scope?: string): Promise<Tokens> {
      const codeVerifier = verifier();
      const decided = await unsafe(http(app).post('/api/v1/oauth/authorize'), [
        world.alpha.owner.cookie,
      ])
        .send({
          decision: 'allow',
          orgId: world.alpha.orgId,
          request: authorizationRequest(challenge(codeVerifier), scope),
        })
        .expect(200);
      const redirect = new URL(mcpAuthorizationRedirectSchema.parse(decided.body).redirectUrl);

      const token = await http(app)
        .post('/api/v1/oauth/token')
        .type('form')
        .send({
          client_id: clientId,
          code: redirect.searchParams.get('code'),
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
          resource: RESOURCE,
        })
        .expect(200);

      return token.body as Tokens;
    }

    /** One JSON-RPC exchange over Streamable HTTP; the answer may come as JSON or as SSE. */
    async function rpc(token: string, method: string, params: object = {}): Promise<RpcResult> {
      const response = await http(app)
        .post(MCP)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', '2025-06-18')
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          res.on('end', () => done(null, text));
        })
        .send({ id: 1, jsonrpc: '2.0', method, params });

      expect(response.status).toBe(200);
      const raw = response.body as string;
      const line = raw.split('\n').find((one) => one.startsWith('data: ')) ?? raw;

      return JSON.parse(line.replace(/^data: /, '')) as RpcResult;
    }

    const callTool = (token: string, name: string, args: object = {}): Promise<RpcResult> =>
      rpc(token, 'tools/call', { arguments: args, name });

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      fake = await startFakeDaytona({ port: FAKE.port });
      fake.workspace.set(`${fake.workDir}/README.md`, {
        content: Buffer.from('# Built over MCP\n'),
        kind: 'file',
      });

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .overrideProvider(DAYTONA_TIMINGS)
        .useValue({ ...DEFAULT_DAYTONA_TIMINGS, lookupTtlMs: 0 })
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      world = await createTwoTenantWorld(app);

      const { orgId, projectId } = world.alpha;
      await app
        .get(TenantTransactionRunner)
        .runInTenantScope({ orgId, userId: null }, (tx) =>
          app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
        );

      const registered = await http(app)
        .post('/api/v1/oauth/register')
        .send({ client_name: 'E2E Agent', redirect_uris: [CALLBACK] })
        .expect(201);
      clientId = (registered.body as { client_id: string }).client_id;
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      if (clientId !== undefined) {
        await database?.delete(schema.mcpClients).where(eq(schema.mcpClients.id, clientId));
      }
      if (world) await destroyTwoTenantWorld(app, world);
      await app?.close();
      await fake?.close();
      await suiteLock?.release();
    });

    it('publishes RFC 8414 and RFC 9728 discovery documents at the origin root', async () => {
      const server = await http(app).get('/.well-known/oauth-authorization-server').expect(200);
      expect(server.body).toMatchObject({
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        code_challenge_methods_supported: ['S256'],
        issuer: ORIGIN,
        registration_endpoint: `${ORIGIN}/api/v1/oauth/register`,
        token_endpoint: `${ORIGIN}/api/v1/oauth/token`,
        token_endpoint_auth_methods_supported: ['none'],
      });

      for (const path of [
        '/.well-known/oauth-protected-resource/api/v1/mcp',
        '/.well-known/oauth-protected-resource',
      ]) {
        const resource = await http(app).get(path).expect(200);
        expect(resource.body).toMatchObject({
          authorization_servers: [ORIGIN],
          resource: RESOURCE,
        });
      }
    });

    it('answers an unauthenticated MCP request 401 with the resource-metadata challenge', async () => {
      const response = await http(app)
        .post(MCP)
        .send({ id: 1, jsonrpc: '2.0', method: 'tools/list' })
        .expect(401);

      expect(response.headers['www-authenticate']).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1/mcp"`,
      );

      const forged = await http(app)
        .post(MCP)
        .set('Authorization', `Bearer mcp_at_${'A'.repeat(43)}`)
        .send({ id: 1, jsonrpc: '2.0', method: 'tools/list' })
        .expect(401);
      expect(forged.headers['www-authenticate']).toContain('error="invalid_token"');
    });

    it('registers public clients only, and only with safe redirect URIs', async () => {
      const insecure = await http(app)
        .post('/api/v1/oauth/register')
        .send({ redirect_uris: ['http://evil.example.test/cb'] })
        .expect(400);
      expect(insecure.body).toMatchObject({ error: 'invalid_redirect_uri' });

      const confidential = await http(app)
        .post('/api/v1/oauth/register')
        .send({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' })
        .expect(400);
      expect(confidential.body).toMatchObject({ error: 'invalid_client_metadata' });
    });

    it('shows the consent screen, and refuses a redirect URI the client did not register', async () => {
      const preview = await unsafe(http(app).post('/api/v1/oauth/authorize/preview'), [
        world.alpha.owner.cookie,
      ])
        .send(authorizationRequest(challenge(verifier()), 'projects:read openid'))
        .expect(200);
      expect(mcpAuthorizationPreviewSchema.parse(preview.body)).toEqual({
        clientName: 'E2E Agent',
        clientUri: null,
        redirectHost: 'client.example.test',
        scopes: ['projects:read'],
      });

      await unsafe(http(app).post('/api/v1/oauth/authorize/preview'), [world.alpha.owner.cookie])
        .send({
          ...authorizationRequest(challenge(verifier())),
          redirectUri: 'https://evil.test/cb',
        })
        .expect(400);
    });

    it('sends a denial back to the client as access_denied with its state and our issuer', async () => {
      const response = await unsafe(http(app).post('/api/v1/oauth/authorize'), [
        world.alpha.owner.cookie,
      ])
        .send({ decision: 'deny', request: authorizationRequest(challenge(verifier())) })
        .expect(200);
      const redirect = new URL(mcpAuthorizationRedirectSchema.parse(response.body).redirectUrl);

      expect(redirect.searchParams.get('error')).toBe('access_denied');
      expect(redirect.searchParams.get('state')).toBe('xyz-state');
      expect(redirect.searchParams.get('iss')).toBe(ORIGIN);
      expect(redirect.searchParams.has('code')).toBe(false);
    });

    it('refuses to let a person connect an organization they do not belong to', async () => {
      await unsafe(http(app).post('/api/v1/oauth/authorize'), [world.alpha.owner.cookie])
        .send({
          decision: 'allow',
          orgId: world.beta.orgId,
          request: authorizationRequest(challenge(verifier())),
        })
        .expect(403);
    });

    it('redeems a code once, and only with the matching PKCE verifier', async () => {
      const codeVerifier = verifier();
      const decided = await unsafe(http(app).post('/api/v1/oauth/authorize'), [
        world.alpha.owner.cookie,
      ])
        .send({
          decision: 'allow',
          orgId: world.alpha.orgId,
          request: authorizationRequest(challenge(codeVerifier)),
        })
        .expect(200);
      const code = new URL(
        mcpAuthorizationRedirectSchema.parse(decided.body).redirectUrl,
      ).searchParams.get('code');
      const exchange = (codeVerifierSent: string) =>
        http(app).post('/api/v1/oauth/token').type('form').send({
          client_id: clientId,
          code,
          code_verifier: codeVerifierSent,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
        });

      // A wrong verifier burns the code (GETDEL): the right one cannot follow it.
      expect((await exchange(verifier()).expect(400)).body).toMatchObject({
        error: 'invalid_grant',
      });
      expect((await exchange(codeVerifier).expect(400)).body).toMatchObject({
        error: 'invalid_grant',
      });
    });

    it('lists every tool with annotations, and runs them as the person in their own organization only', async () => {
      const { access_token: token, scope } = await connect();
      expect(scope).toBe('projects:read projects:write projects:deploy');

      const list = await rpc(token, 'tools/list');
      const names = (list.result?.tools ?? []).map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'apply_database_migrations',
          'create_project',
          'deploy_project',
          'get_agent_run',
          'list_projects',
          'read_file',
          'run_command',
          'start_agent_run',
          'sync_github',
        ]),
      );
      const listProjects = list.result?.tools?.find((tool) => tool.name === 'list_projects');
      expect(listProjects?.annotations).toMatchObject({ readOnlyHint: true });

      const projects = await callTool(token, 'list_projects');
      expect(projects.result?.isError).not.toBe(true);
      const ids = (
        projects.result?.structuredContent?.projects as { id: string }[] | undefined
      )?.map((one) => one.id);
      expect(ids).toContain(world.alpha.projectId);
      expect(ids).not.toContain(world.beta.projectId);

      const foreign = await callTool(token, 'get_project', { projectId: world.beta.projectId });
      expect(foreign.result?.isError).toBe(true);
      expect(foreign.result?.structuredContent).toMatchObject({
        error: { type: 'permission-denied' },
      });

      const file = await callTool(token, 'read_file', {
        path: 'README.md',
        projectId: world.alpha.projectId,
      });
      expect(file.result?.structuredContent).toMatchObject({
        content: '# Built over MCP\n',
        renderable: true,
      });
    });

    it('refuses a tool whose scope the grant does not carry', async () => {
      const { access_token: token, scope } = await connect('projects:read');
      expect(scope).toBe('projects:read');

      const response = await http(app)
        .post(MCP)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', '2025-06-18')
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: { name: 'x' }, name: 'create_project' },
        });

      expect(response.status).toBe(403);
      expect(response.headers['www-authenticate']).toContain('insufficient_scope');
    });

    it('rotates refresh tokens, and revokes the whole grant when a retired one is replayed', async () => {
      const first = await connect();
      const refresh = (token: string) =>
        http(app).post('/api/v1/oauth/token').type('form').send({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: token,
        });

      const second = (await refresh(first.refresh_token).expect(200)).body as Tokens;
      expect(second.refresh_token).not.toBe(first.refresh_token);
      // The rotated-out access token is gone with its pair.
      await http(app).post(MCP).set('Authorization', `Bearer ${first.access_token}`).expect(401);
      expect((await rpc(second.access_token, 'tools/list')).result?.tools?.length).toBeGreaterThan(
        0,
      );

      // Replaying the first refresh token kills the grant, so the live pair dies too.
      expect((await refresh(first.refresh_token).expect(400)).body).toMatchObject({
        error: 'invalid_grant',
      });
      await http(app).post(MCP).set('Authorization', `Bearer ${second.access_token}`).expect(401);
      await refresh(second.refresh_token).expect(400);
    });

    it('lets the person see and revoke a connected agent, which locks it out at once', async () => {
      const { access_token: token } = await connect();
      const grants = `/api/v1/orgs/${world.alpha.orgId}/mcp/grants`;

      const listed = mcpGrantListSchema.parse(
        (await http(app).get(grants).set('Cookie', world.alpha.owner.cookie).expect(200)).body,
      );
      const newest = listed.items[0]!;
      expect(newest).toMatchObject({ clientName: 'E2E Agent' });

      // Another person in another org cannot see or revoke it.
      await unsafe(http(app).delete(`/api/v1/orgs/${world.beta.orgId}/mcp/grants/${newest.id}`), [
        world.beta.owner.cookie,
      ]).expect(404);

      await unsafe(http(app).delete(`${grants}/${newest.id}`), [world.alpha.owner.cookie]).expect(
        204,
      );
      await http(app).post(MCP).set('Authorization', `Bearer ${token}`).expect(401);

      // Under the org's tenant transaction: `audit_log` rows are only visible inside it.
      const audit = await app
        .get(TenantTransactionRunner)
        .runInTenantScope({ orgId: world.alpha.orgId, userId: null }, (tx) =>
          tx
            .select({ action: schema.auditLog.action })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.target, newest.id)),
        );
      expect(audit.map((row) => row.action).sort()).toEqual([
        'mcp.client-authorized',
        'mcp.client-revoked',
      ]);
    });
  });
});
