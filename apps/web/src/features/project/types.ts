/*
 * The project workspace's presentation vocabulary.
 *
 * What is left here is the words the screen speaks in — a run's phase, the tone it paints with,
 * which pane is showing — and nothing about what any of them contain. The shapes that used to
 * live below this line described a run nobody had made: a rota with people's names in it, a file
 * tree, a diff, a list of checkpoints. They were deleted with the module that filled them
 * (FR-027), because a screen that mixes a real run with a convincing fixture is harder to catch
 * than a wholly fictional one.
 *
 * Everything the screen shows now arrives as an event on the run's own stream, and the shapes for
 * those belong to `@repo/contracts`, where the server and the client can be held to the same one.
 */

/** The lifecycle word shown in the topbar and on the preview's address bar. */
export type RunPhase =
  | 'asleep'
  | 'building'
  | 'needs-a-fix'
  | 'paused'
  | 'queued'
  | 'ready'
  | 'starting'
  | 'waiting-for-you';

/** The colour family a run phase or state card borrows. */
export type RunTone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';

/** Which pane of the stage is on show. */
export type StageTab = 'code' | 'git' | 'preview';

/** Git has two views behind one tab: what has changed, and what came before. */
export type GitView = 'changes' | 'history';

/** How a tool call ended. Drives the trailing glyph on its card. */
export type ToolStatus = 'done' | 'failed' | 'running';

/** The tool that ran, mapped to an icon by the card. */
export type ToolKind = 'edit' | 'exec' | 'package';
