import { describe, expect, it } from 'vitest';

import {
  collisionBodySnapshotSchema,
  collisionEventStateSchema,
  deterministicSeedInputSchema,
  materialLayersSchema,
} from './schemas';
import { collisionBody } from './test-helpers';

describe('碰撞 schema', () => {
  it('接受严格的经典分层天体', () => {
    const body = collisionBody({ id: 'planet', massKg: 10, radiusMeters: 2 });
    expect(collisionBodySnapshotSchema.parse(body)).toEqual(body);
  });

  it('拒绝未知字段、非有限数、零半径和非法转动惯量', () => {
    const body = collisionBody({ id: 'planet', massKg: 10, radiusMeters: 2 });
    expect(() => collisionBodySnapshotSchema.parse({ ...body, unexpected: true })).toThrow();
    expect(() => collisionBodySnapshotSchema.parse({ ...body, massKg: Number.NaN })).toThrow();
    expect(() => collisionBodySnapshotSchema.parse({ ...body, radiusMeters: 0 })).toThrow();
    expect(() =>
      collisionBodySnapshotSchema.parse({ ...body, momentOfInertiaFactor: 0.400_000_1 }),
    ).toThrow();
  });

  it('校验材料层顺序、重复项和质量分数', () => {
    expect(
      materialLayersSchema.parse([
        { material: 'gas', massFraction: 0.1 },
        { material: 'ice', massFraction: 0.2 },
        { material: 'silicate', massFraction: 0.5 },
        { material: 'iron', massFraction: 0.2 },
      ]),
    ).toHaveLength(4);
    expect(() =>
      materialLayersSchema.parse([
        { material: 'iron', massFraction: 0.3 },
        { material: 'silicate', massFraction: 0.7 },
      ]),
    ).toThrow('材料层必须按');
    expect(() =>
      materialLayersSchema.parse([
        { material: 'silicate', massFraction: 0.5 },
        { material: 'silicate', massFraction: 0.5 },
      ]),
    ).toThrow('不能重复');
    expect(() =>
      materialLayersSchema.parse([
        { material: 'silicate', massFraction: 0.8 },
        { material: 'iron', massFraction: 0.3 },
      ]),
    ).toThrow('必须等于 1');
    expect(
      materialLayersSchema.parse([
        { material: 'silicate', massFraction: 0.7 },
        { material: 'iron', massFraction: 0.3 + 0.5e-12 },
      ]),
    ).toHaveLength(2);
    expect(() =>
      materialLayersSchema.parse([
        { material: 'silicate', massFraction: 0.7 },
        { material: 'iron', massFraction: 0.3 + 1.1e-12 },
      ]),
    ).toThrow('必须等于 1');
    expect(() =>
      materialLayersSchema.parse([
        { material: 'gas', massFraction: 0.6 },
        { material: 'silicate', massFraction: 0.400_000_000_000_5 },
        { material: 'iron', massFraction: 1e-16 },
      ]),
    ).toThrow('最后一层之前');
  });

  it('把黑洞与经典材料和转动惯量分开', () => {
    const base = collisionBody({ id: 'black-hole', massKg: 10, radiusMeters: 2 });
    const blackHole = {
      ...base,
      collisionModel: 'blackHole' as const,
      materialLayers: [],
      momentOfInertiaFactor: null,
    };
    expect(collisionBodySnapshotSchema.parse(blackHole)).toEqual(blackHole);
    expect(() =>
      collisionBodySnapshotSchema.parse({ ...blackHole, materialLayers: base.materialLayers }),
    ).toThrow('黑洞不能使用经典材料层');
    expect(() =>
      collisionBodySnapshotSchema.parse({ ...blackHole, momentOfInertiaFactor: 0.4 }),
    ).toThrow('黑洞不能使用经典转动惯量因子');
  });

  it('拒绝跨主要天体、tracer 和 dust cohort 的重复 id', () => {
    const body = collisionBody({ id: 'duplicate', massKg: 10, radiusMeters: 2 });
    expect(() =>
      collisionEventStateSchema.parse({
        majorBodies: [body],
        tracers: [
          {
            id: 'duplicate',
            massKg: 1,
            positionMeters: { x: 3, y: 0, z: 0 },
            velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
            materialLayers: [{ material: 'silicate', massFraction: 1 }],
            subgridMechanicalEnergyJoules: 0,
          },
        ],
        dustCohorts: [],
      }),
    ).toThrow('碰撞资产 id 重复');
  });

  it('拒绝标识中的孤立 UTF-16 surrogate', () => {
    const seedInput = {
      eventId: 'event',
      firstParentId: 'first',
      secondParentId: 'second',
      fragmentKind: 'major' as const,
      fragmentOrdinal: 0,
    };
    expect(() => deterministicSeedInputSchema.parse({ ...seedInput, eventId: '\uD800' })).toThrow(
      '完整 Unicode',
    );
    expect(() =>
      deterministicSeedInputSchema.parse({ ...seedInput, firstParentId: '\uDC00' }),
    ).toThrow('完整 Unicode');
  });
});
