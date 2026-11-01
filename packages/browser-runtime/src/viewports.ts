// Desktop matches the most common computer screen (1920 × 1080), tablet is a
// portrait iPad and mobile a current iPhone. Desktop is the default.
export const viewportProfiles = {
  desktop: { width: 1920, height: 1080 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportProfile = keyof typeof viewportProfiles;
export type Viewport = { width: number; height: number };
export function viewportProfile(value = process.env.SCOUT_EXPLORER_VIEWPORT || 'desktop'): ViewportProfile {
  if (!Object.hasOwn(viewportProfiles, value)) throw new Error('Viewport must be desktop, tablet or mobile.');
  return value as ViewportProfile;
}
// A size recorded on an earlier run. Profiles can change size over time, so a
// replay uses the size its source run recorded, not the profile's current one.
export function recordedViewport(value: unknown): Viewport | null {
  const v = value as Partial<Viewport> | null;
  const valid = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 8192;
  return v && valid(v.width) && valid(v.height) ? { width: v.width!, height: v.height! } : null;
}
