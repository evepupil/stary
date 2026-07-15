import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import { computeContactQuantities } from './contact-quantities';
import {
  COLLISION_CONSERVATION_LIMITS,
  COLLISION_LEDGER_VERSION,
  COLLISION_MODEL_VERSION,
  UNIFORM_SPHERE_SELF_BINDING_FACTOR,
} from './model-sources';
import { computeAbsoluteMaterialMasses } from './materials';
import {
  collisionDissipationSchema,
  collisionEventStateSchema,
  collisionLedgerSchema,
  type AbsoluteMaterialMasses,
  type CollisionDissipation,
  type CollisionEventState,
  type CollisionLedger,
  type ContactQuantities,
  type CollisionVector,
} from './schemas';
import { compareUtf8 } from './stable-order';
import { add, compensatedSum, cross, magnitude, scale, subtract, sumVectors } from './vector';

export interface CollisionLedgerInput {
  readonly eventId: string;
  readonly simulationTimeSeconds: number;
  readonly before: CollisionEventState;
  readonly after: CollisionEventState;
  readonly dissipation: CollisionDissipation;
  readonly participantBodyIds: readonly [string, string];
}

interface Frame {
  readonly originMeters: CollisionVector;
  readonly velocityMetersPerSecond: CollisionVector;
}

interface CommonAsset {
  readonly id: string;
  readonly massKg: number;
  readonly positionMeters: CollisionVector;
  readonly velocityMetersPerSecond: CollisionVector;
  readonly materialLayers: CollisionEventState['tracers'][number]['materialLayers'];
  readonly subgridMechanicalEnergyJoules: number;
}

type MajorAsset = CollisionEventState['majorBodies'][number];
type GravitatingAsset = Pick<CommonAsset, 'id' | 'massKg' | 'positionMeters'>;

function sortedById<Asset extends { readonly id: string }>(assets: readonly Asset[]): Asset[] {
  return [...assets].sort((left, right) => compareUtf8(left.id, right.id));
}

function passiveAssets(state: CollisionEventState): CommonAsset[] {
  return sortedById([...state.tracers, ...state.dustCohorts]);
}

function allAssets(state: CollisionEventState): CommonAsset[] {
  const majors: CommonAsset[] = state.majorBodies.map((body) => ({
    id: body.id,
    massKg: body.massKg,
    positionMeters: body.positionMeters,
    velocityMetersPerSecond: body.velocityMetersPerSecond,
    materialLayers: body.materialLayers,
    subgridMechanicalEnergyJoules: 0,
  }));
  return sortedById([...majors, ...passiveAssets(state)]);
}

function computeReferenceFrame(state: CollisionEventState): Frame {
  const assets = allAssets(state);
  if (assets.length === 0) {
    throw new RangeError('碰撞守恒账本至少需要一个物理资产');
  }
  const totalMassKg = compensatedSum(assets.map((asset) => asset.massKg));
  const weightedPositions = assets.map((asset) => scale(asset.positionMeters, asset.massKg));
  const weightedVelocities = assets.map((asset) =>
    scale(asset.velocityMetersPerSecond, asset.massKg),
  );
  return {
    originMeters: scale(sumVectors(weightedPositions), 1 / totalMassKg),
    velocityMetersPerSecond: scale(sumVectors(weightedVelocities), 1 / totalMassKg),
  };
}

function pairPotentialEnergyJoules(first: GravitatingAsset, second: GravitatingAsset): number {
  const distanceMeters = magnitude(subtract(first.positionMeters, second.positionMeters));
  if (distanceMeters <= 0) {
    throw new RangeError(`资产 ${first.id} 与 ${second.id} 的中心距离必须大于 0`);
  }
  return (-GRAVITATIONAL_CONSTANT_SI * first.massKg * second.massKg) / distanceMeters;
}

function computeActiveActivePotential(majorBodies: readonly MajorAsset[]): number {
  const sorted = sortedById(majorBodies);
  const terms: number[] = [];
  for (let firstIndex = 0; firstIndex < sorted.length; firstIndex += 1) {
    const first = sorted[firstIndex];
    if (first === undefined) {
      continue;
    }
    for (let secondIndex = firstIndex + 1; secondIndex < sorted.length; secondIndex += 1) {
      const second = sorted[secondIndex];
      if (second !== undefined) {
        terms.push(pairPotentialEnergyJoules(first, second));
      }
    }
  }
  return compensatedSum(terms);
}

function computeActivePassivePotential(
  majorBodies: readonly MajorAsset[],
  passives: readonly CommonAsset[],
): number {
  const terms: number[] = [];
  for (const major of sortedById(majorBodies)) {
    for (const passive of sortedById(passives)) {
      terms.push(pairPotentialEnergyJoules(major, passive));
    }
  }
  return compensatedSum(terms);
}

function addMaterialMasses(
  totals: Record<keyof AbsoluteMaterialMasses, number[]>,
  massKg: number,
  layers: CommonAsset['materialLayers'],
): void {
  if (layers.length === 0) {
    return;
  }
  const masses = computeAbsoluteMaterialMasses(massKg, layers);
  totals.gas.push(masses.gas);
  totals.ice.push(masses.ice);
  totals.silicate.push(masses.silicate);
  totals.iron.push(masses.iron);
}

function computeEventTotals(state: CollisionEventState, frame: Frame) {
  const majors = sortedById(state.majorBodies);
  const passives = passiveAssets(state);
  const assets = allAssets(state);
  const materialTerms: Record<keyof AbsoluteMaterialMasses, number[]> = {
    gas: [],
    ice: [],
    silicate: [],
    iron: [],
  };
  for (const asset of assets) {
    addMaterialMasses(materialTerms, asset.massKg, asset.materialLayers);
  }

  const linearMomentumTerms: CollisionVector[] = [];
  const orbitalAngularMomentumTerms: CollisionVector[] = [];
  const translationalEnergyTerms: number[] = [];
  for (const asset of assets) {
    const relativeVelocity = subtract(asset.velocityMetersPerSecond, frame.velocityMetersPerSecond);
    const momentum = scale(relativeVelocity, asset.massKg);
    linearMomentumTerms.push(momentum);
    orbitalAngularMomentumTerms.push(
      cross(subtract(asset.positionMeters, frame.originMeters), momentum),
    );
    translationalEnergyTerms.push(0.5 * asset.massKg * magnitude(relativeVelocity) ** 2);
  }

  const spinTerms: number[] = [];
  const spinAngularMomenta: CollisionVector[] = [];
  const selfBindingTerms: number[] = [];
  for (const major of majors) {
    spinAngularMomenta.push(major.spinAngularMomentumKgMetersSquaredPerSecond);
    if (major.collisionModel === 'blackHole') {
      continue;
    }
    const inertiaFactor = major.momentOfInertiaFactor;
    if (inertiaFactor === null) {
      throw new RangeError(`天体 ${major.id} 缺少经典转动惯量因子`);
    }
    const spinMagnitude = magnitude(major.spinAngularMomentumKgMetersSquaredPerSecond);
    const momentOfInertia = inertiaFactor * major.massKg * major.radiusMeters ** 2;
    spinTerms.push(spinMagnitude ** 2 / (2 * momentOfInertia));
    selfBindingTerms.push(
      (-UNIFORM_SPHERE_SELF_BINDING_FACTOR * GRAVITATIONAL_CONSTANT_SI * major.massKg ** 2) /
        major.radiusMeters,
    );
  }

  const translationalJoules = compensatedSum(translationalEnergyTerms);
  const spinJoules = compensatedSum(spinTerms);
  const activeActivePotentialJoules = computeActiveActivePotential(majors);
  const activePassivePotentialJoules = computeActivePassivePotential(majors, passives);
  const selfBindingJoules = compensatedSum(selfBindingTerms);
  const subgridJoules = compensatedSum(
    passives.map((asset) => asset.subgridMechanicalEnergyJoules),
  );
  const totalJoules = compensatedSum([
    translationalJoules,
    spinJoules,
    activeActivePotentialJoules,
    activePassivePotentialJoules,
    selfBindingJoules,
    subgridJoules,
  ]);
  const majorKg = compensatedSum(majors.map((body) => body.massKg));
  const tracerKg = compensatedSum(state.tracers.map((asset) => asset.massKg));
  const dustKg = compensatedSum(state.dustCohorts.map((asset) => asset.massKg));

  return {
    reservoirMasses: {
      majorKg,
      tracerKg,
      dustKg,
      totalKg: compensatedSum([majorKg, tracerKg, dustKg]),
    },
    materialMassesKg: {
      gas: compensatedSum(materialTerms.gas),
      ice: compensatedSum(materialTerms.ice),
      silicate: compensatedSum(materialTerms.silicate),
      iron: compensatedSum(materialTerms.iron),
    },
    linearMomentumKgMetersPerSecond: sumVectors(linearMomentumTerms),
    angularMomentumKgMetersSquaredPerSecond: add(
      sumVectors(orbitalAngularMomentumTerms),
      sumVectors(spinAngularMomenta),
    ),
    energy: {
      translationalJoules,
      spinJoules,
      activeActivePotentialJoules,
      activePassivePotentialJoules,
      selfBindingJoules,
      subgridJoules,
      totalJoules,
    },
  };
}

function conservationCheck(
  absoluteError: number,
  scaleValue: number,
  threshold: number,
  minimumScale: number,
) {
  const scale = Math.max(scaleValue, minimumScale);
  const normalizedError = absoluteError / scale;
  return {
    absoluteError,
    scale,
    normalizedError,
    threshold,
    passed: normalizedError <= threshold,
  };
}

function computeParticipantContact(
  state: CollisionEventState,
  participantBodyIds: readonly [string, string],
): ContactQuantities {
  const [firstId, secondId] = participantBodyIds;
  if (firstId === secondId) {
    throw new RangeError('碰撞参与体 id 不能相同');
  }
  const first = state.majorBodies.find((body) => body.id === firstId);
  const second = state.majorBodies.find((body) => body.id === secondId);
  if (first === undefined || second === undefined) {
    throw new RangeError('碰撞参与体必须存在于碰前主要天体快照');
  }
  if (first.collisionModel === 'blackHole' || second.collisionModel === 'blackHole') {
    throw new RangeError('黑洞参与碰撞时必须使用独立牛顿吞噬账本');
  }
  if (first.collisionModel === 'stellar' || second.collisionModel === 'stellar') {
    throw new RangeError('恒星碰撞超出经典 event-total 账本范围');
  }
  return computeContactQuantities(first, second);
}

function totalDissipation(dissipation: CollisionDissipation): number {
  return compensatedSum([
    dissipation.heatJoules,
    dissipation.deformationJoules,
    dissipation.fractureJoules,
    dissipation.radiationJoules,
  ]);
}

export function computeCollisionLedger(input: CollisionLedgerInput): CollisionLedger {
  const beforeState = collisionEventStateSchema.parse(input.before);
  const afterState = collisionEventStateSchema.parse(input.after);
  const dissipation = collisionDissipationSchema.parse(input.dissipation);
  const participantContact = computeParticipantContact(beforeState, input.participantBodyIds);
  const frame = computeReferenceFrame(beforeState);
  const before = computeEventTotals(beforeState, frame);
  const after = computeEventTotals(afterState, frame);

  const beforeAssets = allAssets(beforeState);
  const momentumScale = Math.max(
    compensatedSum(
      beforeAssets.map(
        (asset) =>
          asset.massKg *
          magnitude(subtract(asset.velocityMetersPerSecond, frame.velocityMetersPerSecond)),
      ),
    ),
    participantContact.totalMassKg * participantContact.mutualEscapeSpeedMetersPerSecond,
    1,
  );
  const angularInputScale = compensatedSum(
    beforeAssets.map((asset) => {
      const momentum = scale(
        subtract(asset.velocityMetersPerSecond, frame.velocityMetersPerSecond),
        asset.massKg,
      );
      return magnitude(cross(subtract(asset.positionMeters, frame.originMeters), momentum));
    }),
  );
  const spinInputScale = compensatedSum(
    beforeState.majorBodies.map((body) =>
      magnitude(body.spinAngularMomentumKgMetersSquaredPerSecond),
    ),
  );
  const angularScale = Math.max(
    angularInputScale + spinInputScale,
    participantContact.totalMassKg *
      participantContact.radiusSumMeters *
      participantContact.mutualEscapeSpeedMetersPerSecond,
    1,
  );
  const impactEnergyScale =
    0.5 * participantContact.reducedMassKg * participantContact.impactSpeedMetersPerSecond ** 2 +
    (GRAVITATIONAL_CONSTANT_SI *
      participantContact.targetMassKg *
      participantContact.projectileMassKg) /
      participantContact.radiusSumMeters;
  const energyScale = Math.max(Math.abs(before.energy.totalJoules), impactEnergyScale, 1);

  const materialKeys = ['gas', 'ice', 'silicate', 'iron'] as const;
  const materialMasses = Object.fromEntries(
    materialKeys.map((material) => [
      material,
      conservationCheck(
        Math.abs(after.materialMassesKg[material] - before.materialMassesKg[material]),
        before.reservoirMasses.totalKg,
        COLLISION_CONSERVATION_LIMITS.mass,
        0,
      ),
    ]),
  ) as Record<(typeof materialKeys)[number], ReturnType<typeof conservationCheck>>;

  const checks = {
    mass: conservationCheck(
      Math.abs(after.reservoirMasses.totalKg - before.reservoirMasses.totalKg),
      before.reservoirMasses.totalKg,
      COLLISION_CONSERVATION_LIMITS.mass,
      0,
    ),
    materialMasses,
    linearMomentum: conservationCheck(
      magnitude(
        subtract(after.linearMomentumKgMetersPerSecond, before.linearMomentumKgMetersPerSecond),
      ),
      momentumScale,
      COLLISION_CONSERVATION_LIMITS.linearMomentum,
      1,
    ),
    angularMomentum: conservationCheck(
      magnitude(
        subtract(
          after.angularMomentumKgMetersSquaredPerSecond,
          before.angularMomentumKgMetersSquaredPerSecond,
        ),
      ),
      angularScale,
      COLLISION_CONSERVATION_LIMITS.angularMomentum,
      1,
    ),
    energy: conservationCheck(
      Math.abs(
        before.energy.totalJoules - after.energy.totalJoules - totalDissipation(dissipation),
      ),
      energyScale,
      COLLISION_CONSERVATION_LIMITS.energy,
      1,
    ),
  };
  const passed =
    checks.mass.passed &&
    checks.linearMomentum.passed &&
    checks.angularMomentum.passed &&
    checks.energy.passed &&
    materialKeys.every((material) => checks.materialMasses[material].passed);

  return collisionLedgerSchema.parse({
    ledgerVersion: COLLISION_LEDGER_VERSION,
    modelVersion: COLLISION_MODEL_VERSION,
    eventId: input.eventId,
    simulationTimeSeconds: input.simulationTimeSeconds,
    referenceFrame: frame,
    before,
    after,
    dissipation,
    checks,
    omittedInteractionClasses: [
      'tracerTracerGravity',
      'tracerDustGravity',
      'dustDustGravity',
      'passiveBackreaction',
    ],
    passed,
  });
}
