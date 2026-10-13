# Network match: reconnect grace period

Date: 2026-10-13 · Status: draft for review · Path: architectural

## Problem

In a 2-player network match, when either player's socket drops, the server ends the match at once
(`Room.dropPlayer`: connected players < 2 → `phase = 'ended'`, broadcast `gameOver`). A player who
reconnects a moment later, with a valid token, is handed `gameOver` too. Any short blip (Wi-Fi flap,
page reload, dev server restart) therefore ends the match for both players.

This was reproduced with a unit-level probe: after `start`, closing one socket gave
`phase = 'ended'`, the other player received `roster, gameOver`, and an immediate token reconnect
received `welcome, roster, startGame, gameOver`.

The client already expects a waiting state: `NetStatusBanner` shows "`{name}` lost connection - waiting
to reconnect..." with an "End match" button, and `RoomClient` rejoins with its reconnect token. Only
the server's 2-player rule contradicts it.

## Scope and non-goals

This spec makes a short drop survivable. It does **not** fix the separate "I fired but the opponent's
screen never shows the shot and both sides wait" stall, whose cause is still unknown (both sockets are
connected in that case, so the server sees no drop). It also does not add keepalive/ping to detect
silent half-open connections; that is a separate follow-up.

## Decisions already made

| Question | Decision |
|---|---|
| While a player is gone in a 2-player match, what happens to the match? | It **pauses** and waits; it does not continue with the remaining player. |
| Timeout outcome | The match ends exactly as today (`gameOver` -> standings). |
| 3+ player matches | Unchanged while two or more players stay connected: dropped players' turns are skipped. |
| Values (proposed, constants) | 60 s grace per drop; 180 s total paused time per match. |

## Facts about the current code that the design relies on

- A room has one Durable Object alarm. It is used for the lobby heartbeat (lobby phase) and for the AFK
  turn deadline (`TURN_DEADLINE_MS` = 120 s, `armTurn`/`disarmTurn`/`alarm()`) during play.
- `Room.alarm()` forfeits the turn when the deadline passed; `armTurn` bumps `turnGen`.
- `resumeMatch` already replays a (re)joining socket: `startGame`, latest `stateUpdate` snapshot,
  `gameOver` or a `turnBegin` with the REMAINING budget. 3+ player matches already use it.
- `onShotResult` validates and broadcasts `stateUpdate`, then either ends/advances the battle or
  advances `turnIdx` and broadcasts `turnBegin`. A `turnGen` mismatch is dropped silently.
- `playablePos` skips turns of disconnected owners.
- The client queues server events and drains them when its own simulation settles
  (`NetGame.dispatch` / `onTurnSettled`).
- The client's shot clock is local (`m_turnElapsed`, `GameConfig.roundTime`, `updateTurnTimer`); the
  server's `turnBegin.deadline` is not read by the client.
- Pausing the local sim with `setPaused(true)` also makes `fire()` ignore input.

## Design

### 1. Entering the paused state (server)

In `dropPlayer`, during `phase === 'playing'`, when the number of connected **non-spectator** players
falls below 2, the room does not end. It enters `paused`:

- `pausedAt = now` and `pausedUntil = now + min(GRACE_MS, PAUSE_TOTAL_MS - pausedTotalMs)` (ms epoch). If
  no budget is left, end the match as today.
- The remaining AFK budget of the current turn is saved in `pausedTurnMs` and the turn alarm is
  replaced by an alarm at `pausedUntil` (`disarmTurn` semantics for the turn, then `setAlarm`).
- Broadcast `matchPaused {deadlineMs}` and the usual `roster`.

Spectators dropping never pause the room.

### 2. While paused (server)

- `cmd` is rejected with error code `match_paused` and not relayed.
- `shotResult` for the live `turnGen` is accepted: validate, store the snapshot, broadcast
  `stateUpdate`. The hand-off part (next `turnIdx` + `turnBegin`, or battle/war end) is **deferred**: the
  server records `deferredAdvance = {over: boolean}` and does nothing more. This lets a shot that was
  already in flight when the drop happened finish without being lost.
- No turn alarm exists, so no AFK forfeit can happen.

### 3. Resuming

When a reconnect (token path of `onHello`) brings the connected non-spectator count back to 2 or more:

1. Add `now - pausedAt` to `pausedTotalMs`; clear `pausedAt` and `pausedUntil`.
2. If `deferredAdvance` is set, run the advance now (the existing hand-off code, factored out of
   `onShotResult`), which arms the next turn normally. Otherwise re-arm the turn alarm with
   `pausedTurnMs` **without** bumping `turnGen`.
3. Broadcast `matchResumed` to the players who were already connected.
4. Replay the match to the rejoining socket with the existing `resumeMatch`, **after** steps 1-3 so it
   boots into the final state and turn (an event broadcast before it boots would be dropped by the
   client).

If the connected count is still below 2 (for example both players dropped and only one returned), the
room stays paused and the alarm at `pausedUntil` is left in place.

### 3b. Timeout

`alarm()` gets a branch before the turn-forfeit logic: if `pausedUntil` is set and has passed, end the
match (`phase = 'ended'`, `disarmTurn`, broadcast `gameOver`), identical to today's end. The lobby
heartbeat branch stays first, then paused, then playing.

### 4. Protocol and stored state

- `ServerMessage`: add `{t: 'matchPaused'; deadlineMs: number}` and `{t: 'matchResumed'}`.
- `ErrorCode`: add `'match_paused'`.
- `RoomState` gains `pausedAt: number` and `pausedUntil: number` (0 = not paused), `pausedTurnMs: number`,
  `pausedTotalMs: number`, `deferredAdvance: {over: boolean} | null`. A room stored before this change
  lacks them; `load()` must default them (0, 0, 0, 0, null).
- `PROTOCOL_VERSION` stays 1: a room is single-version (`appVersion`), so a mismatched client cannot
  join in the first place.

### 5. Client

- `roomClient`/`NetGame` handle `matchPaused` and `matchResumed`, exposed as a `netPause` signal in
  `networkStore` (`{deadlineAt: number} | null`).
- `NetStatusBanner` shows the existing "lost connection - waiting to reconnect" line with a countdown
  (new string with `{name}` and `{s}`), and keeps the "End match" button.
- The controller gets `setNetPaused(on)`:
  - `canAct()` is false while on, so no new aim, fire or HUD action starts; a shot already underway
    runs to completion.
  - The local shot clock (`updateTurnTimer`) does not tick while on and continues from where it was on
    resume (the server's AFK deadline is not what the client's clock follows).
  - It is cleared on `matchResumed`, `gameOver`, and on leaving the match.
- The server's `match_paused` error is ignored by the client; the client gate above is what normally
  prevents the request.
- All new on-screen text is `BmpText`, ASCII only, one line per component; add en and es strings.

### 6. Error handling

| Situation | Behaviour |
|---|---|
| Player drops mid-shot (they were the actor) | Their `shotResult` never arrives. On resume, `resumeMatch` boots them to the last snapshot and the current turn with the remaining budget; they re-aim. Same as 3+ player rejoin today. |
| Remaining player's shot was in flight when the other dropped | Finishes, snapshot is broadcast, hand-off deferred until resume. |
| Both players drop | Paused until one or both return or the grace expires. |
| Grace expires | Match ends with the standings, as today. |
| Total paused time exhausted | The next drop ends the match immediately (guards against repeated deliberate drops). |
| A rejoiner arrives after the match ended | Receives `gameOver` as today. |

### 7. Testing

- `Room` tests in the style of `test/roomListing.test.ts`, mock storage returning **copies** on read:
  2-player drop pauses instead of ending; reconnect within grace resumes the same turn with the saved
  budget and the same `turnGen`; expiry ends the match; a `shotResult` during pause is accepted, the
  snapshot broadcast, the advance deferred and then executed on resume; `cmd` during pause is rejected
  and not relayed; a 3-player match keeps today's behaviour while two remain; a spectator drop never
  pauses; both-dropped then one returns stays paused; total-budget exhaustion ends the match; a state
  stored without the new fields loads with defaults; the alarm branch order (lobby, paused, playing).
- Client tests: `matchPaused`/`matchResumed` handling, `canAct()` and the shot clock while paused, the
  banner text with a countdown.
- End to end (as done for the room list): two browsers against `wrangler dev`, take one offline
  briefly with `context.setOffline`, verify the match continues from the same turn; keep it offline
  past the grace and verify the standings.

## Risks and open points

- A player can still stall the other for up to 60 s per drop and 180 s per match; the caps are
  constants to tune.
- The deferred advance changes when `turnBegin` is sent relative to `stateUpdate` during a pause only;
  the tests above must pin that ordinary (unpaused) play is byte-for-byte the same message sequence.
- Not yet verified: that the client's event queue behaves when `matchResumed` arrives while its own
  simulation is busy. `matchPaused`/`matchResumed` are state signals, not queued turn events, and are
  handled immediately; this must be confirmed in the first client step.
- This does not address silent half-open connections (no ping/pong) nor the unexplained "opponent
  never sees my shot" stall; both stay open.
