import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type PreviewResponse, PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';
import { projects, sandboxes } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
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

    return this.answer(tx, orgId, projectId, row.template, row.previewLabel, row.previewVisibility);
  }

  /** The live row, or the one not-found every preview route answers. */
  async row(tx: TenantTransaction, orgId: string, projectId: string) {
    const row = await tx.query.projects.findFirst({
      columns: { previewLabel: true, previewVisibility: true, template: true },
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
    template: string | null,
    label: string,
    visibility: PreviewResponse['visibility'],
  ): Promise<PreviewResponse> {
    const sandbox = await tx.query.sandboxes.findFirst({
      columns: { lostAt: true, ports: true, state: true, transition: true, workspaceRoot: true },
      where: and(eq(sandboxes.orgId, orgId), eq(sandboxes.projectId, projectId)),
    });
    const { port, url } = this.link(template, label);
    return { port, stage: previewStage(sandbox, port), url, visibility };
  }

  link(template: string | null, label: string): Pick<PreviewResponse, 'port' | 'url'> {
    const port = this.devPort(template);
    const host = `${label}-${String(port)}.${this.domain}`;
    // The local gateway (`pnpm dev:gateway`) speaks plain HTTP on its own port, as the authorize
    // answer already assumes for a host with a port; a deployment sets no gateway port.
    const url =
      this.gatewayPort === undefined
        ? `https://${host}`
        : `http://${host}:${String(this.gatewayPort)}`;
    return { port: port ?? null, url: port === undefined ? '' : url };
  }

  /** The same reading `RouteBrokerService.devPort` makes: no template or no `devPort` is no port. */
  private devPort(template: string | null): number | undefined {
    if (template === null || !(PROJECT_TEMPLATES as readonly string[]).includes(template)) {
      return undefined;
    }
    const declared = this.catalogue.get(template as ProjectTemplate).manifest.devPort;
    return declared === undefined ? undefined : Number(declared);
  }
}
