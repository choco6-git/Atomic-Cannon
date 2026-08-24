/**
 * A battle can end while a modal is UP: the last enemy dying passively (radiation DOT, a mine, the
 * turn timer) needs no input from the player, who may well be mid-purchase in the Weapons Depot.
 * The standings screen then takes the whole screen — and it's a transparent layer ABOVE every
 * battle overlay, so a depot left open underneath turned the standings into overlapping,
 * unreadable text over the depot card. Entering BattleEnd must lower every battle overlay first.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameType} from '../src/game/CGameController';
import type {CAudio} from '../src/audio/CAudio';
import {Roster} from '../src/core/CRoster';

const fakeAudio = (): CAudio => new Proxy({}, {get: () => () => undefined}) as unknown as CAudio;

function newGame(): CGameController {
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setAudio(fakeAudio());
  gc.setGameType(EGameType.Deathmatch);
  gc.setTotalBattles(5);
  gc.setHumanCount(1);
  gc.startGame(2);
  return gc;
}

describe('Battle end lowers the open modals', () => {
  beforeEach(async () => {
    const {warStandings, showDepot, showPause, showHelp, screen} = await import('../src/ui/store');
    warStandings.value = null;
    showDepot.value = false;
    showPause.value = false;
    showHelp.value = false;
    screen.value = 'battle';
  });

  it('closes the depot as the standings come up', async () => {
    const {setController, openDepot, showDepot, syncHud, warStandings} = await import('../src/ui/store');
    const gc = newGame();
    setController(gc);

    openDepot();
    expect(showDepot.value).toBe(true);

    gc.devForceBattleEnd(); // the last enemy dies while the player is shopping
    syncHud();

    expect(warStandings.value).not.toBeNull(); // standings screen took over…
    expect(showDepot.value).toBe(false); // …and the depot is no longer under it
  });

  it('closes Help and unfreezes the sim the overlay had frozen', async () => {
    const {setController, openHelp, closeHelp, showHelp, paused, syncHud} = await import('../src/ui/store');
    const gc = newGame();
    setController(gc);

    openHelp();
    expect(showHelp.value).toBe(true);
    expect(paused.value).toBe(true); // Help freezes the sim (the depot deliberately doesn't)

    gc.devForceBattleEnd();
    syncHud();

    expect(showHelp.value).toBe(false);
    expect(paused.value).toBe(false); // the freeze unwound exactly as a manual close would
    expect(() => closeHelp()).not.toThrow(); // idempotent: closing again is inert
  });

  it('ESC on the standings does not raise an invisible pause menu underneath them', async () => {
    const {setController, openPauseMenu, showPause, paused, syncHud, warStandings} = await import('../src/ui/store');
    const gc = newGame();
    setController(gc);

    gc.devForceBattleEnd();
    syncHud();
    expect(warStandings.value).not.toBeNull();

    openPauseMenu(); // ESC while the standings are up

    // The pause overlay sits BELOW the standings in the z ladder, so opening it would freeze the
    // sim behind a menu nobody can see or click. There is nothing left to pause.
    expect(showPause.value).toBe(false);
    expect(paused.value).toBe(false);
  });
});
