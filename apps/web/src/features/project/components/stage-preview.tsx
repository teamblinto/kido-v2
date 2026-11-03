import type { PreviewVisibility } from '@repo/contracts';
import {
  CopyIcon,
  ExternalLinkIcon,
  MonitorIcon,
  RefreshCwIcon,
  SmartphoneIcon,
} from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isAsleep, useWake } from '../hooks/use-files';
import { usePreview, usePreviewFrameSrc, useRotate, useSetVisibility } from '../hooks/use-preview';
import type { PreviewViewport } from '../hooks/use-project-workspace';
import { runPhaseTone, toneDot } from '../lib/run-phase';
import type { RunPhase } from '../types';
import { AsleepPane } from './asleep-pane';
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
  phase: RunPhase;
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
  const frameSrc = usePreviewFrameSrc(preview.data, reloadKey);
  const asleep = isAsleep(preview.error) || preview.data?.port === null;

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
          <span
            aria-hidden="true"
            className={cn('size-[7px] shrink-0 rounded-full', toneDot[runPhaseTone(phase)])}
          />
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

        <RunStatusChip phase={phase} className="shrink-0 max-sm:hidden" />
      </div>

      <div className="bg-canvas flex min-h-0 flex-1 justify-center overflow-auto">
        {asleep ? (
          <AsleepPane
            because={wake.data?.because ?? (wake.isPending ? 'resuming' : null)}
            error={wake.error ?? undefined}
            onWake={() => {
              wake.mutate();
            }}
          />
        ) : (
          <div
            className={cn(
              'flex h-full w-full flex-col',
              // The phone frame is what the viewport switch above changes to.
              viewport === 'mobile' && 'border-line-subtle max-w-[420px] border-x',
            )}
          >
            <PreviewFrame reloadKey={reloadKey} url={frameSrc} />
          </div>
        )}
      </div>
    </div>
  );
}
