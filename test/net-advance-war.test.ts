/**
 * In a net match the SERVER drives the between-battles advance (`nextBattle` → netNextBattle with the
 * shared seed). A player clicking the standings must not advance locally as well: that bumped the
 * clicker's battle counter twice (click + server advance) and regenerated terrain from the wrong
 * seed, so the host ended the war a whole battle ahead of the guest, who waited forever.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import type {CAudio} from '../src/audio/CAudio';
import {Roster} from '../src/core/CRoster';

const fakeAudio = (): CAudio => new Proxy({}, {get: () => () => undefined}) as unknown as CAudio;
const battleOf = (gc: CGameController): number => (gc as unknown as {m_currentBattle: number}).m_currentBattle;

describe('advanceWar in a net match', () => {
  it('leaves the between-battles advance to the server', async () => {
    const {setController, syncHud, advanceWar, warStandings} = await import('../src/ui/store');
    Roster.players = [];
    const gc = new CGameController(makeCanvas());
    gc.setAudio(fakeAudio());
    gc.startNetworkGame({
      seed: 12345,
      players: 2,
      localIndex: 0,
      roster: [
        {name: 'Ada', color: '#f00'},
        {name: 'Bo', color: '#0f0'},
      ],
      wind: 1,
      mapSize: 2,
      battles: 3,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: {...gc.getMatchConfig(), gameType: 1},
    });
    setController(gc);

    gc.netFinishBattle(); // battle 1 of 3 ends, the war continues
    syncHud();
    expect(warStandings.value?.warOver).toBe(false);

    advanceWar(); // the player clicks the standings before the server's advance arrives
    expect(battleOf(gc)).toBe(1); // no local advance
    expect(warStandings.value).not.toBeNull(); // still waiting on the server

    gc.netNextBattle(777); // the server's nextBattle, once the intermission is over
    expect(battleOf(gc)).toBe(2); // exactly one step
  });
});
