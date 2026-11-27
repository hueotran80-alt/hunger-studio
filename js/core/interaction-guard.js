/**
 * Shared ownership rules for global keyboard shortcuts.
 * Viewport shortcuts must not run while a dialog is open, while the user is
 * typing, or (for Tab) while focus is on another interactive control.
 */

const NON_TEXT_INPUT_TYPES = new Set([
  'range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image'
]);

export function isTextEntryTarget(target = document.activeElement) {
  if (!target || target === document.body || target === document.documentElement) return false;
  const tag = target.tagName ? target.tagName.toLowerCase() : '';
  if (tag === 'input') {
    const inputType = String(target.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }
  if (tag === 'textarea' || tag === 'select' || tag === 'option') return true;
  if (target.isContentEditable) return true;
  const role = String(target.getAttribute?.('role') || '').toLowerCase();
  return role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton';
}

export function hasModalOverlay() {
  if (typeof document === 'undefined') return false;
  const hit = document.querySelector(
    '.ss-backdrop:not([hidden]), .cp-backdrop:not([hidden]), .vr-backdrop:not([hidden]), ' +
    '.wbs-modal-backdrop:not([hidden]), ' +
    '.agent-confirm-backdrop, .blender-kf-modal.is-open, dialog[open]'
  );
  if (!hit) return false;
  if (hit.style && hit.style.display === 'none') return false;
  return true;
}

/**
 * G/R/S modal transform owns the keyboard while active: X/Y/Z, digits and
 * Backspace are handled there, but Delete, Tab, camera presets and Ctrl+Z used
 * to leak through and mutate/delete the object being transformed.
 */
export function isModalTransformActive() {
  if (typeof window === 'undefined') return false;
  return !!(
    (window.app && window.app.modalTransform && window.app.modalTransform.isActive) ||
    window.modalTransformManager?.isActive
  );
}

export function shouldBlockViewportShortcut() {
  return isTextEntryTarget() || hasModalOverlay() || isModalTransformActive();
}

export function isInteractiveTarget(target = document.activeElement) {
  if (!target || target === document.body || target === document.documentElement) return false;
  if (isTextEntryTarget(target)) return true;
  const tag = target.tagName ? target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'button' || tag === 'a' || tag === 'summary') return true;
  return String(target.getAttribute?.('role') || '').toLowerCase() === 'button';
}
