import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import type { PassiveCollisionAsset } from '../collisions/schemas';
import { compensatedSum, cross } from '../collisions/vector';
import {
  physicsStateSchema,
  type BodyState,
  type PassiveAssetDiagnostics,
  type PhysicsState,
} from '../protocol/state-schemas';
import type { PhysicsSnapshot } from './physics-simulation';

export const MAX_PASSIVE_ADVANCE_SUBSTEP_SECONDS = 3_600;
export const MAX_PASSIVE_ADVANCE_SUBSTEPS = 4_096;

const ZERO_VECTOR = { x: 0, y: 0, z: 0 } as const;

interface Vector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface PassiveAdvanceResult {
  readonly assets: readonly PassiveCollisionAsset[];
  readonly omittedLinearImpulse: Vector;
  readonly omittedAngularImpulse: Vector;
  readonly omittedWorkJoules: number;
}

function add(left: Vector, right: Vector): Vector {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: Vector, right: Vector): Vector {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(vector: Vector, factor: number): Vector {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

function squaredMagnitude(vector: Vector): number {
  return vector.x ** 2 + vector.y ** 2 + vector.z ** 2;
}

function finiteNumber(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} 超出有限数范围`);
  }
  return value;
}

function majorBodyMap(bodies: readonly BodyState[]): ReadonlyMap<string, BodyState> {
  return new Map(bodies.map((body) => [body.id, body]));
}

function interpolateMajorBodies(
  previousBodies: readonly BodyState[],
  nextBodies: readonly BodyState[],
  alpha: number,
): BodyState[] {
  const nextById = majorBodyMap(nextBodies);
  if (nextById.size !== previousBodies.length) {
    throw new Error('被动资产推进前后的主要天体集合不一致');
  }
  return previousBodies.map((previous) => {
    const next = nextById.get(previous.id);
    if (next?.massKg !== previous.massKg) {
      throw new Error(`被动资产推进缺少稳定主要天体 ${previous.id}`);
    }
    return {
      ...previous,
      positionMeters: add(
        previous.positionMeters,
        scale(subtract(next.positionMeters, previous.positionMeters), alpha),
      ),
      velocityMetersPerSecond: add(
        previous.velocityMetersPerSecond,
        scale(subtract(next.velocityMetersPerSecond, previous.velocityMetersPerSecond), alpha),
      ),
    };
  });
}

function accelerationAt(positionMeters: Vector, majorBodies: readonly BodyState[]): Vector {
  let acceleration: Vector = ZERO_VECTOR;
  for (const body of majorBodies) {
    const displacement = subtract(body.positionMeters, positionMeters);
    const distanceSquared = squaredMagnitude(displacement);
    if (distanceSquared === 0) {
      throw new Error(`被动资产与主要天体 ${body.id} 中心重合，无法计算引力`);
    }
    const inverseDistanceCubed = 1 / (distanceSquared * Math.sqrt(distanceSquared));
    acceleration = add(
      acceleration,
      scale(displacement, GRAVITATIONAL_CONSTANT_SI * body.massKg * inverseDistanceCubed),
    );
  }
  finiteNumber('被动资产引力加速度 x', acceleration.x);
  finiteNumber('被动资产引力加速度 y', acceleration.y);
  finiteNumber('被动资产引力加速度 z', acceleration.z);
  return acceleration;
}

function advancePassiveGroup(
  assets: readonly PassiveCollisionAsset[],
  previousMajorBodies: readonly BodyState[],
  nextMajorBodies: readonly BodyState[],
  elapsedSeconds: number,
): PassiveAdvanceResult {
  if (assets.length === 0 || elapsedSeconds === 0) {
    return {
      assets: assets.map((asset) => ({
        ...asset,
        positionMeters: { ...asset.positionMeters },
        velocityMetersPerSecond: { ...asset.velocityMetersPerSecond },
        materialLayers: asset.materialLayers.map((layer) => ({ ...layer })),
      })),
      omittedLinearImpulse: ZERO_VECTOR,
      omittedAngularImpulse: ZERO_VECTOR,
      omittedWorkJoules: 0,
    };
  }

  const requestedSubsteps = Math.ceil(elapsedSeconds / MAX_PASSIVE_ADVANCE_SUBSTEP_SECONDS);
  const substepCount = Math.max(1, Math.min(MAX_PASSIVE_ADVANCE_SUBSTEPS, requestedSubsteps));
  const substepSeconds = elapsedSeconds / substepCount;
  let current = assets.map((asset) => ({
    ...asset,
    positionMeters: { ...asset.positionMeters },
    velocityMetersPerSecond: { ...asset.velocityMetersPerSecond },
    materialLayers: asset.materialLayers.map((layer) => ({ ...layer })),
  }));
  let omittedLinearImpulse: Vector = ZERO_VECTOR;
  let omittedAngularImpulse: Vector = ZERO_VECTOR;
  let omittedWorkJoules = 0;

  for (let substepIndex = 0; substepIndex < substepCount; substepIndex += 1) {
    const startAlpha = substepIndex / substepCount;
    const endAlpha = (substepIndex + 1) / substepCount;
    const startMajors = interpolateMajorBodies(previousMajorBodies, nextMajorBodies, startAlpha);
    const endMajors = interpolateMajorBodies(previousMajorBodies, nextMajorBodies, endAlpha);
    current = current.map((asset) => {
      const initialPosition = asset.positionMeters;
      const initialVelocity = asset.velocityMetersPerSecond;
      const startAcceleration = accelerationAt(initialPosition, startMajors);
      const halfVelocity = add(initialVelocity, scale(startAcceleration, substepSeconds / 2));
      const nextPosition = add(initialPosition, scale(halfVelocity, substepSeconds));
      const endAcceleration = accelerationAt(nextPosition, endMajors);
      const nextVelocity = add(halfVelocity, scale(endAcceleration, substepSeconds / 2));
      const passiveImpulse = scale(subtract(nextVelocity, initialVelocity), asset.massKg);
      const initialMomentum = scale(initialVelocity, asset.massKg);
      const nextMomentum = scale(nextVelocity, asset.massKg);
      const passiveAngularChange = subtract(
        cross(nextPosition, nextMomentum),
        cross(initialPosition, initialMomentum),
      );
      const passiveKineticChange =
        0.5 * asset.massKg * (squaredMagnitude(nextVelocity) - squaredMagnitude(initialVelocity));

      omittedLinearImpulse = subtract(omittedLinearImpulse, passiveImpulse);
      omittedAngularImpulse = subtract(omittedAngularImpulse, passiveAngularChange);
      omittedWorkJoules -= passiveKineticChange;
      return {
        ...asset,
        positionMeters: nextPosition,
        velocityMetersPerSecond: nextVelocity,
      };
    });
  }

  finiteNumber('累计省略反作用功', omittedWorkJoules);
  return { assets: current, omittedLinearImpulse, omittedAngularImpulse, omittedWorkJoules };
}

export function computePassiveAssetDiagnostics(
  tracers: readonly PassiveCollisionAsset[],
  dustCohorts: readonly PassiveCollisionAsset[],
  majorBodies: readonly BodyState[],
): PassiveAssetDiagnostics {
  const assets = [...tracers, ...dustCohorts];
  const momentumTerms = assets.map((asset) => scale(asset.velocityMetersPerSecond, asset.massKg));
  const angularTerms = assets.map((asset, index) =>
    cross(asset.positionMeters, momentumTerms[index] ?? ZERO_VECTOR),
  );
  const energyTerms = assets.map((asset) => {
    const kineticJoules = 0.5 * asset.massKg * squaredMagnitude(asset.velocityMetersPerSecond);
    const potentialTerms = majorBodies.map((body) => {
      const displacement = subtract(body.positionMeters, asset.positionMeters);
      const distanceMeters = Math.sqrt(squaredMagnitude(displacement));
      if (distanceMeters === 0) {
        throw new Error(`被动资产 ${asset.id} 与主要天体 ${body.id} 中心重合`);
      }
      return (-GRAVITATIONAL_CONSTANT_SI * asset.massKg * body.massKg) / distanceMeters;
    });
    return compensatedSum([
      kineticJoules,
      compensatedSum(potentialTerms),
      asset.subgridMechanicalEnergyJoules,
    ]);
  });

  return {
    totalMassKg: finiteNumber(
      '被动资产总质量',
      compensatedSum(assets.map((asset) => asset.massKg)),
    ),
    totalLinearMomentumKgMetersPerSecond: {
      x: finiteNumber('被动资产线动量 x', compensatedSum(momentumTerms.map((term) => term.x))),
      y: finiteNumber('被动资产线动量 y', compensatedSum(momentumTerms.map((term) => term.y))),
      z: finiteNumber('被动资产线动量 z', compensatedSum(momentumTerms.map((term) => term.z))),
    },
    totalAngularMomentumKgMetersSquaredPerSecond: {
      x: finiteNumber('被动资产角动量 x', compensatedSum(angularTerms.map((term) => term.x))),
      y: finiteNumber('被动资产角动量 y', compensatedSum(angularTerms.map((term) => term.y))),
      z: finiteNumber('被动资产角动量 z', compensatedSum(angularTerms.map((term) => term.z))),
    },
    totalMechanicalEnergyJoules: finiteNumber('被动资产机械能', compensatedSum(energyTerms)),
  };
}

export function advancePhysicsStateToSnapshot(
  previousState: PhysicsState,
  snapshot: PhysicsSnapshot,
  elapsedSeconds: number,
): PhysicsState {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new Error('被动资产推进时长必须是非负有限数');
  }
  const tracerAdvance = advancePassiveGroup(
    previousState.tracers,
    previousState.majorBodies,
    snapshot.bodies,
    elapsedSeconds,
  );
  const dustAdvance = advancePassiveGroup(
    previousState.dustCohorts,
    previousState.majorBodies,
    snapshot.bodies,
    elapsedSeconds,
  );
  const tracers = [...tracerAdvance.assets];
  const dustCohorts = [...dustAdvance.assets];
  const omittedLinearImpulse = add(
    tracerAdvance.omittedLinearImpulse,
    dustAdvance.omittedLinearImpulse,
  );
  const omittedAngularImpulse = add(
    tracerAdvance.omittedAngularImpulse,
    dustAdvance.omittedAngularImpulse,
  );

  return physicsStateSchema.parse({
    ...previousState,
    majorBodies: snapshot.bodies,
    tracers,
    dustCohorts,
    cumulativeOmittedBackreaction: {
      linearImpulseKgMetersPerSecond: add(
        previousState.cumulativeOmittedBackreaction.linearImpulseKgMetersPerSecond,
        omittedLinearImpulse,
      ),
      angularImpulseKgMetersSquaredPerSecond: add(
        previousState.cumulativeOmittedBackreaction.angularImpulseKgMetersSquaredPerSecond,
        omittedAngularImpulse,
      ),
      workJoules: finiteNumber(
        '累计省略反作用功',
        previousState.cumulativeOmittedBackreaction.workJoules +
          tracerAdvance.omittedWorkJoules +
          dustAdvance.omittedWorkJoules,
      ),
    },
    diagnostics: {
      activeRebound: snapshot.diagnostics,
      passiveAssets: computePassiveAssetDiagnostics(tracers, dustCohorts, snapshot.bodies),
    },
  });
}

export function replacePhysicsStateAssets(
  baseState: PhysicsState,
  snapshot: PhysicsSnapshot,
  tracers: readonly PassiveCollisionAsset[],
  dustCohorts: readonly PassiveCollisionAsset[],
  cumulativeCollisionLedger: PhysicsState['cumulativeCollisionLedger'],
): PhysicsState {
  return physicsStateSchema.parse({
    ...baseState,
    majorBodies: snapshot.bodies,
    tracers,
    dustCohorts,
    cumulativeCollisionLedger,
    diagnostics: {
      activeRebound: snapshot.diagnostics,
      passiveAssets: computePassiveAssetDiagnostics(tracers, dustCohorts, snapshot.bodies),
    },
  });
}
