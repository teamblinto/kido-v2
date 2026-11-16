import type { OutboxWriter } from '../../outbox/outbox-writer';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../../common/errors/domain-error';
import type { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { AuditService } from '../../audit/audit.service';
import { IS_PUBLIC } from '../../identity/decorators/public.decorator';
import type { TemplateCatalogue } from '../../sandbox/template-catalogue';
import { SANDBOX_CALLBACK, SandboxCallbackGuard } from '../sandbox-callback.guard';
import type { SandboxCallbackClaims } from '../sandbox-callback.token';
import { SandboxCallbackController } from './sandbox-callback.controller';

const CLAIMS: SandboxCallbackClaims = {
  aud: 'forge-sandbox-callback',
  leaseEpoch: 0,
  org: '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11',
  project: '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21',
  sandbox: 'dtn-sandbox-1',
};
const NOW = new Date('2026-09-17T10:31:02.441Z');

/**
 * A tenant transaction whose `update … set … where` is recorded, so the write's shape is
 * observable, and whose `select` answers the calling project's template row. `devPort` is what the
 * catalogue declares for that template — `undefined` for a template that declares no dev server.
 */
function build(
  {
    devPort,
    runConfig = null,
    template,
  }: { devPort?: string; runConfig?: unknown; template?: string | null } = {
    devPort: '5173',
    template: 'vite-react',
  },
) {
  const appended: { payload: unknown; type: string }[] = [];
  const opened: string[] = [];
  const updates: { set: unknown; where: unknown }[] = [];
  const record = vi.fn((_tx: unknown, _entry: unknown) => Promise.resolve());
  const get = vi.fn().mockReturnValue({ manifest: { devPort } });
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(template === undefined ? [] : [{ runConfig, template }]),
        }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: (predicate: unknown) => {
          updates.push({ set: values, where: predicate });
          return Promise.resolve();
        },
      }),
    }),
  };
  const transactions = {
    runInTenantTransaction: (orgId: string, fn: (t: typeof tx) => Promise<unknown>) => {
      opened.push(orgId);
      return fn(tx);
    },
  } as unknown as TenantTransactionRunner;
  const controller = new SandboxCallbackController(
    transactions,
    { record } as unknown as AuditService,
    { now: () => NOW },
    { get } as unknown as TemplateCatalogue,
    {
      append: (_tx: unknown, entry: { payload: unknown; type: string }) => {
        appended.push({ payload: entry.payload, type: entry.type });
        return Promise.resolve();
      },
    } as unknown as OutboxWriter,
  );
  const request: Record<PropertyKey, unknown> = { [SANDBOX_CALLBACK]: CLAIMS };
  return { appended, controller, get, opened, record, request, updates };
}

/** The bound SQL of a drizzle `sql` chunk, flattened: enough to see the merge and its operand. */
function flatten(chunk: unknown): string {
  const parts = (chunk as { queryChunks?: unknown[] }).queryChunks ?? [chunk];
  return parts
    .map((part) =>
      typeof part === 'object' && part !== null && 'value' in part
        ? ([] as unknown[]).concat(part.value).join('')
        : typeof part === 'object' && part !== null && 'queryChunks' in part
          ? flatten(part)
          : typeof part === 'string'
            ? part
            : '',
    )
    .join('');
}

describe('SandboxCallbackController', () => {
  it('is the one public route under internal/, admitted by the module-scoped guard alone', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SandboxCallbackController)).toBe(
      'internal/sandbox-callbacks',
    );
    expect(Reflect.getMetadata(IS_PUBLIC, SandboxCallbackController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, SandboxCallbackController)).toEqual([
      SandboxCallbackGuard,
    ]);
  });

  it('preview.status merges the observed port into the claims-named row under the claims-named org', async () => {
    const { controller, opened, record, request, updates } = build();

    await controller.receive(request, { action: 'preview.status', port: 5173, state: 'listening' });

    expect(opened).toEqual([CLAIMS.org]);
    expect(record).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    const merged = flatten((updates[0]!.set as { ports: unknown }).ports);
    expect(merged).toContain(' || ');
    expect(merged).toContain(
      JSON.stringify({ 5173: { observedAt: NOW.toISOString(), state: 'listening' } }),
    );
    // The row is the caller's own: org, project and Daytona id from the verified claims.
    expect(flatten(updates[0]!.where)).toContain(CLAIMS.sandbox);
    expect(flatten(updates[0]!.where)).toContain(CLAIMS.project);
  });

  it.each([
    ['an action outside the declared set', { action: 'preview.stop', port: 5173 }],
    [
      'a body naming another project',
      { action: 'preview.status', port: 5173, project: 'other', state: 'listening' },
    ],
    [
      'a port below the unprivileged range',
      { action: 'preview.status', port: 80, state: 'listening' },
    ],
  ])('refuses %s with the guard’s one message, audits it, and writes nothing', async (_, body) => {
    const { controller, opened, record, request, updates } = build();

    await expect(controller.receive(request, body)).rejects.toBeInstanceOf(ForbiddenError);

    expect(updates).toEqual([]);
    expect(opened).toEqual([CLAIMS.org]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![1]).toEqual({
      action: 'sandbox-callback.refused',
      actorId: null,
      metadata: { because: 'unknown-action', sandbox: CLAIMS.sandbox },
      orgId: CLAIMS.org,
      target: CLAIMS.project,
    });
  });

  it.each([
    ['a port the template did not declare', { devPort: '5173', template: 'vite-react' }, 8080],
    ['any port, when the template declares none', { template: 'python' }, 5173],
  ])(
    'refuses %s with the same uniform message, audits it as undeclared-port, and leaves ports untouched',
    async (_, project, port) => {
      const { controller, get, opened, record, request, updates } = build(project);

      await expect(
        controller.receive(request, { action: 'preview.status', port, state: 'listening' }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // FR-016: the map is unchanged — the refusal happens before the merge, not after it.
      expect(updates).toEqual([]);
      expect(get).toHaveBeenCalledWith(project.template);
      expect(opened).toEqual([CLAIMS.org]);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![1]).toEqual({
        action: 'sandbox-callback.refused',
        actorId: null,
        metadata: { because: 'undeclared-port', sandbox: CLAIMS.sandbox },
        orgId: CLAIMS.org,
        target: CLAIMS.project,
      });
    },
  );
  describe('self-healing (spec 047)', () => {
    const profile = (repairs: number) => ({
      build: null,
      dev: 'corepack pnpm run dev',
      env: [],
      install: 'corepack pnpm install',
      port: 3000,
      repairs,
      root: '.',
      source: 'detected',
      stack: { framework: 'nextjs', language: 'typescript', packageManager: 'pnpm' },
    });

    it('a failed report from a run profile asks for repair 1 and counts it on the profile', async () => {
      const { appended, controller, request, updates } = build({
        runConfig: profile(0),
        template: null,
      });

      await controller.receive(request, { action: 'preview.status', port: 3000, state: 'failed' });

      expect(appended).toEqual([
        {
          payload: { attempt: 1, orgId: CLAIMS.org, projectId: CLAIMS.project },
          type: 'project.preview.failed',
        },
      ]);
      expect(updates.map(({ set }) => set)).toContainEqual({ runConfig: profile(1) });
    });

    it('stops asking once the streak has spent its repairs', async () => {
      const { appended, controller, request, updates } = build({
        runConfig: profile(2),
        template: null,
      });

      await controller.receive(request, { action: 'preview.status', port: 3000, state: 'failed' });

      expect(appended).toEqual([]);
      // Only the report itself is written.
      expect(updates).toHaveLength(1);
    });

    it('listening ends the streak and hands the repairs back, asking for nothing', async () => {
      const { appended, controller, request, updates } = build({
        runConfig: profile(1),
        template: null,
      });

      await controller.receive(request, {
        action: 'preview.status',
        port: 3000,
        state: 'listening',
      });

      expect(appended).toEqual([]);
      expect(updates.map(({ set }) => set)).toContainEqual({ runConfig: profile(0) });
    });

    it('installing is a report like any other, on the profile port', async () => {
      const { appended, controller, request, updates } = build({
        runConfig: profile(0),
        template: null,
      });

      await controller.receive(request, {
        action: 'preview.status',
        port: 3000,
        state: 'installing',
      });

      expect(appended).toEqual([]);
      expect(flatten((updates[0]!.set as { ports: unknown }).ports)).toContain(
        '"state":"installing"',
      );
    });

    it('a template project that fails is left exactly as before: no repair is asked for', async () => {
      const { appended, controller, request, updates } = build();

      await controller.receive(request, { action: 'preview.status', port: 5173, state: 'failed' });

      expect(appended).toEqual([]);
      expect(updates).toHaveLength(1);
    });

    it('a profile port is the only port a profile project may report on', async () => {
      const { controller, request } = build({ runConfig: profile(0), template: null });

      await expect(
        controller.receive(request, { action: 'preview.status', port: 5173, state: 'failed' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
