import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  authorizePreviewResponseSchema,
  previewResponseSchema,
  rotatePreviewResponseSchema,
} from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { TenantContext } from '../../../database/tenant-context';
import type { AuditService } from '../../audit/audit.service';
import {
  AUTHENTICATED_USER,
  type AuthenticatedUser,
} from '../../identity/services/session.service';
import type { OutboxWriter } from '../../outbox/outbox-writer';
import {
  PermissionDeniedError,
  RequirePermissionGuard,
} from '../../rbac/guards/require-permission.guard';
import type { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { PROJECT_ROLE_PERMISSIONS, scoped } from '../../rbac/permissions';
import { ResourceOrgResolver } from '../../rbac/resource-org.resolver';
import type { TemplateCatalogue } from '../../sandbox/template-catalogue';
import type { ProjectService } from '../../tenancy/services/project.service';
import type { GrantService } from '../grant.service';
import { PreviewError } from '../preview.errors';
import { PreviewAuthorizeController, PreviewController } from './preview.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const LABEL = '8f14e45fceea167a5a36dedd4bea2543';

const config = new ConfigService({
  PREVIEW_DOMAIN: 'preview.example.test',
}) as unknown as ConfigService<Environment, true>;

const NEW_LABEL = 'c4ca4238a0b923820dcc509a6f75849b';
const NOW = new Date('2026-09-18T10:00:00.000Z');
const caller = { userId: '33333333-3333-4333-8333-333333333333' } as AuthenticatedUser;

/** A settled sandbox whose dev server last reported `state` on `port`. */
const reported = (port: number, state: string) => ({
  lostAt: null,
  ports: { [port]: { observedAt: NOW.toISOString(), state } },
  state: 'active',
  transition: null,
  workspaceRoot: '/home/daytona/workspace',
});

function build(
  row: Record<string, unknown> | undefined,
  devPort?: string,
  cfg = config,
  sandbox: Record<string, unknown> | undefined = undefined,
) {
  const findFirst = vi.fn().mockResolvedValue(row);
  const get = vi.fn().mockReturnValue({ manifest: { devPort } });
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const sandboxes = { findFirst: vi.fn().mockResolvedValue(sandbox) };
  const tx = {
    query: { projects: { findFirst }, sandboxes },
    // Spec 047: a template-less project asks whether an import is still open; none is.
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    update: vi.fn().mockReturnValue({ set }),
  };
  const rotatePreviewLabel = vi.fn().mockResolvedValue({ label: NEW_LABEL, previousLabel: LABEL });
  const record = vi.fn().mockResolvedValue(undefined);
  const append = vi.fn().mockResolvedValue(undefined);
  const controller = new PreviewController(
    { tx } as unknown as TenantContext,
    { get } as unknown as TemplateCatalogue,
    { rotatePreviewLabel } as unknown as ProjectService,
    { record } as unknown as AuditService,
    { append } as unknown as OutboxWriter,
    { now: () => NOW },
    cfg,
  );
  return { append, controller, findFirst, get, record, rotatePreviewLabel, sandboxes, set, tx };
}

describe('PreviewController', () => {
  it('reads the row on the request transaction and answers the url from the label and devPort', async () => {
    const { controller, findFirst, get, sandboxes } = build(
      { previewLabel: LABEL, previewVisibility: 'org', template: 'vite-react' },
      '5173',
      config,
      reported(5173, 'listening'),
    );

    const body = await controller.read(ORG, PROJECT);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(sandboxes.findFirst).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('vite-react');
    expect(previewResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      port: 5173,
      stage: 'ready',
      url: `https://${LABEL}-5173.preview.example.test`,
      visibility: 'org',
    });
  });

  it('answers the stage from the sandbox row and the dev server report, so the url exists before it serves', async () => {
    const project = { previewLabel: LABEL, previewVisibility: 'org', template: 'vite-react' };
    const stageOf = async (sandbox: Record<string, unknown> | undefined) =>
      (await build(project, '3000', config, sandbox).controller.read(ORG, PROJECT)).stage;

    expect(await stageOf(undefined)).toBe('no-sandbox');
    expect(await stageOf({ ...reported(3000, 'listening'), transition: 'creating' })).toBe(
      'creating',
    );
    expect(await stageOf({ ...reported(3000, 'starting') })).toBe('starting');
    expect(await stageOf({ ...reported(3000, 'failed') })).toBe('failed');
    expect(await stageOf({ ...reported(3000, 'listening'), state: 'hibernated' })).toBe('asleep');
    expect(await stageOf(reported(3000, 'listening'))).toBe('ready');
  });

  it('answers the local gateway over plain HTTP on its port when PREVIEW_GATEWAY_PORT is set', async () => {
    const local = new ConfigService({
      PREVIEW_DOMAIN: 'forge-preview.localhost',
      PREVIEW_GATEWAY_PORT: 3200,
    }) as unknown as ConfigService<Environment, true>;
    const { controller } = build(
      { previewLabel: LABEL, previewVisibility: 'public', template: 'vite-react' },
      '3000',
      local,
    );

    await expect(controller.read(ORG, PROJECT)).resolves.toEqual({
      port: 3000,
      stage: 'no-sandbox',
      url: `http://${LABEL}-3000.forge-preview.localhost:3200`,
      visibility: 'public',
    });
  });

  it('answers port null, an empty url and no-sandbox when the template declares no devPort', async () => {
    const { controller } = build(
      { previewLabel: LABEL, previewVisibility: 'private', template: 'vite-react' },
      undefined,
      config,
      reported(3000, 'listening'),
    );

    const body = await controller.read(ORG, PROJECT);

    expect(previewResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({ port: null, stage: 'no-sandbox', url: '', visibility: 'private' });
  });

  it('treats a project without a template as one without a port', async () => {
    const { controller, get } = build({
      previewLabel: LABEL,
      previewVisibility: 'public',
      template: null,
    });

    await expect(controller.read(ORG, PROJECT)).resolves.toEqual({
      port: null,
      stage: 'no-sandbox',
      url: '',
      visibility: 'public',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('is a not-found when the row is missing from this tenant', async () => {
    const { controller } = build(undefined);

    await expect(controller.read(ORG, PROJECT)).rejects.toBeInstanceOf(PreviewError);
    await expect(controller.read(ORG, PROJECT)).rejects.toMatchObject({
      kind: 'project-not-found',
      status: 404,
    });
  });
});

describe('PreviewController.rotate', () => {
  it('rotates through ProjectService, then audits and enqueues the event on the same handle (FR-040)', async () => {
    const { append, controller, record, rotatePreviewLabel, sandboxes, tx } = build(
      { previewLabel: LABEL, previewVisibility: 'org', template: 'vite-react' },
      '5173',
    );

    const body = await controller.rotate(caller, ORG, PROJECT);

    // The rotate answer carries no stage, so it costs no sandbox read.
    expect(sandboxes.findFirst).not.toHaveBeenCalled();
    expect(rotatePreviewLabel).toHaveBeenCalledWith({ orgId: ORG, projectId: PROJECT }, tx);
    expect(record).toHaveBeenCalledWith(tx, {
      action: 'preview.label-rotated',
      actorId: caller.userId,
      metadata: {},
      orgId: ORG,
      target: PROJECT,
    });
    expect(append).toHaveBeenCalledWith(tx, {
      aggregateId: PROJECT,
      orgId: ORG,
      payload: { orgId: ORG, previousLabel: LABEL, projectId: PROJECT },
      type: 'project.preview-label.rotated',
    });
    expect(rotatePreviewResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      port: 5173,
      status: 'preview-label-rotated',
      url: `https://${NEW_LABEL}-5173.preview.example.test`,
    });
  });

  it('is a not-found before anything is rotated when the row is missing', async () => {
    const { controller, rotatePreviewLabel } = build(undefined);

    await expect(controller.rotate(caller, ORG, PROJECT)).rejects.toMatchObject({
      kind: 'project-not-found',
    });
    expect(rotatePreviewLabel).not.toHaveBeenCalled();
  });
});

describe('PreviewController.setVisibility', () => {
  it('updates the row and audits from → to on the request transaction', async () => {
    const { append, controller, record, set, tx } = build(
      { previewLabel: LABEL, previewVisibility: 'private', template: 'vite-react' },
      '5173',
      config,
      reported(5173, 'starting'),
    );

    const body = await controller.setVisibility(caller, ORG, PROJECT, { visibility: 'public' });

    expect(set).toHaveBeenCalledWith({ previewVisibility: 'public', updatedAt: NOW });
    expect(record).toHaveBeenCalledWith(tx, {
      action: 'preview.visibility-changed',
      actorId: caller.userId,
      metadata: { from: 'private', to: 'public' },
      orgId: ORG,
      target: PROJECT,
    });
    expect(append).not.toHaveBeenCalled();
    expect(previewResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      port: 5173,
      stage: 'starting',
      url: `https://${LABEL}-5173.preview.example.test`,
      visibility: 'public',
    });
  });

  it('writes nothing when the visibility is already the one asked for', async () => {
    const { controller, record, tx } = build({
      previewLabel: LABEL,
      previewVisibility: 'org',
      template: null,
    });

    await expect(
      controller.setVisibility(caller, ORG, PROJECT, { visibility: 'org' }),
    ).resolves.toEqual({ port: null, stage: 'no-sandbox', url: '', visibility: 'org' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

/**
 * Spec 017 US3: rotation and visibility are the owner's alone. Proved through the real guard over
 * the real controller metadata and the real role table, with an editor's resolved set: the guard
 * refuses before the handler runs, so the label and visibility stay what they were.
 */
describe('PreviewController owner-only routes', () => {
  function attempt(role: keyof typeof PROJECT_ROLE_PERMISSIONS, handler: object) {
    const held = new Set(PROJECT_ROLE_PERMISSIONS[role].map((p) => scoped(p, PROJECT)));
    const reflector = new Reflector();
    const guard = new RequirePermissionGuard(reflector, new ResourceOrgResolver(reflector), {
      for: () => Promise.resolve(held),
    } as unknown as PermissionResolutionService);
    const context = {
      getClass: () => PreviewController,
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({
          params: { orgId: ORG, projectId: PROJECT },
          [AUTHENTICATED_USER]: caller,
        }),
      }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  }

  // Handlers as metadata carriers only — never called — hence the `object` read, not the method.
  const handlers = ['rotate', 'setVisibility'].map(
    (name) => [name, Reflect.get(PreviewController.prototype, name) as object] as const,
  );

  it.each(handlers)('refuses an editor’s %s', async (_name, handler) => {
    const { rotatePreviewLabel, tx } = build({
      previewLabel: LABEL,
      previewVisibility: 'org',
      template: 'vite-react',
    });

    await expect(attempt('editor', handler)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(rotatePreviewLabel).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each(handlers)('admits the owner’s %s', async (_name, handler) => {
    await expect(attempt('owner', handler)).resolves.toBe(true);
  });
});

describe('PreviewAuthorizeController', () => {
  const HOST = `${LABEL}-5173.preview.example.test`;

  function authorize(code: string | undefined) {
    const issueCode = vi.fn().mockResolvedValue(code);
    const controller = new PreviewAuthorizeController({ issueCode } as unknown as GrantService);
    return { controller, issueCode };
  }

  it('issues a code for the caller and answers the preview url that redeems it', async () => {
    const { controller, issueCode } = authorize('abc.def');

    const body = await controller.authorize(caller, { label: LABEL, returnHost: HOST });

    expect(issueCode).toHaveBeenCalledWith({
      label: LABEL,
      returnHost: HOST,
      userId: caller.userId,
    });
    expect(authorizePreviewResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({ url: `https://${HOST}/?code=abc.def` });
  });

  it('keeps an explicit port on the return authority, over plain http, for the local gateway', async () => {
    const { controller } = authorize('abc.def');

    await expect(
      controller.authorize(caller, { label: LABEL, returnHost: `${HOST}:3200` }),
    ).resolves.toEqual({ url: `http://${HOST}:3200/?code=abc.def` });
  });

  it('refuses an authority that is not exactly a preview host, before issuing anything', async () => {
    const { controller, issueCode } = authorize('abc.def');

    for (const returnHost of [
      `${HOST}:80@evil.com`,
      `${HOST}:abc`,
      `${HOST}/path`,
      `evil.com#${HOST}`,
      `${HOST}:3200:1`,
    ]) {
      await expect(
        controller.authorize(caller, { label: LABEL, returnHost }),
      ).rejects.toMatchObject({ kind: 'project-not-found' });
    }
    expect(issueCode).not.toHaveBeenCalled();
  });

  it('answers one not-found for every refusal, so a non-member learns nothing an unknown label would not', async () => {
    const { controller } = authorize(undefined);

    const refusal = controller.authorize(caller, { label: LABEL, returnHost: HOST });

    await expect(refusal).rejects.toBeInstanceOf(PreviewError);
    await expect(refusal).rejects.toMatchObject({ kind: 'project-not-found' });
  });
});
