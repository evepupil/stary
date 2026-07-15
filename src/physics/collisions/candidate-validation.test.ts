import { describe, expect, it } from 'vitest';

import { parseCollisionResolutionCandidateForInput } from './candidate-validation';
import { computeGendaMergingThreshold, createCollisionResolutionCandidate } from './classification';
import { computeContactQuantities } from './contact-quantities';
import { computeDisruptionScaling } from './disruption-scaling';
import type { CollisionInput } from './schemas';
import { contactBodies } from './test-helpers';

function createBoundFixture() {
  const initialBodies = contactBodies({
    targetMassKg: 4e21,
    projectileMassKg: 2e21,
    targetRadiusMeters: 700_000,
    projectileRadiusMeters: 500_000,
    impactSpeedMetersPerSecond: 1,
  });
  const initialContact = computeContactQuantities(...initialBodies);
  const initialScaling = computeDisruptionScaling(initialContact, 'gravitySolid');
  const bodies = contactBodies({
    targetMassKg: 4e21,
    projectileMassKg: 2e21,
    targetRadiusMeters: 700_000,
    projectileRadiusMeters: 500_000,
    impactSpeedMetersPerSecond: Math.sqrt(0.2) * initialScaling.criticalImpactSpeedMetersPerSecond,
  });
  const contact = computeContactQuantities(...bodies);
  const candidate = createCollisionResolutionCandidate(
    contact,
    computeDisruptionScaling(contact, 'gravitySolid'),
    null,
  );
  const input: CollisionInput = {
    eventId: 'event-bind-candidate',
    simulationTimeSeconds: 42,
    firstBody: bodies[0],
    secondBody: bodies[1],
  };
  return { bodies, candidate, input };
}

describe('候选与可信输入绑定', () => {
  it('用本地接触量和材料档接受合法候选', () => {
    const { candidate, input } = createBoundFixture();
    expect(parseCollisionResolutionCandidateForInput(candidate, input, 'gravitySolid')).toEqual(
      candidate,
    );
  });

  it('拒绝自洽但属于其他天体或其他材料档的候选', () => {
    const { bodies, candidate, input } = createBoundFixture();
    const foreignBodies = contactBodies({
      targetMassKg: 5e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: candidate.contact.impactSpeedMetersPerSecond,
    });
    const foreignContact = computeContactQuantities(...foreignBodies);
    const foreignCandidate = createCollisionResolutionCandidate(
      foreignContact,
      computeDisruptionScaling(foreignContact, 'gravitySolid'),
      null,
    );

    expect(() =>
      parseCollisionResolutionCandidateForInput(foreignCandidate, input, 'gravitySolid'),
    ).toThrow('原始输入不一致');
    expect(() =>
      parseCollisionResolutionCandidateForInput(candidate, input, 'gravityFluid'),
    ).toThrow('材料档');
    expect(() =>
      parseCollisionResolutionCandidateForInput(
        candidate,
        {
          ...input,
          secondBody: { ...bodies[1], massKg: bodies[1].massKg * 1.01 },
        },
        'gravitySolid',
      ),
    ).toThrow('原始输入不一致');
  });

  it('拒绝把经典碰撞候选绑定到恒星或黑洞', () => {
    const { candidate, input } = createBoundFixture();
    expect(() =>
      parseCollisionResolutionCandidateForInput(
        candidate,
        {
          ...input,
          firstBody: { ...input.firstBody, collisionModel: 'stellar' },
        },
        'gravitySolid',
      ),
    ).toThrow('黑洞或恒星');
  });

  it('由原始材料层和自转补齐 Genda 模型范围', () => {
    const initialBodies = contactBodies({
      targetMassKg: 4e24,
      projectileMassKg: 2e24,
      targetRadiusMeters: 7e6,
      projectileRadiusMeters: 5e6,
      impactSpeedMetersPerSecond: 1,
      impactAngleRadians: Math.asin(0.8),
    });
    const initialContact = computeContactQuantities(...initialBodies);
    const bodies = contactBodies({
      targetMassKg: 4e24,
      projectileMassKg: 2e24,
      targetRadiusMeters: 7e6,
      projectileRadiusMeters: 5e6,
      impactSpeedMetersPerSecond: 1.05 * initialContact.mutualEscapeSpeedMetersPerSecond,
      impactAngleRadians: Math.asin(0.8),
    });
    const contact = computeContactQuantities(...bodies);
    const disruption = computeDisruptionScaling(contact, 'gravitySolid');
    const threshold = computeGendaMergingThreshold(contact);
    const candidate = createCollisionResolutionCandidate(contact, disruption, threshold);
    const input: CollisionInput = {
      eventId: 'event-genda-scope',
      simulationTimeSeconds: 0,
      firstBody: bodies[0],
      secondBody: bodies[1],
    };
    expect(threshold.modelExtrapolated).toBe(false);
    expect(parseCollisionResolutionCandidateForInput(candidate, input, 'gravitySolid')).toEqual(
      candidate,
    );

    const compositionOutsideScope: CollisionInput = {
      ...input,
      firstBody: {
        ...input.firstBody,
        materialLayers: [{ material: 'silicate', massFraction: 1 }],
      },
    };
    expect(() =>
      parseCollisionResolutionCandidateForInput(candidate, compositionOutsideScope, 'gravitySolid'),
    ).toThrow('成分或自转');

    const forcedCandidate = createCollisionResolutionCandidate(
      contact,
      disruption,
      computeGendaMergingThreshold(contact, true),
    );
    expect(
      parseCollisionResolutionCandidateForInput(
        forcedCandidate,
        compositionOutsideScope,
        'gravitySolid',
      ).gendaModelExtrapolated,
    ).toBe(true);
  });
});
