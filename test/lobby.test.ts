/**
 * The Lobby Durable Object and the `GET /api/rooms` route in front of it. The DO is driven through
 * its `fetch` against a mock DurableObjectState (same approach as roomAlarm.test.ts); the route is
 * driven through the Worker's default export with a fake env that forwards to a real Lobby.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {Lobby} from '../worker/Lobby';
import worker from '../worker/index';
import {newRoomCode} from '../src/net/roomCode';
import {LISTING_TTL_MS, MAX_STORED} from '../src/net/roomList';

function makeLobby() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lobby = new Lobby(ctx as any);
  return {
    lobby,
    stored: () => store.get('rooms') as Record<string, unknown> | undefined,
    seed: (rooms: Record<string, unknown>) => void store.set('rooms', rooms),
  };
}

const bare = (over: Record<string, unknown> = {}) => ({
  code: newRoomCode(),
  hostName: 'Ann',
  players: 1,
  maxPlayers: 2,
  mapSize: 1,
  appVersion: '3.1.6',
  ...over,
});
const post = (lobby: Lobby, path: string, body: unknown) =>
  lobby.fetch(
    new Request(`https://do${path}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
const list = async (lobby: Lobby) => {
  const res = await lobby.fetch(new Request('https://do/list'));
  return {res, body: (await res.json()) as {rooms: Record<string, unknown>[]}};
};

afterEach(() => vi.useRealTimers());

describe('Lobby', () => {
  it('empty lobby lists nothing', async () => {
    const {lobby} = makeLobby();
    const {res, body} = await list(lobby);
    expect(res.status).toBe(200);
    expect(body).toEqual({rooms: []});
  });

  it('upsert then list returns the room with a server-stamped updated', async () => {
    const {lobby} = makeLobby();
    const l = bare();
    expect((await post(lobby, '/upsert', {...l, updated: 1})).status).toBe(204);
    const {body} = await list(lobby);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0]).toMatchObject(l);
    expect(Math.abs((body.rooms[0].updated as number) - Date.now())).toBeLessThan(1000);
  });

  it('upsert replaces an existing code', async () => {
    const {lobby} = makeLobby();
    const l = bare();
    await post(lobby, '/upsert', l);
    await post(lobby, '/upsert', {...l, players: 2, hostName: 'Bob'});
    const {body} = await list(lobby);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0]).toMatchObject({players: 2, hostName: 'Bob'});
  });

  it('remove deletes a room and an unknown code is a no-op', async () => {
    const {lobby} = makeLobby();
    const l = bare();
    await post(lobby, '/upsert', l);
    expect((await post(lobby, '/remove', {code: l.code})).status).toBe(204);
    expect((await list(lobby)).body.rooms).toEqual([]);
    expect((await post(lobby, '/remove', {code: newRoomCode()})).status).toBe(204);
  });

  it("a heartbeat keeps a room's list position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const {lobby} = makeLobby();
    const a = bare({hostName: 'First'});
    const b = bare({hostName: 'Second'});
    await post(lobby, '/upsert', a);
    vi.setSystemTime(1_002_000);
    await post(lobby, '/upsert', b);
    vi.setSystemTime(1_003_000);
    await post(lobby, '/upsert', b); // B's heartbeat: B is now the most recently UPDATED
    const names = (await list(lobby)).body.rooms.map(r => r.hostName);
    expect(names).toEqual(['First', 'Second']);
  });

  it('refuses a new room once MAX_STORED are listed but still refreshes an existing one', async () => {
    const {lobby, stored, seed} = makeLobby();
    const now = Date.now();
    const full: Record<string, unknown> = {};
    while (Object.keys(full).length < MAX_STORED) {
      const l = bare();
      full[l.code as string] = {...l, created: now, updated: now};
    }
    seed(full);
    expect((await post(lobby, '/upsert', bare())).status).toBe(503);
    expect(Object.keys(stored() ?? {})).toHaveLength(MAX_STORED);
    const existing = full[Object.keys(full)[0]] as Record<string, unknown>;
    expect((await post(lobby, '/upsert', {...existing, players: 2})).status).toBe(204);
  });

  it('rejects a malformed upsert', async () => {
    const {lobby, stored} = makeLobby();
    expect((await post(lobby, '/upsert', {code: 'nope'})).status).toBe(400);
    expect((await post(lobby, '/upsert', '"x"')).status).toBe(400);
    expect((await post(lobby, '/upsert', '{not json')).status).toBe(400);
    expect(stored() ?? {}).toEqual({});
  });

  it('expired listings are dropped from list and from storage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const {lobby, stored} = makeLobby();
    await post(lobby, '/upsert', bare());
    vi.setSystemTime(1_000_000 + LISTING_TTL_MS + 1000);
    expect((await list(lobby)).body.rooms).toEqual([]);
    expect(stored()).toEqual({});
  });
});

describe('GET /api/rooms', () => {
  const makeEnv = (allow: boolean) => {
    const {lobby} = makeLobby();
    const forwarded = vi.fn((req: Request) => lobby.fetch(req));
    const env = {
      LOBBY: {idFromName: () => 'global', get: () => ({fetch: forwarded})},
      LOBBY_LIMIT: {limit: async () => ({success: allow})},
    };
    return {env, forwarded, lobby};
  };

  it('GET /api/rooms returns the lobby body with a short cache header', async () => {
    const {env, lobby} = makeEnv(true);
    await post(lobby, '/upsert', bare());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await worker.fetch(new Request('https://x/api/rooms'), env as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=2');
    expect(((await res.json()) as {rooms: unknown[]}).rooms).toHaveLength(1);
  });

  it('GET /api/rooms is rate limited', async () => {
    const {env, forwarded} = makeEnv(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await worker.fetch(new Request('https://x/api/rooms'), env as any);
    expect(res.status).toBe(429);
    expect(forwarded).not.toHaveBeenCalled();
  });
});
