import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { plaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  NEON_KEY,
  type ProviderFixture,
  startNeonFixture,
} from '../../../../../test/fixtures/provider-fixtures';
import {
  installNeonBranches,
  NEON_PROJECT,
  type NeonBranchState,
} from '../../../../../test/fixtures/neon-branches';
import { NeonClient } from './neon.client';

let fixture: ProviderFixture;
let client: NeonClient;

beforeAll(async () => {
  fixture = await startNeonFixture();
  client = new NeonClient({ get: () => fixture.url } as unknown as ConfigService<
    Environment,
    true
  >);
});

afterAll(() => fixture.close());

beforeEach(() => fixture.reset());

/** Spec 030 T028, contracts/provider-adapters.md § 3, research R6. */
describe('NeonClient.verify', () => {
  it('answers verified when the key lists at least one project', async () => {
    await expect(client.verify(plaintext(NEON_KEY))).resolves.toEqual({
      accountName: 'acme-db',
      accountRef: 'org-neon-1',
      kind: 'verified',
      scopes: ['projects:read', 'branches:write'],
    });
    expect(fixture.requests[0]!.path).toBe('/projects');
    expect(fixture.requests[0]!.query.get('limit')).toBe('1');
  });

  it('uses the project id as the account for a project-scoped key (no org)', async () => {
    fixture.route('GET', '/projects', () => ({
      body: { projects: [{ id: 'proj-solo', name: 'solo' }] },
      status: 200,
    }));
    await expect(client.verify(plaintext(NEON_KEY))).resolves.toMatchObject({
      accountRef: 'proj-solo',
      kind: 'verified',
    });
  });

  it('answers missing-scope projects:read when the list is empty', async () => {
    fixture.mode = 'missing-scope';
    await expect(client.verify(plaintext(NEON_KEY))).resolves.toEqual({
      kind: 'missing-scope',
      missing: ['projects:read'],
    });
  });

  it('answers revoked on 401', async () => {
    fixture.mode = 'revoked';
    await expect(client.verify(plaintext(NEON_KEY))).resolves.toEqual({ kind: 'revoked' });
  });

  it('answers a retryable failure on 429', async () => {
    fixture.mode = 'rate-limited';
    await expect(client.verify(plaintext(NEON_KEY))).resolves.toEqual({
      category: 'rate-limited',
      kind: 'failed',
      retryAfterSeconds: 5,
    });
  });
});

/** Spec 030 T063, contracts/provider-adapters.md § 3, research R9. */
describe('NeonClient branches', () => {
  let branches: NeonBranchState;
  const key = plaintext(NEON_KEY);

  beforeEach(() => {
    branches = installNeonBranches(fixture);
    client.awaitTimings = { budgetMs: 200, intervalMs: 5 };
  });

  it('findBranch exact-matches the name from a partial search', async () => {
    branches.branches.push(
      { default: false, id: 'br-a', name: 'forge-preview-p1-old', parent_id: 'br-main' },
      { default: false, id: 'br-b', name: 'forge-preview-p1', parent_id: 'br-main' },
    );

    await expect(client.findBranch(key, NEON_PROJECT, 'forge-preview-p1')).resolves.toEqual({
      id: 'br-b',
      name: 'forge-preview-p1',
    });
    expect(fixture.requests.at(-1)!.query.get('search')).toBe('forge-preview-p1');
    await expect(client.findBranch(key, NEON_PROJECT, 'forge-preview-p')).resolves.toBeUndefined();
  });

  it('createBranch sends the endpoint and awaits the operations', async () => {
    branches.createStatuses = ['running', 'running', 'finished'];

    await expect(
      client.createBranch(key, NEON_PROJECT, 'br-main', 'forge-preview-p1'),
    ).resolves.toEqual({ id: 'br-new-1', name: 'forge-preview-p1' });

    const post = fixture.requests.find((request) => request.method === 'POST')!;

    expect(post.body).toEqual({
      branch: { name: 'forge-preview-p1', parent_id: 'br-main' },
      endpoints: [{ type: 'read_write' }],
    });
    expect(fixture.requests.filter((request) => request.path.includes('/operations/')).length).toBe(
      3,
    );
  });

  it('423 is retryable', async () => {
    branches.next = { answer: { body: { message: 'locked' }, status: 423 }, method: 'POST' };

    await expect(
      client.createBranch(key, NEON_PROJECT, 'br-main', 'forge-preview-p1'),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('an operation failed → unavailable', async () => {
    branches.createStatuses = ['failed'];

    await expect(
      client.createBranch(key, NEON_PROJECT, 'br-main', 'forge-preview-p1'),
    ).rejects.toMatchObject({ category: 'unavailable' });
  });

  it('the budget exhausted → retryable', async () => {
    branches.createStatuses = ['running'];

    await expect(
      client.createBranch(key, NEON_PROJECT, 'br-main', 'forge-preview-p1'),
    ).rejects.toMatchObject({ category: 'unavailable', retryable: true });
  });

  it('deleteBranch 404 → success', async () => {
    await expect(client.deleteBranch(key, NEON_PROJECT, 'br-gone')).resolves.toBeUndefined();
  });

  it('deleteBranch deletes and awaits', async () => {
    branches.branches.push({ default: false, id: 'br-x', name: 'x', parent_id: 'br-main' });

    await client.deleteBranch(key, NEON_PROJECT, 'br-x');

    expect(branches.branches.map((branch) => branch.id)).toEqual(['br-main']);
    expect(fixture.requests.at(-1)!.path).toBe(
      `/projects/${NEON_PROJECT}/operations/op-delete-br-x`,
    );
  });

  it('connectionUri asks pooled=true', async () => {
    const uri = await client.connectionUri(key, NEON_PROJECT, 'br-x', 'app', 'owner');

    expect(uri).toContain('br-x-pooler');
    expect(Object.fromEntries(fixture.requests.at(-1)!.query)).toEqual({
      branch_id: 'br-x',
      database_name: 'app',
      pooled: 'true',
      role_name: 'owner',
    });
  });

  it('createBranch 403 → forbidden-scope', async () => {
    branches.next = { answer: { body: { message: 'forbidden' }, status: 403 }, method: 'POST' };

    await expect(
      client.createBranch(key, NEON_PROJECT, 'br-main', 'forge-preview-p1'),
    ).rejects.toMatchObject({ category: 'forbidden-scope', retryable: false });
  });

  it('listProjects lists each project with its branches, databases and roles', async () => {
    await expect(client.listProjects(key)).resolves.toEqual({
      items: [
        {
          branches: [{ default: true, id: 'br-main', name: 'main' }],
          databases: ['neondb'],
          id: 'proj-1',
          name: 'acme-db',
          roles: ['neondb_owner'],
        },
      ],
    });
  });
});
