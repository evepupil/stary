import {
  computeGendaCriticalVelocityRatioFormula,
  computeLargestRemnantMassFractionFormula,
  evaluateCollisionClassification,
  isGendaNumericExtrapolation,
} from './collision-formulas';
import { COLLISION_MODEL_VERSION } from './model-sources';
import {
  contactQuantitiesSchema,
  collisionResolutionCandidateSchema,
  disruptionScalingSchema,
  type CollisionClassification,
  type CollisionResolutionCandidate,
  type ContactQuantities,
  type DisruptionScaling,
} from './schemas';
import { finiteNumber } from './vector';

export interface GendaMergingThreshold {
  readonly criticalVelocityRatio: number;
  readonly modelExtrapolated: boolean;
}

export function computeLargestRemnantMassFraction(normalizedImpactEnergy: number): number {
  if (!Number.isFinite(normalizedImpactEnergy) || normalizedImpactEnergy < 0) {
    throw new RangeError('归一化撞击能必须是非负有限数');
  }
  return finiteNumber(computeLargestRemnantMassFractionFormula(normalizedImpactEnergy));
}

export function computeGendaCriticalVelocityRatio(
  massRatio: number,
  impactParameter: number,
): number {
  if (!Number.isFinite(massRatio) || massRatio <= 0 || massRatio > 1) {
    throw new RangeError('Genda 质量比必须位于 (0, 1]');
  }
  if (!Number.isFinite(impactParameter) || impactParameter < 0 || impactParameter > 1) {
    throw new RangeError('Genda 撞击参数必须位于 [0, 1]');
  }
  return finiteNumber(computeGendaCriticalVelocityRatioFormula(massRatio, impactParameter));
}

export function computeGendaMergingThreshold(
  contactInput: ContactQuantities,
  forceExtrapolated = false,
): GendaMergingThreshold {
  const contact = contactQuantitiesSchema.parse(contactInput);
  const criticalVelocityRatio = computeGendaCriticalVelocityRatio(
    contact.massRatio,
    contact.impactParameter,
  );
  return {
    criticalVelocityRatio,
    modelExtrapolated: forceExtrapolated || isGendaNumericExtrapolation(contact),
  };
}

function classifyByMass(
  contact: ContactQuantities,
  normalizedImpactEnergy: number,
  gendaThreshold: GendaMergingThreshold | null,
): CollisionClassification {
  const evaluation = evaluateCollisionClassification(
    contact,
    normalizedImpactEnergy,
    gendaThreshold?.criticalVelocityRatio ?? null,
  );
  if (evaluation.classification === null) {
    throw new RangeError('擦碰分类必须提供 Genda 临界速度');
  }
  return evaluation.classification;
}

export function classifyCollisionOutcome(
  contactInput: ContactQuantities,
  normalizedImpactEnergy: number,
  gendaThreshold: GendaMergingThreshold | null,
): CollisionClassification {
  const contact = contactQuantitiesSchema.parse(contactInput);
  computeLargestRemnantMassFraction(normalizedImpactEnergy);
  return classifyByMass(contact, normalizedImpactEnergy, gendaThreshold);
}

export function createCollisionResolutionCandidate(
  contactInput: ContactQuantities,
  disruptionInput: DisruptionScaling,
  gendaThreshold: GendaMergingThreshold | null,
): CollisionResolutionCandidate {
  const contact = contactQuantitiesSchema.parse(contactInput);
  const disruption = disruptionScalingSchema.parse(disruptionInput);
  if (contact.interactingProjectileFraction === 0) {
    throw new RangeError('无相互作用正切必须使用正切 no-op 候选');
  }
  if (
    gendaThreshold !== null &&
    (!Number.isFinite(gendaThreshold.criticalVelocityRatio) ||
      gendaThreshold.criticalVelocityRatio <= 0)
  ) {
    throw new RangeError('Genda 临界速度比必须是正有限数或 null');
  }
  const largestRemnantMassFraction = computeLargestRemnantMassFraction(
    disruption.normalizedImpactEnergy,
  );
  const classification = classifyByMass(contact, disruption.normalizedImpactEnergy, gendaThreshold);
  const reportedLargestRemnantMassFraction =
    classification === 'merge' || classification === 'grazeAndMerge'
      ? 1
      : classification === 'hitAndRun'
        ? null
        : largestRemnantMassFraction;
  const largestRemnantMassKg =
    reportedLargestRemnantMassFraction === null
      ? null
      : finiteNumber(reportedLargestRemnantMassFraction * contact.totalMassKg);

  return collisionResolutionCandidateSchema.parse({
    modelVersion: COLLISION_MODEL_VERSION,
    resolutionKind: 'modeledCollision',
    classification,
    contact,
    disruption,
    largestRemnantMassFraction: reportedLargestRemnantMassFraction,
    largestRemnantMassKg,
    gendaCriticalVelocityRatio: gendaThreshold?.criticalVelocityRatio ?? null,
    gendaModelExtrapolated: gendaThreshold?.modelExtrapolated ?? null,
  });
}

export function createNonInteractingTangentCandidate(
  contactInput: ContactQuantities,
): CollisionResolutionCandidate {
  const contact = contactQuantitiesSchema.parse(contactInput);
  if (
    contact.interactingProjectileFraction !== 0 ||
    Math.abs(contact.impactParameter - 1) > 1e-12
  ) {
    throw new RangeError('只有零交互质量的精确正切才能创建 no-op 候选');
  }
  return collisionResolutionCandidateSchema.parse({
    modelVersion: COLLISION_MODEL_VERSION,
    resolutionKind: 'nonInteractingTangent',
    classification: 'hitAndRun',
    contact,
    disruption: null,
    largestRemnantMassFraction: contact.targetMassKg / contact.totalMassKg,
    largestRemnantMassKg: contact.targetMassKg,
    gendaCriticalVelocityRatio: null,
    gendaModelExtrapolated: null,
  });
}
