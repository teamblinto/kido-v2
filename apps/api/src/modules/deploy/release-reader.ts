import { Inject, Injectable } from '@nestjs/common';

import type { ObjectStorePort } from '../../common/object-store/object-store.port';
import type { TenantTransaction } from '../../database/database.types';
import { blobKey, type Manifest, manifestKey } from './artifact';
import { ARTIFACT_STORE } from './deploy.constants';
import { DeploymentRepository } from './deployment.repository';

/**
 * A release's files for another module (spec 030 research R11: the Netlify publish). Reads 027's
 * layout (`artifact.ts`) for one org and project only: a deployment of another project, or one
 * that did not succeed, is not found.
 */
@Injectable()
export class ReleaseReader {
  constructor(
    @Inject(DeploymentRepository) private readonly deployments: DeploymentRepository,
    @Inject(ARTIFACT_STORE) private readonly store: ObjectStorePort,
  ) {}

  /** A `succeeded` release of this project: what a publish may name (contracts/bindings.md § 2). */
  async isRelease(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    deploymentId: string,
  ): Promise<boolean> {
    const row = await this.deployments.byId(tx, orgId, projectId, deploymentId);

    return row?.state === 'succeeded' && row.artifactSha !== null;
  }

  async manifest(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    deploymentId: string,
  ): Promise<Manifest | undefined> {
    const row = await this.deployments.byId(tx, orgId, projectId, deploymentId);

    if (row?.state !== 'succeeded' || row.artifactSha === null) return undefined;

    const object = await this.store.get(manifestKey(orgId, projectId, row.artifactSha));

    return object === null ? undefined : (JSON.parse(object.body.toString('utf8')) as Manifest);
  }

  /** One file's bytes by its sha-256, read whole (the store has no ranged read). */
  async blob(orgId: string, projectId: string, sha256: string): Promise<Buffer | undefined> {
    return (await this.store.get(blobKey(orgId, projectId, sha256)))?.body;
  }
}
