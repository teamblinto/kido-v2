/**
 * The run profiles a process may carry (spec 013). `api` serves requests; the other three are the
 * worker lanes — `agent` executes runs, `events` relays the outbox and drains the light queues,
 * `cron` sweeps. The schema parses `RUN_PROFILES` through this file, and `main.ts` reads it again
 * to choose a factory; the two agree because there is one parser. Imports nothing: `config/` may
 * not reach into `modules/` (constitution I).
 */
export const RUN_PROFILES = ['api', 'agent', 'events', 'cron'] as const;
export type RunProfile = (typeof RUN_PROFILES)[number];
export type WorkerProfile = Exclude<RunProfile, 'api'>;

const VALID = RUN_PROFILES.join(', ');

/** Trims, drops empty entries, collapses duplicates; throws the schema's refinement messages. */
export function parseRunProfiles(raw: string | undefined): ReadonlySet<RunProfile> {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  if (names.length === 0) {
    throw new Error(`RUN_PROFILES is required: one or more of ${VALID}`);
  }

  for (const name of names) {
    if (!(RUN_PROFILES as readonly string[]).includes(name)) {
      throw new Error(`RUN_PROFILES contains "${name}"; valid profiles are ${VALID}`);
    }
  }

  return new Set(names as RunProfile[]);
}

export function hasWorkerProfile(profiles: ReadonlySet<RunProfile>): boolean {
  return RUN_PROFILES.some((profile) => profile !== 'api' && profiles.has(profile));
}
