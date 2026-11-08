/**
 * The command palette's shortcut (FR-UI-03): Cmd+K on macOS, Ctrl+K on Windows and Linux, never with
 * Shift or Alt (other browser shortcuts use those). In a text field the browser keeps Ctrl/Cmd+K; inside
 * the open palette the shortcut closes it, as other command palettes do.
 *
 * @implements FR-UI-03, NFR-A11Y-01
 */
import { useEffect, useEffectEvent } from 'react';

interface NavigatorWithUaData {
  readonly userAgentData?: { readonly platform?: string };
  readonly platform?: string;
}

/** macOS, iPadOS or iOS: Cmd is the command modifier there. */
export function isMacPlatform(nav: NavigatorWithUaData | undefined = globalThis.navigator): boolean {
  const name = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad|ipod/i.test(name);
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export function isPaletteShortcut(e: KeyLike, mac: boolean): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Input types where typing edits text, so Ctrl/Cmd+K belongs to the browser or the field. */
const TEXT_INPUTS: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
]);

export function isTextField(el: Element | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type || 'text');
  return el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('contenteditable') === 'true');
}

/** The keyboard label of the shortcut, for buttons and `aria-keyshortcuts`. */
export const shortcutLabel = (mac: boolean) =>
  mac ? { text: '⌘K', aria: 'Meta+K' } : { text: 'Ctrl K', aria: 'Control+K' };

/**
 * Listens for the shortcut on the window: opens the palette unless focus is in a text field, and closes it
 * when it is open.
 */
export function usePaletteShortcut(open: boolean, setOpen: (open: boolean) => void, enabled = true): void {
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (!isPaletteShortcut(e, isMacPlatform())) return;
    if (open) {
      e.preventDefault();
      setOpen(false);
    } else if (!isTextField(document.activeElement)) {
      e.preventDefault();
      setOpen(true);
    }
  });
  useEffect(() => {
    if (!enabled) return;
    const listener = (e: KeyboardEvent) => onKeyDown(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled]);
}
