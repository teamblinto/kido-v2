import type { PreviewStage } from '@repo/contracts';
import type { Sandbox } from '@repo/db';
import { z } from 'zod';

/** The columns the stage is read from: the row as the ops consumer settles it, plus the reports. */
export type StageRow = Pick<Sandbox, 'lostAt' | 'ports' | 'state' | 'transition' | 'workspaceRoot'>;

/** The `sandboxes.ports` entry the `preview.status` callback writes; anything else is "no report". */
const reportSchema = z.object({ state: z.enum(['failed', 'listening', 'starting']) });

/**
 * Where a project's preview is on its way to serving, from the row and the dev supervisor's last
 * report alone: no adapter call and no wake, so `GET …/preview` can be polled.
 *
 * - No `devPort` (python): `no-sandbox`, whatever the row says. Such a template never has a
 *   preview to wait for or a frame to mount, and its answer already carries `port: null, url: ''`.
 * - `installing` is never answered. Dependencies are installed when the template image is published
 *   (`template.json` `install`, `TemplatePublisher`), so a claimed or resumed sandbox boots with
 *   them; the dev supervisor's only phases are `starting`, `listening` and `failed`. It stays in
 *   the contract for a template that installs at boot.
 * - A releasing row is the "no sandbox" `SandboxService` treats it as; a resume is the dev
 *   server's start, not a second creation; a row that settled with no work dir is a create that
 *   dead-lettered. A dev server nobody has reported on yet is still starting (the supervisor's
 *   first report is `starting`, sent right after its spawn), never failed.
 */
export function previewStage(row: StageRow | undefined, port: number | null): PreviewStage {
  if (port === null || row === undefined) return 'no-sandbox';
  // Recoverable the way a hibernated row is: a wake claims a replacement and restores the files.
  if (row.lostAt !== null) return 'asleep';

  switch (row.transition) {
    case 'creating':
      return 'creating';
    case 'resuming':
      return 'starting';
    case 'hibernating':
      return 'asleep';
    case 'releasing':
      return 'no-sandbox';
    case null:
      break;
  }

  if (row.state === 'hibernated') return 'asleep';
  if (row.state !== 'active' && row.state !== 'idle') return 'no-sandbox';
  if (row.workspaceRoot === null) return 'failed';

  const ports = row.ports as Record<string, unknown> | null;
  const report = reportSchema.safeParse(ports?.[String(port)]).data?.state;
  return report === 'listening' ? 'ready' : report === 'failed' ? 'failed' : 'starting';
}
