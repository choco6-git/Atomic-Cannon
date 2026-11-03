import {describe, it, expect, beforeEach} from 'vitest';
import {
  aimEntry,
  backspaceAimEntry,
  cancelAimEntry,
  digitOf,
  openAimEntry,
  resolveAimEntry,
  typeAimDigit,
} from '../src/ui/aimEntry';
import {aimMirror, angle, power, POWER_MAX, POWER_MIN} from '../src/ui/store';

const typed = (field: 'power' | 'angle', text: string) => ({field, text, selected: false});

describe('aim entry', () => {
  it('clamps typed power into range', () => {
    expect(resolveAimEntry(typed('power', '5'), false)).toBe(POWER_MIN);
    expect(resolveAimEntry(typed('power', '9999'), false)).toBe(POWER_MAX);
    expect(resolveAimEntry(typed('power', '640'), false)).toBe(640);
  });
  it('maps a typed angle back through the display mirror', () => {
    expect(resolveAimEntry(typed('angle', '30'), false)).toBe(30);
    expect(resolveAimEntry(typed('angle', '30'), true)).toBe(150);
    expect(resolveAimEntry(typed('angle', '400'), false)).toBe(40);
  });
  it('returns null when nothing was typed', () => {
    expect(resolveAimEntry(typed('power', ''), false)).toBeNull();
  });
  it('reads main-row and numpad digits only', () => {
    expect(digitOf('Digit7')).toBe('7');
    expect(digitOf('Numpad3')).toBe('3');
    expect(digitOf('KeyA')).toBeNull();
  });
});

describe('aim entry selection', () => {
  beforeEach(() => {
    cancelAimEntry();
    power.value = 640;
    angle.value = 30;
    aimMirror.value = false;
  });

  it('opens holding the current value, selected, instead of blank', () => {
    openAimEntry('power');
    expect(aimEntry.value).toEqual({field: 'power', text: '640', selected: true});
  });
  it('opens the angle as displayed (mirrored for a right-half tank)', () => {
    aimMirror.value = true;
    openAimEntry('angle');
    expect(aimEntry.value).toEqual({field: 'angle', text: '150', selected: true});
  });
  it('commits nothing when the selection is left untouched', () => {
    openAimEntry('power');
    expect(resolveAimEntry(aimEntry.value!, false)).toBeNull();
  });
  it('replaces the selection with the first digit, then appends', () => {
    openAimEntry('power');
    typeAimDigit('7');
    expect(aimEntry.value).toEqual({field: 'power', text: '7', selected: false});
    typeAimDigit('2');
    expect(aimEntry.value!.text).toBe('72');
  });
  it('clears the whole selection on Backspace', () => {
    openAimEntry('power');
    backspaceAimEntry();
    expect(aimEntry.value).toEqual({field: 'power', text: '', selected: false});
  });
});
