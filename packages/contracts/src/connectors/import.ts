import { z } from 'zod';

import { projectTemplateSchema } from '../tenancy/project';

/**
 * Importing a GitHub repository into a new project (spec 026, contracts § 1–2).
 *
 * Inspection is read-only despite its verb — two GitHub calls, no rows — and its `outcome` is
 * derived from `candidates` rather than chosen, so the client never re-derives it. Starting an
 * import always carries an explicit `template`: FR-011's "no template is applied by default" is a
 * property of the wire, not of the UI, which is why `template` here has no `.default()`.
 */

/** `POST /orgs/:orgId/workspaces/:workspaceId/imports/inspect`. */
export const inspectImportRequestSchema = z.strictObject({
  branch: z.string().min(1).max(255).optional(),
  repoId: z.int().positive(),
});

export type InspectImportRequest = z.output<typeof inspectImportRequestSchema>;

/**
 * One template the repository's contents point at, with the evidence that points there. At least
 * one piece of evidence, because a candidate nobody can explain is a guess the user cannot check.
 */
export const importCandidateSchema = z.strictObject({
  evidence: z.array(z.string().min(1)).min(1),
  template: projectTemplateSchema,
});

export type ImportCandidate = z.output<typeof importCandidateSchema>;

/** Contracts § 1: derived from `candidates.length`, never chosen independently. */
export const IMPORT_OUTCOMES = ['proposed', 'ambiguous', 'unrecognised'] as const;

export const importOutcomeSchema = z.enum(IMPORT_OUTCOMES);

export type ImportOutcome = z.output<typeof importOutcomeSchema>;

/** The single derivation both sides use, so "derived, not chosen" has one implementation. */
export function outcomeFor(candidateCount: number): ImportOutcome {
  if (candidateCount === 0) {
    return 'unrecognised';
  }

  return candidateCount === 1 ? 'proposed' : 'ambiguous';
}

const headShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

/**
 * The inspection result. The `outcome`/`candidates` agreement is checked here rather than trusted:
 * a response that says `proposed` with two candidates, or `unrecognised` with one, is a server bug
 * the client would otherwise render as a working proposal. An `unrecognised` repository carries an
 * empty array — the server never ships a default template as a candidate (FR-011).
 */
export const inspectImportResponseSchema = z
  .strictObject({
    branch: z.string().min(1),
    candidates: z.array(importCandidateSchema),
    empty: z.boolean(),
    headSha: headShaSchema.nullable(),
    outcome: importOutcomeSchema,
    repo: z.strictObject({
      id: z.int().positive(),
      name: z.string().min(1),
      owner: z.string().min(1),
    }),
    sizeKib: z.int().nonnegative(),
  })
  .refine(
    (value) => value.outcome === outcomeFor(value.candidates.length),
    'outcome must be derived from the number of candidates',
  );

export type InspectImportResponse = z.output<typeof inspectImportResponseSchema>;

/**
 * `POST /orgs/:orgId/workspaces/:workspaceId/imports`.
 *
 * `template` is required on every import, including the `proposed` case: the client echoes back
 * what the user confirmed, and the server honours it even when a re-inspection now disagrees
 * (FR-013), recording the disagreement as the FR-016 warning instead.
 */
export const startImportRequestSchema = z.strictObject({
  /** Spec 047: omitted means the repository's default branch. */
  branch: z.string().min(1).max(255).optional(),
  /** Spec 047: omitted means the server names the project (and may rename it once it knows more). */
  name: z.string().trim().min(1).max(100).optional(),
  repoId: z.int().positive(),
  /**
   * Spec 026's explicit template. Spec 047: omitted is a smart import — the repository's own run
   * profile is detected from its contents and no template is applied.
   */
  template: projectTemplateSchema.optional(),
});

export type StartImportRequest = z.output<typeof startImportRequestSchema>;

/**
 * Contracts § 4: the FR-016 warning as a field on the project's GitHub panel payload. Null when
 * the chosen template is what inspection would say now; one line in the panel when it is not.
 * Nothing is blocked either way — a runtime mismatch is not a failed import.
 */
export const templateMismatchSchema = z
  .strictObject({
    chosen: projectTemplateSchema,
    detected: z.array(projectTemplateSchema),
  })
  .nullable();

export type TemplateMismatch = z.output<typeof templateMismatchSchema>;

/**
 * `GET /orgs/:orgId/projects/:projectId/import-mismatch` — contracts § 4's field, as its own
 * payload rather than a widening of `repoLinkSchema`: spec 018's link contract is one this feature
 * does not open (SC-014), and the field is named here exactly as § 4 names it so the panel reads
 * `templateMismatch` whichever payload eventually carries it.
 *
 * An object rather than a bare nullable: a body is always sent, so "no disagreement" is a parsed
 * `null` rather than an empty response the client has to treat as a special case.
 */
export const importMismatchResponseSchema = z.strictObject({
  templateMismatch: templateMismatchSchema,
});

export type ImportMismatchResponse = z.output<typeof importMismatchResponseSchema>;
