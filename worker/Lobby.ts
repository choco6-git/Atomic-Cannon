/**
 * Lobby — ONE global Durable Object (named "global") that remembers which rooms are open to join, so
 * the network screen can list them instead of making a second player type a code. Rooms publish a
 * small listing here whenever their lobby changes (and on a heartbeat); the front-door worker reads
 * the list for `GET /api/rooms`. A single DO gives atomic read-modify-write, like Stats.
 *
 * The non-obvious rules: `created` and `updated` are stamped HERE, never taken from the publisher;
 * `created` is kept across refreshes (it orders the list) while every listing expires LISTING_TTL_MS
 * after its last `updated`, so a room that crashed without cleaning up disappears on its own; and at
 * most MAX_STORED rooms are held, so one stored value stays small and a flood can't evict real rooms.
 */
import {type RoomListing, LISTING_TTL_MS, MAX_STORED, openRooms, sanitizeListing} from '../src/net/roomList';
import {json} from './http';

const KEY = 'rooms';

type Rooms = Record<string, RoomListing>;

const noContent = (): Response => new Response(null, {status: 204});

/** Parse a JSON request body, or null when it isn't JSON. */
async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export class Lobby {
  constructor(private readonly ctx: DurableObjectState) {}

  /** The stored map without anything past its TTL, plus whether anything was dropped. */
  private async load(now: number): Promise<{rooms: Rooms; pruned: boolean}> {
    const stored = (await this.ctx.storage.get<Rooms>(KEY)) ?? {};
    const rooms: Rooms = {};
    let pruned = false;
    for (const [code, l] of Object.entries(stored)) {
      if (now - l.updated <= LISTING_TTL_MS) rooms[code] = l;
      else pruned = true;
    }
    return {rooms, pruned};
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;

    if (path === '/list' && req.method === 'GET') {
      let listed: RoomListing[] = [];
      await this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const {rooms, pruned} = await this.load(now);
        if (pruned) await this.ctx.storage.put(KEY, rooms); // reclaim expired entries
        listed = openRooms(Object.values(rooms), now);
      });
      return json({rooms: listed});
    }

    if (req.method !== 'POST') return json({error: 'method not allowed'}, 405);

    if (path === '/upsert') {
      const clean = sanitizeListing(await readJson(req));
      if (!clean) return json({error: 'bad listing'}, 400);
      let full = false;
      await this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const {rooms} = await this.load(now);
        const prev = rooms[clean.code];
        if (!prev && Object.keys(rooms).length >= MAX_STORED) {
          full = true;
          return;
        }
        rooms[clean.code] = {...clean, created: prev?.created ?? now, updated: now};
        await this.ctx.storage.put(KEY, rooms);
      });
      return full ? json({error: 'lobby full'}, 503) : noContent();
    }

    if (path === '/remove') {
      const body = (await readJson(req)) as {code?: unknown} | null;
      if (typeof body?.code !== 'string') return json({error: 'bad body'}, 400);
      const code = body.code;
      await this.ctx.blockConcurrencyWhile(async () => {
        const {rooms} = await this.load(Date.now());
        if (!(code in rooms)) return;
        delete rooms[code];
        await this.ctx.storage.put(KEY, rooms);
      });
      return noContent();
    }

    return json({error: 'not found'}, 404);
  }
}
