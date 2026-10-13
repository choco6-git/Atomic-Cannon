/**
 * The Room Durable Object's side of the open-room list: it publishes a listing to the Lobby when its
 * lobby changes (join, settings, start, leave), removes it when the room can no longer be joined from
 * the list, re-publishes on an alarm heartbeat, and never lets the Lobby affect gameplay. Driven
 * through real `hello`/`settings`/`start` messages against a mock DurableObjectState and a fake LOBBY
 * namespace that records every call.
 */
import {describe, it, expect, vi} from 'vitest';
import {Room} from '../worker/Room';
import {PROTOCOL_VERSION} from '../src/net/protocol';
import {HEARTBEAT_MS} from '../src/net/roomList';

class FakeSocket {
  sent: string[] = [];
  att: unknown = {playerId: null};
  send(raw: string): void {
    this.sent.push(raw);
  }
  serializeAttachment(v: unknown): void {
    this.att = v;
  }
  deserializeAttachment(): unknown {
    return this.att;
  }
  close(): void {}
  msgs(): Record<string, unknown>[] {
    return this.sent.map(s => JSON.parse(s) as Record<string, unknown>);
  }
}

type WsParam = Parameters<Room['webSocketMessage']>[0];
type CloseParam = Parameters<Room['webSocketClose']>[0];

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function lobbyState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'ABCDEF',
    phase: 'lobby',
    nextId: 1,
    hostId: null,
    settings: {maxPlayers: 3, minPlayers: 2, battles: 1, wind: 1, mapSize: 1, tanksPerTeam: 1, alternateTurns: false},
    players: {},
    seed: 0,
    order: [],
    turnIdx: 0,
    turnDeadline: 0,
    viewW: 1280,
    viewH: 720,
    config: null,
    totalBattles: 1,
    currentBattle: 1,
    tanksPerTeam: 1,
    alternateTurns: false,
    snapshot: null,
    snapshotHash: 0,
    appVersion: null,
    contested: false,
    turnGen: 0,
    expectedColumns: 0,
    ...over,
  };
}

function setup(
  opts: {state?: Record<string, unknown>; env?: Record<string, unknown> | 'none'; lobbyFails?: boolean} = {},
) {
  const store = new Map<string, unknown>([['room', opts.state ?? lobbyState()]]);
  const sockets: FakeSocket[] = [];
  const calls: Call[] = [];
  const lobby = {down: !!opts.lobbyFails, hold: null as Promise<void> | null};
  let alarmAt: number | null = null;
  const ctx = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)), // a copy, like the real storage
      put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
      setAlarm: async (t: number) => void (alarmAt = t),
      deleteAlarm: async () => void (alarmAt = null),
    },
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  };
  const ns = {
    idFromName: () => 'global',
    get: () => ({
      fetch: async (req: Request) => {
        if (lobby.down) throw new Error('lobby down');
        const text = await req.text();
        calls.push({path: new URL(req.url).pathname, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}});
        const gate = lobby.hold;
        if (gate) {
          lobby.hold = null; // hold only the next call
          await gate;
        }
        return new Response(null, {status: 204});
      },
    }),
  };
  const env = opts.env === 'none' ? {} : (opts.env ?? {LOBBY: ns});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const room = new Room(ctx as any, env as any);
  const deliver = (ws: FakeSocket, obj: unknown) =>
    room.webSocketMessage(ws as unknown as WsParam, JSON.stringify(obj));
  const join = async (name: string): Promise<FakeSocket> => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await deliver(ws, {t: 'hello', v: PROTOCOL_VERSION, app: 'v1', name});
    return ws;
  };
  const leave = async (ws: FakeSocket) => {
    sockets.splice(sockets.indexOf(ws), 1);
    await room.webSocketClose(ws as unknown as CloseParam);
  };
  return {
    room,
    calls,
    join,
    leave,
    deliver,
    lobby,
    stored: () => store.get('room') as Record<string, unknown>,
    alarmAt: () => alarmAt,
    clearAlarm: () => void (alarmAt = null),
  };
}

const near = (t: number | null, ms: number) => t !== null && Math.abs(t - (Date.now() + ms)) < 2000;

describe('Room listing', () => {
  it('first player joining publishes an upsert and arms the heartbeat', async () => {
    const t = setup();
    await t.join('Ann');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toEqual({
      path: '/upsert',
      body: {code: 'ABCDEF', hostName: 'Ann', players: 1, maxPlayers: 3, mapSize: 1, appVersion: 'v1'},
    });
    expect(near(t.alarmAt(), HEARTBEAT_MS)).toBe(true);
  });

  it('an identical publish is skipped', async () => {
    const t = setup();
    const a = await t.join('Ann');
    await t.deliver(a, {t: 'settings', settings: {wind: 2}}); // changes nothing the listing shows
    expect(t.calls).toHaveLength(1);
  });

  it('host handoff keeps the listing', async () => {
    const t = setup();
    const a = await t.join('Ann');
    await t.join('Bob');
    await t.leave(a);
    const last = t.calls[t.calls.length - 1];
    expect(last.path).toBe('/upsert');
    expect(last.body).toMatchObject({hostName: 'Bob', players: 1});
  });

  it('full room reappears when someone leaves', async () => {
    const t = setup({
      state: lobbyState({
        settings: {
          maxPlayers: 2,
          minPlayers: 2,
          battles: 1,
          wind: 1,
          mapSize: 1,
          tanksPerTeam: 1,
          alternateTurns: false,
        },
      }),
    });
    await t.join('Ann');
    const b = await t.join('Bob');
    expect(t.calls[t.calls.length - 1].path).toBe('/remove');
    expect(t.calls[t.calls.length - 1].body).toEqual({code: 'ABCDEF'});
    await t.leave(b);
    const last = t.calls[t.calls.length - 1];
    expect(last.path).toBe('/upsert');
    expect(last.body).toMatchObject({players: 1, maxPlayers: 2});
  });

  it('lowering maxPlayers to the current count removes the listing', async () => {
    const t = setup();
    const a = await t.join('Ann');
    await t.join('Bob');
    await t.deliver(a, {t: 'settings', settings: {maxPlayers: 2}});
    expect(t.calls[t.calls.length - 1].path).toBe('/remove');
  });

  it('starting the match removes the listing and the turn alarm replaces the heartbeat', async () => {
    const t = setup();
    const a = await t.join('Ann');
    await t.join('Bob');
    await t.deliver(a, {t: 'start', viewW: 1280, viewH: 720, config: {}});
    expect(t.stored().phase).toBe('playing');
    expect(t.calls[t.calls.length - 1].path).toBe('/remove');
    expect(t.alarmAt()).toBe(t.stored().turnDeadline);
  });

  it('last player leaving removes the listing and clears the alarm', async () => {
    const t = setup();
    const a = await t.join('Ann');
    await t.leave(a);
    expect(t.calls[t.calls.length - 1].path).toBe('/remove');
    expect(t.alarmAt()).toBeNull();
  });

  it('lobby heartbeat republishes and re-arms without forfeiting a turn', async () => {
    const t = setup();
    await t.join('Ann');
    const before = t.calls.length;
    t.clearAlarm(); // the runtime clears a fired alarm
    await t.room.alarm();
    expect(t.calls).toHaveLength(before + 1);
    expect(t.calls[t.calls.length - 1].path).toBe('/upsert');
    expect(near(t.alarmAt(), HEARTBEAT_MS)).toBe(true);
    expect(t.stored().turnIdx).toBe(0);
    expect(t.stored().phase).toBe('lobby');
  });

  it("a playing room's alarm still forfeits the turn", async () => {
    const player = (id: number, name: string) => ({
      id,
      name,
      color: '#f00',
      ready: true,
      token: `t${id}`,
      connected: true,
      isHost: id === 1,
    });
    const t = setup({
      state: lobbyState({
        phase: 'playing',
        nextId: 3,
        hostId: 1,
        players: {1: player(1, 'A'), 2: player(2, 'B')},
        order: [1, 2],
        turnIdx: 0,
        turnDeadline: Date.now() - 1000,
        appVersion: 'v1',
        turnGen: 5,
      }),
    });
    await t.room.alarm();
    expect(t.stored().turnIdx).toBe(1);
    expect(t.calls).toHaveLength(0);
  });

  it('a start landing while a publish is in flight keeps the turn alarm', async () => {
    const t = setup({
      state: lobbyState({
        settings: {
          maxPlayers: 2,
          minPlayers: 2,
          battles: 1,
          wind: 1,
          mapSize: 1,
          tanksPerTeam: 1,
          alternateTurns: false,
        },
      }),
    });
    const a = await t.join('Ann');
    let release!: () => void;
    t.lobby.hold = new Promise<void>(r => (release = r));
    const before = t.calls.length;
    const bobJoin = t.join('Bob'); // fills the room; its remove is now stuck waiting on the Lobby
    await vi.waitFor(() => expect(t.calls.length).toBeGreaterThan(before));
    await t.deliver(a, {t: 'start', viewW: 1280, viewH: 720, config: {}});
    release();
    await bobJoin;
    expect(t.stored().phase).toBe('playing');
    expect(t.alarmAt()).toBe(t.stored().turnDeadline); // the AFK alarm survived the late publish
  });

  it('a failed remove is retried by the next heartbeat', async () => {
    const t = setup({
      state: lobbyState({
        settings: {
          maxPlayers: 2,
          minPlayers: 2,
          battles: 1,
          wind: 1,
          mapSize: 1,
          tanksPerTeam: 1,
          alternateTurns: false,
        },
      }),
    });
    await t.join('Ann');
    t.lobby.down = true;
    await t.join('Bob'); // room is full -> remove, which fails
    expect(t.alarmAt()).not.toBeNull(); // heartbeat stays armed so the remove is retried
    t.lobby.down = false;
    t.clearAlarm();
    await t.room.alarm();
    expect(t.calls[t.calls.length - 1].path).toBe('/remove');
  });

  it('a failed publish is not remembered as sent', async () => {
    const t = setup({
      state: lobbyState({
        settings: {
          maxPlayers: 2,
          minPlayers: 2,
          battles: 1,
          wind: 1,
          mapSize: 1,
          tanksPerTeam: 1,
          alternateTurns: false,
        },
      }),
    });
    await t.join('Ann'); // listed as 1/2
    t.lobby.down = true;
    const b = await t.join('Bob'); // remove fails
    t.lobby.down = false;
    const before = t.calls.length;
    await t.leave(b); // back to the SAME listing as before Bob joined
    expect(t.calls).toHaveLength(before + 1);
    expect(t.calls[t.calls.length - 1].path).toBe('/upsert');
  });

  it('works without a LOBBY binding', async () => {
    const t = setup({env: 'none'});
    const a = await t.join('Ann');
    expect(a.msgs().some(m => m.t === 'welcome')).toBe(true);
  });

  it('a failing Lobby never breaks the join', async () => {
    const t = setup({lobbyFails: true});
    const a = await t.join('Ann');
    expect(a.msgs().some(m => m.t === 'welcome')).toBe(true);
  });
});
