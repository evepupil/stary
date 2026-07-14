/// <reference types="node" />

import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { GRAVITATIONAL_CONSTANT_SI, JULIAN_DAY_SECONDS } from '../constants';
import type { BodyState, PhysicsDiagnostics, PositionMeters } from '../protocol/schemas';
import { createSolarSystemScenario } from '../scenarios/solar-system';
import { createReboundSimulation } from './rebound-simulation';

const JULIAN_YEAR_SECONDS = 365.25 * JULIAN_DAY_SECONDS;
const ORBIT_PARENTS = {
  mercury: 'sun',
  venus: 'sun',
  earth: 'sun',
  moon: 'earth',
  mars: 'sun',
  jupiter: 'sun',
  saturn: 'sun',
  uranus: 'sun',
  neptune: 'sun',
} as const;

let reboundWasmPath: string;

beforeAll(() => {
  reboundWasmPath = path.resolve('spikes', 'rebound-wasm', 'dist', 'rebound.wasm');
});

function magnitude(vector: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function relativeDrift(current: number, baseline: number): number {
  return Math.abs(current - baseline) / Math.abs(baseline);
}

function vectorDifference(left: PositionMeters, right: PositionMeters): PositionMeters {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function relativeVectorDrift(current: PositionMeters, baseline: PositionMeters): number {
  return magnitude(vectorDifference(current, baseline)) / magnitude(baseline);
}

function bodyById(bodies: readonly BodyState[], id: string): BodyState {
  const body = bodies.find((candidate) => candidate.id === id);
  if (body === undefined) {
    throw new Error(`缺少天体 ${id}`);
  }
  return body;
}

function separationMeters(left: BodyState, right: BodyState): number {
  return magnitude(vectorDifference(left.positionMeters, right.positionMeters));
}

function expectBoundOrbit(body: BodyState, parent: BodyState): void {
  const distanceMeters = separationMeters(body, parent);
  const relativeVelocity = vectorDifference(
    body.velocityMetersPerSecond,
    parent.velocityMetersPerSecond,
  );
  const specificOrbitalEnergy =
    magnitude(relativeVelocity) ** 2 / 2 -
    (GRAVITATIONAL_CONSTANT_SI * (body.massKg + parent.massKg)) / distanceMeters;
  expect(specificOrbitalEnergy, `${body.id} 应保持引力束缚`).toBeLessThan(0);
}

function expectFiniteDiagnostics(diagnostics: PhysicsDiagnostics): void {
  expect(Number.isFinite(diagnostics.totalEnergyJoules)).toBe(true);
  expect(Number.isFinite(magnitude(diagnostics.totalLinearMomentumKgMetersPerSecond))).toBe(true);
  expect(Number.isFinite(magnitude(diagnostics.totalAngularMomentumKgMetersSquaredPerSecond))).toBe(
    true,
  );
}

describe('JPL J2000 太阳系 REBOUND 集成', () => {
  it('10 体推进一儒略年后保持有限状态与守恒量', async () => {
    const scenario = createSolarSystemScenario();
    const simulation = await createReboundSimulation(scenario.bodies, {
      locateFile: () => reboundWasmPath,
    });

    try {
      const initial = simulation.snapshot();
      expect(initial.bodies).toHaveLength(10);
      expectFiniteDiagnostics(initial.diagnostics);

      simulation.integrateTo(JULIAN_DAY_SECONDS);
      expect(simulation.snapshot().bodies).toHaveLength(10);
      simulation.integrateTo(JULIAN_YEAR_SECONDS);
      const final = simulation.snapshot();
      expect(final.bodies).toHaveLength(10);
      expect(
        final.bodies.flatMap((body) => Object.values(body.positionMeters)).every(Number.isFinite),
      ).toBe(true);
      expectFiniteDiagnostics(final.diagnostics);

      for (const [bodyId, parentId] of Object.entries(ORBIT_PARENTS)) {
        const initialBody = bodyById(initial.bodies, bodyId);
        const initialParent = bodyById(initial.bodies, parentId);
        const finalBody = bodyById(final.bodies, bodyId);
        const finalParent = bodyById(final.bodies, parentId);
        const distanceRatio =
          separationMeters(finalBody, finalParent) / separationMeters(initialBody, initialParent);
        expect(distanceRatio, `${bodyId} 一年后的相对距离比例`).toBeGreaterThan(0.45);
        expect(distanceRatio, `${bodyId} 一年后的相对距离比例`).toBeLessThan(2.2);
        expectBoundOrbit(finalBody, finalParent);
      }

      expect(
        relativeDrift(final.diagnostics.totalEnergyJoules, initial.diagnostics.totalEnergyJoules),
      ).toBeLessThanOrEqual(1e-10);
      expect(
        relativeVectorDrift(
          final.diagnostics.totalAngularMomentumKgMetersSquaredPerSecond,
          initial.diagnostics.totalAngularMomentumKgMetersSquaredPerSecond,
        ),
      ).toBeLessThanOrEqual(1e-10);
    } finally {
      simulation.destroy();
    }
  });
});
