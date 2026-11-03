import { z } from 'zod';

import { PROJECT_TEMPLATES, projectTemplateSchema } from './project';

/**
 * The template catalogue (spec 015, research R7): `GET /api/v1/templates`. Deployment-wide,
 * tenant-blind — the same shape as the model catalogue. `ready` is "a current version exists";
 * no digest, no snapshot name, no state.
 */

export const catalogueTemplateSchema = z.strictObject({
  description: z.string().min(1),
  id: projectTemplateSchema,
  name: z.string().min(1),
  ready: z.boolean(),
});

export type CatalogueTemplate = z.output<typeof catalogueTemplateSchema>;

export const templateCatalogueResponseSchema = z.strictObject({
  default: projectTemplateSchema,
  templates: z.array(catalogueTemplateSchema).length(PROJECT_TEMPLATES.length),
});

export type TemplateCatalogueResponse = z.output<typeof templateCatalogueResponseSchema>;
