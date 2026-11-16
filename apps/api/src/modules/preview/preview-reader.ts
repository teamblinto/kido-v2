import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PreviewResponse } from '@repo/contracts';
import { projects, sandboxes, syncOperations } from '@repo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { parseRunConfig, type ProjectRunSource, resolveDevPort } from '../sandbox/run-config';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import { PreviewError } from './preview.errors';
import { previewStage } from './preview-stage';

/**
 * A project's preview as its readers see it (spec 017 US1): where it is served, the port, who may
 * reach it and its start-up stage. Moved out of `PreviewController` (spec 046) so the MCP
 * `get_preview` tool answers exactly what the web app's preview pane does; the label still only
 * leaves folded into `url`.
 */
@Injectable()
export class PreviewReader {
  private readonly domain: string;
  private readonly gatewayPort: number | undefined;

  constructor(
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.domain = config.get('PREVIEW_DOMAIN', { infer: true });
    this.gatewayPort = config.get('PREVIEW_GATEWAY_PORT', { infer: true });
  }

  async read(tx: TenantTransaction, orgId: string, projectId: string): Promise<PreviewResponse> {
    const row = await this.row(tx, orgId, projectId);

    return this.answer(tx, orgId, projectId, row, row.previewLabel, row.previewVisibility);
  }

  /** The live row, or the one not-found every preview route answers. */
  async row(tx: TenantTransaction, orgId: string, projectId: string) {
    const row = await tx.query.projects.findFirst({
      columns: { previewLabel: true, previewVisibility: true, runConfig: true, template: true },
      where: and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt)),
    });

    if (row === undefined) {
      throw new PreviewError('project-not-found', 'No such project.');
    }

    return row;
  }

  async answer(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    source: ProjectRunSource,
    label: string,
    visibility: PreviewResponse['visibility'],
  ): Promise<PreviewResponse> {
    const sandbox = await tx.query.sandboxes.findFirst({
      columns: { lostAt: true, ports: true, state: true, transition: true, workspaceRoot: true },
      where: and(eq(sandboxes.orgId, orgId), eq(sandboxes.projectId, projectId)),
    });
    const { port, url } = this.link(source, label);
    // Spec 047: what the run profile says the project is, so the pane can say what it is setting up.
    const config = parseRunConfig(source.runConfig);
    const stage =
      port === null && source.template === null && config === null
        ? await this.importStage(tx, orgId, projectId)
        : previewStage(sandbox, port, config?.install != null);
    // A template project's answer is exactly what it was before run profiles: no `stack` key.
    return { port, ...(config === null ? {} : { stack: config.stack }), stage, url, visibility };
  }

  /**
   * Spec 047: a smart import has no run profile until its clone is in, so it has no port yet — but
   * it is being created, not "no preview". An open import operation says which.
   */
  private async importStage(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<PreviewResponse['stage']> {
    const [open] = await tx
      .select({ id: syncOperations.id })
      .from(syncOperations)
      .where(
        and(
          eq(syncOperations.orgId, orgId),
          eq(syncOperations.projectId, projectId),
          eq(syncOperations.kind, 'import'),
          inArray(syncOperations.state, ['queued', 'running']),
        ),
      )
      .limit(1);
    return open === undefined ? 'no-sandbox' : 'creating';
  }

  link(source: ProjectRunSource, label: string): Pick<PreviewResponse, 'port' | 'url'> {
    const port = resolveDevPort(this.catalogue, source);
    const host = `${label}-${String(port)}.${this.domain}`;
    // The local gateway (`pnpm dev:gateway`) speaks plain HTTP on its own port, as the authorize
    // answer already assumes for a host with a port; a deployment sets no gateway port.
    const url =
      this.gatewayPort === undefined
        ? `https://${host}`
        : `http://${host}:${String(this.gatewayPort)}`;
    return { port: port ?? null, url: port === undefined ? '' : url };
  }
}
