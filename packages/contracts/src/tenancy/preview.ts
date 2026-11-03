import { z } from 'zod';

/**
 * The preview gateway and label routing slice (spec 017, contracts § 1).
 *
 * The label itself never appears in a response shape: a preview is addressed by its `url`, and the
 * raw label stays what spec 007 called it, "a capability rather than a description" — anybody
 * holding it can reach the preview, so a listing must not hand it out.
 */

export const previewVisibilitySchema = z.enum(['private', 'org', 'public']);

export type PreviewVisibility = z.output<typeof previewVisibilitySchema>;

/** `GET /api/v1/orgs/:orgId/projects/:projectId/preview`, behind `project:read`. */
export const previewResponseSchema = z.strictObject({
  port: z.number().int().nullable(),
  url: z.string(),
  visibility: previewVisibilitySchema,
});

export type PreviewResponse = z.output<typeof previewResponseSchema>;

/** `PUT /api/v1/orgs/:orgId/projects/:projectId/preview/visibility`, behind `project:preview.rotate`. */
export const setPreviewVisibilityRequestSchema = z.strictObject({
  visibility: previewVisibilitySchema,
});

export type SetPreviewVisibilityRequest = z.output<typeof setPreviewVisibilityRequestSchema>;

export const PREVIEW_LABEL_ROTATED = 'preview-label-rotated';

/** `POST /api/v1/orgs/:orgId/projects/:projectId/preview/rotate`, behind `project:preview.rotate`. */
export const rotatePreviewResponseSchema = z.strictObject({
  port: z.number().int().nullable(),
  status: z.literal(PREVIEW_LABEL_ROTATED),
  url: z.string(),
});

export type RotatePreviewResponse = z.output<typeof rotatePreviewResponseSchema>;

/**
 * `POST /api/v1/preview/authorize` (contract § 2): session required, no permission. The web page
 * calls it with `fetch`, and a cross-origin `302` is opaque to `fetch`, so the return target —
 * `https://<returnHost>/?code=<code>` — is answered as a readable body and followed by the page.
 */
export const authorizePreviewResponseSchema = z.strictObject({
  url: z.url(),
});

export type AuthorizePreviewResponse = z.output<typeof authorizePreviewResponseSchema>;

/**
 * `POST /api/v1/internal/sandbox-callbacks` (contract § 6). A discriminated union of one variant
 * today — `preview.status` — because the guard dispatches on `action` and a second callback kind
 * arrives as a sibling branch, never a field bolted onto this one.
 */
export const sandboxCallbackRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('preview.status'),
    port: z.number().int().min(1024).max(65_535),
    state: z.enum(['listening', 'starting', 'failed']),
  }),
]);

export type SandboxCallbackRequest = z.output<typeof sandboxCallbackRequestSchema>;
