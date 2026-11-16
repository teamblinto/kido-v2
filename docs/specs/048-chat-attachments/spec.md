# 048 — Chat attachments

**Status**: Implementing (2026-11-16)

People attach files to a chat message (picker, drag-and-drop, paste). The files reach the agent
as real context — images and PDFs as native provider blocks, everything else as extracted text —
and are staged into the sandbox workspace so the agent can copy them into the project (a logo
into `public/`, a CSV into `src/data/`).

## Decisions (and what was rejected)

| Decision                                                                                                                                                          | Why / rejected alternative                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upload first, send ids. `POST …/projects/:projectId/attachments?name=` takes the **raw file as the body**; `createRun` / `input` carry `attachmentIds`.           | Base64 in the JSON run request was rejected: it would force the app-wide 1 MB JSON limit up for every route. Multipart was rejected: no parser is installed and a new runtime dependency is ask-first. A raw body needs no parser — the route reads the request stream itself. |
| Stream with a hard cap (`maxBytesFor(kind)`), hashing as it goes; abort past the cap.                                                                             | Never buffers unbounded. The object store port takes a `Buffer`, so a file is held once, at most 25 MiB.                                                                                                                                                                       |
| The server derives type from the extension allowlist (`ATTACHMENT_TYPES`) and verifies bytes (magic numbers; UTF-8 without NUL for text). Client MIME is ignored. | Trusting `Content-Type` lets a renamed binary through.                                                                                                                                                                                                                         |
| PDFs go to the model natively (Anthropic `document`, OpenAI `input_file`). DOCX and ZIP text is extracted by a small in-repo ZIP reader on `node:zlib`.           | No PDF/DOCX parser dependency. ZIP reader enforces entry count, per-entry and total inflated caps, ratio cap, and never writes entries to disk (no zip-slip surface).                                                                                                          |
| SVG is `text`, not `image`. Served as a download, never inline.                                                                                                   | Providers reject SVG images; inline SVG from our origin is stored XSS.                                                                                                                                                                                                         |
| `attachments` is a project blob; `run_message_attachments` links messages to it.                                                                                  | A retry/edit resends the same ids with no re-upload. Unlinked rows older than 24 h are swept (object first, then row).                                                                                                                                                         |
| Objects live in the artifacts bucket under `attachments/{orgId}/{projectId}/{id}` (logical bucket `attachments`); locally, `FsObjectStore(OBJECT_STORE_DIR)`.     | A new bucket would add a required production variable for no isolation gain — keys are tenant-prefixed and every read goes through an RLS-checked row.                                                                                                                         |
| Staged into the workspace at `.git/kido-attachments/<id>/<name>` before the first turn.                                                                           | `SandboxService.upload` already allows `.git/` only: git never tracks it and checkpoints never capture it, so no guard is relaxed. The agent `cp`s what it needs into the project.                                                                                             |

## Limits

10 files per message · 25 MiB per file · 3.75 MiB per image (Anthropic's 5 MB limit is on the base64 form) (the client downscales larger rasters
first) · 200 000 extracted characters stored per file · 60 uploads per minute per caller ·
pending (unlinked) files expire after 24 h.

## API

- `POST /api/v1/orgs/:orgId/projects/:projectId/attachments?name=<file name>` — raw body,
  `project:agent.run`. `201` → `Attachment`. Problems: `attachment-rejected` (type not allowed,
  bytes disagree with type, unreadable archive), `attachment-too-large`.
- `GET …/attachments/:attachmentId/content` — `project:read`. Raster images and PDFs inline,
  everything else `attachment`. Always `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox`, private cache.
- `DELETE …/attachments/:attachmentId` — `project:agent.run`; only while pending. `204`.
- `POST …/runs` and `POST …/runs/:runId/input` accept `attachmentIds`; every id must be an
  attachment of the same project (`attachment-not-found` otherwise). Linked in the run's
  transaction.
- `GET …/runs/messages` returns `attachments` on each user message.

## Agent context

- `ConversationMessage` (user) gains `attachments`. Images → image blocks; PDFs → document /
  file blocks; text/document/archive → a text block `<attachment name=… path=…>…</attachment>`
  capped per file, with the workspace path so the agent can `fs_read` the rest.
- Subscription (CLI) runs get the text form plus workspace paths.
- Summaries record attachments by name.

## Success criteria

| #    | Criterion                                                                             | Proven by                    |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------- |
| SC-1 | A renamed binary (`.png` holding a PE header) is refused                              | `attachment-inspect.spec.ts` |
| SC-2 | An upload past the cap is cut off and nothing is stored                               | `attachment.service.spec.ts` |
| SC-3 | A ZIP bomb is refused by ratio/total caps without inflating it fully                  | `zip-reader.spec.ts`         |
| SC-4 | Another org's attachment id on a run request is `attachment-not-found`                | `run.service.spec.ts`        |
| SC-5 | An image attachment reaches Anthropic as an image block and OpenAI as `input_image`   | adapter specs                |
| SC-6 | Attachments are staged under `.git/kido-attachments/` and the prompt names the path   | `agent-executor.spec.ts`     |
| SC-7 | Composer: picker, drop and paste add chips with progress; remove; failed chip retries | `chat-composer.test.tsx`     |
| SC-8 | Retry resends the original message's attachment ids                                   | `project-page` test          |
