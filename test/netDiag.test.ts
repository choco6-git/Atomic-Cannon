/**
 * The network diagnostic log: a bounded in-memory ring of one-line events (so a stalled match can be
 * explained after the fact) and the stall watchdog that decides when a "shot still resolving" state has
 * lasted too long. Pure logic — no DOM, no game objects.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {
  diag,
  diagClear,
  netLog,
  newWatch,
  briefMsg,
  watchTick,
  DIAG_CAPACITY,
  STALL_AFTER_MS,
  STALL_REPEAT_MS,
  STALL_MAX_DUMPS,
  type WatchSnap,
} from '../src/net/netDiag';

beforeEach(() => diagClear());

describe('diag ring buffer', () => {
  it('records a line with its kind and text', () => {
    diag('ws<-', 'turnBegin idx=1 gen=3');
    const out = netLog();
    expect(out).toContain('ws<-');
    expect(out).toContain('turnBegin idx=1 gen=3');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('keeps only the newest DIAG_CAPACITY lines', () => {
    for (let i = 0; i < DIAG_CAPACITY + 25; i++) diag('x', `line ${i}`);
    const lines = netLog().split('\n');
    expect(lines).toHaveLength(DIAG_CAPACITY);
    expect(lines[0]).toContain('line 25');
    expect(lines[lines.length - 1]).toContain(`line ${DIAG_CAPACITY + 24}`);
  });

  it('flattens newlines and truncates very long text so one event is one line', () => {
    diag('err', 'first\nsecond\r\nthird' + 'x'.repeat(2000));
    const lines = netLog().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThan(700);
    expect(lines[0]).toContain('first second');
  });

  it('diagClear empties the log', () => {
    diag('a', 'b');
    diagClear();
    expect(netLog()).toBe('');
  });
});

describe('watchTick', () => {
  const snap = (over: Partial<WatchSnap> = {}): WatchSnap => ({
    state: 'battle',
    resolving: false,
    current: 0,
    turnSeq: 1,
    detail: () => 'DETAIL',
    ...over,
  });

  it('logs a state line only when the observed state changes', () => {
    const w = newWatch();
    watchTick(w, snap(), 0);
    watchTick(w, snap(), 100);
    watchTick(w, snap({state: 'shot_flying', resolving: true}), 200);
    const lines = netLog().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('shot_flying');
  });

  it('dumps once when a shot has been resolving longer than STALL_AFTER_MS', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = newWatch();
    const s = snap({state: 'explosion', resolving: true});
    watchTick(w, s, 0);
    watchTick(w, s, STALL_AFTER_MS - 1);
    expect(netLog()).not.toContain('STALL');
    watchTick(w, s, STALL_AFTER_MS);
    expect(netLog()).toContain('STALL');
    expect(netLog()).toContain('DETAIL');
    expect(warn).toHaveBeenCalledTimes(1);
    watchTick(w, s, STALL_AFTER_MS + 100); // too soon for a repeat
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('repeats the dump every STALL_REPEAT_MS, at most STALL_MAX_DUMPS times', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = newWatch();
    const s = snap({state: 'explosion', resolving: true});
    watchTick(w, s, 0);
    for (let i = 0; i < STALL_MAX_DUMPS + 4; i++) watchTick(w, s, STALL_AFTER_MS + i * STALL_REPEAT_MS);
    expect(warn).toHaveBeenCalledTimes(STALL_MAX_DUMPS);
    warn.mockRestore();
  });

  it('a state change resets the stall clock', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = newWatch();
    watchTick(w, snap({state: 'explosion', resolving: true}), 0);
    watchTick(w, snap({state: 'battle', resolving: false}), STALL_AFTER_MS - 10);
    watchTick(w, snap({state: 'explosion', resolving: true, turnSeq: 2}), STALL_AFTER_MS - 5);
    watchTick(w, snap({state: 'explosion', resolving: true, turnSeq: 2}), STALL_AFTER_MS + 100);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('briefMsg', () => {
  it('summarises the fields that matter for diagnosing a stall', () => {
    expect(briefMsg({t: 'turnBegin', playerIdx: 1, turnGen: 4, handoff: true})).toBe('turnBegin idx=1 gen=4 handoff');
    expect(briefMsg({t: 'cmd', from: 2, seq: 7, cmd: {t: 'selectWeapon', index: 102}})).toBe(
      'cmd selectWeapon from=2 seq=7',
    );
    expect(briefMsg({t: 'shotResult', seq: 3, turnGen: 3, over: false, result: {tanks: [{}, {}]}})).toBe(
      'shotResult seq=3 gen=3 tanks=2',
    );
    expect(briefMsg({t: 'error', code: 'not_your_turn', message: 'not your turn'})).toBe(
      'error not_your_turn: not your turn',
    );
    expect(briefMsg({t: 'stateUpdate', from: 1, seq: 3, hash: 99})).toBe('stateUpdate from=1 seq=3 hash=99');
  });

  it('never throws on odd input', () => {
    expect(briefMsg(null)).toBe('?');
    expect(briefMsg('x')).toBe('?');
    expect(briefMsg({})).toBe('?');
    expect(briefMsg({t: 'cmd', cmd: null})).toBe('cmd');
  });
});
