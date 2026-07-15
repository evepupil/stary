export interface AtmosphereLayerProfile {
  readonly color: number;
  readonly opacity: number;
  readonly radiusRatio: number;
}

export interface CloudLayerProfile {
  readonly initialPhaseRadians: number;
  readonly opacity: number;
  readonly radiusRatio: number;
  readonly relativeRotationPeriodSeconds: number;
  readonly shadowOffsetRadians: number;
  readonly shadowOpacity: number;
  readonly shadowRadiusRatio: number;
}

export interface BodyEnvironmentProfile {
  readonly atmosphereLayers: readonly AtmosphereLayerProfile[];
  readonly clouds: CloudLayerProfile | null;
}

const FIXED_ENVIRONMENT_PROFILES: Readonly<Record<string, BodyEnvironmentProfile>> = {
  earth: {
    atmosphereLayers: [
      { color: 0x74c7ff, opacity: 0.17, radiusRatio: 1.012 },
      { color: 0x2e8fe8, opacity: 0.11, radiusRatio: 1.026 },
    ],
    clouds: {
      initialPhaseRadians: 0.42,
      opacity: 0.88,
      radiusRatio: 1.008,
      relativeRotationPeriodSeconds: 432_000,
      shadowOffsetRadians: 0.012,
      shadowOpacity: 0.25,
      shadowRadiusRatio: 1.0015,
    },
  },
  mars: {
    atmosphereLayers: [
      { color: 0xc98264, opacity: 0.08, radiusRatio: 1.008 },
      { color: 0x9f5d48, opacity: 0.045, radiusRatio: 1.016 },
    ],
    clouds: null,
  },
  venus: {
    atmosphereLayers: [
      { color: 0xe7c787, opacity: 0.2, radiusRatio: 1.016 },
      { color: 0xc99d58, opacity: 0.13, radiusRatio: 1.035 },
    ],
    clouds: null,
  },
};

export function resolveBodyEnvironmentProfile(bodyId: string): BodyEnvironmentProfile | null {
  return FIXED_ENVIRONMENT_PROFILES[bodyId] ?? null;
}

export function computeCloudPhaseRadians(
  profile: CloudLayerProfile,
  simulationTimeSeconds: number,
): number {
  if (!Number.isFinite(simulationTimeSeconds) || simulationTimeSeconds < 0) {
    throw new RangeError('simulationTimeSeconds 必须是非负有限数');
  }
  if (
    !Number.isFinite(profile.relativeRotationPeriodSeconds) ||
    profile.relativeRotationPeriodSeconds <= 0
  ) {
    throw new RangeError('relativeRotationPeriodSeconds 必须是正有限数');
  }
  const elapsedWithinPeriod = simulationTimeSeconds % profile.relativeRotationPeriodSeconds;
  return normalizeRadians(
    profile.initialPhaseRadians +
      (elapsedWithinPeriod / profile.relativeRotationPeriodSeconds) * Math.PI * 2,
  );
}

function normalizeRadians(value: number): number {
  const fullTurn = Math.PI * 2;
  return ((value % fullTurn) + fullTurn) % fullTurn;
}
