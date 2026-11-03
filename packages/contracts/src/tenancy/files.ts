import { z } from 'zod';

import { checkpointSchema } from './checkpoint';

/**
 * Project files, the wake (spec 022, contracts/files.md) and the hand save (spec 024,
 * contracts/file-write.md). Almost nothing here is stored: every read shape is the sandbox's own
 * view, echoed back by the `sandbox` module through `SandboxPort`. The save is the exception — it
 * answers with a checkpoint, because a member's save is one.
 */

export const FILE_PATH_MAX_LENGTH = 1024;

/** Mirrors `SandboxPort.FileEntry`. `link` is listed, never followed. */
export const fileEntrySchema = z.strictObject({
  kind: z.enum(['file', 'directory', 'link']),
  name: z.string().min(1).max(255),
  size: z.number().int().min(0),
});

export type FileEntry = z.output<typeof fileEntrySchema>;

/** `GET …/files?path=<dir>`. `path` is the jailed, relative directory echoed back; `''` is root. */
export const fileListResponseSchema = z.strictObject({
  entries: z.array(fileEntrySchema),
  path: z.string(),
});

export type FileListResponse = z.output<typeof fileListResponseSchema>;

/**
 * `GET …/files/content?path=<file>`. Discriminated on `renderable`, so an unrenderable answer
 * cannot carry `content` at all — the branch that has no bytes to show has no field to show them.
 * The `content` cap is the port's `fileCapBytes` (010, 2 MiB); it is enforced where the bytes are
 * read, not restated here as a character count that would not mean the same thing.
 *
 * Spec 024 adds `baseCheckpointId` to the renderable branch and to that branch only: it is the
 * project's head at the moment of the read, carried back by the save and compared against the head
 * again under the writer lock (research R3). An unrenderable file cannot be saved, so it has no
 * base to carry and gains no field.
 */
export const fileContentResponseSchema = z.discriminatedUnion('renderable', [
  z.strictObject({
    baseCheckpointId: z.uuid(),
    bytes: z.number().int().min(0),
    content: z.string(),
    path: z.string(),
    renderable: z.literal(true),
  }),
  z.strictObject({
    bytes: z.number().int().min(0),
    path: z.string(),
    reason: z.enum(['binary', 'too-large']),
    renderable: z.literal(false),
  }),
]);

export type FileContentResponse = z.output<typeof fileContentResponseSchema>;

/** The query for both read routes. The jail is the port's; this only bounds the length. */
export const filePathQuerySchema = z.strictObject({
  path: z.string().max(FILE_PATH_MAX_LENGTH),
});

export type FilePathQuery = z.output<typeof filePathQuerySchema>;

/** `POST …/files/wake`: `SandboxLifecycle.Readiness` flattened — `because` is `null` when ready. */
export const wakeResponseSchema = z.strictObject({
  because: z.enum(['creating', 'resuming', 'hibernating', 'releasing']).nullable(),
  ready: z.boolean(),
});

export type WakeResponse = z.output<typeof wakeResponseSchema>;

/**
 * `PUT …/files/content` (spec 024, contracts/file-write.md § 2–3). `z.strictObject` like every
 * other request, so an undeclared key is a `422 validation-failed` before anything reaches a
 * workspace. `baseCheckpointId` is the id the read answered with; the server refuses the save
 * unless it still names the project's head.
 */
export const writeFileRequestSchema = z.strictObject({
  baseCheckpointId: z.uuid(),
  content: z.string(),
  path: z.string().min(1).max(FILE_PATH_MAX_LENGTH),
});

export type WriteFileRequest = z.output<typeof writeFileRequestSchema>;

/**
 * The save's answer, discriminated on `saved` so "I made a checkpoint" and "there was nothing to
 * make one from" cannot be confused by a client reading the body — the same discipline
 * `fileContentResponseSchema` uses for `renderable`. Both branches carry a checkpoint: the new one
 * on `true`, the unchanged head on `false`, so the client always leaves with a fresh base.
 */
export const writeFileResponseSchema = z.discriminatedUnion('saved', [
  z.strictObject({ checkpoint: checkpointSchema, saved: z.literal(true) }),
  z.strictObject({ checkpoint: checkpointSchema, saved: z.literal(false) }),
]);

export type WriteFileResponse = z.output<typeof writeFileResponseSchema>;

/**
 * Why a save was refused `409`. Declared as a union so the web branches against a schema rather
 * than a string literal it invented (research R5): `run-active` means wait for the run,
 * `base-moved` means reload the file. A `reason` outside this union still renders the shared
 * `conflict` sentence, which is the existing fallback rather than a blank.
 */
export const writeFileConflictReasonSchema = z.enum(['run-active', 'base-moved']);

export type WriteFileConflictReason = z.output<typeof writeFileConflictReasonSchema>;
