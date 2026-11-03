import type { DomainFailureReason } from '@repo/contracts';
import type { Domain } from '@repo/db';

import { type CheckResult, nextCheckAt } from './check-schedule';
import type { EdgeStatus } from './custom-hostname.port';
import type { DnsAnswer } from './dns.port';
import {
  DRIFT_THRESHOLD,
  RELEASE_AFTER_MS,
  RELEASE_WARNING_MS,
  WINDOW_MS,
} from './domain.constants';
import type { DomainCheck } from './domain.repository';
import { ownershipTxtValue } from './ownership-token';

/**
 * What a domain check decides (spec 028 research R6). Pure: the checker's observe step gathers
 * the DNS answers and the edge status with no transaction held, and its settle step writes what
 * this returns. Every rule of US1, US3 and US4 lives here, so its spec covers them without I/O.
 */

/** A CAA verdict (R5) as the checker computes it from the chain, or `unavailable`. */
export type CaaObservation = DomainCheck['caa'] | { readonly verdict: 'unavailable' };

/** The edge's answer to `status(edge_id)`, or `unavailable` for a retryable failure. */
export type EdgeObservation =
  ({ readonly kind: 'status' } & EdgeStatus) | { readonly kind: 'unavailable' };

/**
 * What the checker's observe step saw, built straight from `DnsPort` and `CustomHostnamePort`
 * answers. An absent optional field is a question that was not asked.
 */
export interface CheckObservations {
  /** `CUSTOM_HOSTNAME_TARGET`: the CNAME chain must reach it for routing to be found. */
  readonly routingTarget: string;
  /**
   * `resolveTxt(CHALLENGE_PREFIX + hostname)`. Asked while ownership is unproved; once
   * `ownership_verified_at` is set it need not be (R3), and `active`/`drifted` never ask (T061).
   */
  readonly challengeTxt?: DnsAnswer<{ readonly records: readonly string[] }>;
  /** `resolveCnameChain(hostname)`. */
  readonly cnameChain: DnsAnswer<{ readonly chain: readonly string[] }>;
  /** `resolveSoaOwner(hostname)`, for the `apex` routing status. Not asked by `active`/`drifted`. */
  readonly soaOwner?: DnsAnswer<{ readonly owner: string }>;
  /**
   * `caaVerdictFromAnswers` over the CAA chain (R5): `unavailable` only when a level at or below
   * the first non-empty set was. The observe step always asks it; absent is recorded `permitted`.
   */
  readonly caa?: CaaObservation;
  /** `status(edge_id)`, asked only when the row has an `edge_id`. */
  readonly edge?: EdgeObservation;
}

/** The subset of the row the rules read. */
export type CheckedDomain = Pick<
  Domain,
  | 'activatedAt'
  | 'certificateActiveAt'
  | 'driftedAt'
  | 'edgeId'
  | 'failureCount'
  | 'hostname'
  | 'ownershipToken'
  | 'ownershipVerifiedAt'
  | 'releaseWarnedAt'
  | 'removalRequestedAt'
  | 'state'
  | 'windowStartedAt'
>;

export type RecordStatus = DomainCheck['records'][number]['status'];

/** One status per record shown to the member; `certificate` only when the edge asks for one (R4). */
export interface RecordStatuses {
  readonly ownership: RecordStatus;
  readonly routing: RecordStatus;
  readonly certificate: RecordStatus | null;
}

/** A state change. The settle writes it with its audit row and outbox event (FR-027). */
export interface DomainTransition {
  readonly from: Domain['state'];
  readonly to: Domain['state'];
  /** Set for `→ failed`, and for `→ removing` at the window's end, heading for `failed` (US4). */
  readonly failureReason: DomainFailureReason | null;
}

/**
 * Columns the settle writes besides `state`, `failure_reason`, `next_check_at` and `last_check`.
 * An absent key leaves the column as it is.
 */
export type DomainChanges = Partial<
  Pick<
    Domain,
    | 'activatedAt'
    | 'certificateActiveAt'
    | 'driftedAt'
    | 'failureCount'
    | 'ownershipVerifiedAt'
    | 'releaseWarnedAt'
    | 'removalRequestedAt'
  >
>;

export interface CheckOutcome {
  /** False when a resolver or the edge was unavailable: nothing else changes (FR-021). */
  readonly conclusive: boolean;
  readonly transition: DomainTransition | null;
  readonly changes: DomainChanges;
  /** Register the hostname at the edge in this settle (R3): ownership proved, no `edge_id` yet. */
  readonly register: boolean;
  /**
   * Send the 7-day release warning in this settle (R14): `drifted` for `RELEASE_WARNING_MS` and
   * not yet warned. `changes.releaseWarnedAt` is set with it, so it is asked for once per drift.
   */
  readonly releaseWarning: boolean;
  readonly recordStatuses: RecordStatuses;
  readonly nextCheckAt: Date;
  /** The row's new `last_check`. `edgeMessage` is the checker's to set, on `EdgeRefused`. */
  readonly lastCheck: DomainCheck;
}

export function evaluateCheck(
  domain: CheckedDomain,
  observations: CheckObservations,
  now: Date,
): CheckOutcome {
  switch (domain.state) {
    case 'pending':
      return evaluatePending(domain, observations, now);
    case 'active':
    case 'drifted':
      return evaluateLive(domain, observations, now);
    case 'removing':
      // Nothing to evaluate: the checker deregisters it at the edge (R10), with no DNS asked.
      throw new Error('evaluateCheck: a removing domain is deregistered, never evaluated');
    case 'failed':
    case 'removed':
      throw new Error(`evaluateCheck: a ${domain.state} domain is never checked`);
  }
}

function evaluatePending(
  domain: CheckedDomain,
  observations: CheckObservations,
  now: Date,
): CheckOutcome {
  const edge = observations.edge?.kind === 'status' ? observations.edge : undefined;
  const recordStatuses = recordStatusesFor(domain, observations, edge);
  const conclusive = isConclusive(observations);

  if (!conclusive) {
    return {
      changes: {},
      conclusive,
      lastCheck: lastCheckFor(observations, edge, recordStatuses, conclusive, now),
      nextCheckAt: nextCheckAt(domain, 'inconclusive', now),
      recordStatuses,
      register: false,
      releaseWarning: false,
      transition: null,
    };
  }

  const ownershipProved = recordStatuses.ownership === 'found';
  const changes: DomainChanges = {};
  if (ownershipProved && domain.ownershipVerifiedAt === null) changes.ownershipVerifiedAt = now;
  if (edge?.certificate === 'active' && domain.certificateActiveAt === null) {
    changes.certificateActiveAt = now;
  }

  // FR-009: ownership alone never qualifies; the edge's hostname and certificate must be active too.
  const activates = ownershipProved && edge?.hostname === 'active' && edge.certificate === 'active';
  if (activates && domain.activatedAt === null) changes.activatedAt = now;

  const lastCheck = lastCheckFor(observations, edge, recordStatuses, conclusive, now);
  const windowEnd = domain.windowStartedAt.getTime() + WINDOW_MS;

  // US4: the window has passed without activation. An unregistered domain ends `failed` here;
  // a registered one goes `removing` with the reason riding on it, due at once, and the checker's
  // deregistration settles it `failed` (R10). Nothing is registered on the way out.
  if (!activates && now.getTime() >= windowEnd) {
    const failureReason = windowEndReason(domain, observations, recordStatuses, edge);
    const registered = domain.edgeId !== null;
    return {
      changes: registered ? { ...changes, removalRequestedAt: now } : changes,
      conclusive,
      lastCheck,
      // Due at once when removing; an ended row is never due again.
      nextCheckAt: now,
      recordStatuses,
      register: false,
      releaseWarning: false,
      transition: { failureReason, from: 'pending', to: registered ? 'removing' : 'failed' },
    };
  }

  const result: CheckResult = activates ? 'passed' : 'failed';
  // The schedule of the state that was checked: an activation is followed by pending's cadence
  // once, and the active schedule applies from the next check. A pending domain's last check
  // falls on the window's end rather than up to an hour after it.
  const scheduled = nextCheckAt(domain, result, now);
  return {
    changes,
    conclusive,
    lastCheck,
    nextCheckAt: activates ? scheduled : new Date(Math.min(scheduled.getTime(), windowEnd)),
    recordStatuses,
    register: ownershipProved && domain.edgeId === null,
    releaseWarning: false,
    transition: activates ? { failureReason: null, from: 'pending', to: 'active' } : null,
  };
}

/**
 * The most specific cause known when the window ends (R6), in the order `caa-blocked`,
 * `ownership-not-found`, `routing-not-found`, `certificate-failed`, and `verification-timeout`
 * when nothing specific is known. "Known" means the member's DNS shows an attempt: with no records
 * at all the domain ends `verification-timeout` (SC-008), so an unproved ownership counts only
 * when a TXT with another value is published or the CNAME is in place; an apex is always known
 * (FR-003). `provider-refused` is never a window-end reason: a refusal ends the domain at once.
 */
function windowEndReason(
  domain: CheckedDomain,
  observations: CheckObservations,
  statuses: RecordStatuses,
  edge: EdgeStatus | undefined,
): DomainFailureReason {
  if (observations.caa?.verdict === 'blocked') return 'caa-blocked';

  const ownershipProved = statuses.ownership === 'found';
  if (!ownershipProved && (statuses.ownership === 'mismatch' || statuses.routing === 'found')) {
    return 'ownership-not-found';
  }
  if (statuses.routing === 'apex' || (ownershipProved && statuses.routing !== 'found')) {
    return 'routing-not-found';
  }
  if (domain.edgeId !== null && edge !== undefined && edge.certificate !== 'active') {
    return 'certificate-failed';
  }
  return 'verification-timeout';
}

/**
 * An `active` or `drifted` domain's check (R6). A check passes when the edge reports the hostname
 * and the certificate active, routing is found, and CAA does not block the pinned CA.
 *
 * - `active`: a pass resets `failure_count`; a failure counts, and the `DRIFT_THRESHOLD`th
 *   consecutive one moves it to `drifted`, stamping `drifted_at`.
 * - `drifted`: one pass returns it to `active` (`domain.recovered`), clearing `drifted_at`, the
 *   count and `release_warned_at`, so a later drift is warned about again. A failure leaves the
 *   count at the threshold (the data model's `BETWEEN 0 AND 3` CHECK). At `RELEASE_WARNING_MS`
 *   drifted it asks for the warning once; at `RELEASE_AFTER_MS` it is released: `removing` with no
 *   reason, due at once, deregistered and settled `removed` as any removal is (R9, R10).
 *
 * An inconclusive check changes nothing, and so neither counts, warns nor releases (FR-021).
 */
function evaluateLive(
  domain: CheckedDomain,
  observations: CheckObservations,
  now: Date,
): CheckOutcome {
  const edge = observations.edge?.kind === 'status' ? observations.edge : undefined;
  const recordStatuses = recordStatusesFor(domain, observations, edge);
  const conclusive = isConclusive(observations);
  const lastCheck = lastCheckFor(observations, edge, recordStatuses, conclusive, now);
  const unchanged = {
    changes: {},
    conclusive,
    lastCheck,
    recordStatuses,
    register: false,
    releaseWarning: false,
    transition: null,
  } as const;

  if (!conclusive) return { ...unchanged, nextCheckAt: nextCheckAt(domain, 'inconclusive', now) };

  const passed =
    edge?.hostname === 'active' &&
    edge.certificate === 'active' &&
    recordStatuses.routing === 'found' &&
    observations.caa?.verdict !== 'blocked';
  const next = nextCheckAt(domain, passed ? 'passed' : 'failed', now);

  if (domain.state === 'active') {
    if (passed) {
      return {
        ...unchanged,
        changes: domain.failureCount === 0 ? {} : { failureCount: 0 },
        nextCheckAt: next,
      };
    }
    const failureCount = Math.min(domain.failureCount + 1, DRIFT_THRESHOLD);
    if (failureCount < DRIFT_THRESHOLD) {
      return { ...unchanged, changes: { failureCount }, nextCheckAt: next };
    }
    return {
      ...unchanged,
      changes: { driftedAt: now, failureCount },
      nextCheckAt: next,
      transition: { failureReason: null, from: 'active', to: 'drifted' },
    };
  }

  if (passed) {
    return {
      ...unchanged,
      changes: { driftedAt: null, failureCount: 0, releaseWarnedAt: null },
      nextCheckAt: next,
      transition: { failureReason: null, from: 'drifted', to: 'active' },
    };
  }

  const driftAge = now.getTime() - (domain.driftedAt ?? now).getTime();
  if (driftAge >= RELEASE_AFTER_MS) {
    return {
      ...unchanged,
      // `release_warned_at` stays set on the `removing` row: it is what tells the deregistration's
      // settle that this removal is a drift release, whose end sends `domain-released` (R14).
      // A release no warning preceded (checks inconclusive through the warning's day) stamps it.
      changes: {
        driftedAt: null,
        releaseWarnedAt: domain.releaseWarnedAt ?? now,
        removalRequestedAt: now,
      },
      nextCheckAt: now,
      transition: { failureReason: null, from: 'drifted', to: 'removing' },
    };
  }
  if (driftAge >= RELEASE_WARNING_MS && domain.releaseWarnedAt === null) {
    return {
      ...unchanged,
      changes: { releaseWarnedAt: now },
      nextCheckAt: next,
      releaseWarning: true,
    };
  }
  return { ...unchanged, nextCheckAt: next };
}

/** Every question asked was answered; an unavailable resolver or edge changes nothing (R6). */
function isConclusive(observations: CheckObservations): boolean {
  return ![
    observations.challengeTxt?.kind,
    observations.cnameChain.kind,
    observations.soaOwner?.kind,
    observations.edge?.kind,
    observations.caa?.verdict,
  ].includes('unavailable');
}

function recordStatusesFor(
  domain: CheckedDomain,
  observations: CheckObservations,
  edge: EdgeStatus | undefined,
): RecordStatuses {
  return {
    certificate:
      edge === undefined || edge.validationRecords.length === 0
        ? null
        : edge.certificate === 'active'
          ? 'found'
          : 'missing',
    ownership: ownershipStatus(domain, observations.challengeTxt),
    routing: routingStatus(domain, observations, edge),
  };
}

/** Ownership is proved once (R3): after `ownership_verified_at` the TXT need not stay. */
function ownershipStatus(
  domain: CheckedDomain,
  txt: CheckObservations['challengeTxt'],
): RecordStatus {
  if (domain.ownershipVerifiedAt !== null) return 'found';
  switch (txt?.kind) {
    case undefined:
    case 'unavailable':
      return 'unchecked';
    case 'empty':
      return 'missing';
    case 'answer':
      // Exactly `forge-verify=<token>`: another row's token or a near miss proves nothing.
      return txt.records.includes(ownershipTxtValue(domain.ownershipToken)) ? 'found' : 'mismatch';
  }
}

/**
 * Routing is found when the CNAME chain reaches the target, or when the edge reports the hostname
 * active: a customer zone on the same edge may hide the CNAME behind its own proxy (R6).
 */
function routingStatus(
  domain: CheckedDomain,
  observations: CheckObservations,
  edge: EdgeStatus | undefined,
): RecordStatus {
  const { cnameChain, soaOwner } = observations;
  const target = observations.routingTarget.toLowerCase();
  if (edge?.hostname === 'active') return 'found';
  if (
    cnameChain.kind === 'answer' &&
    cnameChain.chain.some((name) => name.toLowerCase() === target)
  ) {
    return 'found';
  }
  // An SOA owned by the name itself is a zone apex, where no CNAME can sit.
  if (soaOwner?.kind === 'answer' && soaOwner.owner.toLowerCase() === domain.hostname)
    return 'apex';
  switch (cnameChain.kind) {
    case 'answer':
      return 'mismatch';
    case 'empty':
      return 'missing';
    case 'unavailable':
      return 'unchecked';
  }
}

function lastCheckFor(
  observations: CheckObservations,
  edge: EdgeStatus | undefined,
  statuses: RecordStatuses,
  conclusive: boolean,
  now: Date,
): DomainCheck {
  const records: DomainCheck['records'] = [
    { purpose: 'ownership', status: statuses.ownership },
    { purpose: 'routing', status: statuses.routing },
  ];
  if (statuses.certificate !== null) {
    records.push({ purpose: 'certificate', status: statuses.certificate });
  }
  const caa = observations.caa;
  return {
    at: now.toISOString(),
    caa: caa === undefined || caa.verdict === 'unavailable' ? { verdict: 'permitted' } : caa,
    certificateRecords: edge?.validationRecords.map(({ name, value }) => ({ name, value })) ?? [],
    conclusive,
    edge: edge === undefined ? null : { certificate: edge.certificate, hostname: edge.hostname },
    edgeMessage: null,
    records,
  };
}
