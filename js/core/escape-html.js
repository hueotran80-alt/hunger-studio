/**
 * Shared HTML escaping utility for safe innerHTML interpolation when DOM textContent
 * cannot be used directly.
 * File: js/core/escape-html.js
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
