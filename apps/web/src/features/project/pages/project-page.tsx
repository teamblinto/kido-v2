import type { CreateRunRequest, RunEvent } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

import { useSession } from '@/features/auth/session/session-context';
import { getProject } from '@/features/workspace/api';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { NotFoundPage } from '@/pages/not-found-page';
import { ActivityLog } from '../components/activity-log';
import { ChatPanel } from '../components/chat-panel';
import { ChatRail } from '../components/chat-rail';
import { ProjectTopbar } from '../components/project-topbar';
import { type PatchedFile, StageCode } from '../components/stage-code';
import { StageGit } from '../components/stage-git';
import { StagePreview } from '../components/stage-preview';
import { byosRefusalCopy } from '@/features/settings/linked-account-copy';
import {
  limitOfRefusal,
  limitSentence,
  RUN_ON_ORGANISATION,
} from '@/features/settings/subscription-limit';
import { cancelRun, createRun } from '../api';
import { usePresence } from '../hooks/use-presence';
import { useProjectWorkspace } from '../hooks/use-project-workspace';
import { useRun } from '../hooks/use-run';
import { useRunStream } from '../hooks/use-run-stream';
import { isTerminal, statusToPhase } from '../lib/run-phase';
import type { SubscriptionRunRequest } from '../lib/pay-with';
import { activityLines, changedPaths } from '../lib/stage';

/** `dirname` for a posix API path. `'src/a.ts'` → `'src'`, `'a.ts'` → `''` (the root). */
function dirname(path: string): string {
  const cut = path.lastIndexOf('/');

  return cut === -1 ? '' : path.slice(0, cut);
}

/** What the workspace composer hands a new project: its prompt, and the model it picked. */
function handoffFrom(state: unknown): {
  readonly credential?: 'organisation';
  readonly model?: string;
  readonly prompt?: string;
} {
  if (typeof state !== 'object' || state === null) {
    return {};
  }

  const { credential, model, prompt } = state as {
    credential?: unknown;
    model?: unknown;
    prompt?: unknown;
  };

  return {
    // Spec 032 A3: the person chose the organisation's credential while their subscription is
    // limited; for this run only.
    ...(credential === 'organisation' ? { credential } : {}),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    ...(typeof prompt === 'string' && prompt.trim().length > 0 ? { prompt } : {}),
  };
}

/**
 * The project workspace — Figma page "03 · Project & Run states".
 *
 * Three regions: the topbar, the chat panel, and the stage. Collapsing the chat
 * on a wide screen gives the stage room to show the code beside the preview;
 * below `lg` the two swap places through the topbar's segmented control.
 */
export function ProjectPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const { user } = useSession();
  const { activeOrg } = useOrgs();
  const orgId = activeOrg?.id;

  /*
   * The project, and the run.
   *
   * There is nothing else. Every surface below this line shows something the run reported or says
   * it has nothing to show — the sample data this screen was built against is deleted, not
   * reduced (FR-027), so there is no longer a way for a fixture to stand in for a project that
   * was never there.
   */
  const project = useQuery({
    enabled: orgId !== undefined && projectId.length > 0,
    queryFn: ({ signal }) => getProject(orgId ?? '', projectId, signal),
    queryKey: ['project', orgId, projectId],
  });

  const {
    gitView,
    isChatOpen,
    isLogOpen,
    isSplit,
    location,
    mobilePane,
    onOpenFile,
    setGitView,
    setMobilePane,
    setStage,
    stage,
    toggleChat,
    toggleLog,
  } = useProjectWorkspace();
  const presence = usePresence({ location, orgId, projectId });

  // The run on screen, and the instruction that started it. The instruction is held here rather
  // than waited for as an event, because the person who just typed it should see it at once —
  // it is the one thing on this screen that did not come from the run, and it is their own words.
  const { runId, selectRun } = useRun({ orgId, projectId });
  const [instruction, setInstruction] = useState<string | undefined>(undefined);

  /*
   * When the API accepted a stop request for the run on screen (its `202`, timed by this client).
   *
   * Held here rather than read back off the run, because the two say different things for as long
   * as the stop takes: the run still reports itself as running — correctly, it is still winding
   * down — while this says the request landed. That gap is the whole of FR-012, and closing it by
   * waiting for the run would be the thing SC-005 measures against.
   */
  const [cancelRequestedAt, setCancelRequestedAt] = useState<string | null>(null);

  /*
   * What the run changed under the Code stage, refreshed by invalidating the reads (research R5).
   *
   * A second reader of the same stream, never a second writer: the transcript is reduced exactly
   * as before and nothing here touches it, which is what keeps this addition invisible to the
   * transcript's own tests (FR-025). `file.patch` invalidates the patched file and the directory
   * holding it; a `checkpoint` moved the whole tree, so it invalidates both prefixes.
   */
  const queryClient = useQueryClient();
  const [patched, setPatched] = useState<PatchedFile | undefined>(undefined);
  // Counted, not stored: the Preview frame keys its iframe on the running total, so every
  // `preview.ready` remounts it without this page holding a url the preview already owns. A
  // `checkpoint` counts too: it is what a successful run ends on, and nothing emits
  // `preview.ready` yet (spec 029 names that follow-up), so it is the one "the run changed what
  // the preview serves" signal the stream carries.
  const [previewReadyCount, setPreviewReadyCount] = useState(0);

  const onEvent = useCallback(
    (event: RunEvent) => {
      if (event.type === 'file.patch') {
        const { path } = event.data;

        // A fresh object every time: the Code stage tells "patched again" from "the same patch it
        // already knew about" by identity, so two patches to one file both count.
        setPatched({ path });
        void queryClient.invalidateQueries({
          queryKey: ['files', orgId, projectId, dirname(path)],
        });
        void queryClient.invalidateQueries({ queryKey: ['file', orgId, projectId, path] });

        return;
      }

      if (event.type === 'preview.ready') {
        setPreviewReadyCount((count) => count + 1);

        return;
      }

      if (event.type === 'checkpoint') {
        setPreviewReadyCount((count) => count + 1);
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        void queryClient.invalidateQueries({ queryKey: ['file'] });
      }
    },
    [orgId, projectId, queryClient],
  );

  const { connection, error, items, retry, run, source } = useRunStream({
    onEvent,
    orgId,
    projectId,
    runId,
  });

  const start = useMutation({
    mutationFn: (body: CreateRunRequest) => createRun(orgId ?? '', projectId, body),
    onSuccess: (created) => {
      // Into the address, not into a local variable: the run on screen is addressable however it
      // got there, so a reload returns to the run just started rather than to whatever is newest
      // by then (FR-025).
      selectRun(created.id);
      // A new run has nothing asked of it yet, whatever was asked of the last one.
      setCancelRequestedAt(created.cancelRequestedAt);
    },
  });

  // `model` only ever comes from the workspace's hand-off below, or with the person's plan (041):
  // the console has no cloud model picker (012 FR-018), so a cloud run typed here sends
  // `{ prompt }` and gets the API's default.
  const startRun = useCallback(
    (
      prompt: string,
      model?: string,
      credential?: 'organisation',
      plan?: SubscriptionRunRequest,
    ) => {
      // Nothing is sent until there is an organisation to send it to. `orgs/…/projects` with an
      // empty segment is a request to a route that does not exist, and the refusal it earns would
      // be reported as the run having failed rather than as the screen not being ready yet.
      if (orgId === undefined) {
        return;
      }

      setInstruction(prompt);
      start.mutate({
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(credential === undefined ? {} : { credential }),
        // Spec 041: a run on the person's own Claude plan; its `model` is a Claude Code alias.
        ...(plan ?? {}),
      });
    },
    [orgId, start],
  );

  /*
   * The first run of a new project: the workspace composer's prompt and model pick, handed over
   * in navigation state (spec 007 R7, spec 011 US6), started as soon as there is an organisation
   * to start it under. Once, by the ref: `selectRun` then replaces the address, which drops the
   * state, so a reload comes back to the run rather than starting another.
   */
  const handoff = handoffFrom(useLocation().state);
  const handedOff = useRef(false);

  useEffect(() => {
    if (handedOff.current || orgId === undefined || handoff.prompt === undefined) {
      return;
    }

    handedOff.current = true;
    startRun(handoff.prompt, handoff.model, handoff.credential);
  }, [handoff.credential, handoff.model, handoff.prompt, orgId, startRun]);

  const stop = useMutation({
    mutationFn: () => cancelRun(orgId ?? '', projectId, runId ?? ''),
    onSuccess: () => {
      // `202` with no body: the acceptance is the acknowledgement, the run's own record follows.
      setCancelRequestedAt(new Date().toISOString());
    },
  });

  const stopRun = useCallback(() => {
    if (orgId === undefined || runId === undefined) {
      return;
    }

    stop.mutate();
  }, [orgId, runId, stop]);

  /*
   * What the stage shows, read straight out of the transcript (FR-029).
   *
   * Derived here rather than passed down as a scenario, because there is no longer anything to
   * choose between: the panes show what this run reported, or they say they have nothing. A
   * project with no run yet is `queued` — waiting to be asked — which is the honest word for a
   * screen nobody has typed into.
   */
  const paths = changedPaths(items);
  const log = activityLines(items);

  const phase = run === undefined ? 'queued' : statusToPhase(run.status);
  const isRunning = run !== undefined && !isTerminal(run.status);

  /*
   * Every refusal the console can earn, in one sentence from the shared catalogue (FR-021).
   *
   * No slug and no wording is added by this feature: `MESSAGES` is exhaustive by type — a slug
   * without a sentence fails `typecheck` — so routing through `messageFor` is the whole of it
   * (R7). Starting a run, stopping one, and reading a run or its history are the four things that
   * can be refused; whichever refused first is what there is to say.
   *
   * `unauthorized` is deliberately not special-cased here. It means one thing in this API, and
   * the application answers it once, on the query client: the session is dropped and `RequireAuth`
   * redirects, so an expired session ends at sign in rather than as a note on this screen
   * (FR-023).
   */
  const refused: unknown = start.error ?? stop.error ?? error;
  // Spec 032 T048: a `409 subscription-limited` says whose limit and until when, and — when the
  // organisation has a credential — offers it for this one run; nothing moves without the click.
  const limit = limitOfRefusal(start.error);
  const lastRequest = start.variables;
  const refusal =
    limit !== undefined
      ? limitSentence(limit)
      : refused === null || refused === undefined
        ? undefined
        : (byosRefusalCopy(refused) ?? messageFor(refused));
  const refusalAction =
    limit?.alternativeMode === undefined || lastRequest === undefined
      ? undefined
      : {
          label: RUN_ON_ORGANISATION,
          onClick: () => {
            startRun(lastRequest.prompt, lastRequest.model, 'organisation');
          },
        };

  // The request as the API recorded it — from this screen's own stop, or already on the run when
  // it was read, which is how a stop survives a reload. `isRunning` gates it, so a run that has
  // since ended shows neither a stop control nor the memory of one (FR-013).
  const isStopping =
    isRunning && (cancelRequestedAt !== null || (run?.cancelRequestedAt ?? null) !== null);

  // The API answers a project the caller may not read and one that does not exist with the same
  // refusal, so the screen does too: an archived project, a mistyped id and somebody else's are
  // all one 404 rather than a stage full of mock data pretending to be it (spec 007).
  if (
    ApiProblem.is(project.error, 'not-found') ||
    ApiProblem.is(project.error, 'permission-denied')
  ) {
    return <NotFoundPage />;
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <ProjectTopbar
        account={{ email: user?.email ?? '', name: user?.email?.split('@')[0] ?? 'You' }}
        changedFileCount={paths.length}
        isChatOpen={isChatOpen}
        mobilePane={mobilePane}
        onChangeMobilePane={setMobilePane}
        onChangeStage={setStage}
        onToggleChat={toggleChat}
        orgId={orgId}
        permissions={project.data?.project.permissions ?? []}
        phase={phase}
        presence={presence}
        projectId={projectId}
        projectName={project.data?.project.name ?? ''}
        stage={stage}
      />

      <div className="flex min-h-0 flex-1">
        <ChatPanel
          connection={connection}
          instruction={instruction}
          isRunning={isRunning}
          isStopping={isStopping}
          items={items}
          model={run?.model}
          onRetry={retry}
          onStop={stopRun}
          onSubmit={(prompt, plan) => {
            startRun(prompt, undefined, undefined, plan);
          }}
          placeholder="Ask for a change to this project"
          projectId={projectId}
          refusal={refusal}
          refusalAction={refusalAction}
          run={run}
          source={source}
          className={cn(
            mobilePane === 'chat' ? 'flex flex-1' : 'hidden',
            isChatOpen ? 'lg:flex lg:flex-none' : 'lg:hidden',
          )}
        />

        {isChatOpen ? null : (
          <ChatRail onOpen={toggleChat} unreadCount={items.length} className="max-lg:hidden" />
        )}

        <div
          id="project-stage"
          role="tabpanel"
          aria-label="Stage"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col lg:flex',
            mobilePane === 'chat' ? 'hidden' : 'flex',
          )}
        >
          {isSplit ? (
            <div className="flex min-h-0 flex-1">
              <StageCode
                className="border-line-subtle flex-1 border-r"
                onOpenFile={onOpenFile}
                orgId={orgId}
                patched={patched}
                projectId={projectId}
              />
              <StagePreview
                orgId={orgId}
                permissions={project.data?.project.permissions}
                phase={phase}
                previewReadyCount={previewReadyCount}
                projectId={projectId}
                className="flex-1"
              />
            </div>
          ) : stage === 'code' ? (
            <StageCode
              className="flex-1"
              onOpenFile={onOpenFile}
              orgId={orgId}
              patched={patched}
              projectId={projectId}
            />
          ) : stage === 'git' ? (
            <StageGit
              className="flex-1"
              onChangeView={setGitView}
              orgId={orgId}
              paths={paths}
              projectId={projectId}
              view={gitView}
            />
          ) : (
            <StagePreview
              orgId={orgId}
              permissions={project.data?.project.permissions}
              phase={phase}
              previewReadyCount={previewReadyCount}
              projectId={projectId}
              className="flex-1"
            />
          )}

          <ActivityLog entries={log} isOpen={isLogOpen} onToggle={toggleLog} />
        </div>
      </div>
    </div>
  );
}
