/// <reference types="node" />

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BodyState } from '../protocol/schemas';
import { createCircularSunEarthScenario } from '../scenarios/sun-earth';
import type { ReboundEmscriptenModule } from './emscripten-types';
import { createReboundSimulation } from './rebound-simulation';

const reboundWasmPath = path.resolve('spikes', 'rebound-wasm', 'dist', 'rebound.wasm');

function bodyTemplate(): BodyState {
  const template = createCircularSunEarthScenario().bodies[1];
  if (template === undefined) {
    throw new Error('测试场景缺少地球模板');
  }
  return template;
}

function collisionBody(id: string, x: number, y: number, velocityX: number): BodyState {
  const template = bodyTemplate();
  return {
    ...template,
    id,
    massKg: 1,
    radiusMeters: 1,
    positionMeters: { x, y, z: 0 },
    velocityMetersPerSecond: { x: velocityX, y: 0, z: 0 },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      ...template.spinAngularMomentumKgMetersSquaredPerSecond,
    },
    materialLayers: template.materialLayers.map((layer) => ({ ...layer })),
  };
}

describe('REBOUND continuous contact adapter', () => {
  it('maps simultaneous particle pairs to stable UTF-8 sorted body IDs', async () => {
    const initialTimeSeconds = 100;
    const simulation = await createReboundSimulation(
      [
        collisionBody('a', 0, 0, 500),
        collisionBody('b\0c', 10, 0, -500),
        collisionBody('a\0b', 0, 100, 500),
        collisionBody('c', 10, 100, -500),
      ],
      {
        gravitationalConstant: 1e-20,
        initialTimeSeconds,
        initialTimestepSeconds: 0.02,
        locateFile: () => reboundWasmPath,
      },
    );

    try {
      const result = simulation.advanceUntilEvent(initialTimeSeconds + 0.02);
      expect(result.type).toBe('contact');
      if (result.type !== 'contact') {
        throw new Error('缺少接触结果');
      }
      expect(result.timeSeconds).toBeCloseTo(initialTimeSeconds + 0.008, 9);
      expect(result.pairs).toEqual([
        { firstBodyId: 'a', secondBodyId: 'b\0c' },
        { firstBodyId: 'a\0b', secondBodyId: 'c' },
      ]);
      expect(result.snapshot.bodies.map((body) => body.id)).toEqual(['a', 'b\0c', 'a\0b', 'c']);
      expect(simulation.timeSeconds).toBe(result.timeSeconds);

      simulation.clearPendingContact();
      simulation.clearPendingContact();
    } finally {
      simulation.destroy();
    }
  });

  it('clears a pending C result when contact parsing fails', async () => {
    let clearCount = 0;
    const module: ReboundEmscriptenModule = {
      _stary_reb_create: () => 1,
      _stary_reb_destroy: () => undefined,
      _stary_reb_reset: () => 0,
      _stary_reb_add_particle: () => 0,
      _stary_reb_set_integrator: () => 0,
      _stary_reb_move_to_com: () => 0,
      _stary_reb_integrate: () => 0,
      _stary_reb_advance_until_event: () => 1,
      _stary_reb_contact_count: () => 1,
      _stary_reb_contact_time: () => Number.NaN,
      _stary_reb_contact_particle_index: () => 0,
      _stary_reb_clear_contact: () => {
        clearCount += 1;
        return 0;
      },
      _stary_reb_discard_contact: () => {
        clearCount += 1;
        return 0;
      },
      _stary_reb_temporary_copy_count: () => 0,
      _stary_reb_particle_count: () => 1,
      _stary_reb_get_time: () => 0,
      _stary_reb_get_particle_value: (_handle, _particleIndex, component) =>
        component === 0 ? 1 : 0,
      _stary_reb_energy: () => 0,
      _stary_reb_angular_momentum_value: () => 0,
    };
    const simulation = await createReboundSimulation([collisionBody('only-body', 0, 0, 0)], {
      moduleFactory: () => Promise.resolve(module),
    });

    try {
      expect(() => simulation.advanceUntilEvent(1)).toThrow(/local contact time/);
      expect(clearCount).toBe(1);
    } finally {
      simulation.destroy();
    }
  });
});
