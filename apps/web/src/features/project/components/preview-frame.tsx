import { cn } from '@/lib/utils';
import { EmptyPane } from './empty-pane';

interface PreviewFrameProps {
  className?: string;
  /** The framed document finished loading: what the stage waits on before fading over to it. */
  onLoad?: () => void;
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
export function PreviewFrame({
  className,
  onLoad,
  reloadKey,
  url,
}: PreviewFrameProps): React.JSX.Element {
  // `allow-same-origin` below is safe only because the preview is served from its own origin; a
  // url on this app's origin would hand the agent's output this app, so it is never framed.
  if (url === undefined || url.length === 0 || new URL(url).origin === window.location.origin) {
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
      // FR-017. The preview is the agent's own output and must never reach this app. It is served
      // from its own `<label>-<port>.<preview domain>` origin (guarded above), so
      // `allow-same-origin` keeps *that* origin — what it has opened in a tab — rather than this
      // app's. Without it the document is opaque (`Origin: null`): its module scripts fail CORS
      // and carry no grant cookie, so no Vite/Next app can run in the frame. Nothing else widens.
      sandbox="allow-scripts allow-forms allow-same-origin"
      onLoad={onLoad}
      className={cn(
        'animate-in fade-in-0 duration-(--duration-slow) size-full border-0',
        className,
      )}
    />
  );
}
