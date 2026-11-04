import { generateKeyPairSync } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { repoLinkSchema } from '@repo/contracts';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Plaintext, revealPlaintext } from '../../common/crypto/branded';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { type GithubFixture, startGithubFixture } from '../../../test/fixtures/github-fixture';
import type { AuditService } from '../audit/audit.service';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import type { ConnectionRecord } from './connection.repository';
import { ConnectionService } from './connection.service';
import { GithubApiError, GithubAppClient } from './github-app.client';
import { InstallStateStore } from './install-state';
import type { RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import { RepoLinkService } from './repo-link.service';
import type { SyncRepository } from './sync.repository';
import type { SyncService } from './sync.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333';
const USER = '66666666-6666-4666-8666-666666666666';
const LINK = '44444444-4444-4444-8444-444444444444';
const CONNECTION = '55555555-5555-4555-8555-555555555555';
const CHECKPOINT = '77777777-7777-4777-8777-777777777777';
const INSTALLATION_ID = 77;
const REF = { orgId: ORG, projectId: PROJECT };
const TX = { tag: 'tx' } as unknown as TenantTransaction;

const OLD_SHA = 'a'.repeat(40);
const KNOWN_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const FOREIGN_SHA = 'd'.repeat(40);

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs1' });

function configOf(values: Record<string, unknown>): ConfigService<Environment, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<Environment, true>;
}

/** The two `MULTI`s `InstallStateStore` runs, in memory: what is proved here is the spending. */
function memoryRedis(hashes: Map<string, Record<string, string>>): Redis {
  return {
    multi() {
      const steps: (() => [null, unknown])[] = [];
      const chain = {
        del(key: string) {
          steps.push(() => [null, hashes.delete(key) ? 1 : 0]);

          return chain;
        },
        exec: () => Promise.resolve(steps.map((step) => step())),
        expire(_key: string, _seconds: number) {
          steps.push(() => [null, 1]);

          return chain;
        },
        hgetall(key: string) {
          steps.push(() => [null, { ...hashes.get(key) }]);

          return chain;
        },
        hset(key: string, record: Record<string, string>) {
          steps.push(() => {
            hashes.set(key, record);

            return [null, 1];
          });

          return chain;
        },
      };

      return chain;
    },
  } as unknown as Redis;
}

/**
 * Spec 044's repository-link work without Postgres: the real client on the wire of the fixture
 * GitHub and the real state store, around in-memory rows. `repo-link.service.spec.ts` holds the
 * suites that need the database.
 */
describe('RepoLinkService (spec 044)', () => {
  let fixture: GithubFixture;
  let github: GithubAppClient;
  let installationToken: Plaintext;
  let row: RepoLinkRecord | undefined;
  let connection: ConnectionRecord;
  let head: { gitSha: string; id: string } | null;
  let hashes: Map<string, Record<string, string>>;
  let states: InstallStateStore;
  let service: RepoLinkService;

  const clientValues = () => ({
    GITHUB_API_URL: fixture.url,
    GITHUB_APP_CLIENT_ID: 'Iv1.app',
    GITHUB_APP_CLIENT_SECRET: 'client-secret',
    GITHUB_APP_ID: 4242,
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_INSTALL_URL: fixture.url,
  });

  const links = {
    setRepository: vi.fn(() => Promise.resolve()),
    checkpointAt: vi.fn((_tx, _org, _project, sha: string) =>
      Promise.resolve(sha === KNOWN_SHA || sha === HEAD_SHA ? CHECKPOINT : undefined),
    ),
    delete: vi.fn(() => {
      row = undefined;

      return Promise.resolve();
    }),
    forProject: vi.fn(() => Promise.resolve(row)),
    insert: vi.fn((_tx, draft: Partial<RepoLinkRecord>) => {
      row = aLink(draft);

      return Promise.resolve(row);
    }),
    project: vi.fn((_tx, _org, projectId: string) =>
      Promise.resolve(
        projectId === PROJECT || projectId === OTHER_PROJECT
          ? { archived: false, workspaceId: 'w' }
          : undefined,
      ),
    ),
    setAutoSync: vi.fn((_tx, _org, _id, autoSync: boolean) => {
      row = { ...row!, autoSync };

      return Promise.resolve();
    }),
    setBranch: vi.fn(
      (
        _tx,
        _org,
        _id,
        move: { branch: string; lastPushedCheckpointId: string | null; remoteHeadSha: string },
      ) => {
        row = {
          ...row!,
          ...move,
          lastPushedSha: move.lastPushedCheckpointId === null ? null : move.remoteHeadSha,
          sideBranch: null,
        };

        return Promise.resolve();
      },
    ),
    setPushed: vi.fn(() => Promise.resolve()),
  };
  const connections = {
    currentToken: vi.fn(() => Promise.resolve(installationToken)),
    ensureUsable: vi.fn(() => Promise.resolve(connection)),
    repositoryToken: vi.fn(() => Promise.resolve(installationToken)),
  };
  const checkpoints = {
    activeRunExists: vi.fn(() => Promise.resolve(false)),
    head: vi.fn(() => Promise.resolve(head)),
  };
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const syncs = { requestAuto: vi.fn(() => Promise.resolve(null)) };
  const operations = { inFlightExists: vi.fn(() => Promise.resolve(false)) };

  function aLink(overrides: Partial<RepoLinkRecord> = {}): RepoLinkRecord {
    return {
      autoSync: true,
      branch: 'main',
      connectionId: CONNECTION,
      createdAt: new Date('2026-11-04T00:00:00.000Z'),
      id: LINK,
      lastPushedCheckpointId: null,
      lastPushedSha: null,
      linkedBy: USER,
      linkedByName: 'jane@example.test',
      name: 'site',
      orgId: ORG,
      owner: 'acme',
      projectId: PROJECT,
      remoteHeadSha: OLD_SHA,
      repoId: 1,
      sideBranch: null,
      state: 'linked',
      updatedAt: new Date('2026-11-04T00:00:00.000Z'),
      ...overrides,
    };
  }

  function build(client: GithubAppClient = github): RepoLinkService {
    return new RepoLinkService(
      client,
      links as unknown as RepoLinkRepository,
      connections as unknown as ConnectionService,
      checkpoints as unknown as CheckpointService,
      audit as unknown as AuditService,
      syncs as unknown as SyncService,
      operations as unknown as SyncRepository,
      states,
    );
  }

  function personal(): void {
    connection = {
      ...connection,
      accountLogin: 'jane',
      accountType: 'user',
    };
  }

  /** Step one, answering the `state` the panel would get back from GitHub's redirect. */
  async function authorized(
    body = { name: 'blog', private: true },
    ref: typeof REF = REF,
  ): Promise<string> {
    const { authorizeUrl } = await service.authorize(TX, ref, USER, body);

    return new URL(authorizeUrl).searchParams.get('state')!;
  }

  function called(path: string): boolean {
    return fixture.requests.some((request) => request.path === path);
  }

  beforeAll(async () => {
    fixture = await startGithubFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    fixture.installations.clear();
    fixture.repositories.clear();
    fixture.tokens.clear();
    fixture.user.login = 'jane';
    fixture.installations.set(INSTALLATION_ID, {
      account: { id: 9, login: 'acme', type: 'Organization' },
      id: INSTALLATION_ID,
    });
    fixture.repositories.set(1, {
      branches: { dev: FOREIGN_SHA, known: KNOWN_SHA, main: OLD_SHA },
      default_branch: 'main',
      full_name: 'acme/site',
      id: 1,
      name: 'site',
      owner: { login: 'acme' },
      private: true,
      protected: ['main'],
    });

    github = new GithubAppClient(configOf(clientValues()));
    installationToken = (await github.mintToken(INSTALLATION_ID, { permissions: {} })).token;
    fixture.requests.length = 0;

    connection = {
      accountLogin: 'acme',
      accountType: 'organization',
      id: CONNECTION,
      installationId: INSTALLATION_ID,
    } as ConnectionRecord;
    row = aLink();
    head = { gitSha: HEAD_SHA, id: CHECKPOINT };
    hashes = new Map();
    states = new InstallStateStore(memoryRedis(hashes), configOf({ OAUTH_STATE_TTL_SECONDS: 600 }));
    service = build();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the contract carries autoSync and sideBranch', async () => {
    row = aLink({ autoSync: false, sideBranch: 'kido-sync' });

    const link = await service.read(TX, REF);

    expect(repoLinkSchema.parse(link)).toEqual(link);
    expect(link).toMatchObject({ autoSync: false, sideBranch: 'kido-sync' });
  });

  describe('link', () => {
    it('asks for the first push, after the row exists', async () => {
      row = undefined;

      await service.link(TX, REF, USER, { existing: { repoId: 1 } });

      expect(syncs.requestAuto).toHaveBeenCalledWith(TX, REF);
      expect(links.insert.mock.invocationCallOrder[0]).toBeLessThan(
        syncs.requestAuto.mock.invocationCallOrder[0]!,
      );
    });

    it('a refused link asks for nothing; create on a personal account stays create-unsupported', async () => {
      row = undefined;
      personal();

      await expect(
        service.link(TX, REF, USER, { create: { name: 'x', private: true } }),
      ).rejects.toMatchObject({ extensions: { reason: 'create-unsupported' }, type: 'conflict' });
      expect(syncs.requestAuto).not.toHaveBeenCalled();
    });
  });

  describe('update: autoSync', () => {
    it('off writes and asks for nothing', async () => {
      await expect(service.update(TX, REF, USER, { autoSync: false })).resolves.toMatchObject({
        autoSync: false,
      });
      expect(syncs.requestAuto).not.toHaveBeenCalled();
      expect(fixture.requests).toEqual([]);
      expect(audit.record).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({
          action: 'repo-link.updated',
          metadata: expect.objectContaining({ autoSync: false, projectId: PROJECT }) as unknown,
          target: LINK,
        }),
      );
    });

    it('on writes and asks for a push, even with a run active: only a branch waits for one', async () => {
      row = aLink({ autoSync: false });
      checkpoints.activeRunExists.mockResolvedValue(true);

      await expect(service.update(TX, REF, USER, { autoSync: true })).resolves.toMatchObject({
        autoSync: true,
      });
      expect(syncs.requestAuto).toHaveBeenCalledWith(TX, REF);
      checkpoints.activeRunExists.mockResolvedValue(false);
    });

    it('no change writes, audits and asks for nothing', async () => {
      await service.update(TX, REF, USER, { autoSync: true, branch: 'main' });

      expect(links.setAutoSync).not.toHaveBeenCalled();
      expect(links.setBranch).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(syncs.requestAuto).not.toHaveBeenCalled();
    });

    it('an unlinked or disconnected project is not-linked', async () => {
      row = undefined;
      await expect(service.update(TX, REF, USER, { autoSync: true })).rejects.toMatchObject({
        extensions: { reason: 'not-linked' },
      });

      row = aLink({ state: 'disconnected' });
      await expect(service.update(TX, REF, USER, { branch: 'dev' })).rejects.toMatchObject({
        extensions: { reason: 'not-linked' },
      });
    });
  });

  describe('update: branch', () => {
    it('refuses during a run, before GitHub', async () => {
      checkpoints.activeRunExists.mockResolvedValueOnce(true);

      await expect(service.update(TX, REF, USER, { branch: 'dev' })).rejects.toMatchObject({
        extensions: { reason: 'run-active' },
        type: 'conflict',
      });
      expect(fixture.requests).toEqual([]);
      expect(links.setBranch).not.toHaveBeenCalled();
    });

    it('refuses during an operation, before GitHub', async () => {
      operations.inFlightExists.mockResolvedValueOnce(true);

      await expect(service.update(TX, REF, USER, { branch: 'dev' })).rejects.toMatchObject({
        extensions: { reason: 'operation-in-flight' },
        type: 'conflict',
      });
      expect(fixture.requests).toEqual([]);
    });

    it('a renamed repository heals before the owner/name route would refuse it', async () => {
      row = aLink({ name: 'old-name' });

      await service.update(TX, REF, USER, { branch: 'dev' });

      expect(links.setRepository).toHaveBeenCalledOnce();
    });

    it('a branch GitHub does not have is branch-not-found and changes nothing', async () => {
      await expect(service.update(TX, REF, USER, { branch: 'nope' })).rejects.toMatchObject({
        extensions: { reason: 'branch-not-found' },
        type: 'conflict',
      });
      expect(links.setBranch).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('a remote head that is a checkpoint counts as pushed: the project reads ahead', async () => {
      row = aLink({ sideBranch: 'kido-sync' });

      const link = await service.update(TX, REF, USER, { branch: 'known' });

      expect(links.setBranch).toHaveBeenCalledWith(TX, ORG, LINK, {
        branch: 'known',
        lastPushedCheckpointId: CHECKPOINT,
        remoteHeadSha: KNOWN_SHA,
      });
      expect(link).toMatchObject({
        branch: 'known',
        lastPushedCheckpointId: CHECKPOINT,
        position: 'ahead',
        remoteHeadSha: KNOWN_SHA,
        sideBranch: null,
      });
      expect(audit.record).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({
          action: 'repo-link.updated',
          metadata: expect.objectContaining({ branch: 'known', projectId: PROJECT }) as unknown,
        }),
      );
    });

    it('a remote head at the project head reads level', async () => {
      fixture.repositories.get(1)!.branches.level = HEAD_SHA;

      await expect(service.update(TX, REF, USER, { branch: 'level' })).resolves.toMatchObject({
        position: 'level',
      });
    });

    it('a remote head the project has never seen clears lastPushed and reads diverged', async () => {
      row = aLink({ lastPushedCheckpointId: CHECKPOINT, lastPushedSha: OLD_SHA });

      await expect(service.update(TX, REF, USER, { branch: 'dev' })).resolves.toMatchObject({
        lastPushedCheckpointId: null,
        position: 'diverged',
        remoteHeadSha: FOREIGN_SHA,
      });
    });

    it('a refused credential is needs-reauth', async () => {
      fixture.override.status = 401;

      await expect(service.update(TX, REF, USER, { branch: 'dev' })).rejects.toMatchObject({
        extensions: { reason: 'needs-reauth' },
      });
    });
  });

  describe('branches', () => {
    it('marks the default and the protected', async () => {
      await expect(service.branches(TX, REF)).resolves.toEqual({
        branches: [
          { default: false, name: 'dev', protected: false },
          { default: false, name: 'known', protected: false },
          { default: true, name: 'main', protected: true },
        ],
      });
      expect(connections.currentToken).toHaveBeenCalledWith(TX, ORG);
    });

    it('a repository gone is not-found; an unlinked project simply has no branches', async () => {
      row = aLink({ repoId: 999 });
      await expect(service.branches(TX, REF)).rejects.toMatchObject({ type: 'not-found' });

      row = undefined;
      await expect(service.branches(TX, REF)).resolves.toEqual({ branches: [] });
    });
  });

  describe('createBranch', () => {
    it('makes the ref from the remote head under the one-repository token, then switches', async () => {
      await expect(
        service.createBranch(TX, REF, USER, { name: 'feature/x' }),
      ).resolves.toMatchObject({ branch: 'feature/x', remoteHeadSha: OLD_SHA, sideBranch: null });
      expect(connections.repositoryToken).toHaveBeenCalledWith(TX, ORG, 1);
      expect(fixture.repositories.get(1)!.branches['feature/x']).toBe(OLD_SHA);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it('reads the head fresh: a stale row does not decide', async () => {
      row = aLink({ remoteHeadSha: null });

      await expect(service.createBranch(TX, REF, USER, { name: 'next' })).resolves.toMatchObject({
        remoteHeadSha: OLD_SHA,
      });
    });

    it('an existing name is name-taken and the link stays', async () => {
      await expect(service.createBranch(TX, REF, USER, { name: 'dev' })).rejects.toMatchObject({
        extensions: { reason: 'name-taken' },
        type: 'conflict',
      });
      expect(links.setBranch).not.toHaveBeenCalled();
    });

    it('no remote head is nothing-to-push and creates no ref', async () => {
      row = aLink({ branch: 'unborn', remoteHeadSha: null });

      await expect(service.createBranch(TX, REF, USER, { name: 'next' })).rejects.toMatchObject({
        extensions: { reason: 'nothing-to-push' },
      });
      expect(called('/repos/acme/site/git/refs')).toBe(false);
    });

    it('a run or an operation refuses before any ref exists', async () => {
      checkpoints.activeRunExists.mockResolvedValueOnce(true);
      await expect(service.createBranch(TX, REF, USER, { name: 'next' })).rejects.toMatchObject({
        extensions: { reason: 'run-active' },
      });

      operations.inFlightExists.mockResolvedValueOnce(true);
      await expect(service.createBranch(TX, REF, USER, { name: 'next' })).rejects.toMatchObject({
        extensions: { reason: 'operation-in-flight' },
      });
      expect(fixture.requests).toEqual([]);
    });
  });

  describe('authorize', () => {
    beforeEach(() => {
      row = undefined;
      personal();
    });

    it('answers GitHub’s authorize URL with a state bound to the request, and no scope', async () => {
      const { authorizeUrl } = await service.authorize(TX, REF, USER, {
        name: 'blog',
        private: true,
      });
      const url = new URL(authorizeUrl);

      expect(`${url.origin}${url.pathname}`).toBe(`${fixture.url}/login/oauth/authorize`);
      expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'state']);
      await expect(
        states.consume(url.searchParams.get('state')!, {
          orgId: ORG,
          projectId: PROJECT,
          provider: 'github',
          userId: USER,
        }),
      ).resolves.toMatchObject({
        repoCreate: { name: 'blog', private: true, projectId: PROJECT },
      });
    });

    it('private false survives the round trip through a string', async () => {
      const state = await authorized({ name: 'blog', private: false });

      await service.completeCreate(TX, REF, USER, { code: 'good', state });

      expect(fixture.requests.find((request) => request.path === '/user/repos')?.body).toEqual({
        name: 'blog',
        private: false,
      });
    });

    it('refuses a linked project, an organisation, and a deployment without the secret', async () => {
      row = aLink();
      await expect(
        service.authorize(TX, REF, USER, { name: 'blog', private: true }),
      ).rejects.toMatchObject({ type: 'conflict' });
      row = undefined;

      connection = { ...connection, accountType: 'organization' };
      await expect(
        service.authorize(TX, REF, USER, { name: 'blog', private: true }),
      ).rejects.toMatchObject({ type: 'conflict' });
      personal();

      const noSecret = build(
        new GithubAppClient(configOf({ ...clientValues(), GITHUB_APP_CLIENT_SECRET: undefined })),
      );

      await expect(
        noSecret.authorize(TX, REF, USER, { name: 'blog', private: true }),
      ).rejects.toMatchObject({ extensions: { reason: 'create-unsupported' }, type: 'conflict' });
      expect(hashes.size).toBe(0);
    });

    it('refuses without a usable connection', async () => {
      connections.ensureUsable.mockRejectedValueOnce(new Error('not usable'));

      await expect(
        service.authorize(TX, REF, USER, { name: 'blog', private: true }),
      ).rejects.toThrow('not usable');
      expect(hashes.size).toBe(0);
    });
  });

  describe('completeCreate', () => {
    beforeEach(() => {
      row = undefined;
      personal();
    });

    it('creates, adds to the installation, links and asks for the first push', async () => {
      const state = await authorized();
      const link = await service.completeCreate(TX, REF, USER, { code: 'good', state });

      expect(repoLinkSchema.parse(link)).toEqual(link);
      expect(link).toMatchObject({
        autoSync: true,
        branch: 'main',
        remoteHeadSha: null,
        repository: { fullName: 'jane/blog', name: 'blog', owner: 'jane' },
      });
      expect(fixture.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        'POST /login/oauth/access_token',
        'GET /user',
        'POST /user/repos',
        `PUT /user/installations/${String(INSTALLATION_ID)}/repositories/${String(link.repository.id)}`,
        expect.stringMatching(/^DELETE \/applications\/.+\/token$/u),
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({ action: 'repo-link.created' }),
      );
      expect(syncs.requestAuto).toHaveBeenCalledWith(TX, REF);
    });

    it('compares the login case-insensitively, and replaces a disconnected link', async () => {
      fixture.user.login = 'JANE';
      row = aLink({ connectionId: null, state: 'disconnected' });

      const state = await authorized();

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).resolves.toMatchObject({ repository: { name: 'blog' }, state: 'linked' });
      expect(links.delete).toHaveBeenCalledTimes(1);
    });

    it('another GitHub account is account-mismatch and creates nothing', async () => {
      const state = await authorized();

      fixture.user.login = 'mallory';

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).rejects.toMatchObject({ extensions: { reason: 'account-mismatch' }, type: 'conflict' });
      expect(called('/user/repos')).toBe(false);
      expect(links.insert).not.toHaveBeenCalled();
    });

    it('a state for another project is refused before any GitHub call, and is spent', async () => {
      const state = await authorized();

      await expect(
        service.completeCreate(TX, { ...REF, projectId: OTHER_PROJECT }, USER, {
          code: 'good',
          state,
        }),
      ).rejects.toMatchObject({ type: 'oauth-state-invalid' });
      expect(fixture.requests).toEqual([]);
      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).rejects.toMatchObject({ type: 'oauth-state-invalid' });
    });

    it('a replayed state is refused', async () => {
      const state = await authorized();

      await service.completeCreate(TX, REF, USER, { code: 'good', state });
      row = undefined;
      fixture.requests.length = 0;

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).rejects.toMatchObject({ type: 'oauth-state-invalid' });
      expect(fixture.requests).toEqual([]);
    });

    it('another user’s state is refused', async () => {
      const state = await authorized();

      await expect(
        service.completeCreate(TX, REF, '99999999-9999-4999-8999-999999999999', {
          code: 'good',
          state,
        }),
      ).rejects.toMatchObject({ type: 'oauth-state-invalid' });
    });

    it('an install’s state cannot finish a create, nor a create’s state an install', async () => {
      const install = await states.issue(ORG, USER);

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state: install }),
      ).rejects.toMatchObject({ type: 'oauth-state-invalid' });

      await expect(
        states.consume(await authorized(), { orgId: ORG, provider: 'github', userId: USER }),
      ).resolves.toBeUndefined();
    });

    it('a project linked while the person was on GitHub creates nothing', async () => {
      const state = await authorized();

      row = aLink();

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).rejects.toMatchObject({ type: 'conflict' });
      expect(fixture.requests).toEqual([]);
    });

    it('a refused code is oauth-exchange-failed', async () => {
      const state = await authorized();

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'bad', state }),
      ).rejects.toMatchObject({ type: 'oauth-exchange-failed' });
      expect(links.insert).not.toHaveBeenCalled();
    });

    it('a taken name is name-taken', async () => {
      fixture.repositories.set(2, {
        branches: {},
        default_branch: 'main',
        full_name: 'jane/blog',
        id: 2,
        name: 'blog',
        owner: { login: 'jane' },
        private: true,
      });

      const state = await authorized();

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).rejects.toMatchObject({ extensions: { reason: 'name-taken' }, type: 'conflict' });
    });

    it.each([
      ['unavailable', 503, 'service-unavailable'],
      ['unauthorized', 403, 'conflict'],
    ] as const)(
      'add-to-installation %s: the refusal says the repository exists, and it is not deleted',
      async (category, status, type) => {
        vi.spyOn(github, 'addRepositoryToInstallation').mockRejectedValueOnce(
          new GithubApiError(category, status),
        );
        vi.spyOn(github, 'repository').mockRejectedValueOnce(new GithubApiError('not-found', 404));

        const state = await authorized();
        const refusal = (await service
          .completeCreate(TX, REF, USER, { code: 'good', state })
          .catch((error: unknown) => error)) as { detail: string; type: string };

        expect(refusal.type).toBe(type);
        expect(refusal.detail).toContain('jane/blog');
        expect(refusal.detail).toContain('was created');
        expect(links.insert).not.toHaveBeenCalled();
        expect([...fixture.repositories.values()].map((repo) => repo.full_name)).toContain(
          'jane/blog',
        );
        expect(
          fixture.requests.some(
            (request) => request.method === 'DELETE' && request.path.startsWith('/repos'),
          ),
        ).toBe(false);
      },
    );

    it('an all-repositories install that refuses the add but reaches the repository still links', async () => {
      vi.spyOn(github, 'addRepositoryToInstallation').mockRejectedValueOnce(
        new GithubApiError('unauthorized', 403),
      );

      const state = await authorized();

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).resolves.toMatchObject({ repository: { name: 'blog' }, state: 'linked' });
    });

    it('revokes the user token even when the create fails', async () => {
      const revoke = vi.spyOn(github, 'revokeUserToken');

      fixture.user.login = 'someone-else';

      const state = await authorized();

      await expect(
        service.completeCreate(TX, REF, USER, { code: 'good', state }),
      ).rejects.toMatchObject({ extensions: { reason: 'account-mismatch' } });
      expect(revoke).toHaveBeenCalledOnce();
    });

    it('the user token reaches no repository, secret, audit row, state, log or response', async () => {
      const levels = (['debug', 'error', 'log', 'verbose', 'warn'] as const).map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
      const exchange = vi.spyOn(github, 'exchangeUserCode');
      const state = await authorized();
      const link = await service.completeCreate(TX, REF, USER, { code: 'good', state });
      const issued = (await exchange.mock.results[0]!.value) as Plaintext;
      const token = revealPlaintext(issued).toString('utf8');

      expect(token).toMatch(/^ghu_/u);

      const written = JSON.stringify([
        link,
        [...hashes.values()],
        ...Object.values(links).map((stub) => stub.mock.calls),
        ...Object.values(connections).map((stub) => stub.mock.calls),
        audit.record.mock.calls,
        syncs.requestAuto.mock.calls,
        levels.map((level) => level.mock.calls),
      ]);

      expect(written).not.toContain(token);
    });
  });

  describe('canCreateRepositories', () => {
    const toContract = (accountType: 'organization' | 'user', canAuthorizeUsers: boolean) =>
      ConnectionService.prototype.toContract.call(
        { github: { canAuthorizeUsers: () => canAuthorizeUsers } },
        {
          accountId: 1,
          accountLogin: 'jane',
          accountType,
          circuitOpenUntil: null,
          connectedBy: USER,
          connectedByName: 'jane',
          createdAt: new Date(),
          credentialFingerprint: 'sha256:0',
          health: 'healthy',
          id: CONNECTION,
          lastVerifiedAt: null,
          provider: 'github',
        } as unknown as ConnectionRecord,
      );

    it('is an organisation, or a person where the App can authorise users', () => {
      expect(toContract('organization', false)).toMatchObject({ canCreateRepositories: true });
      expect(toContract('user', true)).toMatchObject({ canCreateRepositories: true });
      expect(toContract('user', false)).toMatchObject({ canCreateRepositories: false });
    });
  });
});
