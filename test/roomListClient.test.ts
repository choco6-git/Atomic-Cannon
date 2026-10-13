/**
 * The client's side of the open-room list: fetching + validating `GET /api/rooms`, and the polling
 * store the entry screen drives (start on show, stop on leave, skip while the tab is hidden, keep the
 * last list when the server is unreachable).
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {fetchRoomList} from '../src/net/roomClient';
import {roomList, startRoomPolling, stopRoomPolling} from '../src/ui/networkStore';
import {newRoomCode} from '../src/net/roomCode';

const entry = (over: Record<string, unknown> = {}) => ({
  code: newRoomCode(),
  hostName: 'Ann',
  players: 1,
  maxPlayers: 2,
  mapSize: 1,
  appVersion: '3.1.6',
  created: 99,
  updated: 1234,
  ...over,
});
const ok = (rooms: unknown[]) => new Response(JSON.stringify({rooms}), {status: 200});

const setHidden = (hidden: boolean | undefined) => {
  if (hidden === undefined) Reflect.deleteProperty(document, 'hidden');
  else Object.defineProperty(document, 'hidden', {value: hidden, configurable: true});
};

beforeEach(() => {
  vi.useFakeTimers();
  roomList.value = {rooms: [], status: 'loading'};
});

afterEach(() => {
  stopRoomPolling();
  setHidden(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchRoomList', () => {
  it('parses the response and drops bad entries', async () => {
    const good = entry();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok([good, {code: 'x'}, 5, null])),
    );
    expect(await fetchRoomList('https://x')).toEqual([good]);
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', {status: 429})),
    );
    await expect(fetchRoomList('https://x')).rejects.toThrow();
  });
});

describe('room polling', () => {
  it('fetches immediately and then every 4 s', async () => {
    const f = vi.fn(async () => ok([entry()]));
    vi.stubGlobal('fetch', f);
    startRoomPolling();
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f).toHaveBeenCalledTimes(3);
    expect(roomList.value.status).toBe('ok');
    expect(roomList.value.rooms).toHaveLength(1);
  });

  it('startRoomPolling is idempotent', async () => {
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal('fetch', f);
    startRoomPolling();
    startRoomPolling();
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('stopRoomPolling stops further requests', async () => {
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal('fetch', f);
    startRoomPolling();
    stopRoomPolling();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch marks the list offline but keeps the old rooms', async () => {
    let fail = false;
    const f = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return ok([entry()]);
    });
    vi.stubGlobal('fetch', f);
    startRoomPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(roomList.value.status).toBe('ok');
    fail = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(roomList.value.status).toBe('offline');
    expect(roomList.value.rooms).toHaveLength(1);
  });

  it('skips ticks while the document is hidden', async () => {
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal('fetch', f);
    setHidden(true);
    startRoomPolling();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f).not.toHaveBeenCalled();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
