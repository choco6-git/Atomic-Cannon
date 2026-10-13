/**
 * Pure room-list logic — what a lobby listing may contain, when a room is listable, and how the
 * Lobby expires/sorts/caps the list. No Durable Object or DOM involved: the same helpers back
 * both the Worker and the client.
 */
import {describe, it, expect} from 'vitest';
import {newRoomCode} from '../src/net/roomCode';
import {
  LISTING_TTL_MS,
  LIST_LIMIT,
  sanitizeListing,
  openRooms,
  listingFor,
  isJoinable,
  parseRoomsResponse,
  type RoomListing,
  type ListingSource,
} from '../src/net/roomList';

const listing = (over: Partial<RoomListing> = {}): RoomListing => ({
  code: newRoomCode(),
  hostName: 'Ann',
  players: 1,
  maxPlayers: 2,
  mapSize: 1,
  appVersion: '3.1.6',
  created: 500,
  updated: 1000,
  ...over,
});

const {updated: _u, created: _c, ...bare} = listing();
void _u;
void _c;

type P = ListingSource['players'][number];
const player = (over: Partial<P> = {}): P => ({name: 'Ann', isHost: true, connected: true, ...over});
const source = (over: Partial<ListingSource> = {}): ListingSource => ({
  code: newRoomCode(),
  phase: 'lobby',
  settings: {maxPlayers: 2, mapSize: 1},
  appVersion: '3.1.6',
  players: {1: player()},
  ...over,
});

describe('sanitizeListing', () => {
  it('accepts a well-formed listing', () => {
    const l = listing();
    const {updated: _drop, created: _drop2, ...expected} = l;
    void _drop;
    void _drop2;
    expect(sanitizeListing(l)).toEqual(expected);
  });

  it('rejects a bad code, a non-object, and null', () => {
    expect(sanitizeListing({...bare, code: 'nope'})).toBeNull();
    expect(sanitizeListing('x')).toBeNull();
    expect(sanitizeListing(null)).toBeNull();
    expect(sanitizeListing(5)).toBeNull();
  });

  it('clamps and trims hostile fields', () => {
    const out = sanitizeListing({
      ...bare,
      hostName: 'A\u0000B\u001f' + 'x'.repeat(10_000),
      players: -5,
      maxPlayers: 99,
      mapSize: Number.NaN,
      appVersion: 'v'.repeat(100),
    })!;
    expect(out.hostName.length).toBeLessThanOrEqual(24);
    expect([...out.hostName].every(ch => ch.charCodeAt(0) > 0x1f)).toBe(true);
    expect(out.players).toBe(0);
    expect(out.maxPlayers).toBe(8);
    expect(out.mapSize).toBe(1);
    expect(out.appVersion.length).toBe(32);
    expect(sanitizeListing({...bare, maxPlayers: 0})!.maxPlayers).toBe(2);
    expect(sanitizeListing({...bare, mapSize: 99})!.mapSize).toBe(5);
  });
});

describe('openRooms', () => {
  it('drops entries older than the TTL', () => {
    const now = 10_000_000;
    const keep = listing({updated: now - LISTING_TTL_MS});
    const drop = listing({updated: now - LISTING_TTL_MS - 1});
    expect(openRooms([keep, drop], now)).toEqual([keep]);
  });

  it('sorts oldest-created first, ignoring heartbeats, and caps at LIST_LIMIT', () => {
    const now = 10_000_000;
    // `updated` rises with `created` here, so sorting by `updated` would put the NEWEST room first:
    // the list must follow `created`, which a heartbeat never changes.
    const all = Array.from({length: 60}, (_v, i) => listing({created: now - 5000 + i, updated: now - 100 + i}));
    const out = openRooms(all, now);
    expect(out).toHaveLength(LIST_LIMIT);
    expect(out[0].created).toBe(now - 5000);
    expect(out[LIST_LIMIT - 1].created).toBe(now - 5000 + LIST_LIMIT - 1);
  });
});

describe('listingFor', () => {
  it('lists a lobby with one connected player', () => {
    const s = source({code: 'ABCDEF'});
    expect(listingFor(s)).toEqual({
      code: 'ABCDEF',
      hostName: 'Ann',
      players: 1,
      maxPlayers: 2,
      mapSize: 1,
      appVersion: '3.1.6',
    });
  });

  it('returns null when the room is full', () => {
    const s = source({players: {1: player(), 2: player({name: 'Bob', isHost: false})}});
    expect(listingFor(s)).toBeNull();
  });

  it('returns null when playing, when ended, and when nobody is connected', () => {
    expect(listingFor(source({phase: 'playing'}))).toBeNull();
    expect(listingFor(source({phase: 'ended'}))).toBeNull();
    expect(listingFor(source({players: {1: player({connected: false})}}))).toBeNull();
    expect(listingFor(source({players: {}}))).toBeNull();
  });

  it('ignores spectators and disconnected players in the count', () => {
    const s = source({
      settings: {maxPlayers: 3, mapSize: 2},
      players: {
        1: player(),
        2: player({name: 'Bob', isHost: false}),
        3: player({name: 'Cy', isHost: false, spectator: true}),
        4: player({name: 'Di', isHost: false, connected: false}),
      },
    });
    expect(listingFor(s)!.players).toBe(2);
  });

  it("falls back to the first connected player's name when no host is flagged", () => {
    const s = source({players: {7: player({name: 'Zed', isHost: false})}});
    expect(listingFor(s)!.hostName).toBe('Zed');
  });
});

describe('isJoinable', () => {
  it('isJoinable accepts the same appVersion', () => {
    expect(isJoinable(listing({appVersion: '3.1.6'}), '3.1.6')).toBe(true);
  });

  it('isJoinable rejects a different appVersion', () => {
    expect(isJoinable(listing({appVersion: '3.1.5'}), '3.1.6')).toBe(false);
  });
});

describe('parseRoomsResponse', () => {
  it('keeps good entries and drops bad ones', () => {
    const good = listing({created: 99, updated: 1234});
    const out = parseRoomsResponse({rooms: [good, {code: 'x'}, 5, null]});
    expect(out).toEqual([good]);
  });

  it('tolerates a non-object body', () => {
    expect(parseRoomsResponse(null)).toEqual([]);
    expect(parseRoomsResponse('x')).toEqual([]);
    expect(parseRoomsResponse({})).toEqual([]);
    expect(parseRoomsResponse({rooms: 'x'})).toEqual([]);
  });
});
