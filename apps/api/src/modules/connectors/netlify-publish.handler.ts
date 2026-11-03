import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { netlifyBindingConfigSchema } from '@repo/contracts';

import type { Plaintext } from '../../common/crypto/branded';
import { ReleaseReader } from '../deploy/release-reader';
import { BindingRepository } from './binding.repository';
import {
  type OperationContext,
  OperationFailure,
  type OperationHandler,
} from './connector-ops.consumer';
import { OperationRepository } from './operation.repository';
import {
  NETLIFY_CLIENT,
  type NetlifyClient,
  type NetlifyDeploy,
} from './providers/netlify/netlify.client';
import { ProviderFailure } from './providers/provider';

/** R11: a publish's deploy carries this title, so a retry that lost the id adopts its own. */
export function publishTitle(operationId: string): string {
  return `forge:${operationId}`;
}

/** How often and for how long one attempt polls the deploy; past the budget the job retries. */
export interface PublishPollTimings {
  readonly budgetMs: number;
  readonly intervalMs: number;
}

const DONE = 'ready';
const BROKEN = new Set(['error']);

/**
 * `netlify_publish` (spec 030 research R11, FR-016–FR-018): a succeeded release's files as a
 * Netlify digest deploy on the bound site. Every blob is read once to hash it (SHA1, which Netlify
 * asks for), the deploy is created with `path → sha1` and titled `forge:<operationId>`, its id is
 * recorded on the operation the moment create returns, only the digests Netlify names `required`
 * are uploaded, and the deploy is polled to `ready` or `error` with each state written to
 * `provider_state` (the timeline, FR-017).
 *
 * A retry with a recorded id resumes that deploy (re-reading `required`); one without first adopts
 * a deploy with its title, so a crash between create and record never makes a second deploy
 * (SC-006). A bound site that answers 404 is `site-gone` and the binding `disconnected` (FR-018).
 *
 * ponytail: rehash per publish; cache blob_sha1 when hashing shows in publish time
 */
@Injectable()
export class NetlifyPublishHandler implements OperationHandler {
  /** A suite shortens both. */
  pollTimings: PublishPollTimings = { budgetMs: 5 * 60_000, intervalMs: 2_000 };

  constructor(
    @Inject(NETLIFY_CLIENT) private readonly netlify: NetlifyClient,
    @Inject(ReleaseReader) private readonly releases: ReleaseReader,
    @Inject(BindingRepository) private readonly bindings: BindingRepository,
    @Inject(OperationRepository) private readonly operations: OperationRepository,
  ) {}

  async run(context: OperationContext): Promise<void> {
    const { operation, credential: token } = context;
    const { bindingId, deploymentId, orgId, projectId } = operation;

    if (bindingId === null || deploymentId === null || projectId === null) {
      throw new OperationFailure('not-found');
    }

    const binding = await context.inTenant((tx) => this.bindings.byId(tx, orgId, bindingId));

    if (binding?.state !== 'bound') throw new OperationFailure('disconnected');

    const { siteId } = netlifyBindingConfigSchema.parse(binding.config);

    await this.siteOrGone(context, token, siteId, bindingId);

    const manifest = await context.inTenant((tx) =>
      this.releases.manifest(tx, orgId, projectId, deploymentId),
    );

    if (manifest === undefined) throw new OperationFailure('not-found');

    // Each distinct blob read once: its SHA1, and which sha-256 to read again for an upload.
    const sha1Of = new Map<string, string>();
    const sha256Of = new Map<string, string>();
    const files: Record<string, string> = {};

    for (const [path, entry] of Object.entries(manifest.files)) {
      let digest = sha1Of.get(entry.sha);

      if (digest === undefined) {
        const body = await this.blob(orgId, projectId, entry.sha);
        digest = createHash('sha1').update(body).digest('hex');
        sha1Of.set(entry.sha, digest);
        sha256Of.set(digest, entry.sha);
      }

      files[path] = digest;
    }

    const deploy = await this.deployFor(context, token, siteId, files);
    const pathOf = new Map(Object.entries(files).map(([path, digest]) => [digest, path]));

    for (const digest of new Set(deploy.required)) {
      const path = pathOf.get(digest);
      const sha256 = sha256Of.get(digest);

      // Netlify asked for a digest this release does not hold: nothing we can send.
      if (path === undefined || sha256 === undefined) throw new ProviderFailure('validation');

      const body = await this.blob(orgId, projectId, sha256);
      await this.netlify.uploadFile(token, deploy.id, path, body, body.length);
    }

    await this.awaitReady(context, token, deploy.id);
  }

  private async siteOrGone(
    context: OperationContext,
    token: Plaintext,
    siteId: string,
    bindingId: string,
  ): Promise<void> {
    try {
      await this.netlify.site(token, siteId);
    } catch (error) {
      if (error instanceof ProviderFailure && error.category === 'not-found') {
        await context.inTenant((tx) =>
          this.bindings.markDisconnected(tx, context.operation.orgId, bindingId),
        );

        throw new OperationFailure('site-gone');
      }

      throw error;
    }
  }

  private async blob(orgId: string, projectId: string, sha256: string): Promise<Buffer> {
    const body = await this.releases.blob(orgId, projectId, sha256);

    if (body === undefined) throw new OperationFailure('not-found');

    return body;
  }

  /** The recorded deploy, else the one with this operation's title, else a new one — recorded at once. */
  private async deployFor(
    context: OperationContext,
    token: Plaintext,
    siteId: string,
    files: Record<string, string>,
  ): Promise<NetlifyDeploy> {
    const { operation } = context;
    const title = publishTitle(operation.id);
    const recorded = await context.inTenant((tx) =>
      this.operations.byId(tx, operation.orgId, operation.id),
    );

    if (recorded?.externalRef != null) return this.netlify.deploy(token, recorded.externalRef);

    const deploy =
      (await this.netlify.findDeployByTitle(token, siteId, title)) ??
      (await this.netlify.createDeploy(token, siteId, files, title));

    await context.inTenant((tx) =>
      this.operations.setProgress(tx, operation.orgId, operation.id, {
        externalRef: deploy.id,
        providerState: deploy.state,
      }),
    );

    return deploy;
  }

  private async awaitReady(
    context: OperationContext,
    token: Plaintext,
    deployId: string,
  ): Promise<void> {
    const { operation } = context;
    const deadline = Date.now() + this.pollTimings.budgetMs;

    for (;;) {
      const deploy = await this.netlify.deploy(token, deployId);

      await context.inTenant((tx) =>
        this.operations.setProgress(tx, operation.orgId, operation.id, {
          providerState: deploy.state,
        }),
      );

      if (deploy.state === DONE) return;
      if (BROKEN.has(deploy.state)) throw new OperationFailure('provider-refused');
      // Still going: the job retries and resumes by the recorded id.
      if (Date.now() >= deadline) throw new ProviderFailure('unavailable');

      await new Promise((resolve) => setTimeout(resolve, this.pollTimings.intervalMs));
    }
  }
}
