import { cn } from '@/lib/utils';
import { EmptyPane } from './empty-pane';

interface PreviewFrameProps {
  className?: string;
  /**
   * Bumped whenever the frame should load again — the reload button, a rotate, a `preview.ready`.
   * It is the iframe's `key`, so a bump remounts the element: a same-`src` reload cannot be asked
   * for from out here otherwise, the document inside is cross-origin.
   */
  reloadKey: number;
  /**
   * The preview's address, from `GET .../preview`, or that address carrying a grant code minted
   * for it (`usePreviewFrameSrc`) — never from an event payload.
   */
  url: string | undefined;
}

/**
 * The running project, framed.
 *
 * The address is the label host the API serves, not something a run announced: a `preview.ready`
 * event is a signal that there is something new behind that address, and pointing the frame at
 * the event's own url instead would show whatever the sandbox last claimed (FR-016).
 */
export function PreviewFrame({ className, reloadKey, url }: PreviewFrameProps): React.JSX.Element {
  if (url === undefined || url.length === 0) {
    return (
      <EmptyPane
        className={className}
        title="No preview yet"
        body="When this project has something running, its preview appears here."
      />
    );
  }

  return (
    <iframe
      key={reloadKey}
      src={url}
      title="Project preview"
      // FR-017. The preview is the agent's own output: same-origin access to this app is not
      // something it should have, and `allow-same-origin` beside `allow-scripts` would hand it
      // exactly that. This attribute does not widen for convenience.
      sandbox="allow-scripts allow-forms"
      className={cn('size-full border-0', className)}
    />
  );
}
