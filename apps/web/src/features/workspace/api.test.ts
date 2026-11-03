import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { PROJECT_TEMPLATES } from '@repo/contracts';

import { API, modelCatalogue, server } from '@/test/server';
import { fetchModelCatalogue, listTemplates } from './api';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('fetchModelCatalogue', () => {
  it('parses the organisation catalogue', async () => {
    // The default handler answers with contracts/byok.md § 2's JSON: every model the organisation
    // may run, stamped with the credential a run would use, and which is the default.
    const catalogue = await fetchModelCatalogue(ORG_ID);

    expect(catalogue).toEqual(modelCatalogue);
    expect(catalogue.models.map((model) => model.id)).toContain(catalogue.default);
  });

  it('asks under the organisation, not the deployment-wide route 011 had', async () => {
    let path = '';

    server.use(
      http.get(`${API}/orgs/:orgId/models`, ({ request }) => {
        path = new URL(request.url).pathname;

        return HttpResponse.json(modelCatalogue);
      }),
    );

    await fetchModelCatalogue(ORG_ID);

    expect(path).toBe(`${API}/orgs/${ORG_ID}/models`);
  });

  it('refuses a catalogue with an undeclared field', async () => {
    // `modelCatalogueResponseSchema` is strict, so a server that grew a field fails here rather
    // than shipping one the picker never reads.
    server.use(
      http.get(`${API}/orgs/:orgId/models`, () =>
        HttpResponse.json({ ...modelCatalogue, region: 'eu' }),
      ),
    );

    await expect(fetchModelCatalogue(ORG_ID)).rejects.toThrow(ZodError);
  });
});

describe('listTemplates', () => {
  it('asks the deployment-wide route and parses the catalogue', async () => {
    // No `orgId`: the catalogue is the deployment's, as `GET /templates` is tenant-blind (015).
    let path = '';

    server.use(
      http.get(`${API}/templates`, ({ request }) => {
        path = new URL(request.url).pathname;

        return HttpResponse.json({
          default: 'vite-react',
          templates: PROJECT_TEMPLATES.map((id) => ({
            description: `The ${id} starter`,
            id,
            name: id,
            ready: true,
          })),
        });
      }),
    );

    const catalogue = await listTemplates();

    expect(path).toBe(`${API}/templates`);
    expect(catalogue.templates.map((template) => template.id)).toEqual([...PROJECT_TEMPLATES]);
  });
});
