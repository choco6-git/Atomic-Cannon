# Network lobby: open room list

Date: 2026-10-13 · Status: draft for review · Path: architectural

## Goal

Today a network match is joined only by typing the host's room code. A second player
cannot discover a room that was just created. The goal is a list of open rooms on the
network entry screen: the host creates a room, it shows up for everyone browsing, and a
click joins it. Typing a code stays supported.

## Decisions already made

| Question | Decision |
|---|---|
| Which rooms are listed? | Only rooms that are still in the lobby (not started) and have a free slot. Started or full rooms drop off automatically. |
| How does the server remember rooms? | One global `Lobby` Durable Object (same singleton pattern as `Stats`), polled by clients. |
| Private rooms, spectating a running match from the list, live push, paging | Out of scope. |
| Code entry | Kept as is. |

## Facts about the current code that the design relies on

- A room's Durable Object is created lazily by the first WebSocket `hello`, not by
  `GET /api/new` (which only mints a code). The first joiner becomes host
  (`worker/Room.ts`, `onHello`) and fixes the room's `appVersion`.
- Lobby-phase changes happen in `onHello` (join), `onSettings`, `onStart`, and
  `dropPlayer` (leave; in the lobby the slot is removed). Disconnects reach
  `webSocketClose`.
- `Room.alarm()` currently only forfeits turns and returns immediately when
  `phase !== 'playing'`, so the alarm is unused during the lobby phase.
- `RoomSettings.maxPlayers` is clamped to 2..8 and `mapSize` to 1..5 by the server.
- The entry screen is `Entry()` in `src/ui/Network.tsx`; `joinRoom(code)` already
  connects to a code.
- Game text uses `BmpText` (ASCII 33..126 only, no wrapping), per `AGENTS.md`.

## Design

### 1. Server: `Lobby` Durable Object

New file `worker/Lobby.ts`. One instance, named `global`. Stores a map
`code -> RoomListing`.

```ts
interface RoomListing {
  code: string;        // room code
  hostName: string;    // host's display name (max 24 chars, already public inside the room)
  players: number;     // connected, non-spectator players
  maxPlayers: number;
  mapSize: number;
  appVersion: string;  // the room's fixed version
  created: number;     // ms epoch of the room's first publish, set by the Lobby and kept across heartbeats
  updated: number;     // ms epoch of the latest publish, set by the Lobby (expiry only; never trusted from the client)
}
```

Internal operations (called from the Worker and from `Room`, never from browsers):

- `upsert(listing)`: sanitise (clamp numbers, trim strings, validate the code) and store
  with `updated = Date.now()`.
- `remove(code)`.
- `list()`: drop entries older than `LISTING_TTL_MS` (60 s) by `updated`, sort oldest-`created`
  first (a heartbeat must never reorder rows under the cursor), return at most 50.
- The Lobby holds at most `MAX_STORED` (200) rooms: a new room past that is refused with 503 while
  existing rooms still refresh, so one stored value stays small and a flood of new rooms can't evict
  rooms already listed.

The sanitising and the expire/sort/limit logic are pure functions in
`src/net/roomList.ts` so they can be unit-tested without a Durable Object runtime.
Nothing sensitive is stored: no tokens, no IPs.

`wrangler.jsonc`: add a `LOBBY` Durable Object binding, migration
`{"tag": "v4", "new_sqlite_classes": ["Lobby"]}`, and a `LOBBY_LIMIT` rate limit
(new `namespace_id`). `worker/index.ts` exports `Lobby` and adds it to `Env`.

### 2. `Room` publishes its listing

`Room` computes whether it is listable and what its listing is, via a pure function in
`src/net/roomList.ts`:

- Listable iff `phase === 'lobby'`, at least one connected non-spectator player, and
  connected players < `settings.maxPlayers`.
- Not listable (or empty) means the Room calls `Lobby.remove(code)`.

It publishes after: a join in `onHello`, `onSettings`, `onStart` (phase leaves the
lobby, so remove), and `dropPlayer`. It remembers the last published JSON in memory and
skips identical publishes.

Staleness safety net: while in the lobby the Room arms its DO alarm for
`HEARTBEAT_MS` (20 s) and re-publishes on each alarm. `alarm()` gets a lobby branch;
`armTurn` keeps replacing the alarm once the match starts, so the two uses do not
overlap. A Room that dies without cleaning up disappears from the list within the 60 s
TTL.

A failing or slow `Lobby` call must never affect gameplay: the publish is awaited
inside a try/catch that swallows the error.

### 3. HTTP API

`GET /api/rooms` in `worker/index.ts`:

- rate limited per IP with `LOBBY_LIMIT` (polling at 4 s is about 15 requests/minute per tab;
  the limit is 240/minute so a household or office behind one address can run many tabs),
- calls `Lobby.list()`, responds `{rooms: RoomListing[]}`,
- `cache-control: public, max-age=2`, which lets a browser reuse a response briefly. It is
  not an edge cache: a Worker-built response is not cached at the edge, so every client's poll
  reaches the Lobby.

### 4. Client

- `src/net/roomClient.ts`: `listRooms(origin)` fetches `/api/rooms` and validates the
  shape defensively (bad entries are dropped, not thrown).
- `src/ui/networkStore.ts`: `roomList` signal plus `startRoomPolling()` /
  `stopRoomPolling()`. Polls every 4 s, only while the entry screen is shown and the
  document is visible; stops on leaving the screen. Keeps a distinct "offline" state
  for fetch failures.
- `src/ui/Network.tsx` (`Entry`): a new "Open rooms" section between the Create button
  and the code field. Each row shows the host name, `players/max`, and map size.
  Clicking a row calls the existing `joinRoom(code)`. Rows whose `appVersion` differs
  from the running build are dimmed and not clickable, with a short label. Empty state:
  a line telling the player to create a room. Offline state: a line saying the list is
  unavailable (the code field still works).
- All text via `BmpText`, one component per line, ASCII only. New strings in
  `src/i18n/en.ts` and `src/i18n/es.ts` (and `types.ts` if the string tree is typed
  there).

### 5. Error handling

| Situation | Behaviour |
|---|---|
| `/api/rooms` unreachable or non-2xx | List area shows the offline line; polling continues. |
| Rate limited (429) | Treated as offline for that tick. |
| Click on a room that filled or started meanwhile | Existing `room_full` / lobby errors from the Room are shown by the existing error card. |
| `Lobby` call fails inside `Room` | Ignored; gameplay unaffected. |
| Stale entry from a crashed room | Gone after the 60 s TTL. |

### 6. Testing

- Unit tests (`test/roomList.test.ts`): listing sanitisation, `isListable`, expire,
  sort and the 50-entry cap.
- Room integration in the style of `test/roomAlarm.test.ts`: publishes on join and
  settings change, removes when full, started or empty, dedupes identical publishes,
  the lobby heartbeat does not forfeit a turn, a failed publish is retried and is not remembered
  as sent, and a Start that lands while a publish is in flight keeps the turn alarm. The mock
  storage must hand back a COPY on every read, as the real one does, or that race is hidden.
- Client: `listRooms` shape validation, and polling start/stop with fake timers in
  `networkStore`.
- Manual end-to-end: `pnpm build`, `pnpm dev:net`, `pnpm dev`, two browsers; create in
  one, see and click in the other; verify removal on start and on host leaving.
- `pnpm check` must be clean (note: `test/prng.test.ts` is timing-sensitive under high
  machine load and is unrelated).

## Risks and open points

- Host names become visible to anyone who opens the entry screen, not only to people
  holding a code. The 24-character limit already applies. A future private-room option
  is the mitigation.
- A single `Lobby` DO is a throughput ceiling and every poll reaches it (there is no edge
  cache). Fine for this game's scale; revisit with the Cache API or a per-isolate micro-cache
  if polling volume grows.
- `/room/<code>` WebSocket upgrades are not rate limited, so a determined client can open many
  rooms and fill the 200-room store with junk. Because the list is oldest-first and capped, junk
  cannot displace rooms listed earlier, but it can fill the store and crowd out new real rooms. A
  per-IP limit on first-player hellos is the follow-up; it changes reconnect behaviour, so it is a
  separate decision.
- The alarm lobby branch touches the same `alarm()` as the AFK turn forfeit; the tests
  above must pin that a lobby heartbeat never forfeits a turn and that starting a match
  replaces the heartbeat with the turn alarm. The heartbeat is set BEFORE the Lobby request,
  because the request lets other messages (a Start) run and a later alarm write would act on a
  stale phase.
- Not yet verified: that `wrangler dev` accepts the new Durable Object migration and
  rate-limit binding locally. This is checked in the first implementation step.
