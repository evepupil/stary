import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import {
  computeGendaMergingThreshold,
  createCollisionResolutionCandidate,
  createNonInteractingTangentCandidate,
} from './classification';
import { evaluateCollisionClassification } from './collision-formulas';
import { computeCollisionLedger } from './conservation';
import { computeContactQuantities } from './contact-quantities';
import { createDeterministicCollisionSeed } from './deterministic-seed';
import { computeDisruptionScaling } from './disruption-scaling';
import {
  BLACK_HOLE_ACCRETION_LEDGER_VERSION,
  COLLISION_KERNEL_ABI_VERSION,
  COLLISION_RECONSTRUCTION_VERSION,
  collisionKernelBatchRequestSchema,
  collisionKernelResponseSchema,
  type BlackHoleAccretionLedger,
  type CollisionKernelBatchRequest,
  type CollisionKernelErrorCode,
  type CollisionKernelEventRequest,
  type CollisionKernelEventResolution,
  type CollisionKernelResponse,
} from './kernel-schemas';
import { COLLISION_CONSERVATION_LIMITS, COLLISION_MODEL_VERSION } from './model-sources';
import {
  computeAbsoluteMaterialMasses,
  stripOuterMaterial,
  type AbsoluteMaterialLayer,
} from './materials';
import { parseCollisionResolutionCandidateForInput } from './candidate-validation';
import type {
  CollisionBodySnapshot,
  CollisionDissipation,
  CollisionEventState,
  CollisionMaterial,
  CollisionResolutionCandidate,
  CollisionVector,
  MaterialLayer,
} from './schemas';
import { compareUtf8 } from './stable-order';
import { add, compensatedSum, cross, dot, magnitude, scale, subtract, sumVectors } from './vector';

const SPEED_OF_LIGHT_METERS_PER_SECOND = 299_792_458;
const MINIMUM_CLASSIC_RADIUS_METERS = 1_000;
const FRAGMENT_RADIAL_ENERGY_FRACTION = 0.25;
const ZERO_DISSIPATION: CollisionDissipation = {
  heatJoules: 0,
  deformationJoules: 0,
  fractureJoules: 0,
  radiationJoules: 0,
};

class KernelResolutionError extends Error {
  public constructor(
    public readonly code: CollisionKernelErrorCode,
    public readonly eventId: string | null,
    message: string,
  ) {
    super(message);
  }
}

interface CenterOfMassFrame {
  readonly massKg: number;
  readonly positionMeters: CollisionVector;
  readonly velocityMetersPerSecond: CollisionVector;
}

function errorResponse(
  code: CollisionKernelErrorCode,
  eventId: string | null,
  message: string,
): CollisionKernelResponse {
  return collisionKernelResponseSchema.parse({
    abiVersion: COLLISION_KERNEL_ABI_VERSION,
    modelVersion: COLLISION_MODEL_VERSION,
    reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
    kind: 'error',
    error: { code, eventId, message },
  });
}

function centerOfMass(
  first: CollisionBodySnapshot,
  second: CollisionBodySnapshot,
): CenterOfMassFrame {
  const massKg = first.massKg + second.massKg;
  if (!Number.isFinite(massKg)) {
    throw new KernelResolutionError('collisionNumericalFailure', null, '二体总质量超出有限数范围');
  }
  return {
    massKg,
    positionMeters: scale(
      sumVectors([
        scale(first.positionMeters, first.massKg),
        scale(second.positionMeters, second.massKg),
      ]),
      1 / massKg,
    ),
    velocityMetersPerSecond: scale(
      sumVectors([
        scale(first.velocityMetersPerSecond, first.massKg),
        scale(second.velocityMetersPerSecond, second.massKg),
      ]),
      1 / massKg,
    ),
  };
}

function orbitalAngularMomentum(
  first: CollisionBodySnapshot,
  second: CollisionBodySnapshot,
  frame: CenterOfMassFrame,
): CollisionVector {
  return sumVectors(
    [first, second].map((body) =>
      cross(
        subtract(body.positionMeters, frame.positionMeters),
        scale(subtract(body.velocityMetersPerSecond, frame.velocityMetersPerSecond), body.massKg),
      ),
    ),
  );
}

function totalSpin(first: CollisionBodySnapshot, second: CollisionBodySnapshot): CollisionVector {
  return add(
    first.spinAngularMomentumKgMetersSquaredPerSecond,
    second.spinAngularMomentumKgMetersSquaredPerSecond,
  );
}

function totalAngularMomentum(
  first: CollisionBodySnapshot,
  second: CollisionBodySnapshot,
  frame: CenterOfMassFrame,
): CollisionVector {
  return add(orbitalAngularMomentum(first, second, frame), totalSpin(first, second));
}

const MATERIAL_ORDER: readonly CollisionMaterial[] = ['gas', 'ice', 'silicate', 'iron'];

function materialLayersFromMasses(
  masses: Readonly<Record<CollisionMaterial, number>>,
  totalMassKg: number,
): MaterialLayer[] {
  const present = MATERIAL_ORDER.filter((material) => masses[material] > 0);
  if (present.length === 0 || !Number.isFinite(totalMassKg) || totalMassKg <= 0) {
    throw new KernelResolutionError(
      'collisionReconstructionFailed',
      null,
      '经典残体必须保留正的材料质量',
    );
  }
  let assignedFraction = 0;
  return present.map((material, index) => {
    const massFraction =
      index === present.length - 1 ? 1 - assignedFraction : masses[material] / totalMassKg;
    if (!Number.isFinite(massFraction) || massFraction <= 0) {
      throw new KernelResolutionError(
        'collisionNumericalFailure',
        null,
        '材料质量分数无法表示为正有限数',
      );
    }
    assignedFraction += massFraction;
    return { material, massFraction };
  });
}

function materialLayersFromAbsolute(
  layers: readonly AbsoluteMaterialLayer[],
  totalMassKg: number,
): MaterialLayer[] {
  const masses: Record<CollisionMaterial, number> = { gas: 0, ice: 0, silicate: 0, iron: 0 };
  for (const layer of layers) {
    masses[layer.material] += layer.massKg;
  }
  return materialLayersFromMasses(masses, totalMassKg);
}

function combinedMaterialLayers(
  first: CollisionBodySnapshot,
  second: CollisionBodySnapshot,
  totalMassKg: number,
): MaterialLayer[] {
  const firstMasses = computeAbsoluteMaterialMasses(first.massKg, first.materialLayers);
  const secondMasses = computeAbsoluteMaterialMasses(second.massKg, second.materialLayers);
  return materialLayersFromMasses(
    {
      gas: firstMasses.gas + secondMasses.gas,
      ice: firstMasses.ice + secondMasses.ice,
      silicate: firstMasses.silicate + secondMasses.silicate,
      iron: firstMasses.iron + secondMasses.iron,
    },
    totalMassKg,
  );
}

function combinedRadiusMeters(first: CollisionBodySnapshot, second: CollisionBodySnapshot): number {
  const volumeScale = first.radiusMeters ** 3 + second.radiusMeters ** 3;
  const radius = Math.cbrt(volumeScale);
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new KernelResolutionError(
      'collisionNumericalFailure',
      null,
      '平均密度残体半径超出有限数范围',
    );
  }
  return radius;
}

function effectiveMomentOfInertiaFactor(
  first: CollisionBodySnapshot,
  second: CollisionBodySnapshot,
  totalMassKg: number,
): number {
  const firstFactor = first.momentOfInertiaFactor;
  const secondFactor = second.momentOfInertiaFactor;
  if (firstFactor === null || secondFactor === null) {
    throw new KernelResolutionError('unsupportedCollisionDomain', null, '经典重建缺少转动惯量因子');
  }
  return (firstFactor * first.massKg + secondFactor * second.massKg) / totalMassKg;
}

function fragmentId(
  eventId: string,
  firstParentId: string,
  secondParentId: string,
  kind: 'major' | 'tracer' | 'dust',
  ordinal: number,
): string {
  const seed = createDeterministicCollisionSeed({
    eventId,
    firstParentId,
    secondParentId,
    fragmentKind: kind,
    fragmentOrdinal: ordinal,
  });
  return `${kind}-${seed}`;
}

function classicBeforeState(event: CollisionKernelEventRequest): CollisionEventState {
  return {
    majorBodies: [event.input.firstBody, event.input.secondBody].sort((left, right) =>
      compareUtf8(left.id, right.id),
    ),
    tracers: [],
    dustCohorts: [],
  };
}

function dissipationForLoss(
  mechanicalLossJoules: number,
  channel: 'heat' | 'deformation' | 'fracture',
): CollisionDissipation {
  return {
    ...ZERO_DISSIPATION,
    [`${channel}Joules`]: mechanicalLossJoules,
  };
}

function finalizeClassicResolution(
  event: Extract<CollisionKernelEventRequest, { readonly domain: 'classic' }>,
  candidate: CollisionResolutionCandidate,
  after: CollisionEventState,
  ids: {
    readonly majorRemnantIds: readonly string[];
    readonly tracerIds: readonly string[];
    readonly dustCohortIds: readonly string[];
  },
  dissipationChannel: 'heat' | 'deformation' | 'fracture',
  approximations: readonly (
    | 'combinedMaterialBuckets'
    | 'participantLocalLedger'
    | 'passiveFragment'
    | 'remnantDensity'
    | 'separationKinematics'
  )[],
): CollisionKernelEventResolution {
  const before = classicBeforeState(event);
  const provisional = computeCollisionLedger({
    eventId: event.input.eventId,
    simulationTimeSeconds: event.input.simulationTimeSeconds,
    before,
    after,
    dissipation: ZERO_DISSIPATION,
    participantBodyIds: [event.input.firstBody.id, event.input.secondBody.id],
  });
  const mechanicalLossJoules =
    provisional.before.energy.totalJoules - provisional.after.energy.totalJoules;
  if (mechanicalLossJoules < 0 && !provisional.checks.energy.passed) {
    throw new KernelResolutionError(
      'collisionReconstructionFailed',
      event.input.eventId,
      '确定性重建需要负耗散才能闭合机械能',
    );
  }
  const dissipation = dissipationForLoss(Math.max(0, mechanicalLossJoules), dissipationChannel);
  const ledger = computeCollisionLedger({
    eventId: event.input.eventId,
    simulationTimeSeconds: event.input.simulationTimeSeconds,
    before,
    after,
    dissipation,
    participantBodyIds: [event.input.firstBody.id, event.input.secondBody.id],
  });
  if (!ledger.passed) {
    throw new KernelResolutionError(
      'collisionConservationFailed',
      event.input.eventId,
      '确定性重建未通过 event-total 守恒门禁',
    );
  }
  return {
    domain: 'classic',
    eventId: event.input.eventId,
    participantBodyIds: [candidate.contact.targetBodyId, candidate.contact.projectileBodyId],
    expectedMaterialProfile: event.expectedMaterialProfile,
    ledgerScope: 'participantLocalEventTotal',
    candidate,
    after,
    dissipation,
    ledger,
    majorRemnantIds: [...ids.majorRemnantIds],
    tracerIds: [...ids.tracerIds],
    dustCohortIds: [...ids.dustCohortIds],
    approximations: [...approximations],
  };
}

function reconstructMerge(
  event: Extract<CollisionKernelEventRequest, { readonly domain: 'classic' }>,
  candidate: CollisionResolutionCandidate,
): CollisionKernelEventResolution {
  const { firstBody, secondBody } = event.input;
  const frame = centerOfMass(firstBody, secondBody);
  const remnantId = fragmentId(event.input.eventId, firstBody.id, secondBody.id, 'major', 0);
  const remnant: CollisionBodySnapshot = {
    id: remnantId,
    massKg: frame.massKg,
    radiusMeters: combinedRadiusMeters(firstBody, secondBody),
    positionMeters: frame.positionMeters,
    velocityMetersPerSecond: frame.velocityMetersPerSecond,
    spinAngularMomentumKgMetersSquaredPerSecond: totalAngularMomentum(firstBody, secondBody, frame),
    momentOfInertiaFactor: effectiveMomentOfInertiaFactor(firstBody, secondBody, frame.massKg),
    materialLayers: combinedMaterialLayers(firstBody, secondBody, frame.massKg),
    collisionModel: event.expectedMaterialProfile,
  };
  return finalizeClassicResolution(
    event,
    candidate,
    { majorBodies: [remnant], tracers: [], dustCohorts: [] },
    { majorRemnantIds: [remnantId], tracerIds: [], dustCohortIds: [] },
    'heat',
    ['combinedMaterialBuckets', 'participantLocalLedger', 'remnantDensity'],
  );
}

function reconstructHitAndRun(
  event: Extract<CollisionKernelEventRequest, { readonly domain: 'classic' }>,
  candidate: CollisionResolutionCandidate,
): CollisionKernelEventResolution {
  const { firstBody, secondBody } = event.input;
  const frame = centerOfMass(firstBody, secondBody);
  const relativePosition = subtract(secondBody.positionMeters, firstBody.positionMeters);
  const normal = scale(relativePosition, 1 / magnitude(relativePosition));
  const incomingRelativeVelocity = subtract(
    secondBody.velocityMetersPerSecond,
    firstBody.velocityMetersPerSecond,
  );
  const radialSpeed = dot(incomingRelativeVelocity, normal);
  if (radialSpeed === 0 && candidate.resolutionKind !== 'nonInteractingTangent') {
    throw new KernelResolutionError(
      'collisionReconstructionFailed',
      event.input.eventId,
      '有交互质量的切向 hit-and-run 无法通过径向镜像生成分离状态',
    );
  }
  const outgoingRelativeVelocity = subtract(
    incomingRelativeVelocity,
    scale(normal, 2 * Math.min(0, radialSpeed)),
  );
  const firstAfter = {
    ...firstBody,
    velocityMetersPerSecond: subtract(
      frame.velocityMetersPerSecond,
      scale(outgoingRelativeVelocity, secondBody.massKg / frame.massKg),
    ),
  };
  const secondAfter = {
    ...secondBody,
    velocityMetersPerSecond: add(
      frame.velocityMetersPerSecond,
      scale(outgoingRelativeVelocity, firstBody.massKg / frame.massKg),
    ),
  };
  const majorBodies = [firstAfter, secondAfter].sort((left, right) =>
    compareUtf8(left.id, right.id),
  );
  return finalizeClassicResolution(
    event,
    candidate,
    { majorBodies, tracers: [], dustCohorts: [] },
    { majorRemnantIds: majorBodies.map((body) => body.id), tracerIds: [], dustCohortIds: [] },
    'deformation',
    ['participantLocalLedger', 'separationKinematics'],
  );
}

function reconstructDisruption(
  event: Extract<CollisionKernelEventRequest, { readonly domain: 'classic' }>,
  candidate: CollisionResolutionCandidate,
): CollisionKernelEventResolution {
  const { firstBody, secondBody } = event.input;
  const frame = centerOfMass(firstBody, secondBody);
  const majorMassKg = candidate.largestRemnantMassKg;
  if (majorMassKg === null || majorMassKg <= 0 || majorMassKg >= frame.massKg) {
    throw new KernelResolutionError(
      'collisionReconstructionFailed',
      event.input.eventId,
      '破坏结果需要一个正质量最大残体和一个正质量被动资产',
    );
  }
  const passiveMassKg = frame.massKg - majorMassKg;
  const combinedLayers = combinedMaterialLayers(firstBody, secondBody, frame.massKg);
  const stripping = stripOuterMaterial(frame.massKg, combinedLayers, passiveMassKg);
  const majorLayers = materialLayersFromAbsolute(stripping.retainedLayers, majorMassKg);
  const passiveLayers = materialLayersFromAbsolute(stripping.ejectedLayers, passiveMassKg);
  const majorId = fragmentId(event.input.eventId, firstBody.id, secondBody.id, 'major', 0);
  const passiveKind =
    candidate.classification === 'catastrophicDisruption' ||
    candidate.classification === 'superCatastrophicDisruption'
      ? 'dust'
      : 'tracer';
  const passiveId = fragmentId(event.input.eventId, firstBody.id, secondBody.id, passiveKind, 0);
  const relativePosition = subtract(secondBody.positionMeters, firstBody.positionMeters);
  const separationMeters = magnitude(relativePosition);
  const normal = scale(relativePosition, 1 / separationMeters);
  const reducedAfterKg = passiveMassKg / (1 + passiveMassKg / majorMassKg);
  const orbital = orbitalAngularMomentum(firstBody, secondBody, frame);
  const tangentialRelativeVelocity = scale(
    cross(orbital, normal),
    1 / (reducedAfterKg * separationMeters),
  );
  const majorRadiusMeters =
    combinedRadiusMeters(firstBody, secondBody) * Math.cbrt(majorMassKg / frame.massKg);
  const momentOfInertiaFactor = effectiveMomentOfInertiaFactor(firstBody, secondBody, frame.massKg);
  const majorPosition = subtract(
    frame.positionMeters,
    scale(normal, (passiveMassKg / frame.massKg) * separationMeters),
  );
  const passivePosition = add(
    frame.positionMeters,
    scale(normal, (majorMassKg / frame.massKg) * separationMeters),
  );

  const buildAfter = (radialSeparationSpeed: number): CollisionEventState => {
    const relativeVelocity = add(tangentialRelativeVelocity, scale(normal, radialSeparationSpeed));
    const majorVelocity = subtract(
      frame.velocityMetersPerSecond,
      scale(relativeVelocity, passiveMassKg / frame.massKg),
    );
    const passiveVelocity = add(
      frame.velocityMetersPerSecond,
      scale(relativeVelocity, majorMassKg / frame.massKg),
    );
    const major: CollisionBodySnapshot = {
      id: majorId,
      massKg: majorMassKg,
      radiusMeters: majorRadiusMeters,
      positionMeters: majorPosition,
      velocityMetersPerSecond: majorVelocity,
      spinAngularMomentumKgMetersSquaredPerSecond: totalSpin(firstBody, secondBody),
      momentOfInertiaFactor,
      materialLayers: majorLayers,
      collisionModel: event.expectedMaterialProfile,
    };
    const passive = {
      id: passiveId,
      massKg: passiveMassKg,
      positionMeters: passivePosition,
      velocityMetersPerSecond: passiveVelocity,
      materialLayers: passiveLayers,
      subgridMechanicalEnergyJoules: 0,
    };
    return passiveKind === 'tracer'
      ? { majorBodies: [major], tracers: [passive], dustCohorts: [] }
      : { majorBodies: [major], tracers: [], dustCohorts: [passive] };
  };

  const before = classicBeforeState(event);
  const baseAfter = buildAfter(0);
  const baseLedger = computeCollisionLedger({
    eventId: event.input.eventId,
    simulationTimeSeconds: event.input.simulationTimeSeconds,
    before,
    after: baseAfter,
    dissipation: ZERO_DISSIPATION,
    participantBodyIds: [firstBody.id, secondBody.id],
  });
  const energyAvailableJoules =
    baseLedger.before.energy.totalJoules - baseLedger.after.energy.totalJoules;
  if (!Number.isFinite(energyAvailableJoules) || energyAvailableJoules <= 0) {
    throw new KernelResolutionError(
      'collisionReconstructionFailed',
      event.input.eventId,
      '破坏结果没有足够机械能生成守恒的分离状态',
    );
  }
  const maximumRadialSpeed = Math.sqrt((2 * energyAvailableJoules) / reducedAfterKg);
  const incomingRadialSpeed = Math.abs(
    dot(subtract(secondBody.velocityMetersPerSecond, firstBody.velocityMetersPerSecond), normal),
  );
  const radialSeparationSpeed = Math.min(
    Math.max(incomingRadialSpeed, candidate.contact.mutualEscapeSpeedMetersPerSecond * 1e-12),
    maximumRadialSpeed * Math.sqrt(FRAGMENT_RADIAL_ENERGY_FRACTION),
  );
  if (!Number.isFinite(radialSeparationSpeed) || radialSeparationSpeed <= 0) {
    throw new KernelResolutionError(
      'collisionReconstructionFailed',
      event.input.eventId,
      '破坏结果无法生成正的径向分离速度',
    );
  }
  const after = buildAfter(radialSeparationSpeed);
  return finalizeClassicResolution(
    event,
    candidate,
    after,
    {
      majorRemnantIds: [majorId],
      tracerIds: passiveKind === 'tracer' ? [passiveId] : [],
      dustCohortIds: passiveKind === 'dust' ? [passiveId] : [],
    },
    candidate.classification === 'catastrophicDisruption' ||
      candidate.classification === 'superCatastrophicDisruption'
      ? 'fracture'
      : 'deformation',
    [
      'combinedMaterialBuckets',
      'participantLocalLedger',
      'passiveFragment',
      'remnantDensity',
      'separationKinematics',
    ],
  );
}

function resolveClassicEvent(
  event: Extract<CollisionKernelEventRequest, { readonly domain: 'classic' }>,
): CollisionKernelEventResolution {
  const { firstBody, secondBody } = event.input;
  for (const body of [firstBody, secondBody]) {
    if (body.collisionModel === 'stellar') {
      throw new KernelResolutionError(
        'unsupportedStellarCollision',
        event.input.eventId,
        '恒星碰撞超出工程确定性 v1 范围',
      );
    }
    if (body.collisionModel === 'blackHole') {
      throw new KernelResolutionError(
        'unsupportedCollisionDomain',
        event.input.eventId,
        '黑洞参与体必须使用 blackHoleAccretion domain',
      );
    }
    if (body.radiusMeters < MINIMUM_CLASSIC_RADIUS_METERS) {
      throw new KernelResolutionError(
        'unsupportedStrengthRegime',
        event.input.eventId,
        '半径小于 1 km 的强度主导天体超出工程确定性 v1 范围',
      );
    }
  }

  const contact = computeContactQuantities(firstBody, secondBody);
  let candidate: CollisionResolutionCandidate;
  if (contact.interactingProjectileFraction === 0) {
    candidate = createNonInteractingTangentCandidate(contact);
  } else {
    const disruption = computeDisruptionScaling(contact, event.expectedMaterialProfile);
    const evaluation = evaluateCollisionClassification(
      contact,
      disruption.normalizedImpactEnergy,
      null,
    );
    const gendaThreshold = evaluation.gendaRequired ? computeGendaMergingThreshold(contact) : null;
    candidate = createCollisionResolutionCandidate(contact, disruption, gendaThreshold);
  }
  candidate = parseCollisionResolutionCandidateForInput(
    candidate,
    event.input,
    event.expectedMaterialProfile,
  );

  switch (candidate.classification) {
    case 'merge':
    case 'grazeAndMerge':
      return reconstructMerge(event, candidate);
    case 'hitAndRun':
      return reconstructHitAndRun(event, candidate);
    case 'partialAccretion':
    case 'erosion':
    case 'catastrophicDisruption':
    case 'superCatastrophicDisruption':
      return reconstructDisruption(event, candidate);
  }
}

function conservationCheck(absoluteError: number, scaleValue: number, threshold: number) {
  const scaleValueWithFloor = Math.max(scaleValue, 1);
  const normalizedError = absoluteError / scaleValueWithFloor;
  return {
    absoluteError,
    scale: scaleValueWithFloor,
    normalizedError,
    threshold,
    passed: normalizedError <= threshold,
  };
}

function computeBlackHoleLedger(
  event: Extract<CollisionKernelEventRequest, { readonly domain: 'blackHoleAccretion' }>,
  remnant: CollisionBodySnapshot,
  frame: CenterOfMassFrame,
): BlackHoleAccretionLedger {
  const { firstBody, secondBody } = event.input;
  const beforeLinear = sumVectors([
    scale(firstBody.velocityMetersPerSecond, firstBody.massKg),
    scale(secondBody.velocityMetersPerSecond, secondBody.massKg),
  ]);
  const afterLinear = scale(remnant.velocityMetersPerSecond, remnant.massKg);
  const beforeAngular = totalAngularMomentum(firstBody, secondBody, frame);
  const afterAngular = remnant.spinAngularMomentumKgMetersSquaredPerSecond;
  const relativeKineticBefore = compensatedSum(
    [firstBody, secondBody].map(
      (body) =>
        0.5 *
        body.massKg *
        magnitude(subtract(body.velocityMetersPerSecond, frame.velocityMetersPerSecond)) ** 2,
    ),
  );
  const materialMasses = { gas: 0, ice: 0, silicate: 0, iron: 0 };
  for (const body of [firstBody, secondBody]) {
    if (body.collisionModel !== 'blackHole') {
      const masses = computeAbsoluteMaterialMasses(body.massKg, body.materialLayers);
      materialMasses.gas += masses.gas;
      materialMasses.ice += masses.ice;
      materialMasses.silicate += masses.silicate;
      materialMasses.iron += masses.iron;
    }
  }
  const massCheck = conservationCheck(
    Math.abs(remnant.massKg - frame.massKg),
    frame.massKg,
    COLLISION_CONSERVATION_LIMITS.mass,
  );
  const linearCheck = conservationCheck(
    magnitude(subtract(afterLinear, beforeLinear)),
    Math.max(
      firstBody.massKg * magnitude(firstBody.velocityMetersPerSecond) +
        secondBody.massKg * magnitude(secondBody.velocityMetersPerSecond),
      1,
    ),
    COLLISION_CONSERVATION_LIMITS.linearMomentum,
  );
  const angularCheck = conservationCheck(
    magnitude(subtract(afterAngular, beforeAngular)),
    Math.max(magnitude(beforeAngular), 1),
    COLLISION_CONSERVATION_LIMITS.angularMomentum,
  );
  const radiationJoules = relativeKineticBefore;
  const energyCheck = conservationCheck(
    Math.abs(relativeKineticBefore - radiationJoules),
    Math.max(relativeKineticBefore, 1),
    COLLISION_CONSERVATION_LIMITS.energy,
  );
  const passed =
    massCheck.passed && linearCheck.passed && angularCheck.passed && energyCheck.passed;
  return {
    ledgerVersion: BLACK_HOLE_ACCRETION_LEDGER_VERSION,
    modelVersion: COLLISION_MODEL_VERSION,
    reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
    eventId: event.input.eventId,
    simulationTimeSeconds: event.input.simulationTimeSeconds,
    referenceFrame: {
      originMeters: frame.positionMeters,
      velocityMetersPerSecond: frame.velocityMetersPerSecond,
    },
    energyScope: 'relativeKineticOnly',
    mass: { beforeKg: frame.massKg, afterKg: remnant.massKg, check: massCheck },
    linearMomentum: {
      beforeKgMetersPerSecond: beforeLinear,
      afterKgMetersPerSecond: afterLinear,
      check: linearCheck,
    },
    angularMomentum: {
      beforeKgMetersSquaredPerSecond: beforeAngular,
      afterKgMetersSquaredPerSecond: afterAngular,
      check: angularCheck,
    },
    relativeKineticEnergy: {
      beforeJoules: relativeKineticBefore,
      afterJoules: 0,
      radiationJoules,
      check: energyCheck,
    },
    accretedMaterialMassesKg: materialMasses,
    limits: COLLISION_CONSERVATION_LIMITS,
    passed,
  };
}

function resolveBlackHoleEvent(
  event: Extract<CollisionKernelEventRequest, { readonly domain: 'blackHoleAccretion' }>,
): CollisionKernelEventResolution {
  const { firstBody, secondBody } = event.input;
  if (firstBody.collisionModel === 'stellar' || secondBody.collisionModel === 'stellar') {
    throw new KernelResolutionError(
      'unsupportedStellarCollision',
      event.input.eventId,
      '恒星与黑洞碰撞超出工程确定性 v1 范围',
    );
  }
  if (firstBody.collisionModel !== 'blackHole' && secondBody.collisionModel !== 'blackHole') {
    throw new KernelResolutionError(
      'unsupportedCollisionDomain',
      event.input.eventId,
      'blackHoleAccretion domain 至少需要一个黑洞参与体',
    );
  }
  computeContactQuantities(firstBody, secondBody);
  const frame = centerOfMass(firstBody, secondBody);
  const remnantId = fragmentId(event.input.eventId, firstBody.id, secondBody.id, 'major', 0);
  const remnant: CollisionBodySnapshot = {
    id: remnantId,
    massKg: frame.massKg,
    radiusMeters:
      (2 * GRAVITATIONAL_CONSTANT_SI * frame.massKg) / SPEED_OF_LIGHT_METERS_PER_SECOND ** 2,
    positionMeters: frame.positionMeters,
    velocityMetersPerSecond: frame.velocityMetersPerSecond,
    spinAngularMomentumKgMetersSquaredPerSecond: totalAngularMomentum(firstBody, secondBody, frame),
    momentOfInertiaFactor: null,
    materialLayers: [],
    collisionModel: 'blackHole',
  };
  const ledger = computeBlackHoleLedger(event, remnant, frame);
  if (!ledger.passed) {
    throw new KernelResolutionError(
      'collisionConservationFailed',
      event.input.eventId,
      '黑洞吞噬未通过牛顿守恒账本',
    );
  }
  return {
    domain: 'blackHoleAccretion',
    eventId: event.input.eventId,
    participantBodyIds:
      compareUtf8(firstBody.id, secondBody.id) < 0
        ? [firstBody.id, secondBody.id]
        : [secondBody.id, firstBody.id],
    remnant,
    after: { majorBodies: [remnant], tracers: [], dustCohorts: [] },
    ledger,
    approximations: ['blackHoleAccretion'],
  };
}

function resolutionAssetIds(resolution: CollisionKernelEventResolution): readonly string[] {
  return resolution.domain === 'classic'
    ? [...resolution.majorRemnantIds, ...resolution.tracerIds, ...resolution.dustCohortIds]
    : [resolution.remnant.id];
}

function resolveParsedBatch(request: CollisionKernelBatchRequest): CollisionKernelResponse {
  let remainingMajorSlots = request.capacity.majorRemnantSlots;
  let remainingPassiveSlots = request.capacity.passiveAssetSlots;
  const resolutions: CollisionKernelEventResolution[] = [];
  const outputIds = new Set<string>();
  const participantOwner = new Map<string, string>();
  for (const event of request.events) {
    participantOwner.set(event.input.firstBody.id, event.input.eventId);
    participantOwner.set(event.input.secondBody.id, event.input.eventId);
  }
  const events = [...request.events].sort((left, right) =>
    compareUtf8(left.input.eventId, right.input.eventId),
  );
  for (const event of events) {
    let resolution: CollisionKernelEventResolution;
    try {
      resolution =
        event.domain === 'classic' ? resolveClassicEvent(event) : resolveBlackHoleEvent(event);
    } catch (error) {
      if (error instanceof KernelResolutionError) {
        throw error;
      }
      throw new KernelResolutionError(
        'collisionNumericalFailure',
        event.input.eventId,
        error instanceof Error ? error.message : '碰撞事件发生未知数值错误',
      );
    }
    const majorCount = resolution.after.majorBodies.length;
    const passiveCount = resolution.after.tracers.length + resolution.after.dustCohorts.length;
    if (majorCount > remainingMajorSlots || passiveCount > remainingPassiveSlots) {
      throw new KernelResolutionError(
        'collisionCapacityExceeded',
        event.input.eventId,
        '碰撞结果超出本批次剩余主要残体或被动资产容量',
      );
    }
    remainingMajorSlots -= majorCount;
    remainingPassiveSlots -= passiveCount;
    for (const id of resolutionAssetIds(resolution)) {
      const participantEventId = participantOwner.get(id);
      const preservesOwnParticipant =
        resolution.domain === 'classic' &&
        resolution.candidate.classification === 'hitAndRun' &&
        participantEventId === event.input.eventId;
      if (outputIds.has(id) || (participantEventId !== undefined && !preservesOwnParticipant)) {
        throw new KernelResolutionError(
          'duplicateOutputId',
          event.input.eventId,
          `输出资产 id 重复：${id}`,
        );
      }
      outputIds.add(id);
    }
    resolutions.push(resolution);
  }
  return collisionKernelResponseSchema.parse({
    abiVersion: COLLISION_KERNEL_ABI_VERSION,
    modelVersion: COLLISION_MODEL_VERSION,
    reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
    kind: 'success',
    events: resolutions,
  });
}

export function resolveCollisionKernelReference(input: unknown): CollisionKernelResponse {
  const parsed = collisionKernelBatchRequestSchema.safeParse(input);
  if (!parsed.success) {
    return errorResponse(
      'malformedInput',
      null,
      parsed.error.issues[0]?.message ?? '碰撞内核请求格式错误',
    );
  }
  try {
    return resolveParsedBatch(parsed.data);
  } catch (error) {
    if (error instanceof KernelResolutionError) {
      return errorResponse(error.code, error.eventId, error.message);
    }
    return errorResponse(
      'collisionNumericalFailure',
      null,
      error instanceof Error ? error.message : '碰撞内核参考实现发生未知数值错误',
    );
  }
}
