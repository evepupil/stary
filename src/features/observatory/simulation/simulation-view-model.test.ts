import { describe, expect, it } from 'vitest';

import type { PhysicsDiagnostics } from '../../../physics/protocol/schemas';
import {
  calculateRelativeScalarDrift,
  calculateRelativeSpeedMetersPerSecond,
  calculateRelativeVectorDrift,
  createBodyViewModel,
  createDiagnosticsViewModel,
  formatDistance,
  formatMass,
  formatRelativeDrift,
  formatSimulationTime,
  formatSpeed,
} from './simulation-view-model';

describe('simulation view model formatters', () => {
  it('按秒、天和年组织模拟时间', () => {
    expect(formatSimulationTime(0)).toBe('00:00:00');
    expect(formatSimulationTime(90_061)).toBe('1天 01:01:01');
    expect(formatSimulationTime(31_557_600 + 86_400 + 3_600)).toBe('1年 1天 01:00:00');
    expect(formatSimulationTime(Number.NaN)).toBe('--');
  });

  it('根据数量级切换 SI、千米和天文单位', () => {
    expect(formatDistance(500)).toBe('500 m');
    expect(formatDistance(6_371_000)).toBe('6,371 km');
    expect(formatDistance(149_597_870_700)).toBe('1.000 AU');
    expect(formatSpeed(29_780)).toBe('29.78 km/s');
    expect(formatMass(5.9722e24)).toBe('5.972e+24 kg');
  });

  it('组合天体的位置、速度和质量读数', () => {
    const viewModel = createBodyViewModel({
      id: 'earth',
      massKg: 5.9722e24,
      radiusMeters: 6_371_000,
      positionMeters: { x: 149_597_870_700, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 0, y: 29_780, z: 0 },
    });

    expect(viewModel).toMatchObject({
      id: 'earth',
      distanceLabel: '1.000 AU',
      massLabel: '5.972e+24 kg',
      speedLabel: '29.78 km/s',
    });
  });

  it('按轨道父级计算相对速度', () => {
    const earth = {
      id: 'earth',
      massKg: 5.9722e24,
      radiusMeters: 6_371_000,
      positionMeters: { x: 0, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -29_780, y: 0, z: 0 },
    };
    const moon = {
      id: 'moon',
      massKg: 7.34e22,
      radiusMeters: 1_737_530,
      positionMeters: { x: 384_400_000, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -29_780, y: 1_022, z: 0 },
    };

    expect(calculateRelativeSpeedMetersPerSecond(moon, earth)).toBe(1_022);
    expect(calculateRelativeSpeedMetersPerSecond(moon, null)).toBeCloseTo(29_797.5, 1);
  });
});

describe('conservation diagnostics', () => {
  const baseline: PhysicsDiagnostics = {
    totalEnergyJoules: -100,
    totalLinearMomentumKgMetersPerSecond: { x: 3, y: 4, z: 0 },
    totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 10 },
  };

  it('计算标量和向量相对漂移', () => {
    expect(calculateRelativeScalarDrift(-100.1, -100)).toBeCloseTo(0.001);
    expect(
      calculateRelativeVectorDrift({ x: 3.03, y: 4.04, z: 0 }, { x: 3, y: 4, z: 0 }),
    ).toBeCloseTo(0.01);
    expect(calculateRelativeScalarDrift(0, 0)).toBe(0);
    expect(calculateRelativeScalarDrift(1, 0)).toBeNull();
    expect(formatRelativeDrift(1e-10)).toBe('1.00e-10');
    expect(formatRelativeDrift(null)).toBe('无可用基线');
  });

  it('生成三项守恒量的数值和漂移视图', () => {
    const diagnostics: PhysicsDiagnostics = {
      totalEnergyJoules: -100.1,
      totalLinearMomentumKgMetersPerSecond: { x: 3.03, y: 4.04, z: 0 },
      totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 10.001 },
    };

    const viewModel = createDiagnosticsViewModel(diagnostics, baseline);

    expect(viewModel.totalEnergy.valueLabel).toBe('-1.001e+2 J');
    expect(viewModel.totalEnergy.drift).toBeCloseTo(0.001);
    expect(viewModel.totalLinearMomentum.drift).toBeCloseTo(0.05);
    expect(viewModel.totalLinearMomentum).toMatchObject({
      driftKind: 'absolute',
      driftLabel: '5.000e-2 kg m/s',
    });
    expect(viewModel.totalAngularMomentum.drift).toBeCloseTo(0.0001);
  });
});
