import { z } from 'zod';

/**
 * The shapes Daytona v0.190.0 answers with (spec 010, contracts/daytona-http.md). The vendor's
 * dtos, parsed at the boundary and never on our wire — a body that fails one of these is
 * `DaytonaError('malformed')`. `.passthrough()` wherever the dto is wider than what is read, so
 * a field Daytona adds does not become a failure here.
 */

/**
 * #1 `GET {api}/sandbox/{id}` — the state to check and the proxy base to call. Also the dto
 * `POST {api}/sandbox` and every list item answer with (014 research R1/R2): `labels` is present
 * on each, `{}` when none; `createdAt` is what the reconciler ages an orphan by.
 */
export const sandboxLookupSchema = z
  .object({
    createdAt: z.string().optional(),
    id: z.string(),
    labels: z.record(z.string(), z.string()).optional(),
    runnerId: z.string().nullish(),
    state: z.string(),
    toolboxProxyUrl: z.url(),
    user: z.string().optional(),
  })
  .passthrough();

export type SandboxLookup = z.infer<typeof sandboxLookupSchema>;

/** #10–#11 name it for what it is: the dto in any state, not only the one `lookup` accepts. */
export type DaytonaSandboxDto = SandboxLookup;

/** #16 `GET {api}/sandbox?labels=` — a page, not a bare array; `nextCursor` null on the last. */
export const sandboxListSchema = z
  .object({ items: z.array(sandboxLookupSchema), nextCursor: z.string().nullish() })
  .passthrough();

/** #2 `GET {toolbox}/work-dir` */
export const workDirSchema = z.object({ dir: z.string() });

/** #3 entries and #4 `files/info`. The daemon `stat`s through links, so there is no link flag. */
export const fileInfoSchema = z
  .object({
    isDir: z.boolean(),
    name: z.string(),
    size: z.number(),
  })
  .passthrough();

export type FileInfo = z.infer<typeof fileInfoSchema>;

/** #3 `GET {toolbox}/files?path=` */
export const fileListSchema = z.array(fileInfoSchema);

/** #7 `GET {toolbox}/files/find` — Daytona's `find` is a *content* search (research R2). */
export const findMatchesSchema = z.array(
  z.object({ content: z.string(), file: z.string(), line: z.number() }).passthrough(),
);

export type FindMatch = z.infer<typeof findMatchesSchema>[number];

/** #8 `GET {toolbox}/files/search` — Daytona's `search` is a base-name glob. */
export const searchFilesSchema = z.object({ files: z.array(z.string()) }).passthrough();

/** #9 `POST {toolbox}/process/execute` — stdout and stderr arrive merged in `result`. */
export const executeResultSchema = z
  .object({ exitCode: z.number(), result: z.string() })
  .passthrough();

/**
 * `GET {api}/snapshots/{name}` (spec 015, research R1 "Landed as"): `state` is one of Daytona's
 * `pending`, `building`, `pulling`, `active`, `error`, `build_failed`, `inactive`, `removing`;
 * `errorReason` is `null`, not absent, when there is none.
 */
export const snapshotSchema = z
  .object({ errorReason: z.string().nullable(), name: z.string(), state: z.string() })
  .passthrough();

export type DaytonaSnapshotDto = z.infer<typeof snapshotSchema>;

/**
 * `GET {api}/sandbox/{id}/ports/{port}/signed-preview-url?expiresInSeconds=` (spec 017, contract
 * § 7): the per-sandbox, per-port preview origin and the random token the proxy accepts as
 * `X-Daytona-Preview-Token` for that long. `sandboxId` and `port` are echoes and are dropped; the
 * token is never the sandbox `authToken` (the unsigned `/preview-url` route answers that one and
 * is never called).
 */
export const previewOriginSchema = z
  .object({ token: z.string().min(1), url: z.url() })
  .passthrough()
  .transform(({ token, url }) => ({ upstream: url, upstreamToken: token }));

export type PreviewOrigin = z.output<typeof previewOriginSchema>;
