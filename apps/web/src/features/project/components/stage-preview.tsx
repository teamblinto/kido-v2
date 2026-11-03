import type { PreviewStage, PreviewVisibility } from '@repo/contracts';
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MonitorIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';

import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useNow } from '@/hooks/use-now';
import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { isAsleep, useWake } from '../hooks/use-files';
import { usePreview, usePreviewFrameSrc, useRotate, useSetVisibility } from '../hooks/use-preview';
import type { PreviewViewport } from '../hooks/use-project-workspace';
import { runPhaseTone, toneDot } from '../lib/run-phase';
import type { RunPhase } from '../types';
import { AsleepPane } from './asleep-pane';
import { EmptyPane } from './empty-pane';
import { PreviewFrame } from './preview-frame';
import { RunStatusChip } from './run-status-chip';
import { SegmentedControl } from './segmented-control';

const VISIBILITIES: readonly PreviewVisibility[] = ['private', 'org', 'public'];

const VIEWPORTS = [
  { icon: MonitorIcon, id: 'desktop', label: 'Desktop' },
  { icon: SmartphoneIcon, id: 'mobile', label: 'Mobile' },
] as const satisfies readonly { icon: typeof MonitorIcon; id: PreviewViewport; label: string }[];

interface StagePreviewProps {
  className?: string;
  orgId: string | undefined;
  /**
   * The caller's own permissions for this project, from the project read (unqualified). Defaults
   * to none: a page that has not loaded them yet shows a viewer's preview, never a rotate button
   * the API would refuse.
   */
  permissions?: readonly string[];
  /** Absent while the project has no run: no dot or chip claims a run state that does not exist. */
  phase?: RunPhase;
  /**
   * How many `preview.ready` and `checkpoint` events the run has announced, counted by the page
   * from `useRunStream`'s `onEvent`. Each one reloads the frame; none of them is the address (FR-016).
   */
  previewReadyCount?: number;
  projectId: string | undefined;
}

/** The live preview: its address bar, and whatever the project has running. */
export function StagePreview({
  className,
  orgId,
  permissions = [],
  phase,
  previewReadyCount = 0,
  projectId,
}: StagePreviewProps): React.JSX.Element {
  const project = { orgId, projectId };
  const preview = usePreview(project);
  const setVisibility = useSetVisibility(project);
  const rotate = useRotate(project);
  const wake = useWake(orgId, projectId);

  const [viewport, setViewport] = useState<PreviewViewport>('desktop');

  /*
   * Reloads asked for here, plus reloads the run announced. Summed rather than synced into state:
   * the effect that would copy the count across is a render the sum has already done.
   */
  const [bumps, setBumps] = useState(0);
  const reloadKey = bumps + previewReadyCount;

  const mayRotate = permissions.includes('project:preview.rotate');
  const url = preview.data?.url;
  const stage = preview.data?.stage;
  // Only a ready preview is framed, so only a ready one spends a grant code.
  const frameSrc = usePreviewFrameSrc(stage === 'ready' ? preview.data : undefined, reloadKey);
  const asleep = isAsleep(preview.error) || stage === 'asleep';

  /*
   * The last start-up step this pane watched, kept so a failure can name the step it stopped on
   * and so a start-up seen here ends in a cross-fade rather than a cut. Adjusted during render
   * (React's "storing information from previous renders"), not synced in an effect.
   */
  const [lastStep, setLastStep] = useState<StartupStage | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);

  if (stage !== undefined && isStartup(stage) && stage !== lastStep) {
    setLastStep(stage);
    setFrameLoaded(false);
  }

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      <div className="bg-raised border-line-subtle flex shrink-0 flex-wrap items-center gap-[9px] border-b px-3.5 py-[9px]">
        <button
          type="button"
          onClick={() => {
            setBumps((count) => count + 1);
          }}
          className="text-subdued hover:text-foreground shrink-0 rounded-sm transition-colors"
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Reload the preview</span>
        </button>

        <p className="bg-muted flex min-w-0 flex-1 items-center gap-2 rounded-md px-[11px] py-1.5">
          {phase ? (
            <span
              aria-hidden="true"
              className={cn('size-[7px] shrink-0 rounded-full', toneDot[runPhaseTone(phase)])}
            />
          ) : null}
          {/* The address bar shows the preview's address or nothing — never a plausible-looking one. */}
          <span className="text-mono-sm text-subdued truncate font-mono">
            {url ?? 'No preview yet'}
          </span>
          {preview.data ? (
            <Badge variant="muted" className="ml-auto shrink-0">
              {preview.data.visibility}
            </Badge>
          ) : null}
        </p>

        <button
          type="button"
          disabled={url === undefined}
          onClick={() => {
            if (url !== undefined) {
              void navigator.clipboard.writeText(url);
            }
          }}
          className="text-subdued hover:text-foreground shrink-0 rounded-sm transition-colors disabled:opacity-50"
        >
          <CopyIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Copy the preview address</span>
        </button>

        <a
          href={url ?? '#'}
          target="_blank"
          rel="noreferrer"
          aria-disabled={url === undefined}
          className="text-subdued hover:text-foreground aria-disabled:pointer-events-none shrink-0 rounded-sm transition-colors aria-disabled:opacity-50"
        >
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Open the preview in a new tab</span>
        </a>

        {mayRotate ? (
          <>
            {/* Native select: keyboard- and screen-reader-operable without a listbox of our own,
                and there are three options that never grow a description. */}
            <select
              aria-label="Preview visibility"
              disabled={preview.data === undefined || setVisibility.isPending}
              value={preview.data?.visibility ?? 'private'}
              onChange={(event) => {
                setVisibility.mutate(event.target.value as PreviewVisibility);
              }}
              className="border-line bg-raised text-label-sm text-subdued shrink-0 rounded-md border px-2 py-1"
            >
              {VISIBILITIES.map((visibility) => (
                <option key={visibility} value={visibility}>
                  {visibility}
                </option>
              ))}
            </select>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rotate.isPending}
              onClick={() => {
                // Awaited rather than invalidated-and-hoped: the old label stops resolving the
                // moment this lands, so the frame reloads only once the new address is in the
                // query — a bump any earlier points it at a dead host.
                void rotate.mutateAsync().then(
                  () => {
                    setBumps((count) => count + 1);
                  },
                  () => {
                    // The refusal is on the mutation; the frame keeps the address it had.
                  },
                );
              }}
            >
              Rotate
            </Button>
          </>
        ) : null}

        <SegmentedControl
          ariaLabel="Preview viewport"
          items={VIEWPORTS}
          onChange={setViewport}
          value={viewport}
          className="shrink-0"
        />

        {phase ? <RunStatusChip phase={phase} className="shrink-0 max-sm:hidden" /> : null}
      </div>

      <div className="bg-canvas relative flex min-h-0 flex-1 justify-center overflow-auto">
        {asleep ? (
          <AsleepPane
            because={wake.data?.because ?? (wake.isPending ? 'resuming' : null)}
            error={wake.error ?? undefined}
            onWake={() => {
              wake.mutate();
            }}
          />
        ) : stage === 'ready' ? (
          // Mounted only now: before `ready` the gateway has no route, and a frame pointed at it
          // shows the browser's own "invalid response" page instead of ours.
          <div
            className={cn(
              'flex h-full w-full flex-col',
              // The phone frame is what the viewport switch above changes to.
              viewport === 'mobile' && 'border-line-subtle max-w-[420px] border-x',
            )}
          >
            <PreviewFrame
              onLoad={() => {
                setFrameLoaded(true);
              }}
              reloadKey={reloadKey}
              url={frameSrc}
            />
          </div>
        ) : stage === undefined || stage === 'no-sandbox' ? (
          <EmptyPane
            title="No preview yet"
            body="When this project has something running, its preview appears here."
          />
        ) : null}

        {/* Its own slot, so one instance (and one elapsed clock) walks every step; a retry is a
            new attempt, so it gets a new instance. */}
        {!asleep &&
        stage !== undefined &&
        (isStartup(stage) || stage === 'failed' || (stage === 'ready' && lastStep !== null)) ? (
          <PreviewProgress
            key={wake.submittedAt}
            error={wake.error ?? undefined}
            failedAt={lastStep}
            onRetry={() => {
              wake.mutate();
            }}
            retrying={wake.isPending}
            stage={stage}
            // At `ready` it lies over the frame until the frame has loaded, then fades away.
            className={
              stage === 'ready'
                ? cn(
                    'bg-canvas absolute inset-0 transition-opacity duration-(--duration-slow) ease-standard',
                    frameLoaded && 'pointer-events-none opacity-0',
                  )
                : undefined
            }
            onFaded={() => {
              if (frameLoaded) setLastStep(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

const STARTUP_STEPS = [
  { label: 'Creating your sandbox', stage: 'creating' },
  { label: 'Installing dependencies', stage: 'installing' },
  { label: 'Starting the dev server', stage: 'starting' },
] as const;

const STEPS = [...STARTUP_STEPS, { label: 'Ready', stage: 'ready' }] as const;

type StartupStage = (typeof STARTUP_STEPS)[number]['stage'];

type StepState = 'active' | 'done' | 'failed' | 'pending';

function isStartup(stage: PreviewStage): stage is StartupStage {
  return STARTUP_STEPS.some((step) => step.stage === stage);
}

const STEP_SR: Record<StepState, string> = {
  active: 'in progress',
  done: 'done',
  failed: 'failed',
  pending: 'not started',
};

/** `12 s`, `1 min 05 s`. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  return seconds < 60
    ? `${String(seconds)} s`
    : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60).padStart(2, '0')} s`;
}

interface PreviewProgressProps {
  className?: string | undefined;
  error: unknown;
  /** The last start-up step seen before a failure; `null` when the pane never saw one. */
  failedAt: StartupStage | null;
  onFaded: () => void;
  onRetry: () => void;
  retrying: boolean;
  stage: StartupStage | 'failed' | 'ready';
}

/** The sandbox on its way to a preview: each step done, under way or still to come. */
function PreviewProgress({
  className,
  error,
  failedAt,
  onFaded,
  onRetry,
  retrying,
  stage,
}: PreviewProgressProps): React.JSX.Element {
  const id = useId();
  const [startedAt] = useState(() => Date.now());
  const now = useNow(1_000);
  const failed = stage === 'failed';
  const running = !failed && stage !== 'ready';
  const at = STEPS.findIndex((step) => step.stage === (failed ? failedAt : stage));
  const states = STEPS.map((_, index): StepState => {
    if (index < at) return 'done';
    if (index > at) return 'pending';
    if (failed) return 'failed';
    return stage === 'ready' ? 'done' : 'active';
  });
  const current = STEPS[at];
  const title = failed
    ? 'Your preview could not start'
    : stage === 'ready'
      ? 'Your preview is ready'
      : 'Starting your preview';

  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      onTransitionEnd={(event) => {
        // Its own opacity only, not a step label's colour bubbling up.
        if (event.target === event.currentTarget) onFaded();
      }}
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10',
        'animate-in fade-in-0 duration-(--duration-base)',
        className,
      )}
    >
      <div className="w-full max-w-[340px]">
        <div className="flex items-center gap-2.5">
          {failed ? (
            <AlertTriangleIcon className="text-danger size-4 shrink-0" aria-hidden="true" />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                'bg-brand size-2 shrink-0 rounded-full',
                running && 'animate-breathe motion-reduce:animate-none',
              )}
            />
          )}
          <p id={`${id}-title`} className="text-label-md text-foreground font-medium">
            {title}
          </p>
          {running ? (
            <span className="text-caption text-faint ml-auto tabular-nums">
              <span className="sr-only">Elapsed </span>
              {formatElapsed(now - startedAt)}
            </span>
          ) : null}
        </div>

        {at === -1 ? null : (
          <>
            <Progress
              aria-label="Preview start-up"
              className="mt-3"
              getValueLabel={() => current?.label ?? title}
              value={
                stage === 'ready' ? 100 : ((at + (failed ? 0 : 0.5)) / STARTUP_STEPS.length) * 100
              }
            />
            <ol className="mt-4 grid gap-2.5">
              {STEPS.map((step, index) => {
                const state = states[index] ?? 'pending';

                return (
                  <li
                    key={step.stage}
                    data-state={state}
                    aria-current={state === 'active' ? 'step' : undefined}
                    className="text-body-sm flex items-center gap-2.5"
                  >
                    <StepIcon state={state} />
                    <span
                      className={cn(
                        'transition-colors duration-(--duration-base)',
                        state === 'pending' && 'text-faint',
                        state === 'active' && 'text-foreground font-medium',
                        state === 'done' && 'text-subdued',
                        state === 'failed' && 'text-danger font-medium',
                      )}
                    >
                      {step.label}
                    </span>
                    <span className="sr-only">({STEP_SR[state]})</span>
                  </li>
                );
              })}
            </ol>
          </>
        )}

        {failed ? (
          <div className="mt-5 grid justify-items-start gap-3">
            <p className="text-body-sm text-subdued">
              Something went wrong while the sandbox was starting. Trying again starts it over.
            </p>
            {error === undefined ? null : (
              <Alert variant="danger">
                <AlertTriangleIcon />
                <AlertTitle>{messageFor(error, 'The preview could not be restarted.')}</AlertTitle>
              </Alert>
            )}
            <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
              {retrying ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
              {retrying ? 'Retrying…' : 'Try again'}
            </Button>
          </div>
        ) : null}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {failed ? title : stage === 'ready' ? title : `${current?.label ?? title}…`}
      </p>
    </div>
  );
}

function StepIcon({ state }: { state: StepState }): React.JSX.Element {
  const ring = 'flex size-4 shrink-0 items-center justify-center rounded-full';

  switch (state) {
    case 'done':
      return (
        <span
          aria-hidden="true"
          className={cn(ring, 'bg-success-soft text-success animate-in zoom-in-50 fade-in-0')}
        >
          <CheckIcon className="size-3" strokeWidth={3} />
        </span>
      );
    case 'active':
      return <Loader2Icon aria-hidden="true" className="text-brand size-4 shrink-0 animate-spin" />;
    case 'failed':
      return (
        <span aria-hidden="true" className={cn(ring, 'bg-danger-soft text-danger')}>
          <XIcon className="size-3" strokeWidth={3} />
        </span>
      );
    case 'pending':
      return <span aria-hidden="true" className={cn(ring, 'border-line-strong border')} />;
  }
}
