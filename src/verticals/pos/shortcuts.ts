/**
 * The till's function-key shortcuts (H4).
 *
 * One pure mapping, so the keys the cashier presses and the actions the till takes cannot drift
 * apart, and so the mapping can be asserted without a browser.
 *
 *   * F2 — focus the scan field (a cashier's manual "scan now"),
 *   * F3 — hold: park the current cart and start a fresh one,
 *   * F4 — recall the most recently parked cart,
 *   * F9 — pay: open payment with the exact amount preselected, Enter confirms,
 *   * F10 — pay in ZWG (the converted exact amount).
 */

export type PosShortcut = 'scan' | 'hold' | 'recall' | 'pay' | 'pay-zwg';

export const POS_SHORTCUTS: ReadonlyArray<{ key: string; shortcut: PosShortcut; label: string }> = [
  { key: 'F2', shortcut: 'scan', label: 'Scan' },
  { key: 'F3', shortcut: 'hold', label: 'Hold' },
  { key: 'F4', shortcut: 'recall', label: 'Recall' },
  { key: 'F9', shortcut: 'pay', label: 'Pay (exact cash)' },
  { key: 'F10', shortcut: 'pay-zwg', label: 'Pay (exact ZWG)' },
];

/** Resolve a key event's `key` to a till shortcut, or null when it is not a shortcut. */
export function resolveShortcut(key: string): PosShortcut | null {
  switch (key) {
    case 'F2':
      return 'scan';
    case 'F3':
      return 'hold';
    case 'F4':
      return 'recall';
    case 'F9':
      return 'pay';
    case 'F10':
      return 'pay-zwg';
    default:
      return null;
  }
}

/** The hint line shown on the till, derived from the same mapping. */
export function shortcutHint(): string {
  return POS_SHORTCUTS.map((entry) => `${entry.key} ${entry.label}`).join(' · ');
}
