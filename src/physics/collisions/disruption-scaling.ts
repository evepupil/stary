import { computeDisruptionFormula } from './collision-formulas';
import { COLLISION_MATERIAL_PROFILES, REFERENCE_DENSITY_KG_PER_CUBIC_METER } from './model-sources';
import {
  contactQuantitiesSchema,
  disruptionScalingSchema,
  type ContactQuantities,
  type DisruptionScaling,
} from './schemas';
import { finiteNumber } from './vector';

export type DisruptionMaterialProfile = keyof typeof COLLISION_MATERIAL_PROFILES;

export function computeEquivalentCombinedRadiusMeters(totalMassKg: number): number {
  if (!Number.isFinite(totalMassKg) || totalMassKg <= 0) {
    throw new RangeError('总质量必须是正有限数');
  }
  return finiteNumber(
    Math.cbrt((totalMassKg / REFERENCE_DENSITY_KG_PER_CUBIC_METER) * (3 / (4 * Math.PI))),
  );
}

export function computeDisruptionScaling(
  contactInput: ContactQuantities,
  materialProfile: DisruptionMaterialProfile,
): DisruptionScaling {
  const contact = contactQuantitiesSchema.parse(contactInput);
  if (contact.interactingReducedMassKg <= 0) {
    throw new RangeError('零交互质量的正切接触不能进入破坏标度');
  }
  const result = computeDisruptionFormula(contact, materialProfile);

  return disruptionScalingSchema.parse({
    materialProfile,
    equivalentCombinedRadiusMeters: finiteNumber(result.equivalentCombinedRadiusMeters),
    principalDisruptionThresholdJoulesPerKg: finiteNumber(
      result.principalDisruptionThresholdJoulesPerKg,
    ),
    massRatioScale: finiteNumber(result.massRatioScale),
    headOnDisruptionThresholdJoulesPerKg: finiteNumber(result.headOnDisruptionThresholdJoulesPerKg),
    obliquityScale: finiteNumber(result.obliquityScale),
    obliquityModelExtrapolated: result.obliquityModelExtrapolated,
    disruptionThresholdJoulesPerKg: finiteNumber(result.disruptionThresholdJoulesPerKg),
    criticalImpactSpeedMetersPerSecond: finiteNumber(result.criticalImpactSpeedMetersPerSecond),
    normalizedImpactEnergy: finiteNumber(result.normalizedImpactEnergy),
  });
}
