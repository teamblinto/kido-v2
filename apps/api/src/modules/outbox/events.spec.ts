import { describe, expect, it } from 'vitest';

import { MAIL_TEMPLATE_IDS } from '../mail/mailer.port';
import { EVENTS, MAX_PAYLOAD_BYTES } from './events';

type DomainTemplate = Extract<(typeof MAIL_TEMPLATE_IDS)[number], `domain-${string}`>;
type WebhookTemplate = Extract<(typeof MAIL_TEMPLATE_IDS)[number], `webhook-${string}`>;
type ByosTemplate = Extract<(typeof MAIL_TEMPLATE_IDS)[number], `byos-${string}`>;
type AccountTemplate = Exclude<
  (typeof MAIL_TEMPLATE_IDS)[number],
  DomainTemplate | WebhookTemplate | ByosTemplate
>;

const isDomainTemplate = (id: (typeof MAIL_TEMPLATE_IDS)[number]): id is DomainTemplate =>
  id.startsWith('domain-');
const isWebhookTemplate = (id: (typeof MAIL_TEMPLATE_IDS)[number]): id is WebhookTemplate =>
  id.startsWith('webhook-');
const isByosTemplate = (id: (typeof MAIL_TEMPLATE_IDS)[number]): id is ByosTemplate =>
  id.startsWith('byos-');
const isAccountTemplate = (id: (typeof MAIL_TEMPLATE_IDS)[number]): id is AccountTemplate =>
  !isDomainTemplate(id) && !isWebhookTemplate(id) && !isByosTemplate(id);

/**
 * The catalogue is the review point for "ids, never contents" (§10): a payload that carries a
 * name, an address or a document body is refused here, at the schema, not discovered in a queue
 * dump. `strictObject` is what makes an undeclared key a failure rather than a passenger.
 */
describe('event catalogue', () => {
  const probe = EVENTS['outbox.probe'];

  it('accepts a probe payload with a uuid probeId', () => {
    const payload = { probeId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a' };

    expect(probe.payload.safeParse(payload)).toEqual({ data: payload, success: true });
  });

  it('rejects an unknown key', () => {
    const result = probe.payload.safeParse({
      email: 'someone@example.com',
      probeId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid probeId', () => {
    expect(probe.payload.safeParse({ probeId: 'probe-1' }).success).toBe(false);
  });

  it('names the aggregate the probe belongs to', () => {
    expect(probe.aggregate).toBe('probe');
  });

  /**
   * Spec 006 (ADR 030): one entry per mail template, and the job carries ids only — a `token` key
   * is the one thing a producer must not be able to slip past the schema.
   */
  it('carries one strict entry per account mail template', () => {
    // `project-invitation` names its org and row and no recipient (spec 031): its own case below.
    for (const id of MAIL_TEMPLATE_IDS.filter(
      (template) => isAccountTemplate(template) && template !== 'project-invitation',
    )) {
      const entry = EVENTS[`mail.${id}`];
      const idKey = id === 'invitation' ? 'invitationId' : 'userId';
      const valid = { [idKey]: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a', recipient: 'a@example.com' };

      expect(entry, `mail.${id}`).toBeDefined();
      expect(entry.payload.safeParse(valid).success).toBe(true);
      expect(entry.payload.safeParse({ ...valid, token: 'plaintext' }).success).toBe(false);
    }
  });

  /** Spec 007: a project event names the project and where it lives, and never the name. */
  describe('project events', () => {
    const ids = {
      actorId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
      orgId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
      projectId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
      workspaceId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5d',
    };

    it('created carries the ids and the template', () => {
      const payload = { ...ids, template: 'vite-react' };

      expect(EVENTS['project.created'].aggregate).toBe('project');
      expect(EVENTS['project.created'].payload.safeParse(payload)).toEqual({
        data: payload,
        success: true,
      });
      expect(
        EVENTS['project.created'].payload.safeParse({ ...payload, name: 'Shop' }).success,
      ).toBe(false);
      expect(
        EVENTS['project.created'].payload.safeParse({ ...ids, template: 'rails' }).success,
      ).toBe(false);
    });

    it('archived carries the ids only', () => {
      expect(EVENTS['project.archived'].aggregate).toBe('project');
      expect(EVENTS['project.archived'].payload.safeParse(ids)).toEqual({
        data: ids,
        success: true,
      });
      expect(EVENTS['project.archived'].payload.safeParse({ ...ids, name: 'Shop' }).success).toBe(
        false,
      );
    });

    /** Spec 017: the rotated-away label only, never the project's name. */
    it('preview-label.rotated carries the ids and the previous label', () => {
      const payload = {
        orgId: ids.orgId,
        previousLabel: 'swift-otter',
        projectId: ids.projectId,
      };

      expect(EVENTS['project.preview-label.rotated'].aggregate).toBe('project');
      expect(EVENTS['project.preview-label.rotated'].payload.safeParse(payload)).toEqual({
        data: payload,
        success: true,
      });
      expect(
        EVENTS['project.preview-label.rotated'].payload.safeParse({ ...payload, name: 'Shop' })
          .success,
      ).toBe(false);
    });
  });

  /** Spec 031 (data-model § 4): ids only, never an address, a name or a token. */
  describe('spec 031 events', () => {
    const orgId = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
    const projectId = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b';
    const id = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c';

    it('project.access-removed carries org, project and user ids only', () => {
      const entry = EVENTS['project.access-removed'];
      const payload = { orgId, projectId, userId: id };

      expect(entry.aggregate).toBe('project');
      expect(entry.payload.safeParse(payload)).toEqual({ data: payload, success: true });
      expect(entry.payload.safeParse({ ...payload, email: 'a@example.com' }).success).toBe(false);
    });

    it('mail.project-invitation carries the org and invitation ids, never the token', () => {
      const entry = EVENTS['mail.project-invitation'];
      const payload = { invitationId: id, orgId };

      expect(entry.aggregate).toBe('project-invitation');
      expect(entry.payload.safeParse(payload)).toEqual({ data: payload, success: true });
      expect(entry.payload.safeParse({ ...payload, token: 'plaintext' }).success).toBe(false);
    });
  });

  /** Spec 008: the dispatch event carries the three ids a worker needs and nothing it could read. */
  it('agent-run.requested carries the ids only', () => {
    const ids = {
      orgId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
      projectId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
      runId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5e',
    };

    expect(EVENTS['agent-run.requested'].aggregate).toBe('agent-run');
    expect(EVENTS['agent-run.requested'].payload.safeParse(ids)).toEqual({
      data: ids,
      success: true,
    });
    expect(
      EVENTS['agent-run.requested'].payload.safeParse({ ...ids, prompt: 'build it' }).success,
    ).toBe(false);
  });

  /** Spec 014: an op names its target and the op; a maintenance tick names the job and period. */
  describe('sandbox lifecycle events', () => {
    const orgId = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b';

    it('sandbox.op.requested carries ids and the op only', () => {
      const payload = { op: 'resume', orgId, sandboxId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5f' };

      expect(EVENTS['sandbox.op.requested'].aggregate).toBe('sandbox');
      expect(EVENTS['sandbox.op.requested'].payload.safeParse(payload)).toEqual({
        data: payload,
        success: true,
      });
      expect(
        EVENTS['sandbox.op.requested'].payload.safeParse({ ...payload, labels: { a: 'b' } })
          .success,
      ).toBe(false);
    });

    it('maintenance.due carries the job and the period only', () => {
      const payload = { job: 'sandbox.sweep', periodStart: '2026-09-17T10:00:00.000Z' };

      expect(EVENTS['maintenance.due'].aggregate).toBe('maintenance');
      expect(EVENTS['maintenance.due'].payload.safeParse(payload)).toEqual({
        data: payload,
        success: true,
      });
      expect(EVENTS['maintenance.due'].payload.safeParse({ ...payload, orgId }).success).toBe(
        false,
      );
    });

    /** Spec 018 R9: the daily connector health sweep rides the same tick. */
    it('maintenance.due accepts the connector.verify job', () => {
      const payload = { job: 'connector.verify', periodStart: '2026-09-17T00:00:00.000Z' };

      expect(EVENTS['maintenance.due'].payload.safeParse(payload).success).toBe(true);
    });

    /** Spec 020 US4: the daily provider-key check rides the same tick. */
    it('maintenance.due accepts the connector.ops-timeout job (spec 030 US6)', () => {
      const payload = { job: 'connector.ops-timeout', periodStart: '2026-09-17T00:00:00.000Z' };

      expect(EVENTS['maintenance.due'].payload.safeParse(payload).success).toBe(true);
    });

    it('maintenance.due accepts the byok.verify job', () => {
      const payload = { job: 'byok.verify', periodStart: '2026-09-17T00:00:00.000Z' };

      expect(EVENTS['maintenance.due'].payload.safeParse(payload).success).toBe(true);
    });

    /** Spec 028: the domain check routine rides the same tick, every 60 s. */
    it('maintenance.due accepts the domain.check job', () => {
      const payload = { job: 'domain.check', periodStart: '2026-09-17T10:01:00.000Z' };

      expect(EVENTS['maintenance.due'].payload.safeParse(payload).success).toBe(true);
    });

    /** Spec 027 research R8: the stuck-deployment sweep rides the same tick, every 300 s. */
    it('maintenance.due accepts the deploy.sweep job', () => {
      const payload = { job: 'deploy.sweep', periodStart: '2026-09-17T10:05:00.000Z' };

      expect(EVENTS['maintenance.due'].payload.safeParse(payload).success).toBe(true);
    });
  });

  /**
   * Spec 027 data-model § Events: a deployment event names the deployment and where it lives, and
   * a site event the project; never a log line, an artifact key or a checkpoint's contents.
   */
  describe('deploy and site events', () => {
    const ids = {
      deploymentId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
      orgId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
      projectId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
    };

    it.each([
      ['deploy.requested', 'deployment', ids],
      ['deploy.succeeded', 'deployment', { ...ids, siteLabel: 'swift-otter' }],
      ['deploy.failed', 'deployment', { ...ids, reason: 'build-failed' }],
      ['site.released', 'project', ids],
      ['site.offline', 'project', { orgId: ids.orgId, projectId: ids.projectId }],
    ] as const)('%s belongs to the %s and carries its payload only', (type, aggregate, payload) => {
      const entry = EVENTS[type];

      expect(entry.aggregate).toBe(aggregate);
      expect(entry.payload.safeParse(payload)).toEqual({ data: payload, success: true });
      expect(entry.payload.safeParse({ ...payload, logTail: 'npm ERR!' }).success).toBe(false);
    });

    it('deploy.failed names a reason from the failure vocabulary', () => {
      const entry = EVENTS['deploy.failed'];

      expect(entry.payload.safeParse({ ...ids, reason: 'platform' }).success).toBe(true);
      expect(entry.payload.safeParse({ ...ids, reason: 'the build broke' }).success).toBe(false);
      expect(entry.payload.safeParse(ids).success).toBe(false);
    });

    it('deploy.succeeded requires the site label, and the ids stay uuids', () => {
      const entry = EVENTS['deploy.succeeded'];

      expect(entry.payload.safeParse(ids).success).toBe(false);
      expect(
        entry.payload.safeParse({ ...ids, deploymentId: 'dep-1', siteLabel: 'swift-otter' })
          .success,
      ).toBe(false);
    });
  });

  /**
   * Spec 028 data-model § Events: a domain event names the domain and where it lives — never the
   * hostname, the ownership token or a DNS answer. `domain.removing` and `domain.failed` add the
   * reason from the closed failure vocabulary.
   */
  describe('domain events', () => {
    const ids = {
      domainId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
      orgId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
      projectId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
    };

    it.each([
      ['domain.added', ids],
      ['domain.activated', ids],
      ['domain.drifted', ids],
      ['domain.recovered', ids],
      ['domain.retried', ids],
      ['domain.removing', { ...ids, reason: null }],
      ['domain.removing', { ...ids, reason: 'caa-blocked' }],
      ['domain.failed', { ...ids, reason: 'verification-timeout' }],
      ['domain.removed', ids],
      ['domain.check-requested', ids],
    ] as const)('%s belongs to the domain and refuses an extra key', (type, payload) => {
      const entry = EVENTS[type];

      expect(entry.aggregate).toBe('domain');
      expect(entry.payload.safeParse(payload)).toEqual({ data: payload, success: true });
      expect(entry.payload.safeParse({ ...payload, hostname: 'app.acme.com' }).success).toBe(false);
    });

    it('domain.failed requires a reason from the failure vocabulary', () => {
      const entry = EVENTS['domain.failed'];

      expect(entry.payload.safeParse(ids).success).toBe(false);
      expect(entry.payload.safeParse({ ...ids, reason: null }).success).toBe(false);
      expect(entry.payload.safeParse({ ...ids, reason: 'dns broke' }).success).toBe(false);
    });

    it('domain.removing requires the reason key, null when the member asked', () => {
      const entry = EVENTS['domain.removing'];

      expect(entry.payload.safeParse(ids).success).toBe(false);
      expect(entry.payload.safeParse({ ...ids, reason: 'removed' }).success).toBe(false);
    });

    it('the ids stay uuids', () => {
      expect(
        EVENTS['domain.added'].payload.safeParse({ ...ids, domainId: 'app.acme.com' }).success,
      ).toBe(false);
    });

    describe('mail.domain', () => {
      const entry = EVENTS['mail.domain'];
      const payload = {
        domainId: ids.domainId,
        notice: 'drifted',
        recipient: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5d',
      } as const;

      it('carries the recipient user id, the domain id and the notice only', () => {
        expect(entry.aggregate).toBe('domain');
        expect(entry.payload.safeParse(payload)).toEqual({ data: payload, success: true });
        expect(entry.payload.safeParse({ ...payload, orgId: ids.orgId }).success).toBe(false);
        expect(entry.payload.safeParse({ ...payload, recipient: 'a@example.com' }).success).toBe(
          false,
        );
      });

      /** One notice per domain mail template, and nothing else. */
      it('names the notice from a closed enum, one per domain template', () => {
        const notices = MAIL_TEMPLATE_IDS.filter(isDomainTemplate).map((id) =>
          id.slice('domain-'.length),
        );

        expect(notices.sort()).toEqual(['drifted', 'failed', 'release-warning', 'released']);
        for (const notice of notices) {
          expect(entry.payload.safeParse({ ...payload, notice }).success).toBe(true);
        }
        expect(entry.payload.safeParse({ ...payload, notice: 'recovered' }).success).toBe(false);
      });
    });
  });

  /**
   * Spec 029 data-model § 7: the two new sources the fan-out reads, and the three webhook events,
   * carry ids and closed vocabularies only — never a URL, a body, a secret, a name or an email.
   */
  describe('webhook events', () => {
    const orgId = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
    const id = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b';
    const valid = {
      'agent-run.finished': { orgId, outcome: 'succeeded', projectId: id, runId: id },
      'mail.webhook': {
        endpointId: id,
        notice: 'paused',
        orgId,
        pausedAt: '2026-09-23T12:00:00.000Z',
        recipientUserId: id,
      },
      'member.joined': { orgId, role: 'member', userId: id },
      'webhook.attempt-due': { orgId, sendId: id },
      'webhook.endpoint-paused': { endpointId: id, orgId },
    } as const;

    it.each(Object.entries(valid))('%s is strict and refuses an extra key', (type, payload) => {
      const entry = EVENTS[type as keyof typeof valid];

      expect(entry.payload.safeParse(payload)).toEqual({ data: payload, success: true });
      expect(entry.payload.safeParse({ ...payload, url: 'https://x.test' }).success).toBe(false);
    });

    it('names the aggregates', () => {
      expect(EVENTS['agent-run.finished'].aggregate).toBe('agent-run');
      expect(EVENTS['member.joined'].aggregate).toBe('membership');
      expect(EVENTS['webhook.attempt-due'].aggregate).toBe('webhook-send');
      expect(EVENTS['webhook.endpoint-paused'].aggregate).toBe('webhook-endpoint');
      expect(EVENTS['mail.webhook'].aggregate).toBe('webhook-endpoint');
    });

    it('agent-run.finished names the outcome from a closed enum', () => {
      const entry = EVENTS['agent-run.finished'].payload;

      for (const outcome of ['succeeded', 'failed', 'cancelled']) {
        expect(entry.safeParse({ ...valid['agent-run.finished'], outcome }).success).toBe(true);
      }
      expect(entry.safeParse({ ...valid['agent-run.finished'], outcome: 'running' }).success).toBe(
        false,
      );
    });

    it('member.joined carries no email', () => {
      expect(
        EVENTS['member.joined'].payload.safeParse({
          ...valid['member.joined'],
          email: 'a@example.com',
        }).success,
      ).toBe(false);
    });

    it("mail.webhook's notice is 'paused' only, one per webhook template", () => {
      const notices = MAIL_TEMPLATE_IDS.filter(isWebhookTemplate).map((template) =>
        template.slice('webhook-'.length),
      );

      expect(notices).toEqual(['paused']);
      expect(
        EVENTS['mail.webhook'].payload.safeParse({ ...valid['mail.webhook'], notice: 'failing' })
          .success,
      ).toBe(false);
    });

    /** Spec 029 research R6: the redelivery sweep rides the maintenance tick, every 60 s. */
    it('maintenance.due accepts the webhook.redeliver job', () => {
      const payload = { job: 'webhook.redeliver', periodStart: '2026-09-23T10:01:00.000Z' };

      expect(EVENTS['maintenance.due'].payload.safeParse(payload).success).toBe(true);
    });
  });

  /**
   * Spec 032 T013: one event per person and provider — a user id, never an address, an
   * organisation or anything of the grant; `kind` picks the `byos-account` variant.
   */
  describe('mail.byos', () => {
    const payload = {
      kind: 'needs-reauth',
      provider: 'anthropic',
      recipientUserId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
    } as const;

    it('is strict, closed and on the linked-account aggregate', () => {
      const entry = EVENTS['mail.byos'];

      expect(entry.aggregate).toBe('linked-account');
      expect(entry.payload.safeParse(payload).success).toBe(true);
      expect(entry.payload.safeParse({ ...payload, kind: 'provider-withdrawn' }).success).toBe(
        true,
      );
      expect(entry.payload.safeParse({ ...payload, kind: 'limited' }).success).toBe(false);
      expect(entry.payload.safeParse({ ...payload, provider: 'mistral' }).success).toBe(false);
      expect(entry.payload.safeParse({ ...payload, orgId: payload.recipientUserId }).success).toBe(
        false,
      );
      expect(entry.payload.safeParse({ ...payload, accessToken: 'x' }).success).toBe(false);
    });
  });

  /** Spec 030 R15: the ops consumer reads the operation row — ids only on the event. */
  it('connector.op.requested carries the ids only', () => {
    const ids = {
      operationId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5d',
      orgId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
    };

    expect(EVENTS['connector.op.requested'].aggregate).toBe('connector-operation');
    expect(EVENTS['connector.op.requested'].payload.safeParse(ids)).toEqual({
      data: ids,
      success: true,
    });
    expect(
      EVENTS['connector.op.requested'].payload.safeParse({ ...ids, kind: 'neon_branch_create' })
        .success,
    ).toBe(false);
  });

  /** Spec 018: the push/pull consumers read the operation row — ids only on the event. */
  it('sync.requested carries the ids only', () => {
    const ids = {
      orgId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
      projectId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
      syncOperationId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5d',
    };

    expect(EVENTS['sync.requested'].aggregate).toBe('sync-operation');
    expect(EVENTS['sync.requested'].payload.safeParse(ids)).toEqual({ data: ids, success: true });
    expect(EVENTS['sync.requested'].payload.safeParse({ ...ids, kind: 'push' }).success).toBe(
      false,
    );
  });

  /** Spec 016: the mirror consumer reads the row for the sha — ids only on the event. */
  it('checkpoint.created carries the ids only', () => {
    const ids = {
      checkpointId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
      orgId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
      projectId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
    };

    expect(EVENTS['checkpoint.created'].aggregate).toBe('checkpoint');
    expect(EVENTS['checkpoint.created'].payload.safeParse(ids)).toEqual({
      data: ids,
      success: true,
    });
    expect(
      EVENTS['checkpoint.created'].payload.safeParse({ ...ids, label: 'Turn 3' }).success,
    ).toBe(false);
  });

  it('caps a serialised payload at 4 096 bytes (FR-007)', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(4_096);
  });
});
