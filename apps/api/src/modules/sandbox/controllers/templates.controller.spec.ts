import { templateCatalogueResponseSchema } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TEMPLATES_DIR, TemplateCatalogue } from '../template-catalogue';
import type { TemplateVersions } from '../template-versions';
import { TemplatesController } from './templates.controller';

/** The controller asks the versions for one thing, so one stubbed method is the whole of it. */
function versionsWith(current: string[]): TemplateVersions {
  return { currentTemplates: () => Promise.resolve(current) } as unknown as TemplateVersions;
}

describe('TemplatesController', () => {
  describe('GET /templates', () => {
    it('answers the four templates in order with readiness from the current versions', async () => {
      const catalogue = new TemplateCatalogue(DEFAULT_TEMPLATES_DIR);
      const controller = new TemplatesController(catalogue, versionsWith(['vite-react', 'nextjs']));

      const body = await controller.list();

      expect(templateCatalogueResponseSchema.parse(body)).toEqual(body);
      expect(body.default).toBe('vite-react');
      expect(body.templates.map((t) => t.id)).toEqual(catalogue.all().map((d) => d.id));
      expect(body.templates.map((t) => t.ready)).toEqual(
        catalogue.all().map((d) => d.id === 'vite-react' || d.id === 'nextjs'),
      );
      expect(body.templates[0]).toEqual({
        description: catalogue.all()[0]!.manifest.description,
        id: catalogue.all()[0]!.id,
        name: catalogue.all()[0]!.manifest.name,
        ready: true,
      });
    });
  });
});
