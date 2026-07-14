import type { BodyState, PositionMeters } from '../protocol/schemas';

export interface CenterOfMassState {
  readonly positionMeters: PositionMeters;
  readonly velocityMetersPerSecond: PositionMeters;
}

interface CompensatedSum {
  compensation: number;
  sum: number;
}

function addCompensated(state: CompensatedSum, value: number): void {
  const corrected = value - state.compensation;
  const next = state.sum + corrected;
  state.compensation = next - state.sum - corrected;
  state.sum = next;
}

function assertFiniteBody(body: BodyState): void {
  if (!Number.isFinite(body.massKg) || body.massKg <= 0) {
    throw new RangeError(`天体 ${body.id} 的质量必须是正有限数`);
  }
  const values = [
    body.positionMeters.x,
    body.positionMeters.y,
    body.positionMeters.z,
    body.velocityMetersPerSecond.x,
    body.velocityMetersPerSecond.y,
    body.velocityMetersPerSecond.z,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError(`天体 ${body.id} 的位置和速度必须是有限数`);
  }
}

export function computeCenterOfMass(bodies: readonly BodyState[]): CenterOfMassState {
  if (bodies.length === 0) {
    throw new RangeError('至少需要一个天体才能计算质心');
  }

  const totalMass = { compensation: 0, sum: 0 };
  const weightedPosition = {
    x: { compensation: 0, sum: 0 },
    y: { compensation: 0, sum: 0 },
    z: { compensation: 0, sum: 0 },
  };
  const weightedVelocity = {
    x: { compensation: 0, sum: 0 },
    y: { compensation: 0, sum: 0 },
    z: { compensation: 0, sum: 0 },
  };

  for (const body of bodies) {
    assertFiniteBody(body);
    addCompensated(totalMass, body.massKg);
    addCompensated(weightedPosition.x, body.massKg * body.positionMeters.x);
    addCompensated(weightedPosition.y, body.massKg * body.positionMeters.y);
    addCompensated(weightedPosition.z, body.massKg * body.positionMeters.z);
    addCompensated(weightedVelocity.x, body.massKg * body.velocityMetersPerSecond.x);
    addCompensated(weightedVelocity.y, body.massKg * body.velocityMetersPerSecond.y);
    addCompensated(weightedVelocity.z, body.massKg * body.velocityMetersPerSecond.z);
  }

  if (!Number.isFinite(totalMass.sum) || totalMass.sum <= 0) {
    throw new RangeError('天体总质量必须是正有限数');
  }

  return {
    positionMeters: {
      x: weightedPosition.x.sum / totalMass.sum,
      y: weightedPosition.y.sum / totalMass.sum,
      z: weightedPosition.z.sum / totalMass.sum,
    },
    velocityMetersPerSecond: {
      x: weightedVelocity.x.sum / totalMass.sum,
      y: weightedVelocity.y.sum / totalMass.sum,
      z: weightedVelocity.z.sum / totalMass.sum,
    },
  };
}

export function centerBodiesOnCenterOfMass(bodies: readonly BodyState[]): BodyState[] {
  const center = computeCenterOfMass(bodies);
  return bodies.map((body) => ({
    ...body,
    positionMeters: {
      x: body.positionMeters.x - center.positionMeters.x,
      y: body.positionMeters.y - center.positionMeters.y,
      z: body.positionMeters.z - center.positionMeters.z,
    },
    velocityMetersPerSecond: {
      x: body.velocityMetersPerSecond.x - center.velocityMetersPerSecond.x,
      y: body.velocityMetersPerSecond.y - center.velocityMetersPerSecond.y,
      z: body.velocityMetersPerSecond.z - center.velocityMetersPerSecond.z,
    },
  }));
}
