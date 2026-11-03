import { metaShortcutLabel, useMetaShortcut } from '@/hooks/use-meta-shortcut';

/** How the palette shortcut is written on this platform. */
export const commandShortcutLabel = metaShortcutLabel('k');

/** Opens the command palette on ⌘K / Ctrl+K from anywhere on the page. */
export function useCommandShortcut(onTrigger: () => void): void {
  useMetaShortcut('k', onTrigger);
}
