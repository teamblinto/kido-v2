import { describe, expect, it } from 'vitest';

import { PROJECT_TEMPLATES } from './project';
import { catalogueTemplateSchema, templateCatalogueResponseSchema } from './template-catalogue';

const templates = PROJECT_TEMPLATES.map((id) => ({
  description: `${id} description`,
  id,
  name: id,
  ready: id === 'vite-react',
}));

describe('catalogueTemplateSchema / templateCatalogueResponseSchema', () => {
  it('accepts one row per project template', () => {
    expect(
      templateCatalogueResponseSchema.safeParse({ default: 'vite-react', templates }).success,
    ).toBe(true);
  });

  it('refuses an undeclared field', () => {
    expect(catalogueTemplateSchema.safeParse({ ...templates[0], extra: 1 }).success).toBe(false);
    expect(
      templateCatalogueResponseSchema.safeParse({ default: 'vite-react', extra: 1, templates })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown template id and a wrong row count', () => {
    expect(catalogueTemplateSchema.safeParse({ ...templates[0], id: 'rails' }).success).toBe(false);
    expect(templateCatalogueResponseSchema.safeParse({ default: 'rails', templates }).success).toBe(
      false,
    );
    expect(
      templateCatalogueResponseSchema.safeParse({
        default: 'vite-react',
        templates: templates.slice(1),
      }).success,
    ).toBe(false);
  });
});
