import type { Environment } from '../../../config/environment';
import type { CaaRecord, DnsAnswer, DnsPort } from './dns.port';
import type { DomainCheck } from './domain.repository';
import type { CaaObservation } from './evaluate-check';

/**
 * The CAA verdict for a custom hostname (spec 028 research R5): may the pinned certificate
 * authority issue for it? A blocked verdict names the zone holding the relevant set and the
 * record that would permit issuance, so the member is told the fix (FR-014) instead of waiting
 * for the edge's issuance to time out.
 *
 * RFC 8659's tree climb: the relevant set is the first non-empty CAA RRset walking from the
 * hostname upwards, stopping above the top-level label. In that set:
 *
 * - an unknown property with the issuer-critical flag → `blocked` (§4.1);
 * - no `issue` and no `issuewild` property → `permitted`;
 * - an `issue` whose value, before any `;` parameters, is the pinned CA's identifier →
 *   `permitted`;
 * - otherwise `blocked`. `issuewild` never permits, because our hostnames are not wildcards, so a
 *   set holding only `issuewild` for our CA blocks (spec edge case).
 *
 * The resolver follows a CNAME at a queried name by itself, which is why the platform's target
 * zone must publish no restrictive CAA (quickstart prerequisite 3).
 */

export type CaaVerdict = DomainCheck['caa'];

/** One level of the chain: the RRset at exactly `zone`, empty when it has none. */
export interface CaaLevel {
  readonly zone: string;
  readonly records: readonly CaaRecord[];
}

/** One level's `DnsPort.resolveCaa` answer. */
export interface CaaLevelAnswer {
  readonly zone: string;
  readonly answer: DnsAnswer<{ readonly records: readonly CaaRecord[] }>;
}

/** The CAA issuer domain of each CA `CUSTOM_HOSTNAME_CA` may pin. */
const CAA_IDENTIFIERS: Readonly<Record<Environment['CUSTOM_HOSTNAME_CA'], string>> = {
  google: 'pki.goog',
  lets_encrypt: 'letsencrypt.org',
};

const KNOWN_TAGS = new Set(['iodef', 'issue', 'issuewild']);

export function caaIdentifier(ca: Environment['CUSTOM_HOSTNAME_CA']): string {
  return CAA_IDENTIFIERS[ca];
}

/** `hostname`, then each parent above the top-level label: `a.acme.com` → `[a.acme.com, acme.com]`. */
export function caaChain(hostname: string): string[] {
  const labels = hostname.split('.');
  const chain: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) chain.push(labels.slice(i).join('.'));
  return chain;
}

/** An `issue` value's issuer domain: the part before any `;` parameters, trimmed, lowercase. */
function issuerOf(value: string): string {
  // `split` always answers at least one element, the whole value when there is no `;`.
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function setVerdict(level: CaaLevel, identifier: string): CaaVerdict {
  const { records, zone } = level;
  const blocked: CaaVerdict = { record: `0 issue "${identifier}"`, verdict: 'blocked', zone };
  if (records.some((record) => record.critical && !KNOWN_TAGS.has(record.tag))) return blocked;
  if (!records.some((record) => record.tag === 'issue' || record.tag === 'issuewild')) {
    return { verdict: 'permitted' };
  }
  const wanted = identifier.toLowerCase();
  return records.some((record) => record.tag === 'issue' && issuerOf(record.value) === wanted)
    ? { verdict: 'permitted' }
    : blocked;
}

/** The verdict over `chain` (hostname first) for the CA whose issuer domain is `identifier`. */
export function caaVerdict(chain: readonly CaaLevel[], identifier: string): CaaVerdict {
  const relevant = chain.find((level) => level.records.length > 0);
  return relevant === undefined ? { verdict: 'permitted' } : setVerdict(relevant, identifier);
}

/**
 * The verdict over `resolveCaa` answers for the chain (hostname first). `unavailable` only when a
 * level at or below the relevant set was: a level above it cannot change the verdict.
 */
export function caaVerdictFromAnswers(
  answers: readonly CaaLevelAnswer[],
  identifier: string,
): CaaObservation {
  for (const { answer, zone } of answers) {
    if (answer.kind === 'unavailable') return { verdict: 'unavailable' };
    if (answer.kind === 'answer' && answer.records.length > 0) {
      return setVerdict({ records: answer.records, zone }, identifier);
    }
  }
  return { verdict: 'permitted' };
}

/** The observe step's CAA question: `resolveCaa` at every level of `hostname`'s chain, in parallel. */
export async function observeCaa(
  dns: DnsPort,
  hostname: string,
  identifier: string,
): Promise<CaaObservation> {
  const answers = await Promise.all(
    caaChain(hostname).map(async (zone) => ({ answer: await dns.resolveCaa(zone), zone })),
  );
  return caaVerdictFromAnswers(answers, identifier);
}
