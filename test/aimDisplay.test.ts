/**
 * The aim readout is mirrored for right-half tanks so 0 always means "horizon toward the middle of
 * the map". Only the DISPLAY changes: the stored aim stays world-absolute (physics, bots and the net
 * `aim` relay all use it), so the conversion must be exact and its own inverse.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';
import {toDisplayAngle} from '../src/core/aimDisplay';
import {CGameController} from '../src/game/CGameController';
import type {CTank} from '../src/core/CTank';

describe('toDisplayAngle', () => {
  it('leaves a left-half tank untouched (0 = right horizon, 90 = up)', () => {
    for (const a of [0, 45, 90, 135, 180, 270, 359]) expect(toDisplayAngle(a, false)).toBe(a);
  });

  it('mirrors a right-half tank: 0 = left horizon, climbing as the barrel rises', () => {
    expect(toDisplayAngle(180, true)).toBe(0); // level toward the middle
    expect(toDisplayAngle(135, true)).toBe(45); // up-left 45 reads as 45
    expect(toDisplayAngle(90, true)).toBe(90); // straight up is 90 from either side
    expect(toDisplayAngle(0, true)).toBe(180); // level the OTHER way
    expect(toDisplayAngle(225, true)).toBe(315); // down-left: below the horizon, like 315 on the left
  });

  it('is its own inverse, so one function converts both ways', () => {
    for (let a = 0; a < 360; a++) expect(toDisplayAngle(toDisplayAngle(a, true), true)).toBe(a);
  });

  it('stays inside 0..359', () => {
    for (let a = -400; a < 800; a += 7) {
      const d = toDisplayAngle(a, true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(360);
    }
  });
});

describe('CGameController.isAimMirrored', () => {
  it('is true exactly for the tank standing on the right half of the map', () => {
    const gc = new CGameController(makeCanvas());
    gc.startNetworkGame({
      seed: 4242,
      players: 2,
      localIndex: 0,
      roster: [
        {name: 'Ada', color: '#f00'},
        {name: 'Bo', color: '#0f0'},
      ],
      wind: 1,
      mapSize: 2,
      battles: 1,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: gc.getMatchConfig(),
    });
    const width = priv(gc).m_land.width;
    const seen = new Set<boolean>();
    for (const i of [0, 1]) {
      gc.netSetActivePlayer(i);
      const tank = (priv(gc).m_tanks as CTank[])[i];
      const expected = tank.getPosition().x >= width / 2;
      expect(gc.isAimMirrored()).toBe(expected);
      seen.add(gc.isAimMirrored());
    }
    expect(seen.size).toBe(2); // the two tanks start on opposite halves
  });
});
