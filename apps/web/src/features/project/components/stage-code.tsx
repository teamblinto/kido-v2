import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { getProject } from '@/features/workspace/api';
import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { isAsleep, useDirectory, useFile, useSaveFile, useWake } from '../hooks/use-files';
import { AsleepPane } from './asleep-pane';
import { EmptyPane } from './empty-pane';
import { type DirectoryState, FileTree } from './file-tree';
import { FileView } from './file-view';

/**
 * The most recent `file.patch` the run reported, by identity.
 *
 * Compared with `!==` rather than by path: two patches to the same file are two different
 * objects, so re-patching the open file marks it refreshed again, and nothing needs a sequence
 * number to say so.
 */
export interface PatchedFile {
  readonly path: string;
}

interface StageCodeProps {
  className?: string;
  /** Told the path of each file opened, so the page can say where the person is (spec 031). */
  onOpenFile?: (path: string) => void;
  orgId: string | undefined;
  /** The last file the run patched, from the stream (FR-005). */
  patched?: PatchedFile;
  projectId: string;
}

/**
 * The project's source, read-only: the tree on the left, the open file on the right.
 *
 * The root listing is what the pane branches on — a sleeping sandbox refuses it the same way it
 * refuses everything else (FR-018), and every other refusal gets the console's one sentence from
 * the shared catalogue rather than a second wording invented here (FR-021). Below `md` the file
 * view is a drawer over the tree instead of a second column, because two columns on a phone is
 * two unusable ones.
 */
export function StageCode({
  className,
  onOpenFile,
  orgId,
  patched,
  projectId,
}: StageCodeProps): React.JSX.Element {
  /*
   * The open file, and the patch that was current when it was opened.
   *
   * One piece of state rather than two, because "refreshed by the run" is exactly the difference
   * between them: opening a file records the patch of the moment, so the line appears only for a
   * patch that arrived afterwards and disappears the moment someone opens anything themselves
   * (FR-005).
   */
  const [open, setOpen] = useState<{ readonly path: string; readonly since?: PatchedFile } | null>(
    null,
  );

  /*
   * The listing the tree injects into every node it renders.
   *
   * Declared as a hook rather than passed as a plain callback because that is what it is: the
   * tree calls it from inside each directory node's render, once per open directory, which is the
   * whole of what makes the tree lazy (`file-tree.tsx`).
   */
  const useDirectoryState = (dir: string): DirectoryState => {
    const query = useDirectory(orgId, projectId, dir);

    return { entries: query.data?.entries, error: query.error, isPending: query.isPending };
  };

  const root = useDirectory(orgId, projectId, '');
  const file = useFile(orgId, projectId, open?.path);
  const wake = useWake(orgId, projectId);
  const save = useSaveFile(orgId, projectId);

  /*
   * What the caller holds on this project, for the save gate (FR-002).
   *
   * The key is the one the project screen already fills — `['project', …]` — so this is not a
   * second request but a read of the entry that is there, exactly as `stage-git.tsx` does it.
   */
  const project = useQuery({
    enabled: orgId !== undefined && projectId !== '',
    queryFn: ({ signal }) => getProject(orgId ?? '', projectId, signal),
    queryKey: ['project', orgId, projectId],
  });

  /* Named so the save can read the base out of the very answer the view is rendering. */
  const fileData = file.data;

  if (isAsleep(root.error)) {
    return (
      <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
        <AsleepPane
          because={wake.isPending ? 'resuming' : (wake.data?.because ?? null)}
          error={wake.error ?? undefined}
          onWake={() => {
            wake.mutate();
          }}
        />
      </div>
    );
  }

  if (root.error !== null) {
    return (
      <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
        <EmptyPane title="The project's files are unavailable" body={messageFor(root.error)} />
      </div>
    );
  }

  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-1', className)}>
      <div className="border-line-subtle flex min-h-0 w-full min-w-0 flex-col md:w-64 md:shrink-0 md:border-r">
        <FileTree
          onOpen={(path) => {
            setOpen({ path, since: patched });
            onOpenFile?.(path);
          }}
          openPath={open?.path ?? null}
          useDirectory={useDirectoryState}
        />
      </div>

      {open === null ? (
        <EmptyPane
          className="max-md:hidden"
          title="No file open"
          body="Pick a file from the tree to read it."
        />
      ) : (
        <div className="bg-raised absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col md:static md:flex-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="m-2 self-start md:hidden"
            onClick={() => {
              setOpen(null);
            }}
          >
            <ChevronLeftIcon aria-hidden="true" />
            Files
          </Button>

          {fileData === undefined ? (
            <EmptyPane
              title={open.path}
              body={file.error === null ? 'Reading this file…' : messageFor(file.error)}
            />
          ) : (
            <FileView
              file={fileData}
              isSaving={save.isPending}
              /*
               * The base travels read → save untouched: it is the head the API answered *this*
               * read against, and the save carries it back so the server can tell whether the
               * project moved underneath it (contracts § 1, FR-018). Never minted here, never
               * remembered across reads — a refetch brings a new one.
               */
              onSave={
                fileData.renderable
                  ? (content) => {
                      save.mutate({
                        baseCheckpointId: fileData.baseCheckpointId,
                        content,
                        path: open.path,
                      });
                    }
                  : undefined
              }
              /*
               * The remedy for a `base-moved` refusal, which is the only thing that makes the
               * view offer one (FR-022).
               *
               * A refetch rather than a reopen: the query already holds this path, so re-reading
               * it hands the view a newer `file` — new content, new base — while the view keeps
               * whatever was typed. The refusal is cleared in the same breath, because it named a
               * base that no longer exists and leaving it up would describe a file nobody is
               * looking at any more.
               */
              onReload={() => {
                save.reset();
                void file.refetch();
              }}
              permissions={project.data?.project.permissions}
              refreshedByRun={patched?.path === open.path && patched !== open.since}
              saveError={save.error}
            />
          )}
        </div>
      )}
    </div>
  );
}
