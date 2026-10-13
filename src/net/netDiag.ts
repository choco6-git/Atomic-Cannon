/**
 * Network diagnostic log — a small in-memory ring of one-line events so a stalled network match can be
 * explained after the fact. Nothing is printed during normal play; when a match hangs, run
 * `copy(netLog())` in the browser console and send the text. The one non-obvious part is the stall
 * watchdog: it fires on "a shot has been resolving for a long time", which is exactly the state in
 * which a client stops draining the server's events and both players end up waiting on each other.
 * Free functions over module state (no class), dependency-free so any layer can log.
 */

// ==========================================================================
// TUNING
// ==========================================================================

/** Lines kept; older ones are dropped. */
export const DIAG_CAPACITY = 500;
/** A shot "resolving" this long (wall clock) is reported as a stall. */
export const STALL_AFTER_MS = 10_000;
/** Gap between repeated stall dumps while the stall persists. */
export const STALL_REPEAT_MS = 15_000;
/** Most stall dumps per stall. */
export const STALL_MAX_DUMPS = 5;
/** No rendered frame for this long, in a visible tab during a net match, is reported. */
const FRAME_STALL_MS = 4000;
const MAX_LINE = 400;

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

/** What the stall watchdog looks at each frame. `detail` is only evaluated when a dump is written. */
export interface WatchSnap {
  state: string;
  resolving: boolean;
  current: number;
  turnSeq: number;
  detail: () => string;
}

/** The watchdog's own memory between frames. */
export interface WatchState {
  key: string;
  resolvingSince: number;
  lastDump: number;
  dumps: number;
}

// ==========================================================================
// RING BUFFER
// ==========================================================================

const lines: string[] = [];

/** Record one event. `kind` is a short tag (ws<-, ws->, queue, turn, state, STALL...). */
export function diag(kind: string, text: string): void {
  const flat = text.replace(/[\r\n]+/g, ' ').slice(0, MAX_LINE);
  const t = Math.round(performance.now());
  lines.push(`${String(t).padStart(8)}ms ${kind.padEnd(8)} ${flat}`);
  if (lines.length > DIAG_CAPACITY) lines.splice(0, lines.length - DIAG_CAPACITY);
}

/** The whole log, oldest first, one event per line. */
export function netLog(): string {
  return lines.join('\n');
}

/** Empty the log (a new match, or a test). */
export function diagClear(): void {
  lines.length = 0;
}

// ==========================================================================
// MESSAGE SUMMARY
// ==========================================================================

/** One short line for a wire message: its type plus only the fields that explain turn flow. Never throws. */
export function briefMsg(msg: unknown): string {
  if (typeof msg !== 'object' || msg === null) return '?';
  const m = msg as Record<string, unknown>;
  if (typeof m.t !== 'string') return '?';
  if (m.t === 'error') return `error ${String(m.code)}: ${String(m.message)}`;
  const parts: string[] = [m.t];
  const cmd = m.cmd as {t?: unknown} | null | undefined;
  if (cmd && typeof cmd.t === 'string') parts.push(cmd.t);
  const num = (label: string, v: unknown) => {
    if (typeof v === 'number') parts.push(`${label}=${v}`);
  };
  num('idx', m.playerIdx);
  num('from', m.from);
  num('seq', m.seq);
  num('gen', m.turnGen);
  const tanks = (m.result as {tanks?: unknown[]} | null | undefined)?.tanks;
  if (Array.isArray(tanks)) parts.push(`tanks=${tanks.length}`);
  num('hash', m.hash);
  if (m.over === true) parts.push('over');
  if (m.handoff === true) parts.push('handoff');
  return parts.join(' ');
}

// ==========================================================================
// STALL WATCHDOG
// ==========================================================================

export function newWatch(): WatchState {
  return {key: '', resolvingSince: 0, lastDump: 0, dumps: 0};
}

/** Call once per frame. Logs a line when the observed state changes, and a detailed dump when a shot has
 *  been resolving longer than STALL_AFTER_MS (then every STALL_REPEAT_MS, at most STALL_MAX_DUMPS). */
export function watchTick(w: WatchState, s: WatchSnap, now: number): void {
  const key = `${s.state}|${s.resolving}|${s.current}|${s.turnSeq}`;
  if (key !== w.key) {
    w.key = key;
    w.resolvingSince = s.resolving ? now : 0;
    w.dumps = 0;
    diag('state', `${s.state} resolving=${s.resolving} current=${s.current} turnSeq=${s.turnSeq}`);
    return;
  }
  if (!s.resolving || w.dumps >= STALL_MAX_DUMPS) return;
  if (now - w.resolvingSince < STALL_AFTER_MS) return;
  if (w.dumps > 0 && now - w.lastDump < STALL_REPEAT_MS) return;
  w.dumps++;
  w.lastDump = now;
  const text = `resolving for ${Math.round((now - w.resolvingSince) / 1000)}s ${s.detail()}`;
  diag('STALL', text);
  console.warn(`[netdiag] STALL ${text}`);
}

// ==========================================================================
// BROWSER HOOKS
// ==========================================================================

let lastFrameAt = 0;
let frameStallReported = false;

/** Call from the render loop every frame, so a dead loop can be told apart from a merely waiting one. */
export function diagFrame(): void {
  lastFrameAt = performance.now();
  if (frameStallReported) {
    frameStallReported = false;
    diag('frame', 'render loop running again');
  }
}

/**
 * Wire the log into the page: `netLog()` on window, uncaught errors and rejected promises into the ring
 * (an exception inside the render loop or a socket handler is otherwise invisible), and a once-a-second
 * check that the render loop is still ticking while a net match is on screen. `netActive` says whether
 * one is.
 */
export function installNetDiag(netActive: () => boolean): void {
  (window as unknown as {netLog: () => string}).netLog = netLog;
  window.addEventListener('error', e =>
    diag('ERROR', `${e.message} @ ${e.filename}:${e.lineno} ${e.error?.stack ?? ''}`),
  );
  window.addEventListener('unhandledrejection', e =>
    diag('ERROR', `unhandled rejection: ${String(e.reason?.stack ?? e.reason)}`),
  );
  setInterval(() => {
    if (!netActive() || document.hidden || frameStallReported || lastFrameAt === 0) return;
    const quiet = performance.now() - lastFrameAt;
    if (quiet < FRAME_STALL_MS) return;
    frameStallReported = true;
    const text = `no rendered frame for ${Math.round(quiet / 1000)}s while a net match is on screen`;
    diag('FRAME', text);
    console.warn(`[netdiag] ${text}`);
  }, 1000);
}
