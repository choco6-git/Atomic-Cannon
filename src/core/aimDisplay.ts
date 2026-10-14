/**
 * Aim-angle display — how the stored aim is SHOWN to the player.
 *
 * The aim itself is a world-absolute angle everywhere (0 = right, 90 = up, 180 = left, 270 = down,
 * counter-clockwise): the physics, the bots, the saved per-tank aim and the `aim` command relayed in
 * net play all rely on it. The readout is the one thing that is not: a tank on the right half of the
 * map is shown the MIRROR image (0 = horizontal toward the middle of the map), so every player reads
 * "0 at the horizon facing the enemy, climbing as the barrel rises" whichever side they stand on.
 *
 * The mirror is `180 - a` folded into 0..359, which is its own inverse — one function converts in
 * both directions (stored → shown, and a slider/typed value → stored).
 */

/** Convert between the stored (absolute) aim and the displayed one. `mirrored` = right-half tank. */
export const toDisplayAngle = (deg: number, mirrored: boolean): number =>
  mirrored ? (((180 - Math.round(deg)) % 360) + 360) % 360 : Math.round(deg);
