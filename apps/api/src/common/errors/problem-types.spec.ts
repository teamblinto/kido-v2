import {
  PROBLEM_TYPE_BASE_URI,
  PROBLEM_TYPES,
  type ProblemType,
  problemTypeForStatus,
  type ProblemTypeSlug,
  problemTypeUri,
} from './problem-types';

/**
 * The catalogue seen as the interface rather than as its literal types: `as const` narrows each
 * entry to exactly the properties it has, so `definition.refines` is a compile error on the entries
 * that do not set it — which is every entry these tests have to check.
 */
const CATALOGUE: Readonly<Record<ProblemTypeSlug, ProblemType>> = PROBLEM_TYPES;

describe('problem type catalogue', () => {
  it('is frozen so a slug cannot be added or rewritten at runtime', () => {
    expect(Object.isFrozen(PROBLEM_TYPES)).toBe(true);
    expect(() => {
      Object.assign(PROBLEM_TYPES, { 'made-up': { status: 499, title: 'Made Up' } });
    }).toThrow(TypeError);
  });

  it('gives every slug an HTTP error status and a non-empty title', () => {
    for (const [slug, definition] of Object.entries(PROBLEM_TYPES)) {
      expect(slug, `${slug} must be kebab-case`).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(definition.status).toBeGreaterThanOrEqual(400);
      expect(definition.status).toBeLessThan(600);
      expect(definition.title.length).toBeGreaterThan(0);
    }
  });

  /**
   * Narrowed from "every slug" when T12 added three password rejections that are all 422: a slug
   * that {@link ProblemType.refines} another is a *refinement* of it, not a second claimant to the
   * status, so it is excluded here and constrained harder by the two tests below. The property the
   * original test protected — that `problemTypeForStatus` has exactly one answer — is unchanged.
   */
  it('gives every status-owning slug a distinct status so status lookup is unambiguous', () => {
    const statuses = Object.values(CATALOGUE)
      .filter((definition) => definition.refines === undefined)
      .map((definition) => definition.status);

    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it('points every refinement at a catalogued slug that owns the status it shares', () => {
    for (const [slug, definition] of Object.entries(CATALOGUE)) {
      if (definition.refines === undefined) {
        continue;
      }

      const parent = CATALOGUE[definition.refines as ProblemTypeSlug] as ProblemType | undefined;

      expect(parent, `${slug} refines an uncatalogued slug`).toBeDefined();
      expect(parent?.refines, `${slug} refines a refinement`).toBeUndefined();
      expect(parent?.status, `${slug} must share the status it refines`).toBe(definition.status);
    }
  });

  /**
   * §11 rejects a password for three different reasons, and "your password is unacceptable" is not
   * an answer a user can act on. Three slugs, so the client can say *which* thing to fix — all of
   * them 422 refinements of `validation-failed`, because that is what they are to a generic client.
   */
  it('gives each of the three password rejections its own slug', () => {
    const slugs = [
      'password-breached',
      'password-too-weak',
      'password-uses-personal-information',
    ] as const;

    expect(new Set(slugs).size).toBe(slugs.length);

    for (const slug of slugs) {
      expect(CATALOGUE[slug].status).toBe(422);
      expect(CATALOGUE[slug].refines).toBe('validation-failed');
    }
  });

  /**
   * T14, criterion 2. A dead verification link fails in three ways and the reader can only act on
   * the difference: ask for a new one, sign in because you already did this, or check you copied
   * the whole link. One `token-invalid` for all three would push that distinction into prose, where
   * no client can branch on it and no support reply can be written in advance.
   *
   * All three are 400 refinements of `bad-request`, not statuses of their own. To HTTP they are one
   * thing — the token you presented will not work — and the slug is what separates them, exactly as
   * it separates the three password rejections that share a 422.
   */
  it('gives each of the three ways a token is dead its own slug', () => {
    const slugs = ['token-already-used', 'token-expired', 'token-invalid'] as const;

    expect(new Set(slugs).size).toBe(slugs.length);

    for (const slug of slugs) {
      expect(CATALOGUE[slug].status).toBe(400);
      expect(CATALOGUE[slug].refines).toBe('bad-request');
    }
  });

  /**
   * The fourth case, and the one criterion 2 names on its own: an address change invalidates an
   * outstanding link. It is not `token-invalid` — the link was real and the reader did copy it
   * correctly — and it is the only one of the four whose remedy involves a different mailbox.
   */
  it('separates a token invalidated by an address change from one that was never valid', () => {
    expect(CATALOGUE['verification-address-changed'].status).toBe(400);
    expect(CATALOGUE['verification-address-changed'].refines).toBe('bad-request');
    expect(CATALOGUE['verification-address-changed']).not.toEqual(CATALOGUE['token-invalid']);
  });

  it('carries the slugs the domain error base classes depend on', () => {
    expect(PROBLEM_TYPES.conflict.status).toBe(409);
    expect(PROBLEM_TYPES.forbidden.status).toBe(403);
    expect(PROBLEM_TYPES['internal-server-error'].status).toBe(500);
    expect(PROBLEM_TYPES['not-found'].status).toBe(404);
    expect(PROBLEM_TYPES['rate-limited'].status).toBe(429);
  });
});

describe('problemTypeUri', () => {
  it('builds an absolute, dereferenceable URI whose last segment is the stable slug', () => {
    expect(problemTypeUri('not-found')).toBe(`${PROBLEM_TYPE_BASE_URI}not-found`);
    expect(problemTypeUri('rate-limited').endsWith('/rate-limited')).toBe(true);
    expect(() => new URL(problemTypeUri('conflict'))).not.toThrow();
  });
});

describe('problemTypeForStatus', () => {
  it('resolves the slug a catalogued status belongs to', () => {
    expect(problemTypeForStatus(404)).toBe('not-found');
    expect(problemTypeForStatus(429)).toBe('rate-limited');
    expect(problemTypeForStatus(500)).toBe('internal-server-error');
  });

  /**
   * A framework-thrown 422 means "the body did not validate", not "the password was found in a
   * breach corpus". The reverse lookup answers with the slug that owns the status, never with one of
   * its refinements — which is the whole reason refinements are excluded from the uniqueness rule.
   */
  it('resolves a shared status to the slug that owns it, never to a refinement', () => {
    expect(problemTypeForStatus(422)).toBe('validation-failed');
  });

  it('returns undefined for a status the catalogue makes no promise about', () => {
    expect(problemTypeForStatus(418)).toBeUndefined();
    expect(problemTypeForStatus(200)).toBeUndefined();
  });
});
