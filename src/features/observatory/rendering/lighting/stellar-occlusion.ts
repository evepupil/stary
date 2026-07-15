import type { BodyState } from '../../../../physics/protocol/schemas';

export interface StellarOcclusionResult {
  readonly occluderIds: readonly string[];
  readonly visibility: number;
}

export interface StellarIlluminationSample {
  readonly unoccludedIlluminance: number;
  readonly visibility: number;
}

interface AngularOccluderDisk {
  readonly angularRadius: number;
  readonly coveredFraction: number;
  readonly direction: BodyState['positionMeters'];
  readonly id: string;
}

const OCCLUSION_UNION_SAMPLE_COUNT = 1_024;
const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));

export function computeCombinedStellarTransmission(
  samples: readonly StellarIlluminationSample[],
): number {
  let totalUnoccludedIlluminance = 0;
  let totalVisibleIlluminance = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.unoccludedIlluminance) || sample.unoccludedIlluminance < 0) {
      throw new RangeError('unoccludedIlluminance 必须是非负有限数');
    }
    if (!Number.isFinite(sample.visibility) || sample.visibility < 0 || sample.visibility > 1) {
      throw new RangeError('visibility 必须在 0 到 1 之间');
    }
    totalUnoccludedIlluminance += sample.unoccludedIlluminance;
    totalVisibleIlluminance += sample.unoccludedIlluminance * sample.visibility;
  }
  if (totalUnoccludedIlluminance <= Number.EPSILON) {
    return 0;
  }
  return clamp(totalVisibleIlluminance / totalUnoccludedIlluminance, 0, 1);
}

export function computeStellarVisibility(
  target: BodyState,
  star: BodyState,
  bodies: readonly BodyState[],
): StellarOcclusionResult {
  const starVector = subtract(star.positionMeters, target.positionMeters);
  const starDistance = magnitude(starVector);
  if (starDistance <= star.radiusMeters || starDistance <= 0) {
    return { occluderIds: [], visibility: 1 };
  }
  const starDirection = scale(starVector, 1 / starDistance);
  const starAngularRadius = Math.asin(clamp(star.radiusMeters / starDistance, 0, 1));
  const occluders: AngularOccluderDisk[] = [];

  for (const candidate of bodies) {
    if (candidate.id === target.id || candidate.id === star.id) {
      continue;
    }
    const candidateVector = subtract(candidate.positionMeters, target.positionMeters);
    const candidateDistance = magnitude(candidateVector);
    if (
      candidateDistance <= candidate.radiusMeters ||
      candidateDistance >= starDistance ||
      candidateDistance <= 0
    ) {
      continue;
    }
    const projectedDistance = dot(candidateVector, starDirection);
    if (projectedDistance <= 0 || projectedDistance >= starDistance) {
      continue;
    }
    const candidateDirection = scale(candidateVector, 1 / candidateDistance);
    const angularSeparation = Math.acos(clamp(dot(starDirection, candidateDirection), -1, 1));
    const candidateAngularRadius = Math.asin(
      clamp(candidate.radiusMeters / candidateDistance, 0, 1),
    );
    const coveredFraction = computeAngularDiskOverlapFraction(
      starAngularRadius,
      candidateAngularRadius,
      angularSeparation,
    );
    if (coveredFraction <= 0) {
      continue;
    }
    occluders.push({
      angularRadius: candidateAngularRadius,
      coveredFraction,
      direction: candidateDirection,
      id: candidate.id,
    });
  }

  const visibility = computeOccluderUnionVisibility(starDirection, starAngularRadius, occluders);

  return {
    occluderIds: occluders.map((occluder) => occluder.id).toSorted(),
    visibility: clamp(visibility, 0, 1),
  };
}

function computeOccluderUnionVisibility(
  starDirection: BodyState['positionMeters'],
  starAngularRadius: number,
  occluders: readonly AngularOccluderDisk[],
): number {
  if (occluders.length === 0) {
    return 1;
  }
  if (occluders.some((occluder) => occluder.coveredFraction >= 1)) {
    return 0;
  }
  if (occluders.length === 1) {
    return 1 - (occluders[0]?.coveredFraction ?? 0);
  }

  const reference = Math.abs(starDirection.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const tangentX = normalize(cross(reference, starDirection));
  const tangentY = normalize(cross(starDirection, tangentX));
  let coveredSamples = 0;
  for (let index = 0; index < OCCLUSION_UNION_SAMPLE_COUNT; index += 1) {
    const radialFraction = Math.sqrt((index + 0.5) / OCCLUSION_UNION_SAMPLE_COUNT);
    const angularDistance = radialFraction * starAngularRadius;
    const azimuth = index * GOLDEN_ANGLE_RADIANS;
    const tangentDirection = add(
      scale(tangentX, Math.cos(azimuth)),
      scale(tangentY, Math.sin(azimuth)),
    );
    const sampleDirection = add(
      scale(starDirection, Math.cos(angularDistance)),
      scale(tangentDirection, Math.sin(angularDistance)),
    );
    if (
      occluders.some(
        (occluder) => dot(sampleDirection, occluder.direction) >= Math.cos(occluder.angularRadius),
      )
    ) {
      coveredSamples += 1;
    }
  }
  return 1 - coveredSamples / OCCLUSION_UNION_SAMPLE_COUNT;
}

export function computeAngularDiskOverlapFraction(
  lightRadius: number,
  occluderRadius: number,
  separation: number,
): number {
  if (
    !Number.isFinite(lightRadius) ||
    !Number.isFinite(occluderRadius) ||
    !Number.isFinite(separation) ||
    lightRadius <= 0 ||
    occluderRadius < 0 ||
    separation < 0
  ) {
    throw new RangeError('角圆盘参数无效');
  }
  if (occluderRadius === 0 || separation >= lightRadius + occluderRadius) {
    return 0;
  }
  const lightArea = Math.PI * lightRadius * lightRadius;
  if (separation <= Math.abs(lightRadius - occluderRadius)) {
    const overlapRadius = Math.min(lightRadius, occluderRadius);
    return clamp((Math.PI * overlapRadius * overlapRadius) / lightArea, 0, 1);
  }

  const lightAngle = Math.acos(
    clamp(
      (separation * separation + lightRadius * lightRadius - occluderRadius * occluderRadius) /
        (2 * separation * lightRadius),
      -1,
      1,
    ),
  );
  const occluderAngle = Math.acos(
    clamp(
      (separation * separation + occluderRadius * occluderRadius - lightRadius * lightRadius) /
        (2 * separation * occluderRadius),
      -1,
      1,
    ),
  );
  const triangleArea =
    0.5 *
    Math.sqrt(
      Math.max(
        0,
        (-separation + lightRadius + occluderRadius) *
          (separation + lightRadius - occluderRadius) *
          (separation - lightRadius + occluderRadius) *
          (separation + lightRadius + occluderRadius),
      ),
    );
  const overlapArea =
    lightRadius * lightRadius * lightAngle +
    occluderRadius * occluderRadius * occluderAngle -
    triangleArea;
  return clamp(overlapArea / lightArea, 0, 1);
}

function subtract(
  left: BodyState['positionMeters'],
  right: BodyState['positionMeters'],
): BodyState['positionMeters'] {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function add(
  left: BodyState['positionMeters'],
  right: BodyState['positionMeters'],
): BodyState['positionMeters'] {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function cross(
  left: BodyState['positionMeters'],
  right: BodyState['positionMeters'],
): BodyState['positionMeters'] {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function scale(value: BodyState['positionMeters'], factor: number): BodyState['positionMeters'] {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function dot(left: BodyState['positionMeters'], right: BodyState['positionMeters']): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function magnitude(value: BodyState['positionMeters']): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(value: BodyState['positionMeters']): BodyState['positionMeters'] {
  const length = magnitude(value);
  if (length <= Number.EPSILON) {
    throw new RangeError('方向向量长度必须大于零');
  }
  return scale(value, 1 / length);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
