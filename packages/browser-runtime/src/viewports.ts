export const viewportProfiles = {
  desktop: { width: 800, height: 600 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportProfile = keyof typeof viewportProfiles;
export function viewportProfile(value = process.env.SCOUT_EXPLORER_VIEWPORT || 'desktop'): ViewportProfile {
  if (!Object.hasOwn(viewportProfiles, value)) throw new Error('Viewport must be desktop, tablet or mobile.');
  return value as ViewportProfile;
}
