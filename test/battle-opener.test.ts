/**
 * The opening shot rotates between sides battle to battle (A opens battle 1, B battle 2, ...), on
 * BOTH the solo controller and the net server, and a "round" (round credit, after-round Buy Time,
 * per-round wind) is measured from that battle's opener rather than from turn position 0.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController, EGameType} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import {Roster} from '../src/core/CRoster';
import {Room} from '../worker/Room';

function newWar(players: number, perTeam = 1): CGameController {
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setGameType(EGameType.Deathmatch);
  gc.setTotalBattles(6);
  gc.setTanksPerTeam(perTeam);
  gc.startGame(players);
  return gc;
}

/** The TEAM (squad) whose tank holds the turn. */
const openingTeam = (gc: CGameController, perTeam = 1): number => Math.floor(priv(gc).m_currentPlayerIndex / perTeam);

describe('battle opener rotation (solo)', () => {
  it('alternates the first turn between two sides each battle', () => {
    const gc = newWar(2);
    const openers = [openingTeam(gc)];
    for (let b = 2; b <= 4; b++) {
      gc.nextBattle();
      openers.push(openingTeam(gc));
    }
    expect(openers).toEqual([0, 1, 0, 1]);
  });

  it('cycles through every side with three players', () => {
    const gc = newWar(3);
    const openers = [openingTeam(gc)];
    for (let b = 2; b <= 4; b++) {
      gc.nextBattle();
      openers.push(openingTeam(gc));
    }
    expect(openers).toEqual([0, 1, 2, 0]);
  });

  it('hands the opener to the next SQUAD, not the next tank of the same squad', () => {
    const saved = GameConfig.alternateTurns;
    try {
      for (const alternate of [false, true]) {
        GameConfig.alternateTurns = alternate;
        const gc = newWar(2, 2); // [A1, A2, B1, B2]
        expect(priv(gc).m_currentPlayerIndex).toBe(0); // A1
        gc.nextBattle();
        expect(priv(gc).m_currentPlayerIndex).toBe(2); // B1
      }
    } finally {
      GameConfig.alternateTurns = saved;
    }
  });

  it('completes a round only when the turn comes back to the battle opener', () => {
    const gc = newWar(2);
    gc.nextBattle(); // battle 2: B opens
    expect(priv(gc).m_currentPlayerIndex).toBe(1);
    expect(priv(gc).advanceToNextPlayer()).toBe(false); // B -> A: the round is still going
    expect(priv(gc).m_currentPlayerIndex).toBe(0);
    expect(priv(gc).advanceToNextPlayer()).toBe(true); // A -> B: both have shot, round complete
  });
});

// ---- SERVER (net matches) ------------------------------------------------
// The Room's helpers are private statics; reach them through a loose cast.
type RoomStatics = {
  battleStartPos(s: object): number;
  roundWrapped(s: object, prev: number, next: number): boolean;
};
const R = Room as unknown as RoomStatics;
const state = (currentBattle: number, players = 2, tanksPerTeam = 1, alternateTurns = false) => ({
  order: Array.from({length: players}, (_, i) => i + 1),
  currentBattle,
  tanksPerTeam,
  alternateTurns,
});

describe('battle opener rotation (server)', () => {
  it('matches the client: the opener rotates by side, battle 1 at position 0', () => {
    expect([1, 2, 3, 4].map(b => R.battleStartPos(state(b)))).toEqual([0, 1, 0, 1]);
    expect([1, 2, 3, 4].map(b => R.battleStartPos(state(b, 3)))).toEqual([0, 1, 2, 0]);
    expect(R.battleStartPos(state(2, 2, 2, false))).toBe(2); // contiguous [A1,A2,B1,B2] → B1
    expect(R.battleStartPos(state(2, 2, 2, true))).toBe(1); // interleaved [A1,B1,A2,B2] → B1
  });

  it('flags a round complete only on returning to the opener', () => {
    const s = state(2); // B (position 1) opened
    expect(R.roundWrapped(s, 1, 0)).toBe(false);
    expect(R.roundWrapped(s, 0, 1)).toBe(true);
    const s1 = state(1); // battle 1: unchanged behaviour
    expect(R.roundWrapped(s1, 0, 1)).toBe(false);
    expect(R.roundWrapped(s1, 1, 0)).toBe(true);
  });
});
