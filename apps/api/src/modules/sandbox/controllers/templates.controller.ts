import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { TemplateCatalogueResponse } from '@repo/contracts';

import { TemplateCatalogueResponseDto } from '../dto/template-catalogue.dto';
import { TemplateCatalogue } from '../template-catalogue';
import { TemplateVersions } from '../template-versions';

/**
 * The template catalogue (spec 015 US3, contract § 5), on the `models` precedent
 * (`agent/controllers/models.controller.ts`): deployment-wide and tenant-blind, so no
 * `@ResourceOrg` and no `@RequirePermission` — the global `SessionGuard` still applies. Names and
 * descriptions from the manifests, `ready` from one `template_versions` query.
 */
@ApiTags('sandbox')
@Controller({ path: 'templates', version: '1' })
export class TemplatesController {
  constructor(
    private readonly catalogue: TemplateCatalogue,
    private readonly versions: TemplateVersions,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the project templates, their readiness, and the default' })
  @ApiResponse({ status: 200, type: TemplateCatalogueResponseDto })
  async list(): Promise<TemplateCatalogueResponse> {
    const ready = new Set(await this.versions.currentTemplates());
    return {
      default: 'vite-react',
      templates: this.catalogue.all().map((def) => ({
        description: def.manifest.description,
        id: def.id,
        name: def.manifest.name,
        ready: ready.has(def.id),
      })),
    };
  }
}
