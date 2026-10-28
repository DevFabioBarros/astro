export const NEWTONIAN_G = 6.6743e-11;
export const LIGHT_SPEED_MS = 299_792_458;
export function schwarzschildRadius(massKg: number): number { return 2 * NEWTONIAN_G * massKg / LIGHT_SPEED_MS ** 2; }
