/**
 * Asks for an optional note to attach to a highlight.
 *
 * Runs in the page because a background script has no window to prompt from —
 * background pages are hidden, and prompt() there is a no-op in Firefox.
 * Injected only for the "with note" menu item, and only after the selection
 * has already been read (a modal can drop the selection).
 *
 * Completion value goes back to background.js via tabs.executeScript().
 */
(() => {
  'use strict';
  const note = window.prompt('Note for this highlight (optional):', '');
  // Cancel means "never mind", which has to be distinguishable from an empty
  // note — otherwise dismissing the dialog would still save the quote.
  if (note === null) return { cancelled: true };
  return { note: note.trim().slice(0, 20000) };
})();
