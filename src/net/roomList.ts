/**
 * The open-room list — the pure rules shared by the Worker (which stores and serves listings) and
 * the client (which parses and shows them). No I/O here: what a listing may contain, when a room is
 * listable at all, and how the Lobby expires, sorts and caps the list. The one non-obvious rule is
 * that `updated` is never trusted from a publisher — the Lobby stamps it — so a stale or hostile
 * room can't pin itself to the top of the list.
 */
import {isValidRoomCode, normalizeRoomCode} from './roomCode';

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

/** What a publisher supplies; the Lobby stamps `created` and `updated`. */
export type ListingFields = Omit<RoomListing, 'created' | 'updated'>;

/** One open room as the lobby list shows it. */
export interface RoomListing {
  code: string;
  /** The host's display name (control characters stripped, max 24 chars). */
  hostName: string;
  /** Connected, non-spectator players in the room right now. */
  players: number;
  maxPlayers: number;
  mapSize: number;
  /** The room's fixed app version — a client on another version can't play in it. */
  appVersion: string;
  /** Ms epoch of the room's FIRST publish, stamped by the Lobby and kept across heartbeats: the list
   *  sorts on it so rows never shuffle under the cursor. */
  created: number;
  /** Ms epoch of the latest publish, stamped by the Lobby. Used only to expire a silent room. */
  updated: number;
}

/** The slice of a Room's state that decides whether, and how, it is listed. */
export interface ListingSource {
  code: string;
  phase: 'lobby' | 'playing' | 'ended';
  settings: {maxPlayers: number; mapSize: number};
  appVersion: string | null;
  players: Record<number, {name: string; isHost: boolean; connected: boolean; spectator?: boolean}>;
}

// ==========================================================================
// TUNING
// ==========================================================================

/** A listing not refreshed within this window is treated as gone (the crashed-room safety net). */
export const LISTING_TTL_MS = 60_000;
/** The most rooms one list response carries. */
export const LIST_LIMIT = 50;
/** The most listings the Lobby will hold. A new room past this is refused (existing rooms still refresh),
 *  which bounds the single stored value and means a flood can't evict the rooms already listed. */
export const MAX_STORED = 200;
/** How often a listed Room re-publishes while it sits in the lobby (well inside the TTL). */
export const HEARTBEAT_MS = 20_000;

const NAME_MAX = 24;
const VERSION_MAX = 32;

// ==========================================================================
// VALIDATION
// ==========================================================================

/** Clamp to `[lo, hi]`; anything non-finite becomes `lo`. */
function clampNum(n: unknown, lo: number, hi: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** Drop C0 control characters and DEL (a char-code test, since a control-char regex trips the linter). */
function stripControl(s: string): string {
  return [...s].filter(ch => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f).join('');
}

/**
 * A listing's publisher-supplied fields, validated and clamped — or null when the payload is not a
 * listing at all. `created` and `updated` are deliberately absent: the Lobby stamps them.
 */
export function sanitizeListing(raw: unknown): ListingFields | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== 'string' || typeof r.hostName !== 'string' || typeof r.appVersion !== 'string') return null;
  const code = normalizeRoomCode(r.code);
  if (!isValidRoomCode(code)) return null;
  return {
    code,
    hostName: stripControl(r.hostName).slice(0, NAME_MAX),
    players: clampNum(r.players, 0, 8),
    maxPlayers: clampNum(r.maxPlayers, 2, 8),
    mapSize: clampNum(r.mapSize, 1, 5),
    appVersion: r.appVersion.slice(0, VERSION_MAX),
  };
}

/** The client's view of `GET /api/rooms`: good entries kept, anything malformed dropped. */
export function parseRoomsResponse(body: unknown): RoomListing[] {
  const rooms = (body as {rooms?: unknown} | null)?.rooms;
  if (!Array.isArray(rooms)) return [];
  const out: RoomListing[] = [];
  for (const raw of rooms) {
    const clean = sanitizeListing(raw);
    if (!clean) continue;
    const stamp = (k: 'created' | 'updated'): number => {
      const v = (raw as Record<string, unknown>)[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    out.push({...clean, created: stamp('created'), updated: stamp('updated')});
  }
  return out;
}

// ==========================================================================
// LIST RULES
// ==========================================================================

/** Unexpired listings, oldest-created first (a heartbeat never reorders rows), capped at LIST_LIMIT. With
 *  the cap this also means rooms that appear later can't push earlier ones off the list. */
export function openRooms(all: Iterable<RoomListing>, now: number): RoomListing[] {
  return [...all]
    .filter(l => now - l.updated <= LISTING_TTL_MS)
    .sort((a, b) => a.created - b.created || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .slice(0, LIST_LIMIT);
}

/**
 * What a Room publishes about itself, or null when it must not be listed: only a lobby that has at
 * least one connected player and a free slot is open to join from the list.
 */
export function listingFor(s: ListingSource): ListingFields | null {
  if (s.phase !== 'lobby') return null;
  const seated = Object.values(s.players).filter(p => p.connected && !p.spectator);
  if (seated.length < 1 || seated.length >= s.settings.maxPlayers) return null;
  const host = seated.find(p => p.isHost) ?? seated[0];
  return {
    code: s.code,
    hostName: host.name,
    players: seated.length,
    maxPlayers: s.settings.maxPlayers,
    mapSize: s.settings.mapSize,
    appVersion: s.appVersion ?? '',
  };
}

/** A room built by another app version is shown but can't be joined (the netcode would diverge). */
export function isJoinable(l: RoomListing, appVersion: string): boolean {
  return l.appVersion === appVersion;
}
