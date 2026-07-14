import { describe, expect, it } from 'vitest';

import type { BodyState } from '../protocol/schemas';
import type { ReboundSimulation, ReboundSnapshot } from '../rebound/rebound-simulation';
import { centerBodiesOnCenterOfMass } from '../scenarios/center-of-mass';
import {
  computeCollisionSubdivisionCount,
  generateTrajectoryPreview,
} from './generate-trajectory-preview';
import { ORBIT_PREVIEW_PROTOCOL_VERSION, type TrajectoryPreviewRequest } from './schemas';

const diagnostics = {
  totalEnergyJoules: 0,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
} as const;

class LinearSimulation implements ReboundSimulation {
  destroyCount = 0;
  failSnapshot = false;
  timeSeconds = 0;
  readonly #bodies: BodyState[];

  constructor(bodies: readonly BodyState[]) {
    this.#bodies = centerBodiesOnCenterOfMass(bodies);
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  integrateTo(targetTimeSeconds: number): void {
    const elapsedSeconds = targetTimeSeconds - this.timeSeconds;
    for (const body of this.#bodies) {
      body.positionMeters.x += body.velocityMetersPerSecond.x * elapsedSeconds;
      body.positionMeters.y += body.velocityMetersPerSecond.y * elapsedSeconds;
      body.positionMeters.z += body.velocityMetersPerSecond.z * elapsedSeconds;
    }
    this.timeSeconds = targetTimeSeconds;
  }

  snapshot(): ReboundSnapshot {
    if (this.failSnapshot) {
      throw new Error('fake snapshot failure');
    }
    return { bodies: structuredClone(this.#bodies), diagnostics };
  }
}

class CurvedSimulation implements ReboundSimulation {
  destroyed = false;
  timeSeconds = 0;

  constructor(
    private readonly bodies: readonly BodyState[],
    private readonly draftPositionAt: (timeSeconds: number) => BodyState['positionMeters'],
  ) {}

  destroy(): void {
    this.destroyed = true;
  }

  integrateTo(targetTimeSeconds: number): void {
    this.timeSeconds = targetTimeSeconds;
  }

  snapshot(): ReboundSnapshot {
    return {
      bodies: this.bodies.map((source) => ({
        ...structuredClone(source),
        positionMeters:
          source.id === 'draft'
            ? this.draftPositionAt(this.timeSeconds)
            : { ...source.positionMeters },
      })),
      diagnostics,
    };
  }
}

function body(id: string, x: number, velocityX = 0, radiusMeters = 0): BodyState {
  return {
    id,
    massKg: id === 'reference' ? 1e20 : 1,
    radiusMeters,
    positionMeters: { x, y: 0, z: 0 },
    velocityMetersPerSecond: { x: velocityX, y: 0, z: 0 },
  };
}

function request(bodies: readonly BodyState[], overrides: Partial<TrajectoryPreviewRequest> = {}) {
  return {
    version: ORBIT_PREVIEW_PROTOCOL_VERSION,
    type: 'trajectoryPreviewRequest',
    requestId: 'request-1',
    draftRevision: 2,
    bodies: [...bodies],
    draftBodyIds: ['draft'],
    referenceBodyId: 'reference',
    durationSeconds: 4,
    sampleCount: 3,
    ...overrides,
  } satisfies TrajectoryPreviewRequest;
}

describe('generateTrajectoryPreview', () => {
  it('随天体数量收紧额外碰撞积分预算', () => {
    expect(computeCollisionSubdivisionCount(256, 16)).toBe(16);
    expect(computeCollisionSubdivisionCount(256, 512)).toBe(1);
  });

  it('按包含首尾的固定时刻输出草稿轨迹并释放 simulation', async () => {
    const simulation = new LinearSimulation([body('reference', 0), body('draft', 10, 0, 1)]);
    const result = await generateTrajectoryPreview(
      request([body('reference', 0), body('draft', 10, 0, 1)]),
      () => Promise.resolve(simulation),
    );

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.points.map((point) => point.timeSeconds)).toEqual([0, 2, 4]);
    expect(result.risk.kind).toBe('stable');
    expect(result.closestApproachMeters).toBe(10);
    expect(simulation.destroyCount).toBe(1);
  });

  it('把质心初始位置与匀速平移补回输出轨迹', async () => {
    const bodies = [body('reference', 0, 100), body('draft', 10, 100, 1)];
    const result = await generateTrajectoryPreview(
      request(bodies, { durationSeconds: 2, sampleCount: 2 }),
      () => Promise.resolve(new LinearSimulation(bodies)),
    );

    expect(result.tracks[0]?.points.map((point) => point.positionMeters.x)).toEqual([10, 210]);
  });

  it('检测初始重叠', async () => {
    const bodies = [body('reference', 100), body('obstacle', 0, 0, 2), body('draft', 1, 0, 2)];
    const result = await generateTrajectoryPreview(request(bodies), () =>
      Promise.resolve(new LinearSimulation(bodies)),
    );

    expect(result.risk).toMatchObject({
      kind: 'collision',
      bodyId: 'draft',
      otherBodyId: 'obstacle',
      timeSeconds: 0,
    });
    expect(result.closestApproachMeters).toBe(1);
  });

  it('检测相邻采样点之间穿过的碰撞', async () => {
    const bodies = [body('reference', 1_000), body('obstacle', 0, 0, 1), body('draft', -10, 20, 1)];
    const result = await generateTrajectoryPreview(
      request(bodies, { durationSeconds: 1, sampleCount: 2 }),
      () => Promise.resolve(new LinearSimulation(bodies)),
    );

    expect(result.risk).toMatchObject({
      kind: 'collision',
      bodyId: 'draft',
      otherBodyId: 'obstacle',
    });
    expect(result.risk.timeSeconds).toBeCloseTo(0.4, 12);
    expect(result.closestApproachMeters).toBeCloseTo(0, 12);
  });

  it('风险细分能发现展示轨迹端点之间的高曲率碰撞', async () => {
    const bodies = [
      body('reference', 1_000),
      body('obstacle', 0, 0, 0.1),
      body('draft', 2, 0, 0.1),
    ];
    const simulation = new CurvedSimulation(bodies, (timeSeconds) => ({
      x: 1 + Math.cos(2 * Math.PI * timeSeconds),
      y: Math.sin(2 * Math.PI * timeSeconds),
      z: 0,
    }));

    const result = await generateTrajectoryPreview(
      request(bodies, { durationSeconds: 1, sampleCount: 2 }),
      () => Promise.resolve(simulation),
    );

    expect(result.tracks[0]?.points).toHaveLength(2);
    expect(result.risk).toMatchObject({
      kind: 'collision',
      bodyId: 'draft',
      otherBodyId: 'obstacle',
    });
    expect(result.risk.timeSeconds).toBeGreaterThan(0.45);
    expect(result.risk.timeSeconds).toBeLessThan(0.5);
    expect(result.closestApproachMeters).toBeCloseTo(0, 12);
  });

  it('风险细分不会把绕开天体的高曲率轨迹按整段弦线误报', async () => {
    const bodies = [
      body('reference', 1_000),
      body('obstacle', 0, 0, 0.1),
      body('draft', -1, 0, 0.1),
    ];
    const simulation = new CurvedSimulation(bodies, (timeSeconds) => ({
      x: -Math.cos(Math.PI * timeSeconds),
      y: Math.sin(Math.PI * timeSeconds),
      z: 0,
    }));

    const result = await generateTrajectoryPreview(
      request(bodies, { durationSeconds: 1, sampleCount: 2 }),
      () => Promise.resolve(simulation),
    );

    expect(result.risk.kind).toBe('stable');
    expect(result.closestApproachMeters).toBeGreaterThan(0.9);
  });

  it('末端非负比能且径向向外时返回逃逸风险', async () => {
    const bodies = [body('reference', 0), body('draft', 1e7, 1e7)];
    const result = await generateTrajectoryPreview(
      request(bodies, { durationSeconds: 1, sampleCount: 2 }),
      () => Promise.resolve(new LinearSimulation(bodies)),
    );

    expect(result.risk).toMatchObject({
      kind: 'escape',
      bodyId: 'draft',
      otherBodyId: 'reference',
      timeSeconds: 1,
    });
  });

  it('采样失败仍释放 simulation', async () => {
    const bodies = [body('reference', 0), body('draft', 10)];
    const simulation = new LinearSimulation(bodies);
    simulation.failSnapshot = true;

    await expect(
      generateTrajectoryPreview(request(bodies), () => Promise.resolve(simulation)),
    ).rejects.toThrow('fake snapshot failure');
    expect(simulation.destroyCount).toBe(1);
  });
});
