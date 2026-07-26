import { describe, expect, it } from 'vitest';

import type { PhysicsState } from '../physics/protocol/schemas';
import { createTestBodyState } from '../test/fixtures/body-state';
import {
  computeSnapshotContentHash,
  createStarySnapshot,
  decodeStarySnapshotFromJson,
  encodeStarySnapshotToJson,
  SNAPSHOT_JSON_MAX_BYTES,
  SnapshotCodecError,
} from './snapshot-codec';
import type { SnapshotContent } from './snapshot-schema';

const ZERO_VECTOR = { x: 0, y: 0, z: 0 } as const;

function createPhysicsStateFixture(
  overrides: Partial<Pick<PhysicsState, 'majorBodies' | 'tracers'>> = {},
): PhysicsState {
  const tracers = overrides.tracers ?? [];
  const tracerMassKg = tracers.reduce((sum, tracer) => sum + tracer.massKg, 0);
  return {
    majorBodies: overrides.majorBodies ?? [
      createTestBodyState({ id: 'earth', massKg: 5.9722e24, radiusMeters: 6_371_000 }),
    ],
    tracers,
    dustCohorts: [],
    cumulativeCollisionLedger: {
      resolvedEventCount: 0,
      accumulatedDissipation: {
        heatJoules: 0,
        deformationJoules: 0,
        fractureJoules: 0,
        radiationJoules: 0,
      },
    },
    omittedInteractionClasses: [],
    cumulativeOmittedBackreaction: {
      linearImpulseKgMetersPerSecond: ZERO_VECTOR,
      angularImpulseKgMetersSquaredPerSecond: ZERO_VECTOR,
      workJoules: 0,
    },
    diagnostics: {
      activeRebound: {
        totalEnergyJoules: -1,
        totalLinearMomentumKgMetersPerSecond: ZERO_VECTOR,
        totalAngularMomentumKgMetersSquaredPerSecond: ZERO_VECTOR,
      },
      passiveAssets: {
        totalMassKg: tracerMassKg,
        totalLinearMomentumKgMetersPerSecond: ZERO_VECTOR,
        totalAngularMomentumKgMetersSquaredPerSecond: ZERO_VECTOR,
        totalMechanicalEnergyJoules: 0,
      },
    },
  };
}

function createContentFixture(): SnapshotContent {
  return {
    simulationTimeSeconds: 86_400,
    bodyRevision: 3,
    timeScale: 86_400,
    physicsState: createPhysicsStateFixture(),
  };
}

describe('createStarySnapshot', () => {
  it('由内容哈希派生快照 ID,改标签不改身份', () => {
    const content = createContentFixture();
    const first = createStarySnapshot({ content, capturedAtUnixMilliseconds: 1_000 });
    const renamed = createStarySnapshot({
      content,
      label: '大碰撞之前',
      capturedAtUnixMilliseconds: 2_000,
    });

    expect(first.snapshotId).toBe(`snapshot-${first.contentHash}`);
    expect(renamed.snapshotId).toBe(first.snapshotId);
    expect(renamed.contentHash).toBe(first.contentHash);
    expect(renamed.label).toBe('大碰撞之前');
  });

  it('极端数值逐位往返,-0 在创建时归一为 0', () => {
    const content: SnapshotContent = {
      simulationTimeSeconds: 0,
      bodyRevision: 0,
      timeScale: 1,
      physicsState: createPhysicsStateFixture({
        majorBodies: [
          createTestBodyState({
            id: 'extreme',
            massKg: 1e308,
            radiusMeters: 1,
            positionMeters: { x: -0, y: 5e-324, z: 1.7976931348623157e308 },
            velocityMetersPerSecond: { x: 2.2250738585072014e-308, y: 0, z: -1e-9 },
          }),
        ],
      }),
    };
    const snapshot = createStarySnapshot({ content, capturedAtUnixMilliseconds: 0 });
    const decoded = decodeStarySnapshotFromJson(encodeStarySnapshotToJson(snapshot));

    const body = decoded.physicsState.majorBodies.at(0);
    expect(body?.massKg).toBe(1e308);
    expect(Object.is(body?.positionMeters.x, 0)).toBe(true);
    expect(body?.positionMeters.y).toBe(5e-324);
    expect(body?.positionMeters.z).toBe(1.7976931348623157e308);
    expect(body?.velocityMetersPerSecond.x).toBe(2.2250738585072014e-308);
    expect(decoded).toStrictEqual(snapshot);
  });

  it('拒绝非法内容:零天体、超上限倍率', () => {
    expect(() =>
      createStarySnapshot({
        content: { ...createContentFixture(), timeScale: 5_400_001 },
        capturedAtUnixMilliseconds: 0,
      }),
    ).toThrow();
    expect(() =>
      createStarySnapshot({
        content: {
          ...createContentFixture(),
          physicsState: { ...createPhysicsStateFixture(), majorBodies: [] },
        },
        capturedAtUnixMilliseconds: 0,
      }),
    ).toThrow();
  });
});

describe('computeSnapshotContentHash', () => {
  it('黄金样例锁定规范化与哈希规则', () => {
    expect(computeSnapshotContentHash(createContentFixture())).toBe('3161ae6c6ae55b35');
  });

  it('含被动资产的内容哈希稳定且与资产内容相关', () => {
    const withTracer = createPhysicsStateFixture({
      tracers: [
        {
          id: 'tracer-1',
          massKg: 1,
          positionMeters: { x: 1e9, y: 0, z: 0 },
          velocityMetersPerSecond: ZERO_VECTOR,
          materialLayers: [{ material: 'silicate', massFraction: 1 }],
          subgridMechanicalEnergyJoules: 0,
        },
      ],
    });
    const base = { ...createContentFixture(), physicsState: withTracer };
    expect(computeSnapshotContentHash(base)).toBe(computeSnapshotContentHash(base));
    expect(computeSnapshotContentHash(base)).not.toBe(
      computeSnapshotContentHash(createContentFixture()),
    );
  });
});

describe('decodeStarySnapshotFromJson', () => {
  function encodedFixture(): string {
    return encodeStarySnapshotToJson(
      createStarySnapshot({
        content: createContentFixture(),
        label: '样例',
        capturedAtUnixMilliseconds: 1_000,
      }),
    );
  }

  it('解码规范化文本得到逐位一致的快照', () => {
    const text = encodedFixture();
    const decoded = decodeStarySnapshotFromJson(text);
    expect(encodeStarySnapshotToJson(decoded)).toBe(text);
  });

  it('篡改可恢复内容会触发哈希拒绝', () => {
    const tampered = JSON.parse(encodedFixture()) as {
      simulationTimeSeconds: number;
    };
    tampered.simulationTimeSeconds += 1;
    expect(() => decodeStarySnapshotFromJson(JSON.stringify(tampered))).toThrow(
      expect.objectContaining({ name: 'SnapshotCodecError', code: 'contentHashMismatch' }),
    );
  });

  it('拒绝错误格式、错误版本、未知字段与非法结构', () => {
    const parsed = JSON.parse(encodedFixture()) as Record<string, unknown>;

    expect(() =>
      decodeStarySnapshotFromJson(JSON.stringify({ ...parsed, format: 'other-format' })),
    ).toThrow(expect.objectContaining({ code: 'unsupportedFormat' }));
    expect(() =>
      decodeStarySnapshotFromJson(JSON.stringify({ ...parsed, formatVersion: 2 })),
    ).toThrow(expect.objectContaining({ code: 'unsupportedVersion' }));
    expect(() =>
      decodeStarySnapshotFromJson(JSON.stringify({ ...parsed, extraField: true })),
    ).toThrow(expect.objectContaining({ code: 'malformedSnapshot' }));
    expect(() =>
      decodeStarySnapshotFromJson(
        JSON.stringify({
          ...parsed,
          physicsState: { ...(parsed.physicsState as object), majorBodies: [] },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'malformedSnapshot' }));
  });

  it('拒绝非法 JSON 与超大输入', () => {
    expect(() => decodeStarySnapshotFromJson('{')).toThrow(
      expect.objectContaining({ code: 'invalidJson' }),
    );
    expect(() => decodeStarySnapshotFromJson('0'.repeat(SNAPSHOT_JSON_MAX_BYTES + 1))).toThrow(
      expect.objectContaining({ code: 'snapshotTooLarge' }),
    );
  });

  it('SnapshotCodecError 携带稳定名称与错误码', () => {
    try {
      decodeStarySnapshotFromJson('not-json');
      expect.unreachable('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotCodecError);
      expect((error as SnapshotCodecError).code).toBe('invalidJson');
    }
  });
});
