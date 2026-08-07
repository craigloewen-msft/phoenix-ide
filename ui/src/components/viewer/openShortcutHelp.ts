/**
 * Opening the global shortcut guide from a viewer surface.
 *
 * The panel lives at the app root and is already toggled by a window event, so
 * a viewer asks for it the same way `?` does rather than threading a callback
 * down through every viewer prop chain.
 */
export function openShortcutHelp(): void {
  window.dispatchEvent(new CustomEvent('toggle-shortcut-help'));
}
