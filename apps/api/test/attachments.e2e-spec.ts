import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { attachmentSchema, problemDetailSchema } from '@repo/contracts';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { unsafe } from './support/csrf-client';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  // Where no bucket is configured, attachments fall back to a directory (spec 048).
  process.env.OBJECT_STORE_DIR ??= `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/forge-attachments-e2e`;
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * Chat attachments over HTTP (spec 048): the raw-body upload through the real middleware stack
 * (body parsers, CSRF, idempotency, tenant transaction), the download's headers, the type check,
 * the pending delete, and another tenant's reach.
 */
describe('Attachments (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let app: INestApplication;
    let world: TwoTenantWorld;
    const base = (orgId: string, projectId: string): string =>
      `/api/v1/orgs/${orgId}/projects/${projectId}/attachments`;
    let alpha: string;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

      // As `main.ts` builds it: a body a JSON parser takes is kept on `rawBody`.
      app = moduleRef.createNestApplication({ rawBody: true });
      configureApplication(app);
      await app.init();
      world = await createTwoTenantWorld(app);
      alpha = base(world.alpha.orgId, world.alpha.projectId);
    }, 600_000);

    afterAll(async () => {
      if (world) await destroyTwoTenantWorld(app, world);
      await app?.close();
    });

    function upload(name: string, body: Buffer, type = 'application/octet-stream') {
      return unsafe(http(app).post(`${alpha}?name=${encodeURIComponent(name)}`), [
        world.alpha.owner.cookie,
      ])
        .set('Content-Type', type)
        .send(body);
    }

    it('stores a raw body and serves it back as a download with the hardening headers', async () => {
      const bytes = Buffer.from('# Brief\n\nBuild the landing page.\n');
      const created = attachmentSchema.parse((await upload('brief.md', bytes).expect(201)).body);

      expect(created).toMatchObject({ kind: 'text', mimeType: 'text/markdown', name: 'brief.md' });
      expect(created.sizeBytes).toBe(bytes.length);

      const response = await http(app)
        .get(`${alpha}/${created.id}/content`)
        .set('Cookie', world.alpha.owner.cookie)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.body).toEqual(bytes);
      expect(response.headers).toMatchObject({
        'cache-control': 'private, max-age=3600',
        'content-disposition': `attachment; filename="brief.md"; filename*=UTF-8''brief.md`,
        'content-security-policy': 'sandbox',
        'content-type': 'text/markdown; charset=utf-8',
        'cross-origin-resource-policy': 'same-site',
        'x-content-type-options': 'nosniff',
      });
    });

    it('serves a PDF inline without the sandbox CSP, which would stop Chrome’s viewer', async () => {
      const { id } = attachmentSchema.parse(
        (await upload('spec.pdf', Buffer.from('%PDF-1.4 %%EOF')).expect(201)).body,
      );

      const response = await http(app)
        .get(`${alpha}/${id}/content`)
        .set('Cookie', world.alpha.owner.cookie)
        .expect(200);

      expect(response.headers).toMatchObject({
        'content-disposition': `inline; filename="spec.pdf"; filename*=UTF-8''spec.pdf`,
        'content-type': 'application/pdf',
        'cross-origin-resource-policy': 'same-site',
        'x-content-type-options': 'nosniff',
      });
      expect(response.headers['content-security-policy']).toBeUndefined();
    });

    it('reads a body a JSON parser took first', async () => {
      const created = await upload('data.json', Buffer.from('{"a":1}'), 'application/json').expect(
        201,
      );

      expect(attachmentSchema.parse(created.body).kind).toBe('text');
    });

    it('refuses a .png whose bytes are an executable (415 attachment-rejected)', async () => {
      const response = await upload('logo.png', Buffer.from('MZ\x90\x00 not an image')).expect(415);

      expect(problemDetailSchema.parse(response.body).type).toMatch(/attachment-rejected$/);
    });

    it('deletes a pending file, after which it is gone', async () => {
      const { id } = attachmentSchema.parse(
        (await upload('scratch.txt', Buffer.from('x')).expect(201)).body,
      );

      await unsafe(http(app).delete(`${alpha}/${id}`), [world.alpha.owner.cookie]).expect(204);
      await http(app)
        .get(`${alpha}/${id}/content`)
        .set('Cookie', world.alpha.owner.cookie)
        .expect(404);
    });

    it('never serves one tenant’s file to another', async () => {
      const { id } = attachmentSchema.parse(
        (await upload('secret.txt', Buffer.from('alpha only')).expect(201)).body,
      );

      // Through alpha's path: beta holds no permission there.
      await http(app)
        .get(`${alpha}/${id}/content`)
        .set('Cookie', world.beta.owner.cookie)
        .expect(403);
      // Through beta's own path: RLS hides alpha's row.
      const response = await http(app)
        .get(`${base(world.beta.orgId, world.beta.projectId)}/${id}/content`)
        .set('Cookie', world.beta.owner.cookie)
        .expect(404);

      expect(problemDetailSchema.parse(response.body).type).toMatch(/attachment-not-found$/);
    });
  });
});
