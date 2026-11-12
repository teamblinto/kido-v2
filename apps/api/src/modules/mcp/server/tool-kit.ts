import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  type McpServer,
  requireScopes,
  type ServerContext,
  type ToolCallback,
} from '@modelcontextprotocol/server';
import type { McpScope, ProblemTypeSlug } from '@repo/contracts';
import type { z } from 'zod';

import { DomainError } from '../../../common/errors/domain-error';
import { PROBLEM_TYPES } from '../../../common/errors/problem-types';
import type { TenantTransaction } from '../../../database/database.types';
import { PermissionDeniedError } from '../../rbac/guards/require-permission.guard';
import { type OrgPermission, type ProjectPermission, scoped } from '../../rbac/permissions';
import type { McpPrincipal } from '../oauth/mcp-oauth.service';
import type { McpPlatform } from './mcp-platform';

/** What a tool may tell the client about itself (MCP tool annotations; hints, never trusted). */
export interface ToolHints {
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  /** Reaches a third party (GitHub, Netlify, Supabase, Neon) beyond this platform. */
  readonly openWorld?: boolean;
}

export interface ToolSpec<Input extends z.ZodObject> extends ToolHints {
  readonly description: string;
  readonly input: Input;
  /** The OAuth scope the token must carry. `projects:read` tools are marked read-only. */
  readonly scope: McpScope;
  readonly title: string;
}

/** `{ orgId, projectId }`, the reference every project-scoped service takes. */
export interface ProjectRef {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * A refusal the agent can act on: what went wrong and what to do next. Thrown from a tool, it
 * becomes an `isError` result the model reads — never a protocol error, which a client would show
 * to the person as a failure of the connection.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly type = 'tool-refused',
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Longest a tool waits on a run or a deployment in one call; clients time out near a minute. */
export const MAX_WAIT_SECONDS = 50;

/** The next step for the failure classes an agent can do something about. */
const HINTS: Partial<Record<ProblemTypeSlug, string>> = {
  conflict: 'The project is busy or changed underneath you: read its current state and retry.',
  'not-found': 'Check the id: list the parent resource to find a current one.',
  'permission-denied':
    'Your role in this project or organization does not allow this. Ask an owner for access.',
  'rate-limited': 'Wait a little and retry.',
  'service-unavailable': 'A dependency is unavailable. Wait a few seconds and retry.',
  // Checked before `conflict`, which it refines: retrying cannot help, only the person can.
  'subscription-not-connected':
    'Stop and tell the person: they need to connect their Claude subscription or add an organization API key in the web app (Settings), then you can start the run again.',
  'validation-failed': 'Fix the input named in the message and call the tool again.',
};

/**
 * Registers the tools of one MCP server instance for one verified principal (spec 046). Each tool
 * runs the same three checks the HTTP routes do, in the same order of independence: the token's
 * scope (the SDK's `requireScopes`, answered as an RFC 6750 `insufficient_scope` challenge), the
 * person's RBAC permission resolved afresh for this call, and RLS under the tenant transaction.
 */
export class McpToolKit {
  private readonly logger = new Logger('McpTools');

  constructor(
    readonly server: McpServer,
    readonly principal: McpPrincipal,
    readonly platform: McpPlatform,
  ) {}

  tool<Input extends z.ZodObject>(
    name: string,
    spec: ToolSpec<Input>,
    handler: (args: z.output<Input>, call: ToolCall) => Promise<object>,
  ): void {
    const readOnly = spec.scope === 'projects:read';

    this.server.registerTool(
      name,
      {
        annotations: {
          destructiveHint: !readOnly && spec.destructive === true,
          idempotentHint: readOnly || spec.idempotent === true,
          openWorldHint: spec.openWorld === true,
          readOnlyHint: readOnly,
          title: spec.title,
        },
        description: spec.description,
        inputSchema: spec.input,
        scopeChallenge: requireScopes(spec.scope),
        title: spec.title,
      },
      // The SDK infers the callback's argument type from `Input` through Standard Schema, which a
      // still-generic `Input` cannot resolve; the schema itself has already parsed `args`.
      (async (args: unknown, ctx: ServerContext) => {
        const started = Date.now();
        const call = new ToolCall(this, ctx, name);

        try {
          const result = await handler(args as z.output<Input>, call);
          this.audit(name, 'ok', started);

          return {
            content: [{ text: JSON.stringify(result, null, 2), type: 'text' as const }],
            structuredContent: result,
          };
        } catch (error) {
          const failure = this.describe(error);
          this.audit(name, failure.type, started);

          return {
            content: [{ text: failure.text, type: 'text' as const }],
            isError: true,
            structuredContent: { error: failure },
          };
        }
      }) as ToolCallback<Input>,
    );
  }

  /**
   * One line per call, in the API's own log stream: which grant did what, and how it ended. The
   * mutations themselves are audited by the services that perform them, in their transactions,
   * with the person as the actor — the same rows the web app's actions write.
   */
  private audit(tool: string, outcome: string, started: number): void {
    const { clientId, grantId, orgId, userId } = this.principal;

    this.logger.log({
      clientId,
      durationMs: Date.now() - started,
      grantId,
      msg: 'mcp tool call',
      orgId,
      outcome,
      tool,
      userId,
    });
  }

  private describe(error: unknown): { hint?: string; text: string; type: string } {
    if (error instanceof ToolError) {
      return {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        text: error.hint === undefined ? error.message : `${error.message}\n\n${error.hint}`,
        type: error.type,
      };
    }

    if (error instanceof DomainError) {
      const problem = PROBLEM_TYPES[error.type];
      const hint = HINTS[error.type] ?? ('refines' in problem ? HINTS[problem.refines] : undefined);
      const text = `${problem.title}: ${error.detail}`;

      return {
        ...(hint === undefined ? {} : { hint }),
        text: hint === undefined ? text : `${text}\n\n${hint}`,
        type: error.type,
      };
    }

    this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));

    return {
      hint: 'This is a platform error, not a problem with your input. Retry once; if it persists, stop and tell the person.',
      text: 'The platform failed to complete this tool call.',
      type: 'internal-server-error',
    };
  }
}

/** One invocation of one tool: the caller's checks, tenant work, progress and idempotency. */
export class ToolCall {
  constructor(
    private readonly kit: McpToolKit,
    private readonly ctx: ServerContext,
    private readonly tool: string,
  ) {}

  get principal(): McpPrincipal {
    return this.kit.principal;
  }

  get platform(): McpPlatform {
    return this.kit.platform;
  }

  get signal(): AbortSignal {
    return this.ctx.mcpReq.signal;
  }

  /**
   * Run `fn` in the project's tenant transaction, after checking the person holds `permission` on
   * this project right now. A project outside the grant's organisation fails the same check: the
   * resolved set only names this organisation's projects.
   */
  async inProject<T>(
    projectId: string,
    permission: ProjectPermission,
    fn: (tx: TenantTransaction, ref: ProjectRef) => Promise<T>,
  ): Promise<T> {
    await this.requireProject(projectId, permission);
    const { orgId, userId } = this.principal;

    return this.platform.transactions.runInTenantScope({ orgId, userId }, (tx) =>
      fn(tx, { orgId, projectId }),
    );
  }

  /** The permission check alone, for a service that opens its own transaction. */
  async requireProject(projectId: string, permission: ProjectPermission): Promise<void> {
    const { orgId, userId } = this.principal;
    const held = await this.platform.permissions.for(orgId, userId);

    if (!held.has(scoped(permission, projectId))) throw new PermissionDeniedError();
  }

  /** Org-level work in the grant's organisation; `null` asks only that the person belong to it. */
  async inOrg<T>(
    permission: OrgPermission | null,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const { orgId, userId } = this.principal;
    const held = await this.platform.permissions.for(orgId, userId);

    if (permission === null ? held.size === 0 : !held.has(permission)) {
      throw new PermissionDeniedError();
    }

    return this.platform.transactions.runInTenantScope({ orgId, userId }, fn);
  }

  /** Whether the person holds an org permission, without failing (for listing what they may do). */
  async holds(permission: OrgPermission): Promise<boolean> {
    const { orgId, userId } = this.principal;

    return (await this.platform.permissions.for(orgId, userId)).has(permission);
  }

  /** `notifications/progress`, when the client asked for it with a progress token. */
  async progress(progress: number, message: string, total?: number): Promise<void> {
    const token = this.ctx.mcpReq._meta?.progressToken;

    if (token === undefined) return;

    await this.ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: {
          message,
          progress,
          progressToken: token,
          ...(total === undefined ? {} : { total }),
        },
      })
      .catch(() => undefined);
  }

  /**
   * Poll `check` until it returns a value or `seconds` pass, reporting progress on the way. A
   * client that cancels the call (closes the stream) stops the wait; the work itself carries on,
   * and the agent reads it later. `undefined` means still running.
   */
  async waitFor<T>(
    seconds: number,
    check: (
      elapsedSeconds: number,
    ) => Promise<{ done: true; value: T } | { done: false; note: string }>,
  ): Promise<T | undefined> {
    const deadline = Date.now() + Math.min(seconds, MAX_WAIT_SECONDS) * 1_000;
    const started = Date.now();
    let step = 0;

    for (;;) {
      const outcome = await check(Math.round((Date.now() - started) / 1_000));

      if (outcome.done) return outcome.value;
      if (Date.now() >= deadline || this.signal.aborted) return undefined;

      await this.progress(++step, outcome.note);
      await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())), this.signal);
    }
  }

  /**
   * Run a mutation at most once per `key` (the `IdempotencyStore` the HTTP routes use, namespaced
   * to this person and this tool): a retried call with the same key and arguments gets the first
   * call's result instead of a second deployment or a second run.
   */
  async once<T extends object>(
    key: string | undefined,
    args: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined) return fn();

    const store = this.platform.idempotency;
    const slot = {
      fingerprint: createHash('sha256')
        .update(`${this.tool}\n${JSON.stringify(args)}`)
        .digest('hex'),
      key,
      namespace: `mcp.${this.principal.userId}`,
    };
    const begun = await store.begin(slot);

    if (begun.outcome === 'replay') return begun.record.body as T;
    if (begun.outcome === 'mismatch') {
      throw new ToolError(
        'This idempotencyKey was already used with different arguments.',
        'Use a fresh idempotencyKey for a new request.',
        'idempotency-key-reused',
      );
    }
    if (begun.outcome === 'in-flight') {
      throw new ToolError(
        'A call with this idempotencyKey is still running.',
        'Wait a few seconds and retry with the same key to get its result.',
        'idempotency-key-in-flight',
      );
    }

    try {
      const result = await fn();
      await store.complete(begun.lease, { body: result, status: 200 });

      return result;
    } catch (error) {
      await store.release(begun.lease);
      throw error;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
