// Shared modal behaviour, kept deliberately tiny: an Escape key handler plus
// focus-on-mount for any element that carries role="dialog".
//
// A module-level stack means stacked dialogs (a ghost result behind the front
// one, the gallery's full-image viewer over the grid) do not all react to the
// same Escape — only the most recently activated dialog handles it.

/** @type {{ onEscape: (() => void) | null }[]} */
const stack = [];
let listening = false;

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (!top?.onEscape) return;
  e.stopPropagation();
  top.onEscape();
}

function sync() {
  if (stack.length > 0 && !listening) {
    window.addEventListener('keydown', onKeydown, true);
    listening = true;
  } else if (stack.length === 0 && listening) {
    window.removeEventListener('keydown', onKeydown, true);
    listening = false;
  }
}

/**
 * Svelte action. Params: a close callback, or `{ onEscape, active }` where
 * `active: false` keeps the dialog out of the Escape stack (ghost cards).
 *
 * @param {HTMLElement} node — the element with role="dialog" (needs tabindex="-1")
 */
export function dialog(node, params) {
  const entry = { onEscape: null };
  const prevFocus = document.activeElement;

  function apply(p) {
    const opts = typeof p === 'function' ? { onEscape: p } : (p ?? {});
    entry.onEscape = opts.onEscape ?? null;
    const wanted = opts.active !== false && !!entry.onEscape;
    const i = stack.indexOf(entry);
    if (wanted && i === -1) stack.push(entry);
    else if (!wanted && i !== -1) stack.splice(i, 1);
    sync();
  }

  apply(params);
  // Move focus into the dialog so keyboard and screen-reader users are not left
  // tabbing through the form behind it. Inactive dialogs (ghost cards) must not
  // steal focus from the one in front.
  if (stack.includes(entry)) {
    try { node.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }

  return {
    update(p) { apply(p); },
    destroy() {
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      sync();
      if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) {
        try { prevFocus.focus({ preventScroll: true }); } catch { /* gone */ }
      }
    },
  };
}
