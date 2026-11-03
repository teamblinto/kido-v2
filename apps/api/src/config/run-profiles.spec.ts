import { hasWorkerProfile, parseRunProfiles } from './run-profiles';

describe('run profiles (spec 013)', () => {
  it('parses a comma-separated list into a set, trimming and collapsing duplicates', () => {
    expect(parseRunProfiles(' api, agent ,agent ')).toEqual(new Set(['api', 'agent']));
  });

  it('refuses an empty list naming the valid set', () => {
    const message = 'RUN_PROFILES is required: one or more of api, agent, events, cron';

    expect(() => parseRunProfiles(undefined)).toThrow(message);
    expect(() => parseRunProfiles(' , ')).toThrow(message);
  });

  it('refuses an unknown name naming it and the valid set', () => {
    expect(() => parseRunProfiles('api,agnet')).toThrow(
      'RUN_PROFILES contains "agnet"; valid profiles are api, agent, events, cron',
    );
  });

  it('knows whether a set carries a worker profile', () => {
    expect(hasWorkerProfile(new Set(['api']))).toBe(false);
    expect(hasWorkerProfile(new Set(['api', 'cron']))).toBe(true);
    expect(hasWorkerProfile(new Set(['events']))).toBe(true);
  });
});
