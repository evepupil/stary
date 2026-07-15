export interface BlackHoleVisualProfile {
  readonly accretionDisk: null;
  readonly eventHorizonRadiusRatio: number;
  readonly observableOuterRadiusRatio: number;
  readonly photonRingRadiusRatio: number;
  readonly photonSphereRadiusRatio: number;
  readonly shadowRadiusRatio: number;
}

export const ISOLATED_BLACK_HOLE_PROFILE: BlackHoleVisualProfile = {
  accretionDisk: null,
  eventHorizonRadiusRatio: 1,
  observableOuterRadiusRatio: 3.25,
  photonRingRadiusRatio: (3 * Math.sqrt(3)) / 2,
  photonSphereRadiusRatio: 1.5,
  shadowRadiusRatio: (3 * Math.sqrt(3)) / 2,
};

export function resolveBlackHoleVisualProfile(surfaceKind: string): BlackHoleVisualProfile | null {
  return surfaceKind === 'black-hole' ? ISOLATED_BLACK_HOLE_PROFILE : null;
}
