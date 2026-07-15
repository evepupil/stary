import { computeContactQuantities } from './contact-quantities';
import type { DisruptionMaterialProfile } from './disruption-scaling';
import {
  collisionInputSchema,
  collisionResolutionCandidateSchema,
  type CollisionInput,
  type CollisionResolutionCandidate,
  type ContactQuantities,
} from './schemas';

const NUMERIC_CONTACT_FIELDS = [
  'targetMassKg',
  'projectileMassKg',
  'targetRadiusMeters',
  'projectileRadiusMeters',
  'totalMassKg',
  'reducedMassKg',
  'interactingReducedMassKg',
  'massRatio',
  'centerDistanceMeters',
  'radiusSumMeters',
  'impactSpeedMetersPerSecond',
  'mutualEscapeSpeedMetersPerSecond',
  'specificImpactEnergyJoulesPerKg',
  'impactAngleRadians',
  'impactParameter',
  'criticalImpactParameter',
  'interactingLengthMeters',
  'interactingProjectileFraction',
] as const satisfies readonly (keyof ContactQuantities)[];

function approximatelyEqual(actual: number, expected: number): boolean {
  return (
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) <=
      1e-10 * Math.max(Math.abs(actual), Math.abs(expected), Number.MIN_VALUE)
  );
}

function assertClassicCollisionInput(input: CollisionInput): void {
  for (const body of [input.firstBody, input.secondBody]) {
    if (body.collisionModel === 'blackHole' || body.collisionModel === 'stellar') {
      throw new RangeError('经典碰撞候选不能绑定黑洞或恒星参与体');
    }
  }
}

function bodyMatchesGendaCompositionAndSpin(body: CollisionInput['firstBody']): boolean {
  const [mantle, core] = body.materialLayers;
  return (
    body.materialLayers.length === 2 &&
    mantle?.material === 'silicate' &&
    Math.abs(mantle.massFraction - 0.7) <= 1e-12 &&
    core?.material === 'iron' &&
    Math.abs(core.massFraction - 0.3) <= 1e-12 &&
    body.spinAngularMomentumKgMetersSquaredPerSecond.x === 0 &&
    body.spinAngularMomentumKgMetersSquaredPerSecond.y === 0 &&
    body.spinAngularMomentumKgMetersSquaredPerSecond.z === 0
  );
}

function assertContactMatches(
  candidateContact: ContactQuantities,
  trustedContact: ContactQuantities,
): void {
  if (
    candidateContact.targetBodyId !== trustedContact.targetBodyId ||
    candidateContact.projectileBodyId !== trustedContact.projectileBodyId ||
    candidateContact.grazing !== trustedContact.grazing
  ) {
    throw new RangeError('碰撞候选的参与体或擦碰分类与原始输入不一致');
  }
  for (const field of NUMERIC_CONTACT_FIELDS) {
    if (!approximatelyEqual(candidateContact[field], trustedContact[field])) {
      throw new RangeError(`碰撞候选的 ${field} 与原始输入不一致`);
    }
  }
}

export function parseCollisionResolutionCandidateForInput(
  candidateInput: unknown,
  collisionInput: CollisionInput,
  expectedMaterialProfile: DisruptionMaterialProfile,
): CollisionResolutionCandidate {
  const parsedInput = collisionInputSchema.parse(collisionInput);
  assertClassicCollisionInput(parsedInput);
  const candidate = collisionResolutionCandidateSchema.parse(candidateInput);
  const trustedContact = computeContactQuantities(parsedInput.firstBody, parsedInput.secondBody);
  assertContactMatches(candidate.contact, trustedContact);

  if (
    candidate.disruption !== null &&
    candidate.disruption.materialProfile !== expectedMaterialProfile
  ) {
    throw new RangeError('碰撞候选的材料档与本地选择不一致');
  }
  if (
    candidate.gendaModelExtrapolated === false &&
    (!bodyMatchesGendaCompositionAndSpin(parsedInput.firstBody) ||
      !bodyMatchesGendaCompositionAndSpin(parsedInput.secondBody))
  ) {
    throw new RangeError('Genda 候选未标记成分或自转范围外推');
  }

  return collisionResolutionCandidateSchema.parse({
    ...candidate,
    contact: trustedContact,
  });
}
