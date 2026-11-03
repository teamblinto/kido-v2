import { useEffect } from 'react';

const isAppleDevice = /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? '');

/** How a ⌘/Ctrl shortcut is written on this platform, e.g. "⌘K" or "Ctrl K". */
export function metaShortcutLabel(key: string): string {
  const upper = key.toUpperCase();

  return isAppleDevice ? `⌘${upper}` : `Ctrl ${upper}`;
}

/**
 * Runs `onTrigger` on ⌘+key (Ctrl+key off Apple platforms) from anywhere on the
 * page. Listens on the document so it works regardless of what has focus.
 */
export function useMetaShortcut(key: string, onTrigger: () => void): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== key.toLowerCase()) {
        return;
      }

      if (isAppleDevice ? !event.metaKey : !event.ctrlKey) {
        return;
      }

      event.preventDefault();
      onTrigger();
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [key, onTrigger]);
}
