import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Plaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import type { NeonProjectPage } from '@repo/contracts';
import type { z } from 'zod';

import {
  failureFromStatus,
  ProviderFailure,
  type ProviderVerifier,
  retryAfterHeader,
  type VerifyResult,
  verifyFailure,
} from '../provider';
import { endpoint, type ProviderRequest, providerJson } from '../provider-request';
import {
  neonBranchesSchema,
  neonBranchMutationSchema,
  neonConnectionUriSchema,
  neonDatabasesSchema,
  neonOperationSchema,
  neonProjectsSchema,
  neonRolesSchema,
} from './neon.schemas';

export const NEON_CLIENT = Symbol('forge.connectors.neonClient');

/** R6: listing proves `projects:read`; branch writes are implied by the key type, checked at use. */
const NEON_SCOPES = ['projects:read', 'branches:write'] as const;

/** R9: an operation still running after the budget is retried by the job, never waited on longer. */
export interface NeonAwaitTimings {
  readonly budgetMs: number;
  readonly intervalMs: number;
}

const DONE = new Set(['finished', 'skipped']);
const BROKEN = new Set(['failed', 'error', 'cancelled', 'cancelling']);

export interface NeonBranch {
  readonly id: string;
  readonly name: string;
}

/** Neon's API (contracts/provider-adapters.md § 3): `verify`, and the preview branch (R9). */
@Injectable()
export class NeonClient implements ProviderVerifier {
  private readonly baseUrl: string;

  /** Poll every second for up to a minute (contracts § 3); a suite shortens both. */
  awaitTimings: NeonAwaitTimings = { budgetMs: 60_000, intervalMs: 1_000 };

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.baseUrl = config.get('NEON_API_URL', { infer: true });
  }

  async verify(key: Plaintext): Promise<VerifyResult> {
    try {
      const { projects } = await providerJson(
        endpoint(this.baseUrl, '/projects?limit=1'),
        key,
        neonProjectsSchema,
      );
      const project = projects[0];

      if (project === undefined) return { kind: 'missing-scope', missing: ['projects:read'] };

      return {
        accountName: project.name,
        // An org key names its organisation; a project-scoped key only its project (ask-first 4).
        accountRef: project.org_id ?? project.id,
        kind: 'verified',
        scopes: [...NEON_SCOPES],
      };
    } catch (error) {
      return verifyFailure(error, ['projects:read']);
    }
  }

  /** The bind form's list: each project with its default branch's databases and roles. */
  async listProjects(key: Plaintext, query?: string): Promise<NeonProjectPage> {
    const search =
      query === undefined || query === '' ? '' : `?search=${encodeURIComponent(query)}`;
    const { projects } = await this.call(`/projects${search}`, key, neonProjectsSchema);
    const items: NeonProjectPage['items'] = [];

    for (const project of projects) {
      const id = encodeURIComponent(project.id);
      const { branches } = await this.call(`/projects/${id}/branches`, key, neonBranchesSchema);
      const main = branches.find((row) => row.default === true) ?? branches[0];
      const [databases, roles] =
        main === undefined
          ? [[], []]
          : await Promise.all([
              this.call(
                `/projects/${id}/branches/${encodeURIComponent(main.id)}/databases`,
                key,
                neonDatabasesSchema,
              ).then((body) => body.databases.map((row) => row.name)),
              this.call(
                `/projects/${id}/branches/${encodeURIComponent(main.id)}/roles`,
                key,
                neonRolesSchema,
              ).then((body) => body.roles.map((row) => row.name)),
            ]);

      items.push({
        branches: branches.map((row) => ({
          default: row.default === true,
          id: row.id,
          name: row.name === '' ? row.id : row.name,
        })),
        databases,
        id: project.id,
        name: project.name === '' ? project.id : project.name,
        roles,
      });
    }

    return { items };
  }

  /** `search` is a substring match; only the exact name is ours (R9's adoption). */
  async findBranch(
    key: Plaintext,
    projectId: string,
    name: string,
  ): Promise<NeonBranch | undefined> {
    const { branches } = await this.call(
      `/projects/${encodeURIComponent(projectId)}/branches?search=${encodeURIComponent(name)}`,
      key,
      neonBranchesSchema,
    );
    const found = branches.find((row) => row.name === name);

    return found === undefined ? undefined : { id: found.id, name: found.name };
  }

  async createBranch(
    key: Plaintext,
    projectId: string,
    parentId: string,
    name: string,
  ): Promise<NeonBranch> {
    const created = await this.call(
      `/projects/${encodeURIComponent(projectId)}/branches`,
      key,
      neonBranchMutationSchema,
      {
        body: { branch: { name, parent_id: parentId }, endpoints: [{ type: 'read_write' }] },
        method: 'POST',
      },
    );

    await this.awaitOperations(
      key,
      projectId,
      created.operations.map((row) => row.id),
    );

    return { id: created.branch.id, name: created.branch.name };
  }

  /** A `404` is success: the branch is already gone. */
  async deleteBranch(key: Plaintext, projectId: string, branchId: string): Promise<void> {
    let deleted: z.output<typeof neonBranchMutationSchema>;

    try {
      deleted = await this.call(
        `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
        key,
        neonBranchMutationSchema,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof ProviderFailure && error.category === 'not-found') return;
      throw error;
    }

    await this.awaitOperations(
      key,
      projectId,
      deleted.operations.map((row) => row.id),
    );
  }

  /** The pooled URI, for a serverless dev server (research R9). */
  async connectionUri(
    key: Plaintext,
    projectId: string,
    branchId: string,
    databaseName: string,
    roleName: string,
  ): Promise<string> {
    const query = new URLSearchParams({
      branch_id: branchId,
      database_name: databaseName,
      pooled: 'true',
      role_name: roleName,
    });
    const { uri } = await this.call(
      `/projects/${encodeURIComponent(projectId)}/connection_uri?${query.toString()}`,
      key,
      neonConnectionUriSchema,
    );

    return uri;
  }

  /** Poll until every operation is `finished`/`skipped`; a broken one or the budget → `unavailable`. */
  async awaitOperations(
    key: Plaintext,
    projectId: string,
    operations: readonly string[],
  ): Promise<void> {
    const deadline = Date.now() + this.awaitTimings.budgetMs;

    for (const operationId of operations) {
      for (;;) {
        const { operation } = await this.call(
          `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`,
          key,
          neonOperationSchema,
        );

        if (DONE.has(operation.status)) break;
        if (BROKEN.has(operation.status))
          throw new ProviderFailure('unavailable', undefined, false);
        if (Date.now() >= deadline) throw new ProviderFailure('unavailable');

        await new Promise((resolve) => setTimeout(resolve, this.awaitTimings.intervalMs));
      }
    }
  }

  /** R5: Neon's `423 Locked` (another operation on the project) is retried. */
  private call<T>(
    path: string,
    key: Plaintext,
    schema: z.ZodType<T>,
    request?: ProviderRequest,
  ): Promise<T> {
    return providerJson(endpoint(this.baseUrl, path), key, schema, request, {
      classify: (response) =>
        response.status === 423
          ? new ProviderFailure('conflict', retryAfterHeader(response.headers), true)
          : failureFromStatus(response.status, retryAfterHeader(response.headers)),
    });
  }
}
