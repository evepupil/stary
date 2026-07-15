import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import {
  COLLISION_MATERIAL_PROFILES,
  GENDA_MERGING_COEFFICIENTS,
  GENDA_MODEL_SCOPE,
  LEINHARDT_STEWART_OBLIQUITY_SCOPE,
  REFERENCE_DENSITY_KG_PER_CUBIC_METER,
  SUPER_CATASTROPHIC_EXPONENT,
  SUPER_CATASTROPHIC_TRANSITION,
} from './model-sources';

export type CollisionFormulaClassification =
  | 'merge'
  | 'grazeAndMerge'
  | 'hitAndRun'
  | 'partialAccretion'
  | 'erosion'
  | 'catastrophicDisruption'
  | 'superCatastrophicDisruption';

export type CollisionFormulaMaterialProfile = keyof typeof COLLISION_MATERIAL_PROFILES;

export interface CollisionFormulaContact {
  readonly totalMassKg: number;
  readonly targetMassKg: number;
  readonly reducedMassKg: number;
  readonly interactingReducedMassKg: number;
  readonly interactingProjectileFraction: number;
  readonly massRatio: number;
  readonly impactParameter: number;
  readonly impactSpeedMetersPerSecond: number;
  readonly mutualEscapeSpeedMetersPerSecond: number;
  readonly specificImpactEnergyJoulesPerKg: number;
  readonly grazing: boolean;
}

export interface DisruptionFormulaResult {
  readonly equivalentCombinedRadiusMeters: number;
  readonly principalDisruptionThresholdJoulesPerKg: number;
  readonly massRatioScale: number;
  readonly headOnDisruptionThresholdJoulesPerKg: number;
  readonly obliquityScale: number;
  readonly obliquityModelExtrapolated: boolean;
  readonly disruptionThresholdJoulesPerKg: number;
  readonly criticalImpactSpeedMetersPerSecond: number;
  readonly normalizedImpactEnergy: number;
}

export function computeLargestRemnantMassFractionFormula(normalizedImpactEnergy: number): number {
  return Math.min(
    1,
    Math.max(
      0,
      normalizedImpactEnergy <= SUPER_CATASTROPHIC_TRANSITION
        ? 1 - 0.5 * normalizedImpactEnergy
        : (0.1 / SUPER_CATASTROPHIC_TRANSITION ** SUPER_CATASTROPHIC_EXPONENT) *
            normalizedImpactEnergy ** SUPER_CATASTROPHIC_EXPONENT,
    ),
  );
}

export function computeGendaCriticalVelocityRatioFormula(
  massRatio: number,
  impactParameter: number,
): number {
  const gammaTerm = (1 - massRatio) / (1 + massRatio);
  const angleTerm = (1 - impactParameter) ** GENDA_MERGING_COEFFICIENTS.c5;
  return (
    GENDA_MERGING_COEFFICIENTS.c1 * gammaTerm * angleTerm +
    GENDA_MERGING_COEFFICIENTS.c2 * gammaTerm +
    GENDA_MERGING_COEFFICIENTS.c3 * angleTerm +
    GENDA_MERGING_COEFFICIENTS.c4
  );
}

export function isGendaNumericExtrapolation(contact: CollisionFormulaContact): boolean {
  const impactSpeedEscapeRatio =
    contact.impactSpeedMetersPerSecond / contact.mutualEscapeSpeedMetersPerSecond;
  const totalMassEarthMasses = contact.totalMassKg / GENDA_MODEL_SCOPE.referenceEarthMassKg;
  return (
    contact.massRatio < GENDA_MODEL_SCOPE.minimumMassRatio ||
    contact.impactParameter > GENDA_MODEL_SCOPE.maximumImpactParameter ||
    impactSpeedEscapeRatio < GENDA_MODEL_SCOPE.impactSpeedEscapeRatios[0] ||
    impactSpeedEscapeRatio > GENDA_MODEL_SCOPE.impactSpeedEscapeRatios[1] ||
    totalMassEarthMasses < GENDA_MODEL_SCOPE.totalMassEarthMasses[0] ||
    totalMassEarthMasses > GENDA_MODEL_SCOPE.totalMassEarthMasses[1]
  );
}

export function computeDisruptionFormula(
  contact: CollisionFormulaContact,
  materialProfile: CollisionFormulaMaterialProfile,
): DisruptionFormulaResult {
  const profile = COLLISION_MATERIAL_PROFILES[materialProfile];
  const equivalentCombinedRadiusMeters = Math.cbrt(
    (contact.totalMassKg / REFERENCE_DENSITY_KG_PER_CUBIC_METER) * (3 / (4 * Math.PI)),
  );
  const principalDisruptionThresholdJoulesPerKg =
    profile.cStar *
    (4 / 5) *
    Math.PI *
    REFERENCE_DENSITY_KG_PER_CUBIC_METER *
    GRAVITATIONAL_CONSTANT_SI *
    equivalentCombinedRadiusMeters ** 2;
  const symmetricMassRatioTerm = (1 / 4) * ((contact.massRatio + 1) ** 2 / contact.massRatio);
  const massRatioScale = symmetricMassRatioTerm ** (2 / (3 * profile.muBar) - 1);
  const headOnDisruptionThresholdJoulesPerKg =
    principalDisruptionThresholdJoulesPerKg * massRatioScale;
  const obliquityScale =
    (contact.reducedMassKg / contact.interactingReducedMassKg) ** (2 - (3 * profile.muBar) / 2);
  const disruptionThresholdJoulesPerKg = headOnDisruptionThresholdJoulesPerKg * obliquityScale;
  const criticalImpactSpeedMetersPerSecond = Math.sqrt(
    2 * disruptionThresholdJoulesPerKg * (contact.totalMassKg / contact.reducedMassKg),
  );
  const normalizedImpactEnergy =
    contact.specificImpactEnergyJoulesPerKg / disruptionThresholdJoulesPerKg;

  return {
    equivalentCombinedRadiusMeters,
    principalDisruptionThresholdJoulesPerKg,
    massRatioScale,
    headOnDisruptionThresholdJoulesPerKg,
    obliquityScale,
    obliquityModelExtrapolated:
      contact.interactingProjectileFraction <=
      LEINHARDT_STEWART_OBLIQUITY_SCOPE.minimumInteractingProjectileFractionExclusive,
    disruptionThresholdJoulesPerKg,
    criticalImpactSpeedMetersPerSecond,
    normalizedImpactEnergy,
  };
}

export function evaluateCollisionClassification(
  contact: CollisionFormulaContact,
  normalizedImpactEnergy: number,
  gendaCriticalVelocityRatio: number | null,
): {
  readonly classification: CollisionFormulaClassification | null;
  readonly gendaRequired: boolean;
} {
  if (contact.impactSpeedMetersPerSecond <= contact.mutualEscapeSpeedMetersPerSecond) {
    return { classification: 'merge', gendaRequired: false };
  }
  if (normalizedImpactEnergy > SUPER_CATASTROPHIC_TRANSITION) {
    return { classification: 'superCatastrophicDisruption', gendaRequired: false };
  }
  if (normalizedImpactEnergy >= 1) {
    return { classification: 'catastrophicDisruption', gendaRequired: false };
  }

  const largestRemnantMassFraction =
    computeLargestRemnantMassFractionFormula(normalizedImpactEnergy);
  if (largestRemnantMassFraction <= contact.targetMassKg / contact.totalMassKg) {
    return { classification: 'erosion', gendaRequired: false };
  }
  if (!contact.grazing) {
    return { classification: 'partialAccretion', gendaRequired: false };
  }
  if (gendaCriticalVelocityRatio === null) {
    return { classification: null, gendaRequired: true };
  }
  return {
    classification:
      contact.impactSpeedMetersPerSecond <=
      gendaCriticalVelocityRatio * contact.mutualEscapeSpeedMetersPerSecond
        ? 'grazeAndMerge'
        : 'hitAndRun',
    gendaRequired: true,
  };
}
