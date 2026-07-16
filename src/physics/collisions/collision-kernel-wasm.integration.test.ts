/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { computeContactQuantities } from './contact-quantities';
import {
  CollisionKernelWasmError,
  createCollisionKernelWasm,
  type CollisionKernelWasm,
  type CollisionKernelWasmExportSource,
} from './collision-kernel-wasm';
import { computeDisruptionScaling } from './disruption-scaling';
import {
  COLLISION_KERNEL_ABI_VERSION,
  COLLISION_RECONSTRUCTION_VERSION,
  collisionKernelResponseSchema,
  type CollisionKernelBatchRequest,
  type CollisionKernelEventRequest,
} from './kernel-schemas';
import { resolveCollisionKernelReference } from './kernel-reference';
import { COLLISION_MODEL_VERSION } from './model-sources';
import type { CollisionBodySnapshot } from './schemas';
import { contactBodies } from './test-helpers';

const PAGE_BYTES = 65_536;
const NUMERIC_RELATIVE_TOLERANCE = 32 * Number.EPSILON;

interface FakeContext {
  byteLength: number;
  pointer: number;
  state: 'fresh' | 'request' | 'response';
}

function createFakeExports(options: { readonly trapOnResolve?: boolean } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const contexts = new Map<number, FakeContext>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let nextToken = 1;
  let destroyCallCount = 0;

  const exports: CollisionKernelWasmExportSource = {
    memory,
    stary_collision_abi_version: () => 1,
    stary_collision_create: () => {
      const token = nextToken;
      nextToken += 1;
      contexts.set(token, { byteLength: 0, pointer: 0, state: 'fresh' });
      return token;
    },
    stary_collision_alloc: (token, byteLength) => {
      const context = contexts.get(token);
      if (context?.state !== 'fresh') {
        return 1;
      }
      const oldPageCount = memory.grow(1);
      context.pointer = oldPageCount * PAGE_BYTES;
      context.byteLength = byteLength;
      context.state = 'request';
      return 0;
    },
    stary_collision_buffer_ptr: (token) => contexts.get(token)?.pointer ?? 0,
    stary_collision_buffer_len: (token) => contexts.get(token)?.byteLength ?? 0,
    stary_collision_resolve: (token) => {
      if (options.trapOnResolve === true) {
        throw new WebAssembly.RuntimeError('forced resolve trap');
      }
      const context = contexts.get(token);
      if (context?.state !== 'request') {
        return 1;
      }
      const request = JSON.parse(
        decoder.decode(new Uint8Array(memory.buffer, context.pointer, context.byteLength)),
      ) as unknown;
      const response = encoder.encode(JSON.stringify({ echo: request, kind: 'success' }));
      const requiredPages = Math.ceil(response.byteLength / PAGE_BYTES);
      const oldPageCount = memory.grow(Math.max(1, requiredPages));
      context.pointer = oldPageCount * PAGE_BYTES;
      context.byteLength = response.byteLength;
      context.state = 'response';
      new Uint8Array(memory.buffer, context.pointer, context.byteLength).set(response);
      return 0;
    },
    stary_collision_destroy: (token) => {
      destroyCallCount += 1;
      contexts.delete(token);
      return 0;
    },
    stary_collision_live_count: () => contexts.size,
  };

  return {
    exports,
    get destroyCallCount(): number {
      return destroyCallCount;
    },
  };
}

function classicEvent(
  eventId: string,
  bodies: readonly [CollisionBodySnapshot, CollisionBodySnapshot],
): CollisionKernelEventRequest {
  return {
    domain: 'classic',
    input: {
      eventId,
      simulationTimeSeconds: 42,
      firstBody: bodies[0],
      secondBody: bodies[1],
    },
    expectedMaterialProfile: 'gravitySolid',
  };
}

function request(
  events: readonly CollisionKernelEventRequest[],
  capacity: CollisionKernelBatchRequest['capacity'],
): CollisionKernelBatchRequest {
  return {
    abiVersion: COLLISION_KERNEL_ABI_VERSION,
    modelVersion: COLLISION_MODEL_VERSION,
    reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
    capacity,
    events: [...events],
  };
}

function renamedBodies(
  prefix: string,
  bodies: readonly [CollisionBodySnapshot, CollisionBodySnapshot],
): [CollisionBodySnapshot, CollisionBodySnapshot] {
  return [
    { ...bodies[0], id: `${prefix}-${bodies[0].id}` },
    { ...bodies[1], id: `${prefix}-${bodies[1].id}` },
  ];
}

function blackHoleRequest(): CollisionKernelBatchRequest {
  const blackHoleRadiusMeters = 0.01;
  const planetRadiusMeters = 100_000;
  const blackHole: CollisionBodySnapshot = {
    id: 'black-hole',
    massKg: 5e24,
    radiusMeters: blackHoleRadiusMeters,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
    spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1e20 },
    momentOfInertiaFactor: null,
    materialLayers: [],
    collisionModel: 'blackHole',
  };
  const planet: CollisionBodySnapshot = {
    id: 'planet',
    massKg: 1e20,
    radiusMeters: planetRadiusMeters,
    positionMeters: { x: blackHoleRadiusMeters + planetRadiusMeters, y: 0, z: 0 },
    velocityMetersPerSecond: { x: -1_000, y: 100, z: 0 },
    spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
    momentOfInertiaFactor: 0.4,
    materialLayers: [
      { material: 'silicate', massFraction: 0.7 },
      { material: 'iron', massFraction: 0.3 },
    ],
    collisionModel: 'gravitySolid',
  };
  return request(
    [
      {
        domain: 'blackHoleAccretion',
        input: {
          eventId: 'event-black-hole',
          simulationTimeSeconds: 7,
          firstBody: blackHole,
          secondBody: planet,
        },
        expectedMaterialProfile: null,
      },
    ],
    { majorRemnantSlots: 1, passiveAssetSlots: 0 },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareKernelValues(
  actual: unknown,
  expected: unknown,
  path: string,
  numericDriftPaths: string[],
): void {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') {
      throw new TypeError(`${path} 预期为数值`);
    }
    if (actual === expected) {
      return;
    }
    if (actual === 0 || expected === 0) {
      expect(actual, path).toBe(expected);
      return;
    }
    const scale = Math.max(Math.abs(actual), Math.abs(expected), Number.MIN_VALUE);
    expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(
      NUMERIC_RELATIVE_TOLERANCE * scale,
    );
    numericDriftPaths.push(path);
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new TypeError(`${path} 预期为数组`);
    }
    expect(actual.length, `${path}.length`).toBe(expected.length);
    expected.forEach((item, index) => {
      compareKernelValues(actual[index], item, `${path}[${String(index)}]`, numericDriftPaths);
    });
    return;
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      throw new TypeError(`${path} 预期为对象`);
    }
    const keys = Object.keys(expected).sort();
    expect(Object.keys(actual).sort(), `${path} keys`).toEqual(keys);
    for (const key of keys) {
      compareKernelValues(actual[key], expected[key], `${path}.${key}`, numericDriftPaths);
    }
    return;
  }

  expect(actual, path).toEqual(expected);
}

function expectRealKernelParity(
  kernel: CollisionKernelWasm,
  input: CollisionKernelBatchRequest,
): {
  readonly actual: ReturnType<typeof collisionKernelResponseSchema.parse>;
  readonly numericDriftPaths: readonly string[];
} {
  const expected = resolveCollisionKernelReference(input);
  const actual = collisionKernelResponseSchema.parse(kernel.resolveJson(input));
  const numericDriftPaths: string[] = [];
  compareKernelValues(actual, expected, '$', numericDriftPaths);
  expect(kernel.liveContextCount()).toBe(0);
  return { actual, numericDriftPaths: numericDriftPaths.sort() };
}

describe('Collision WASM adapter integration', () => {
  it('survives memory growth before both request and response views', () => {
    const fake = createFakeExports();
    const kernel = createCollisionKernelWasm(fake.exports);
    const request = { eventId: '碰撞-🪐', nested: { value: 42 } };

    expect(kernel.resolveJson(request)).toEqual({ echo: request, kind: 'success' });
    expect(kernel.liveContextCount()).toBe(0);
    expect(fake.destroyCallCount).toBe(1);
  });

  it('destroys the context when resolve traps', () => {
    const fake = createFakeExports({ trapOnResolve: true });
    const kernel = createCollisionKernelWasm(fake.exports);

    expect(() => kernel.resolveJson({ eventId: 'trap' })).toThrow(
      expect.objectContaining<Partial<CollisionKernelWasmError>>({
        name: 'CollisionKernelWasmError',
        operation: 'resolve',
      }),
    );
    expect(kernel.liveContextCount()).toBe(0);
    expect(fake.destroyCallCount).toBe(1);
  });

  it('rejects an incompatible ABI before allocating a context', () => {
    const fake = createFakeExports();

    expect(() =>
      createCollisionKernelWasm({
        ...fake.exports,
        stary_collision_abi_version: () => 2,
      }),
    ).toThrow(/ABI 版本不兼容/);
    expect(fake.destroyCallCount).toBe(0);
  });
});

describe('Collision WASM real kernel parity', () => {
  let kernel: CollisionKernelWasm;

  beforeAll(async () => {
    const wasmBytes = Uint8Array.from(
      await readFile(path.resolve('crates', 'stary-collision', 'dist', 'stary_collision.wasm')),
    );
    const instantiated = await WebAssembly.instantiate(wasmBytes, {});
    kernel = createCollisionKernelWasm(instantiated.instance.exports);
  });

  it('matches the TypeScript merge reconstruction exactly', () => {
    const bodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const parity = expectRealKernelParity(
      kernel,
      request([classicEvent('event-merge', bodies)], {
        majorRemnantSlots: 2,
        passiveAssetSlots: 1,
      }),
    );
    expect(parity.numericDriftPaths).toEqual([
      '$.events[0].after.majorBodies[0].radiusMeters',
      '$.events[0].dissipation.heatJoules',
      '$.events[0].ledger.after.energy.selfBindingJoules',
      '$.events[0].ledger.after.energy.totalJoules',
      '$.events[0].ledger.dissipation.heatJoules',
    ]);
  });

  it('matches hit-and-run and disruption while sorting a reversed batch', () => {
    const hitAndRunBase = contactBodies({
      targetMassKg: 4e24,
      projectileMassKg: 2e24,
      targetRadiusMeters: 7e6,
      projectileRadiusMeters: 5e6,
      impactSpeedMetersPerSecond: 1,
      impactAngleRadians: Math.asin(0.8),
    });
    const escapeSpeed = computeContactQuantities(...hitAndRunBase).mutualEscapeSpeedMetersPerSecond;
    const hitAndRunBodies = renamedBodies(
      'hit-run',
      contactBodies({
        targetMassKg: 4e24,
        projectileMassKg: 2e24,
        targetRadiusMeters: 7e6,
        projectileRadiusMeters: 5e6,
        impactSpeedMetersPerSecond: 1.5 * escapeSpeed,
        impactAngleRadians: Math.asin(0.8),
      }),
    );

    const disruptionBase = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const criticalSpeed = computeDisruptionScaling(
      computeContactQuantities(...disruptionBase),
      'gravitySolid',
    ).criticalImpactSpeedMetersPerSecond;
    const disruptionBodies = renamedBodies(
      'disruption',
      contactBodies({
        targetMassKg: 4e21,
        projectileMassKg: 2e21,
        targetRadiusMeters: 700_000,
        projectileRadiusMeters: 500_000,
        impactSpeedMetersPerSecond: 1.1 * criticalSpeed,
      }),
    );
    const input = request(
      [
        classicEvent('z-event-disruption', disruptionBodies),
        classicEvent('a-event-hit-run', hitAndRunBodies),
      ],
      { majorRemnantSlots: 3, passiveAssetSlots: 1 },
    );

    const parity = expectRealKernelParity(kernel, input);
    expect(parity.numericDriftPaths).toEqual([
      '$.events[0].ledger.after.energy.totalJoules',
      '$.events[0].ledger.after.energy.translationalJoules',
      '$.events[0].ledger.before.energy.totalJoules',
      '$.events[0].ledger.before.energy.translationalJoules',
      '$.events[1].after.majorBodies[0].radiusMeters',
      '$.events[1].ledger.after.energy.selfBindingJoules',
    ]);
    const { actual } = parity;
    expect(actual.kind).toBe('success');
    if (actual.kind === 'success') {
      expect(actual.events.map((event) => event.eventId)).toEqual([
        'a-event-hit-run',
        'z-event-disruption',
      ]);
    }
  });

  it('matches the TypeScript black-hole accretion ledger exactly', () => {
    const parity = expectRealKernelParity(kernel, blackHoleRequest());
    expect(parity.numericDriftPaths).toEqual([
      '$.events[0].ledger.relativeKineticEnergy.beforeJoules',
      '$.events[0].ledger.relativeKineticEnergy.check.scale',
      '$.events[0].ledger.relativeKineticEnergy.radiationJoules',
    ]);
  });
});
