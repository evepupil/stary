import { GRAVITATIONAL_CONSTANT_SI } from '../../../physics/constants';
import type { BodyState, CollisionEvent, PhysicsState } from '../../../physics/protocol/schemas';
import { getCelestialCatalogEntry } from '../catalog';
import { formatMass, formatSpeed } from '../simulation';
import type { CollisionLedgerDelta } from '../simulation/simulation-state';
import {
  COLLISION_CLASSIFICATION_DETAIL_LABELS,
  COLLISION_CLASSIFICATION_LABELS,
  type CollisionClassification,
} from './collision-labels';

export interface CollisionMeasurementViewModel {
  readonly label: string;
  readonly value: string;
}

export interface CollisionConservationCheckViewModel {
  readonly label: string;
  readonly normalizedErrorLabel: string;
  readonly thresholdLabel: string;
  readonly passed: boolean;
}

export interface CollisionRemnantViewModel {
  readonly id: string;
  readonly name: string;
  readonly massLabel: string;
  readonly isSurvivor: boolean;
}

export interface CollisionEventViewModel {
  readonly eventId: string;
  readonly classification: CollisionClassification;
  readonly classificationLabel: string;
  readonly classificationDetailLabel: string;
  readonly participantNames: readonly string[];
  readonly modelVersion: string;
  readonly modelExtrapolated: boolean;
  readonly contactMeasurements: readonly CollisionMeasurementViewModel[];
  readonly matterFate: readonly CollisionMeasurementViewModel[];
  readonly dissipation: readonly CollisionMeasurementViewModel[];
  readonly conservationChecks: readonly CollisionConservationCheckViewModel[];
  readonly ledgerPassed: boolean | null;
  readonly remnants: readonly CollisionRemnantViewModel[];
  readonly tracerCount: number;
  readonly dustCohortCount: number;
}

function isBlackHoleLedger(
  ledger: CollisionLedgerDelta,
): ledger is Extract<CollisionLedgerDelta, { energyScope: 'relativeKineticOnly' }> {
  return 'energyScope' in ledger;
}

function findParticipants(
  event: CollisionEvent,
  participants: readonly BodyState[],
): readonly [BodyState, BodyState] | null {
  const first = participants.find((body) => body.id === event.participantBodyIds[0]);
  const second = participants.find((body) => body.id === event.participantBodyIds[1]);
  if (first === undefined || second === undefined) {
    return null;
  }
  return [first, second];
}

/**
 * 协议事件只携带 Q_R,不携带接触速度;按 LS2012 的定义
 * `Q_R = 0.5 * (mu / M_total) * v^2` 用碰前参与体质量精确反推。
 */
export function deriveImpactSpeedMetersPerSecond(
  event: CollisionEvent,
  participants: readonly BodyState[],
): number | null {
  const pair = findParticipants(event, participants);
  if (pair === null) {
    return null;
  }
  const [first, second] = pair;
  const totalMassKg = first.massKg + second.massKg;
  const reducedMassKg = first.massKg / (1 + first.massKg / second.massKg);
  if (!Number.isFinite(totalMassKg) || !(reducedMassKg > 0)) {
    return null;
  }
  const impactSpeed = Math.sqrt(
    (2 * event.specificImpactEnergyJoulesPerKg * totalMassKg) / reducedMassKg,
  );
  return Number.isFinite(impactSpeed) ? impactSpeed : null;
}

export function deriveMutualEscapeSpeedMetersPerSecond(
  event: CollisionEvent,
  participants: readonly BodyState[],
): number | null {
  const pair = findParticipants(event, participants);
  if (pair === null) {
    return null;
  }
  const [first, second] = pair;
  const totalMassKg = first.massKg + second.massKg;
  const radiusSumMeters = first.radiusMeters + second.radiusMeters;
  if (!Number.isFinite(totalMassKg) || !(radiusSumMeters > 0)) {
    return null;
  }
  const escapeSpeed = Math.sqrt((2 * GRAVITATIONAL_CONSTANT_SI * totalMassKg) / radiusSumMeters);
  return Number.isFinite(escapeSpeed) ? escapeSpeed : null;
}

export function resolveBodyDisplayName(bodyId: string): string {
  return getCelestialCatalogEntry(bodyId)?.name ?? bodyId;
}

function formatJoules(value: number): string {
  return Number.isFinite(value) ? `${value.toExponential(3)} J` : '--';
}

function formatSpecificEnergy(value: number): string {
  return Number.isFinite(value) ? `${value.toExponential(3)} J/kg` : '--';
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(4) : '--';
}

function formatAngleDegrees(radians: number): string {
  return Number.isFinite(radians) ? `${((radians * 180) / Math.PI).toFixed(1)}°` : '--';
}

function formatNormalizedError(value: number): string {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return value === 0 ? '0' : value.toExponential(2);
}

const MATERIAL_LABELS = [
  ['gas', '气体'],
  ['ice', '冰'],
  ['silicate', '硅酸盐'],
  ['iron', '铁'],
] as const;

function buildContactMeasurements(
  event: CollisionEvent,
  participants: readonly BodyState[],
): CollisionMeasurementViewModel[] {
  const impactSpeed = deriveImpactSpeedMetersPerSecond(event, participants);
  const escapeSpeed = deriveMutualEscapeSpeedMetersPerSecond(event, participants);
  const measurements: CollisionMeasurementViewModel[] = [
    { label: '接触速度', value: impactSpeed === null ? '--' : formatSpeed(impactSpeed) },
    { label: '互逃逸速度', value: escapeSpeed === null ? '--' : formatSpeed(escapeSpeed) },
    { label: '接触角度', value: formatAngleDegrees(event.impactAngleRadians) },
    { label: '比冲击能 Q_R', value: formatSpecificEnergy(event.specificImpactEnergyJoulesPerKg) },
  ];
  if (event.disruptionThresholdJoulesPerKg !== null) {
    measurements.push({
      label: '破坏阈值 Q*',
      value: formatSpecificEnergy(event.disruptionThresholdJoulesPerKg),
    });
  }
  if (event.normalizedImpactEnergy !== null) {
    measurements.push({ label: 'Q_R/Q*', value: formatRatio(event.normalizedImpactEnergy) });
  }
  return measurements;
}

function buildMatterFate(ledger: CollisionLedgerDelta | null): CollisionMeasurementViewModel[] {
  if (ledger === null) {
    return [];
  }
  if (isBlackHoleLedger(ledger)) {
    const fate: CollisionMeasurementViewModel[] = [
      { label: '吞噬前总质量', value: formatMass(ledger.mass.beforeKg) },
      { label: '黑洞残体质量', value: formatMass(ledger.mass.afterKg) },
    ];
    for (const [material, label] of MATERIAL_LABELS) {
      const massKg = ledger.accretedMaterialMassesKg[material];
      if (massKg > 0) {
        fate.push({ label: `被吞${label}`, value: formatMass(massKg) });
      }
    }
    fate.push({
      label: '辐射能量',
      value: formatJoules(ledger.relativeKineticEnergy.radiationJoules),
    });
    return fate;
  }

  const fate: CollisionMeasurementViewModel[] = [
    { label: '碰前总质量', value: formatMass(ledger.before.reservoirMasses.totalKg) },
    { label: '碰后主要残体', value: formatMass(ledger.after.reservoirMasses.majorKg) },
  ];
  if (ledger.after.reservoirMasses.tracerKg > 0) {
    fate.push({ label: '碰后 tracer', value: formatMass(ledger.after.reservoirMasses.tracerKg) });
  }
  if (ledger.after.reservoirMasses.dustKg > 0) {
    fate.push({ label: '碰后尘埃', value: formatMass(ledger.after.reservoirMasses.dustKg) });
  }
  for (const [material, label] of MATERIAL_LABELS) {
    const massKg = ledger.after.materialMassesKg[material];
    if (massKg > 0) {
      fate.push({ label: `${label}总量`, value: formatMass(massKg) });
    }
  }
  return fate;
}

function buildDissipation(ledger: CollisionLedgerDelta | null): CollisionMeasurementViewModel[] {
  if (ledger === null) {
    return [];
  }
  if (isBlackHoleLedger(ledger)) {
    return [{ label: '辐射', value: formatJoules(ledger.relativeKineticEnergy.radiationJoules) }];
  }
  return [
    { label: '热', value: formatJoules(ledger.dissipation.heatJoules) },
    { label: '变形', value: formatJoules(ledger.dissipation.deformationJoules) },
    { label: '破碎', value: formatJoules(ledger.dissipation.fractureJoules) },
    { label: '辐射', value: formatJoules(ledger.dissipation.radiationJoules) },
  ];
}

function toCheckViewModel(
  label: string,
  check: {
    readonly normalizedError: number;
    readonly threshold: number;
    readonly passed: boolean;
  },
): CollisionConservationCheckViewModel {
  return {
    label,
    normalizedErrorLabel: formatNormalizedError(check.normalizedError),
    thresholdLabel: formatNormalizedError(check.threshold),
    passed: check.passed,
  };
}

function buildConservationChecks(
  ledger: CollisionLedgerDelta | null,
): CollisionConservationCheckViewModel[] {
  if (ledger === null) {
    return [];
  }
  if (isBlackHoleLedger(ledger)) {
    return [
      toCheckViewModel('质量', ledger.mass.check),
      toCheckViewModel('线动量', ledger.linearMomentum.check),
      toCheckViewModel('角动量', ledger.angularMomentum.check),
      toCheckViewModel('能量', ledger.relativeKineticEnergy.check),
    ];
  }
  const materialChecks = MATERIAL_LABELS.map(
    ([material]) => ledger.checks.materialMasses[material],
  );
  const worstMaterialCheck = materialChecks.reduce((worst, check) =>
    check.normalizedError > worst.normalizedError ? check : worst,
  );
  return [
    toCheckViewModel('质量', ledger.checks.mass),
    toCheckViewModel('材料质量', {
      normalizedError: worstMaterialCheck.normalizedError,
      threshold: worstMaterialCheck.threshold,
      passed: materialChecks.every((check) => check.passed),
    }),
    toCheckViewModel('线动量', ledger.checks.linearMomentum),
    toCheckViewModel('角动量', ledger.checks.angularMomentum),
    toCheckViewModel('能量', ledger.checks.energy),
  ];
}

function buildRemnants(
  event: CollisionEvent,
  state: PhysicsState | null,
): CollisionRemnantViewModel[] {
  const participantIds = new Set(event.participantBodyIds);
  return event.majorRemnantIds.map((remnantId) => {
    const body = state?.majorBodies.find((candidate) => candidate.id === remnantId) ?? null;
    return {
      id: remnantId,
      name: resolveBodyDisplayName(remnantId),
      massLabel: body === null ? '--' : formatMass(body.massKg),
      isSurvivor: participantIds.has(remnantId),
    };
  });
}

export interface CollisionEventViewModelInput {
  readonly event: CollisionEvent;
  readonly ledger: CollisionLedgerDelta | null;
  readonly participants: readonly BodyState[];
  readonly state: PhysicsState | null;
}

export function createCollisionEventViewModel(
  input: CollisionEventViewModelInput,
): CollisionEventViewModel {
  const { event, ledger, participants, state } = input;
  return {
    eventId: event.eventId,
    classification: event.classification,
    classificationLabel: COLLISION_CLASSIFICATION_LABELS[event.classification],
    classificationDetailLabel: COLLISION_CLASSIFICATION_DETAIL_LABELS[event.classification],
    participantNames: event.participantBodyIds.map(resolveBodyDisplayName),
    modelVersion: event.modelVersion,
    modelExtrapolated: event.modelExtrapolated,
    contactMeasurements: buildContactMeasurements(event, participants),
    matterFate: buildMatterFate(ledger),
    dissipation: buildDissipation(ledger),
    conservationChecks: buildConservationChecks(ledger),
    ledgerPassed: ledger?.passed ?? null,
    remnants: buildRemnants(event, state),
    tracerCount: event.tracerIds.length,
    dustCohortCount: event.dustCohortIds.length,
  };
}

export function findLedgerForEvent(
  event: CollisionEvent,
  ledgerDelta: readonly CollisionLedgerDelta[],
): CollisionLedgerDelta | null {
  return ledgerDelta.find((ledger) => ledger.eventId === event.eventId) ?? null;
}
