import type { CreateRunRequest, RunEvent, RunInputRequest } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

import { useSession } from '@/features/auth/session/session-context';
import { getProject } from '@/features/workspace/api';
import { useModelChoice } from '@/features/workspace/hooks/use-model-choice';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import {
  type ModelChoice,
  modelChoiceSchema,
  runBody,
} from '@/features/workspace/lib/model-choice';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { NotFoundPage } from '@/pages/not-found-page';
import { ActivityLog } from '../components/activity-log';
import { ChatComposer } from '../components/chat-composer';
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
import { answerRun, cancelRun, createRun } from '../api';
import { usePresence } from '../hooks/use-presence';
import { useProjectWorkspace } from '../hooks/use-project-workspace';
import { useRun } from '../hooks/use-run';
import { useRunStream } from '../hooks/use-run-stream';
import { isTerminal, statusToPhase } from '../lib/run-phase';
import { activityLines, changedPaths } from '../lib/stage';
import type { UserTurn } from '../lib/timeline';
import { joinTokens } from '../lib/transcript';

/** `dirname` for a posix API path. `'src/a.ts'` → `'src'`, `'a.ts'` → `''` (the root). */
function dirname(path: string): string {
  const cut = path.lastIndexOf('/');

  return cut === -1 ? '' : path.slice(0, cut);
}

/** What the workspace composer hands a new project: its prompt, and the model it picked. */
function handoffFrom(state: unknown): {
  readonly choice?: ModelChoice;
  readonly credential?: 'organisation';
  readonly prompt?: string;
} {
  if (typeof state !== 'object' || state === null) {
    return {};
  }

  const { choice, credential, prompt } = state as {
    choice?: unknown;
    credential?: unknown;
    prompt?: unknown;
  };
  const parsed = modelChoiceSchema.safeParse(choice);

  return {
    ...(parsed.success ? { choice: parsed.data } : {}),
    // Spec 032 A3: the person chose the organisation's credential while their subscription is
    // limited; for this run only.
    ...(credential === 'organisation' ? { credential } : {}),
    ...(typeof prompt === 'string' && prompt.trim().length > 0 ? { prompt } : {}),
  };
}

/** A message the person sent, and the run it went to once the API said which. */
interface SentTurn extends UserTurn {
  /** Undefined while the request is out: shown at the foot of whatever is on screen. */
  readonly runId: string | undefined;
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
  const { activeOrg, isGuest } = useOrgs();
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

  // The run on screen, and what the person sent it. Messages are held here rather than waited for
  // as events, because the person who just typed one should see it at once — they are the one
  // thing on this screen that did not come from the run, and they are their own words.
  const { runId, selectRun } = useRun({ orgId, projectId });
  const [turns, setTurns] = useState<readonly SentTurn[]>([]);
  const turnCount = useRef(0);

  // What the next message runs on, and so who pays (spec 043), remembered for this project.
  const modelState = useModelChoice({ enabled: !isGuest, orgId, projectId });

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

  // Where a message sent now sits in the run on screen: after everything it has said so far.
  const joinedCount = useRef(0);
  const shownRunId = useRef(runId);

  useEffect(() => {
    joinedCount.current = joinTokens(items).length;
    shownRunId.current = runId;
  });

  // The run just created, until the address has caught up with it: the router applies
  // `selectRun` a render or more later, and its first message must not vanish in between.
  // Held with the run that was on screen when it began; once the screen moves, the wait is over.
  const [awaited, setAwaited] = useState<{ readonly id: string; readonly on?: string }>();
  const awaitedRunId = awaited !== undefined && awaited.on === runId ? awaited.id : undefined;

  const start = useMutation({
    mutationFn: (body: CreateRunRequest) => createRun(orgId ?? '', projectId, body),
    onSuccess: (created) => {
      // Into the address, not into a local variable: the run on screen is addressable however it
      // got there, so a reload returns to the run just started rather than to whatever is newest
      // by then (FR-025).
      setAwaited({ id: created.id, ...(runId === undefined ? {} : { on: runId }) });
      selectRun(created.id);
      // A new run has nothing asked of it yet, whatever was asked of the last one.
      setCancelRequestedAt(created.cancelRequestedAt);
    },
  });

  // Answering a run that waits for input (`POST …/input`): the run carries on, so its reads are
  // stale — the stream itself stays open and reports what happens next.
  const answer = useMutation({
    mutationFn: (body: RunInputRequest) => answerRun(orgId ?? '', projectId, runId ?? '', body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['run', orgId, projectId, runId] }),
        queryClient.invalidateQueries({ queryKey: ['runs', orgId, projectId] }),
      ]),
  });

  /** Show what was sent at once; on a refusal take it back, so the composer can return it. */
  const sendTurn = useCallback(
    <T,>(
      text: string,
      turnRunId: string | undefined,
      request: () => Promise<T>,
      runOf?: (result: T) => string,
    ): Promise<T> => {
      turnCount.current += 1;
      const id = `u-${String(turnCount.current)}`;
      const sentOn = shownRunId.current;
      const sentAt = joinedCount.current;

      setTurns((current) => [
        ...current,
        {
          at: turnRunId === undefined ? Number.POSITIVE_INFINITY : sentAt,
          id,
          runId: turnRunId,
          text,
        },
      ]);

      return request().then(
        (result) => {
          const named = runOf?.(result);

          if (named !== undefined) {
            // A new run starts at its top; a waiting run the API redirected the message to
            // carries on below what it had said.
            const place = named === sentOn ? sentAt : 0;

            setTurns((current) =>
              current.map((turn) => (turn.id === id ? { ...turn, at: place, runId: named } : turn)),
            );
          }

          return result;
        },
        (refusal: unknown) => {
          setTurns((current) => current.filter((turn) => turn.id !== id));
          throw refusal;
        },
      );
    },
    [],
  );

  // The model picker's choice is the run's `model` and who pays (spec 043). It applies from this
  // message on; switching between messages is always allowed.
  const startRun = useCallback(
    (prompt: string, choice: ModelChoice | undefined, credential?: 'organisation') => {
      // Nothing is sent until there is an organisation to send it to. `orgs/…/projects` with an
      // empty segment is a request to a route that does not exist, and the refusal it earns would
      // be reported as the run having failed rather than as the screen not being ready yet.
      if (orgId === undefined) {
        return Promise.reject(new Error('The organisation is not known yet.'));
      }

      answer.reset();
      const body = runBody(prompt, choice);

      return sendTurn(
        prompt,
        undefined,
        // Spec 032 A3's organisation credential is a catalogue run's alternative only.
        () =>
          start.mutateAsync(
            credential === undefined || body.subscription !== undefined
              ? body
              : { ...body, credential },
          ),
        (created) => created.id,
      );
    },
    [answer, orgId, sendTurn, start],
  );

  const answerWaitingRun = useCallback(
    (message: string, choice: ModelChoice | undefined) => {
      start.reset();

      return sendTurn(message, runId, () =>
        answer.mutateAsync({
          message,
          ...(choice?.model === undefined ? {} : { model: choice.model }),
        }),
      );
    },
    [answer, runId, sendTurn, start],
  );

  /*
   * The first run of a new project: the workspace composer's prompt and model pick, handed over
   * in navigation state (spec 007 R7, spec 011 US6), started as soon as there is an organisation
   * to start it under. Once, by the ref: `selectRun` then replaces the address, which drops the
   * state, so a reload comes back to the run rather than starting another.
   */
  const handoff = handoffFrom(useLocation().state);
  const handedOff = useRef(false);
  const { setChoice } = modelState;

  useEffect(() => {
    if (handedOff.current || orgId === undefined || handoff.prompt === undefined) {
      return;
    }

    handedOff.current = true;
    // The pick that came with the project is this project's from now on.
    if (handoff.choice !== undefined) setChoice(handoff.choice);
    // A refusal is shown on the screen; nothing else waits on this promise.
    startRun(handoff.prompt, handoff.choice, handoff.credential).catch(() => undefined);
  }, [handoff.choice, handoff.credential, handoff.prompt, orgId, setChoice, startRun]);

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
   * project with no run has no phase — not "Queued", which would claim a run exists, and would be
   * wrong after a refused request.
   */
  const paths = changedPaths(items);
  const log = activityLines(items);

  const phase = run === undefined ? undefined : statusToPhase(run.status);
  const isRunning = run !== undefined && !isTerminal(run.status);
  const isAwaitingInput = run?.status === 'awaiting_input';

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
  const refused: unknown = start.error ?? answer.error ?? stop.error ?? error;
  // Nothing can pay (spec 043): the composer offers to connect instead — a way forward, not an
  // error. The API's own refusal counts until a subscription is connected.
  const needsConnection =
    modelState.needsConnection ||
    (ApiProblem.is(refused, 'subscription-not-connected') &&
      modelState.subscriptions.data?.claude.state !== 'connected');
  // Spec 032 T048: a `409 subscription-limited` says whose limit and until when, and — when the
  // organisation has a credential — offers it for this one run; nothing moves without the click.
  const limit = limitOfRefusal(start.error);
  const lastRequest = start.variables;
  const refusal =
    limit !== undefined
      ? limitSentence(limit)
      : refused === null || refused === undefined || needsConnection
        ? undefined
        : (byosRefusalCopy(refused) ?? messageFor(refused));
  const refusalAction =
    limit?.alternativeMode === undefined || lastRequest === undefined
      ? undefined
      : {
          label: RUN_ON_ORGANISATION,
          onClick: () => {
            start.mutate({ ...lastRequest, credential: 'organisation' });
          },
        };

  // This run's messages in place; one still on its way to the screen (no run yet, or a run the
  // address has not caught up with) at the foot of whatever is shown.
  const shownTurns = useMemo(
    () =>
      turns
        .filter(
          (turn) => turn.runId === undefined || turn.runId === runId || turn.runId === awaitedRunId,
        )
        .map((turn) => (turn.runId === runId ? turn : { ...turn, at: Number.POSITIVE_INFINITY })),
    [awaitedRunId, runId, turns],
  );
  // A failed or cancelled run is sent again as a new run on the current model — when this screen
  // holds its whole prompt; the run record carries only an excerpt.
  const retryPrompt = turns.find((turn) => turn.runId === runId && turn.at === 0)?.text;
  const { choice } = modelState;
  const retryRun =
    retryPrompt === undefined
      ? undefined
      : () => {
          startRun(retryPrompt, choice).catch(() => undefined);
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
          composer={
            <ChatComposer
              key={projectId}
              isAnswering={isAwaitingInput}
              isRunning={isRunning}
              isSending={start.isPending || answer.isPending}
              isStopping={isStopping}
              modelState={modelState}
              needsConnection={needsConnection}
              onStop={stopRun}
              onSubmit={(prompt) =>
                // Belt and braces with the API, which redirects a new run to a waiting one too.
                isAwaitingInput ? answerWaitingRun(prompt, choice) : startRun(prompt, choice)
              }
              placeholder="Ask for a change to this project"
            />
          }
          connection={connection}
          isRunning={isRunning}
          items={items}
          onRetry={retry}
          onRetryRun={retryRun}
          refusal={refusal}
          refusalAction={refusalAction}
          run={run}
          source={source}
          turns={shownTurns}
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
              phase={phase ?? 'queued'}
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
