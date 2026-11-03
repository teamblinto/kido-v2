import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CONNECTOR_HEALTH, connectionSchema, repositorySchema } from './connection';
import { repoLinkSchema } from './repo-link';

/**
 * SC-014, the half a passing suite cannot prove.
 *
 * Spec 026 is allowed to widen `sync.ts` and to add `import.ts`, and it did both. It is *not*
 * allowed to touch spec 018's two frozen contracts — the connection and the repository link — and
 * that is a claim about the files themselves, not about behaviour. A behavioural test would still
 * pass if someone added an optional field: optional fields parse the old payloads fine, and spec
 * 018's own suite would stay green while its contract had quietly grown. So the assertion is on
 * the bytes.
 *
 * The digests below are the two files as they stand on `origin/auth`, unchanged by this feature
 * (`git diff origin/auth -- connection.ts repo-link.ts` is empty). Anything that edits either file
 * — a field, a comment, a reformat — fails this test, and whoever did it has to come here, read
 * SC-014, and decide deliberately rather than by accident.
 *
 * This is why spec 026 gave `templateMismatch` its own route (`GET …/import-mismatch`) instead of
 * widening `repoLinkSchema`, which contracts § 4 would otherwise have made the obvious place for
 * it: § 3 and SC-014 forbid opening this file, so the panel's extra fact is fetched beside the
 * link rather than inside it.
 *
 * If a later spec genuinely must change one of these, the fix is to update the digest **in the
 * same commit as the change**, with the reason in the message — not to delete the test.
 */
const FROZEN: Readonly<Record<string, string>> = {
  // Spec 030 (research R2, contracts/bindings.md § 1) widened `connection.ts` deliberately:
  // `CONNECTOR_PROVIDERS` gained five values and `connectionSchema` became a discriminated union
  // on `provider` whose `github` arm (`githubConnectionSchema`) is 018's object unchanged but for
  // `provider` narrowing to the literal. The digest was updated in that commit, for that reason.
  'connection.ts': '26fea3b8c68305cbf107aa3dcb31fe39cdba463f06d8780cbd3cefa1c519061c',
  'repo-link.ts': '2f1306a8d33f2be9a21a8c4b90928cc1b9dcea2fc26584cf693610d7fcd19de8',
};

function digestOf(file: string): string {
  return createHash('sha256')
    .update(readFileSync(new URL(file, import.meta.url)))
    .digest('hex');
}

describe("spec 018's frozen contracts (SC-014)", () => {
  for (const [file, digest] of Object.entries(FROZEN)) {
    it(`SC-014: ${file} is byte-for-byte what spec 018 left`, () => {
      expect(digestOf(file)).toBe(digest);
    });
  }

  /**
   * The digest catches an edit; this catches the other direction — a file replaced wholesale by
   * one that happens to hash the same way is not a thing that happens, but a *deleted export* that
   * someone re-added elsewhere is. These are the names spec 018's clients import.
   */
  it('SC-014: still exports the connection and link shapes spec 018 published', () => {
    expect(typeof connectionSchema.parse).toBe('function');
    expect(typeof repositorySchema.parse).toBe('function');
    expect(typeof repoLinkSchema.parse).toBe('function');
    expect([...CONNECTOR_HEALTH]).toEqual(['healthy', 'needs_reauth', 'unavailable']);
  });
});
