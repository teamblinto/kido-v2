import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Deployment } from '@repo/db';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import { objectStoreFor } from '../../common/object-store/r2-object-store';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { blobKey, buildManifest, upload } from './artifact';
import type { DeploymentRepository } from './deployment.repository';
import { ReleaseReader } from './release-reader';

const ORG = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000003';
const DEPLOYMENT = '00000000-0000-4000-8000-0000000000d1';
const OTHER_DEPLOYMENT = '00000000-0000-4000-8000-0000000000d2';
const tx = {} as TenantTransaction;

const FILES = [
  { body: Buffer.from('<h1>hi</h1>'), path: 'index.html' },
  { body: Buffer.from('console.log(1)'), path: 'assets/app.js' },
];

/** The repository's `byId` is keyed on org, project and id, as the real one's `where` is. */
function repository(rows: Partial<Deployment>[]): DeploymentRepository {
  return {
    byId: (_tx: TenantTransaction, orgId: string, projectId: string, id: string) =>
      Promise.resolve(
        rows.find((r) => r.orgId === orgId && r.projectId === projectId && r.id === id) as
          Deployment | undefined,
      ),
  } as unknown as DeploymentRepository;
}

async function setup() {
  const store = new MemoryObjectStore();
  const { artifactSha } = await upload(store, ORG, PROJECT, FILES);
  // Another project's release of the same bytes lives under its own prefix.
  await upload(store, ORG, OTHER_PROJECT, FILES);
  const reader = new ReleaseReader(
    repository([
      { artifactSha, id: DEPLOYMENT, orgId: ORG, projectId: PROJECT, state: 'succeeded' },
      {
        artifactSha,
        id: OTHER_DEPLOYMENT,
        orgId: ORG,
        projectId: OTHER_PROJECT,
        state: 'succeeded',
      },
      { artifactSha: null, id: 'd-failed', orgId: ORG, projectId: PROJECT, state: 'failed' },
      { artifactSha: null, id: 'd-building', orgId: ORG, projectId: PROJECT, state: 'building' },
      { artifactSha: null, id: 'd-cancelled', orgId: ORG, projectId: PROJECT, state: 'cancelled' },
    ]),
    store,
  );

  return { artifactSha, reader, store };
}

/** Spec 030 T080, research R11: a release's files, read from 027's layout, this project only. */
describe('ReleaseReader', () => {
  it('reads the manifest of a succeeded release of this org and project', async () => {
    const { reader } = await setup();

    await expect(reader.manifest(tx, ORG, PROJECT, DEPLOYMENT)).resolves.toEqual(
      buildManifest(FILES).manifest,
    );
  });

  it('answers not found for another project’s deployment and for a release not succeeded', async () => {
    const { reader } = await setup();

    await expect(reader.manifest(tx, ORG, PROJECT, OTHER_DEPLOYMENT)).resolves.toBeUndefined();
    await expect(reader.manifest(tx, ORG, PROJECT, 'd-failed')).resolves.toBeUndefined();
  });

  it('reads a blob under this org and project’s prefix only', async () => {
    const { reader, store } = await setup();
    const sha = buildManifest(FILES).manifest.files['index.html']!.sha;

    await expect(reader.blob(ORG, PROJECT, sha)).resolves.toEqual(Buffer.from('<h1>hi</h1>'));

    await store.delete(blobKey(ORG, PROJECT, sha));
    // The other project's copy is not read in its place.
    await expect(reader.blob(ORG, PROJECT, sha)).resolves.toBeUndefined();
  });
});

/** A publish that waits on its release's build reads where the build stands. */
describe('ReleaseReader.progress', () => {
  it('says building, succeeded or failed for this project, and nothing for another’s', async () => {
    const { reader } = await setup();

    await expect(reader.progress(tx, ORG, PROJECT, 'd-building')).resolves.toBe('building');
    await expect(reader.progress(tx, ORG, PROJECT, DEPLOYMENT)).resolves.toBe('succeeded');
    await expect(reader.progress(tx, ORG, PROJECT, 'd-failed')).resolves.toBe('failed');
    await expect(reader.progress(tx, ORG, PROJECT, 'd-cancelled')).resolves.toBe('failed');
    await expect(reader.progress(tx, ORG, PROJECT, OTHER_DEPLOYMENT)).resolves.toBeUndefined();
  });
});

/**
 * A single host with no bucket (`OBJECT_STORE_DIR`, the VPS): the build's upload and the Netlify
 * publish's read go through the directory store, and a release reads back byte for byte.
 */
describe('ReleaseReader over the directory store', () => {
  it('reads back the manifest and every blob a build uploaded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-artifacts-'));
    const store = objectStoreFor(
      new ConfigService<Environment, true>({ OBJECT_STORE_DIR: dir }),
      'artifacts',
    );
    const files = [
      { body: Buffer.from('<!doctype html><div id="root"></div>'), path: 'index.html' },
      { body: Buffer.alloc(190_000, 7), path: 'assets/index-DpqUGku5.js' },
    ];

    try {
      const { artifactSha } = await upload(store, ORG, PROJECT, files);
      const reader = new ReleaseReader(
        repository([
          { artifactSha, id: DEPLOYMENT, orgId: ORG, projectId: PROJECT, state: 'succeeded' },
        ]),
        store,
      );
      const manifest = await reader.manifest(tx, ORG, PROJECT, DEPLOYMENT);

      expect(Object.keys(manifest!.files).sort()).toEqual([
        'assets/index-DpqUGku5.js',
        'index.html',
      ]);
      for (const file of files) {
        await expect(reader.blob(ORG, PROJECT, manifest!.files[file.path]!.sha)).resolves.toEqual(
          file.body,
        );
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
