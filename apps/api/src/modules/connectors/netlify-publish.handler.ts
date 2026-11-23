import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { netlifyBindingConfigSchema } from '@repo/contracts';

import type { Plaintext } from '../../common/crypto/branded';
import type { Manifest } from '../deploy/artifact';
import { BUILD_TIMEOUT_MS } from '../deploy/deploy.constants';
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

/**
 * How often and for how long one attempt polls: the deploy (past `budgetMs` the job retries), and
 * first the release's build (past `buildBudgetMs` the publish is `timed-out`).
 */
export interface PublishPollTimings {
  readonly budgetMs: number;
  readonly buildBudgetMs: number;
  readonly intervalMs: number;
}

const DONE = 'ready';
const BROKEN = new Set(['error']);
/**
 * An `async: true` create answers before Netlify has diffed the digests: `required` is not
 * there yet. Netlify's file-digest flow polls the deploy until it leaves these, then uploads.
 */
const PREPARING = new Set(['new', 'preparing']);

/** `provider_state` while the publish waits on its release's build — ours, not Netlify's. */
export const BUILDING_STATE = 'building';

/**
 * Kido's own host answers an extensionless path it holds no file for with `index.html` (the SPA
 * fallback, `apps/gateway/src/site-serve.ts`); Netlify serves only the files it is given. A
 * release with an `index.html` and no redirect config of its own gets the same fallback as a
 * Netlify rewrite, which Netlify applies only where no file matches (shadowing).
 */
export function spaRedirects(files: Manifest['files']): Buffer | undefined {
  const own = ['_redirects', 'netlify.toml'].some((path) => Object.hasOwn(files, path));

  return Object.hasOwn(files, 'index.html') && !own
    ? Buffer.from('/*    /index.html    200\n')
    : undefined;
}

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
  /**
   * A suite shortens them. The build wait is the build's own cap plus queueing slack, so build
   * wait and publish together stay inside the sweep's `STALE_PUBLISH_MS` (30 min).
   */
  pollTimings: PublishPollTimings = {
    budgetMs: 5 * 60_000,
    buildBudgetMs: BUILD_TIMEOUT_MS + 5 * 60_000,
    intervalMs: 2_000,
  };

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
    await this.awaitRelease(context, projectId, deploymentId);

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

    // Files the publish adds to the release, by SHA1, with their bytes.
    const generated = new Map<string, Buffer>();
    const redirects = spaRedirects(manifest.files);

    if (redirects !== undefined) {
      const digest = createHash('sha1').update(redirects).digest('hex');
      generated.set(digest, redirects);
      files._redirects = digest;
    }

    const deploy = await this.awaitPrepared(
      context,
      token,
      await this.deployFor(context, token, siteId, files),
    );
    const pathOf = new Map(Object.entries(files).map(([path, digest]) => [digest, path]));

    for (const digest of new Set(deploy.required)) {
      const path = pathOf.get(digest);
      const sha256 = sha256Of.get(digest);
      const body =
        generated.get(digest) ??
        (sha256 === undefined ? undefined : await this.blob(orgId, projectId, sha256));

      // Netlify asked for a digest this release does not hold: nothing we can send.
      if (path === undefined || body === undefined) throw new ProviderFailure('validation');

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

  /**
   * "Deploy to Netlify" queues the publish with the build it starts: wait for that build to land,
   * with `building` on the timeline meanwhile. A failed or cancelled build is `build-failed`; a
   * build still going past the budget is `timed-out` (the deploy sweep settles it on its side).
   */
  private async awaitRelease(
    context: OperationContext,
    projectId: string,
    deploymentId: string,
  ): Promise<void> {
    const { operation } = context;
    const deadline = Date.now() + this.pollTimings.buildBudgetMs;
    let marked = false;

    for (;;) {
      const progress = await context.inTenant((tx) =>
        this.releases.progress(tx, operation.orgId, projectId, deploymentId),
      );

      if (progress === 'succeeded') return;
      if (progress === undefined) throw new OperationFailure('not-found');
      if (progress === 'failed') throw new OperationFailure('build-failed');
      if (Date.now() >= deadline) throw new OperationFailure('timed-out');

      if (!marked) {
        await context.inTenant((tx) =>
          this.operations.setProgress(tx, operation.orgId, operation.id, {
            providerState: BUILDING_STATE,
          }),
        );
        marked = true;
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollTimings.intervalMs));
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

  /**
   * The deploy once Netlify knows which digests it still needs: read again while it is
   * `preparing` (each state on the timeline), within the same budget as the ready poll. Past it
   * the job retries and resumes by the recorded id, as a ready poll does.
   */
  private async awaitPrepared(
    context: OperationContext,
    token: Plaintext,
    created: NetlifyDeploy,
  ): Promise<NetlifyDeploy> {
    const { operation } = context;
    const deadline = Date.now() + this.pollTimings.budgetMs;
    let deploy = created;

    while (PREPARING.has(deploy.state)) {
      if (Date.now() >= deadline) throw new ProviderFailure('unavailable');

      await new Promise((resolve) => setTimeout(resolve, this.pollTimings.intervalMs));
      deploy = await this.netlify.deploy(token, deploy.id);

      const { state } = deploy;
      await context.inTenant((tx) =>
        this.operations.setProgress(tx, operation.orgId, operation.id, { providerState: state }),
      );
    }

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
