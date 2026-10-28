export const DEFAULT_ENVIRONMENT_SEED_V1 = 0x41535400;
export const LEGACY_ENVIRONMENT_SEED_V1 = 0x4c454701;

export function isEnvironmentSeed(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}
