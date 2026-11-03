import {
  type FileContentResponse,
  type WriteFileConflictReason,
  writeFileConflictReasonSchema,
} from '@repo/contracts';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { highlight } from '../lib/highlight';

interface FileViewProps {
  className?: string;
  /** The API's answer for the open file: `renderable: false` structurally carries no content. */
  file: FileContentResponse;
  /** True while the save this view started is in flight. */
  isSaving?: boolean;
  /**
   * Read the file again from the API and hand the answer back as a fresh `file` (FR-022).
   *
   * Offered only where it is the remedy — a save refused because the base moved. The caller
   * refetches; it does not close the file, because the whole point is that the person stays in the
   * editor with the text they were about to save.
   */
  onReload?: () => void;
  /**
   * Save the text as it now stands.
   *
   * The base the read was answered against is not passed back up: the caller holds it, because
   * the caller is what read the file (contracts § 1). This view knows the text and nothing else.
   */
  onSave?: (content: string) => void;
  /**
   * What the caller holds on this project, as `ProjectResponse.permissions` carries it.
   *
   * The gate is `project:files.write` and never a role name, so a role gaining or losing the
   * permission needs no change here (FR-002).
   */
  permissions?: readonly string[];
  /** True when the open file was last refetched because the run patched it (FR-005). */
  refreshedByRun?: boolean;
  /** How the last save was refused, if it was. */
  saveError?: Error | null;
}

/**
 * The sentence for a save refused because the project moved, and the action it promises.
 *
 * Distinct from the shared `conflict` sentence on purpose: FR-019 is that a person can tell
 * "reload" from "wait", and the remedy is in the words rather than only in a button.
 */
const BASE_MOVED =
  'This file changed after you opened it, so your save was refused. Reload it to pick up the ' +
  'current version \u2014 your own edits stay in the editor.';

/**
 * The sentence for a save refused because the run holds the project, and the absence of an action.
 *
 * The other half of FR-019: nothing the person can press would help, so nothing is offered. Saying
 * "wait" and meaning it is the honest branch — a button here would only refuse again.
 */
const RUN_ACTIVE =
  'A run is working on this project, so your save was refused. Wait for the run to finish, then ' +
  'save again \u2014 your edits stay in the editor.';

/** What the reload did to the draft, said out loud rather than left to be noticed. */
const EDITS_KEPT =
  'Reloaded. Your edits are still here \u2014 saving now replaces the version you just reloaded.';

/**
 * Why a save was refused, as the contract spells the vocabulary (`writeFileConflictReasonSchema`).
 *
 * Parsed rather than compared to a string literal: the reason rides as an RFC 9457 extension
 * member, so it arrives as `unknown`, and a reason from a newer server yields `undefined` here and
 * falls back to the shared sentence instead of rendering a branch this build does not have.
 */
function conflictReason(error: Error | null | undefined): WriteFileConflictReason | undefined {
  const problem: unknown = error;

  if (!ApiProblem.is(problem, 'conflict')) return undefined;

  // The extension members ride alongside the RFC 9457 fields, typed as whatever a server may
  // send; naming that shape here keeps the read a parse rather than a cast.
  const extensions: Readonly<Record<string, unknown>> = problem.detail ?? {};
  const parsed = writeFileConflictReasonSchema.safeParse(extensions.reason);

  return parsed.success ? parsed.data : undefined;
}

const NOT_RENDERED: Record<'binary' | 'too-large', string> = {
  binary: 'This file is binary, so it is not rendered here.',
  'too-large': 'This file is too large to render here.',
};

/** Bytes as the shortest honest unit; a file view is not a place for three decimal places. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One file: its path, its size, and its contents with line numbers — editable for a member who
 * may write, read-only for everyone else.
 *
 * Colouring is best-effort on the read-only branch — an extension with no registered grammar
 * falls back to plain monospace rather than to nothing (research R6). The highlighted branch
 * injects HTML, which is only safe because highlight.js escapes the file's own text; the fallback
 * branch passes the text as a React child so React escapes it. The editable branch is a plain
 * textarea and so escapes nothing, because it renders no markup at all.
 */
export function FileView({
  className,
  file,
  isSaving,
  onReload,
  onSave,
  permissions,
  refreshedByRun,
  saveError,
}: FileViewProps): React.JSX.Element {
  const html = file.renderable ? highlight(file.path, file.content) : null;
  const lines = file.renderable ? file.content.split('\n') : [];

  /*
   * Editable only when all three hold: the file has content to edit, the caller may write it, and
   * somebody upstream is listening for the save. A file that cannot be rendered cannot be saved
   * either — it carries no base, by the contract's own § 1.
   */
  const mayWrite = permissions?.includes('project:files.write') === true;
  const isEditable = file.renderable && mayWrite && onSave !== undefined;

  /*
   * A fresh read replaces the draft, unless the draft is somebody's unsaved work.
   *
   * The read is the truth about what is on disk — it arrives when the file is opened, when a run
   * patches it, when a save lands, and now when a `base-moved` refusal is reloaded — and an
   * untouched draft has nothing in it worth keeping over that. Typed text is different: it exists
   * nowhere else, so it stays, and `keptEdits` says so on screen. That is what FR-022's "without
   * leaving the editor" means in practice, and it is why the reload can be offered at all.
   *
   * A different path is always a different file, so there is no work of theirs to keep: opening
   * another file is not an edit to this one.
   *
   * Adjusted during render rather than in an effect, which is React's own answer for state that
   * derives from a prop: the textarea never paints the previous file's text for a frame, and the
   * repo's `set-state-in-effect` rule forbids the other shape anyway.
   */
  const content = file.renderable ? file.content : '';
  const [read, setRead] = useState({ content, path: file.path });
  const [draft, setDraft] = useState(content);
  const [keptEdits, setKeptEdits] = useState(false);

  if (read.content !== content || read.path !== file.path) {
    const theirs = read.path === file.path && draft !== read.content;

    setRead({ content, path: file.path });
    setKeptEdits(theirs);

    if (!theirs) setDraft(content);
  }

  const reason = conflictReason(saveError);
  const mayReload = reason === 'base-moved' && onReload !== undefined;

  /*
   * The sentence for the refusal, chosen by reason, falling back to the shared catalogue.
   *
   * `base-moved` speaks only where a reload was handed down, because its sentence promises one.
   * `run-active` needs no such condition: waiting is available to everybody. A reason this build
   * does not know lands on `messageFor`, which is never blank.
   */
  const sentence = mayReload
    ? BASE_MOVED
    : reason === 'run-active'
      ? RUN_ACTIVE
      : messageFor(saveError);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="border-subtle flex items-baseline gap-2 border-b px-4 py-2">
        <span className="text-label-sm truncate font-medium">{file.path}</span>
        <span className="text-body-sm text-faint shrink-0">{formatBytes(file.bytes)}</span>
        {refreshedByRun === true && (
          <span className="text-body-sm text-subdued ml-auto shrink-0">Refreshed by the run</span>
        )}
        {isEditable && (
          <Button
            type="button"
            size="sm"
            variant="default"
            className={cn('shrink-0', refreshedByRun === true ? '' : 'ml-auto')}
            disabled={isSaving === true}
            onClick={() => {
              onSave(draft);
            }}
          >
            {isSaving === true ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>

      {/*
       * One sentence for a refused save, and the remedy where there is one.
       *
       * Two reasons have a branch of their own (FR-019). `base-moved` says to reload, and only
       * when a reload was handed down — a sentence that tells somebody to reload beside no way of
       * reloading is worse than the generic one. `run-active` says to wait, and carries no button
       * because there is nothing to press. Everything else, a reason this build does not know
       * included, takes the shared catalogue's sentence.
       */}
      {saveError != null && (
        <div
          role="alert"
          className="border-subtle flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2"
        >
          <p className="text-body-sm text-danger min-w-0 flex-1">{sentence}</p>
          {mayReload && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={onReload}
            >
              Reload the file
            </Button>
          )}
        </div>
      )}

      {/*
       * What the reload did, for the person who had typed something.
       *
       * `status` rather than `alert`: the refetch landing on top of their text is news, not a
       * failure, and the point of saying it is that their draft is now sitting on a base they did
       * not read — the next save overwrites the newer content on purpose (FR-022).
       */}
      {keptEdits && (
        <p role="status" className="text-body-sm text-subdued border-subtle border-b px-4 py-2">
          {EDITS_KEPT}
        </p>
      )}

      {isEditable ? (
        <textarea
          aria-label="File contents"
          className="text-body-sm min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono leading-5 outline-none"
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      ) : file.renderable ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="text-body-sm flex font-mono leading-5">
            <div
              aria-hidden="true"
              className="text-faint border-subtle shrink-0 border-r px-2 text-right tabular-nums select-none"
            >
              {lines.map((_, index) => (
                // The index IS the line number here: nothing reorders, nothing is inserted.
                <div key={index}>{index + 1}</div>
              ))}
            </div>
            {html === null ? (
              <pre className="min-w-0 px-3 whitespace-pre">{file.content}</pre>
            ) : (
              <pre
                className="hljs min-w-0 bg-transparent px-3 whitespace-pre"
                // Safe: highlight.js escapes the source text it wraps in these spans.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </div>
        </div>
      ) : (
        <p className="text-body-sm text-subdued px-4 py-6">{NOT_RENDERED[file.reason]}</p>
      )}
    </div>
  );
}
