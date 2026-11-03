/**
 * Keyboard entry for power and angle — type the number instead of nudging it with arrows or the mouse.
 *
 * The one non-obvious thing: the angle the player types is the DISPLAYED one (right-half tanks see it
 * mirrored, see `core/aimDisplay`), so a commit converts it back to the stored absolute aim with the
 * same self-inverse `toDisplayAngle`. Power is committed as typed, clamped to POWER_MIN..POWER_MAX.
 *
 * Opening an entry does NOT blank the readout: it starts out holding the current value, SELECTED (the
 * HUD highlights it), like clicking into a text box that selects-all. The first digit replaces it;
 * Enter with the selection untouched commits nothing, so the aim stays exactly where it was.
 */

import {signal} from '@preact/signals';
import {toDisplayAngle} from '../core/aimDisplay';
import {aimMirror, angle, power, POWER_MAX, POWER_MIN, wrapAngle} from './store';

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

export type AimField = 'power' | 'angle';

export interface AimEntry {
  field: AimField;
  /** The readout's digits: the current value right after opening, then what was typed. */
  text: string;
  /** True until the first keystroke: `text` is the untouched current value, shown highlighted, and
   *  the next digit replaces it rather than appending. */
  selected: boolean;
}

// ==========================================================================
// ENTRY STATE
// ==========================================================================

/** The field being typed into, or null when the HUD shows live values. Read by the HUD readouts. */
export const aimEntry = signal<AimEntry | null>(null);

const MAX_DIGITS: Record<AimField, number> = {power: String(POWER_MAX).length, angle: 3};

/** Open `field` holding its current value (as displayed — the angle mirrored), selected. */
export function openAimEntry(field: AimField): void {
  const text = field === 'power' ? String(power.value) : String(toDisplayAngle(angle.value, aimMirror.value));
  aimEntry.value = {field, text, selected: true};
}

export function cancelAimEntry(): void {
  aimEntry.value = null;
}

/** Swap between power and angle, discarding what was typed. */
export function toggleAimEntry(): void {
  const e = aimEntry.value;
  if (e) openAimEntry(e.field === 'power' ? 'angle' : 'power');
}

export function typeAimDigit(digit: string): void {
  const e = aimEntry.value;
  if (!e) return;
  if (e.selected) aimEntry.value = {...e, text: digit, selected: false};
  else if (e.text.length < MAX_DIGITS[e.field]) aimEntry.value = {...e, text: e.text + digit};
}

/** Delete the last digit — or, with the value still selected, clear the whole selection. */
export function backspaceAimEntry(): void {
  const e = aimEntry.value;
  if (e) aimEntry.value = {...e, text: e.selected ? '' : e.text.slice(0, -1), selected: false};
}

// ==========================================================================
// COMMIT
// ==========================================================================

/** The stored value a typed entry resolves to, or null when nothing was typed (an empty field, or the
 *  opening selection left untouched — the aim is kept as is). Pure — no side effects. */
export function resolveAimEntry(e: AimEntry, mirrored: boolean): number | null {
  if (e.selected || !e.text) return null;
  const n = Number(e.text);
  return e.field === 'power' ? Math.min(POWER_MAX, Math.max(POWER_MIN, n)) : wrapAngle(toDisplayAngle(n, mirrored));
}

/** Map a key `code` to a typed digit ('0'..'9'), main row or numpad; null for anything else. */
export function digitOf(code: string): string | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  return m ? m[1] : null;
}
