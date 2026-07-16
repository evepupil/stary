import createReboundModule from '../../../spikes/rebound-wasm/dist/rebound.mjs';

import { REBOUND_WASM_URL } from '../../platform/wasm/rebound-asset';
import { compareUtf8 } from '../collisions/stable-order';
import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import {
  bodyStatesSchema,
  MAX_MAJOR_BODY_COUNT,
  type BodyState,
  type PhysicsDiagnostics,
} from '../protocol/schemas';
import type {
  ReboundEmscriptenModule,
  ReboundHandle,
  ReboundModuleFactory,
  ReboundModuleOptions,
  ReboundParticleComponent,
  ReboundWasmBinary,
} from './emscripten-types';

export const DEFAULT_GRAVITATIONAL_CONSTANT = GRAVITATIONAL_CONSTANT_SI;
export const DEFAULT_IAS15_INITIAL_TIMESTEP_SECONDS = 3_600;

const IAS15_INTEGRATOR_CODE = 0;
const PARTICLE_COMPONENT = {
  mass: 0,
  radius: 1,
  x: 2,
  y: 3,
  z: 4,
  vx: 5,
  vy: 6,
  vz: 7,
} as const;

const VECTOR_COMPONENT = {
  x: 0,
  y: 1,
  z: 2,
} as const;

export interface CreateReboundSimulationOptions {
  readonly gravitationalConstant?: number;
  readonly initialTimeSeconds?: number;
  readonly initialTimestepSeconds?: number;
  readonly locateFile?: ReboundModuleOptions['locateFile'];
  readonly moduleFactory?: ReboundModuleFactory;
  readonly wasmBinary?: ReboundWasmBinary;
}

export interface ReboundSnapshot {
  readonly bodies: readonly BodyState[];
  readonly diagnostics: PhysicsDiagnostics;
}

export interface ReboundContactPair {
  readonly firstBodyId: string;
  readonly secondBodyId: string;
}

export type ReboundAdvanceResult =
  | {
      readonly type: 'advanced';
      readonly timeSeconds: number;
    }
  | {
      readonly type: 'contact';
      readonly timeSeconds: number;
      readonly pairs: readonly ReboundContactPair[];
      readonly snapshot: ReboundSnapshot;
    };

export interface ReboundSimulation {
  readonly timeSeconds: number;
  integrateTo(targetTimeSeconds: number): void;
  snapshot(): ReboundSnapshot;
  destroy(): void;
}

export interface ReboundEventSimulation extends ReboundSimulation {
  advanceUntilEvent(targetTimeSeconds: number): ReboundAdvanceResult;
  clearPendingContact(): void;
}

function finiteNumber(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数，实际为 ${String(value)}`);
  }
  return value;
}

function positiveFiniteNumber(label: string, value: number): number {
  finiteNumber(label, value);
  if (value <= 0) {
    throw new Error(`${label} 必须大于 0，实际为 ${String(value)}`);
  }
  return value;
}

function nonNegativeFiniteNumber(label: string, value: number): number {
  finiteNumber(label, value);
  if (value < 0) {
    throw new Error(`${label} 不能小于 0，实际为 ${String(value)}`);
  }
  return value;
}

function checkStatus(operation: string, status: number): void {
  if (status !== 0) {
    throw new Error(`${operation} 失败，REBOUND 状态码为 ${String(status)}`);
  }
}

function validateBodies(bodies: readonly BodyState[]): BodyState[] {
  if (bodies.length === 0 || bodies.length > MAX_MAJOR_BODY_COUNT) {
    throw new Error(`天体数量必须在 1 到 ${String(MAX_MAJOR_BODY_COUNT)} 之间`);
  }

  const ids = new Set<string>();
  for (const [index, body] of bodies.entries()) {
    if (body.id.length === 0 || body.id.trim().length === 0) {
      throw new Error(`bodies[${String(index)}].id 不能为空`);
    }
    if (ids.has(body.id)) {
      throw new Error(`天体 id 重复：${body.id}`);
    }
    ids.add(body.id);

    positiveFiniteNumber(`bodies[${String(index)}].massKg`, body.massKg);
    nonNegativeFiniteNumber(`bodies[${String(index)}].radiusMeters`, body.radiusMeters);
    finiteNumber(`bodies[${String(index)}].positionMeters.x`, body.positionMeters.x);
    finiteNumber(`bodies[${String(index)}].positionMeters.y`, body.positionMeters.y);
    finiteNumber(`bodies[${String(index)}].positionMeters.z`, body.positionMeters.z);
    finiteNumber(
      `bodies[${String(index)}].velocityMetersPerSecond.x`,
      body.velocityMetersPerSecond.x,
    );
    finiteNumber(
      `bodies[${String(index)}].velocityMetersPerSecond.y`,
      body.velocityMetersPerSecond.y,
    );
    finiteNumber(
      `bodies[${String(index)}].velocityMetersPerSecond.z`,
      body.velocityMetersPerSecond.z,
    );
  }

  return bodyStatesSchema.parse(bodies);
}

function moduleOptions(
  wasmBinary: ReboundWasmBinary | undefined,
  providedLocateFile: ReboundModuleOptions['locateFile'],
): ReboundModuleOptions {
  const locateFile =
    providedLocateFile ??
    ((path: string): string => (path === 'rebound.wasm' ? REBOUND_WASM_URL : path));

  return wasmBinary === undefined ? { locateFile } : { locateFile, wasmBinary };
}

class ReboundSimulationAdapter implements ReboundSimulation {
  private handle: ReboundHandle;

  public constructor(
    private readonly module: ReboundEmscriptenModule,
    handle: ReboundHandle,
    private readonly bodyMetadata: readonly BodyState[],
    private readonly timeOriginSeconds: number,
  ) {
    this.handle = handle;
  }

  public get timeSeconds(): number {
    const handle = this.requireHandle();
    const localTimeSeconds = nonNegativeFiniteNumber(
      'REBOUND local simulation time',
      this.module._stary_reb_get_time(handle),
    );
    return finiteNumber('REBOUND simulation time', this.timeOriginSeconds + localTimeSeconds);
  }

  public integrateTo(targetTimeSeconds: number): void {
    const currentTimeSeconds = this.timeSeconds;
    nonNegativeFiniteNumber('targetTimeSeconds', targetTimeSeconds);
    if (targetTimeSeconds < currentTimeSeconds) {
      throw new Error(
        `targetTimeSeconds 不能早于当前模拟时间 ${String(currentTimeSeconds)}，实际为 ${String(targetTimeSeconds)}`,
      );
    }

    const localTargetTimeSeconds = finiteNumber(
      'localTargetTimeSeconds',
      targetTimeSeconds - this.timeOriginSeconds,
    );
    checkStatus(
      'integrateTo',
      this.module._stary_reb_integrate(this.requireHandle(), localTargetTimeSeconds),
    );
    void this.timeSeconds;
  }

  public advanceUntilEvent(targetTimeSeconds: number): ReboundAdvanceResult {
    const currentTimeSeconds = this.timeSeconds;
    nonNegativeFiniteNumber('targetTimeSeconds', targetTimeSeconds);
    if (targetTimeSeconds < currentTimeSeconds) {
      throw new Error(
        `targetTimeSeconds 不能早于当前模拟时间 ${String(currentTimeSeconds)}，实际为 ${String(targetTimeSeconds)}`,
      );
    }

    const handle = this.requireHandle();
    const localTargetTimeSeconds = finiteNumber(
      'localTargetTimeSeconds',
      targetTimeSeconds - this.timeOriginSeconds,
    );
    const status = this.module._stary_reb_advance_until_event(handle, localTargetTimeSeconds);
    this.assertTemporaryCopiesReleased(handle);
    if (status === 0) {
      const timeSeconds = this.timeSeconds;
      if (timeSeconds !== targetTimeSeconds) {
        throw new Error(
          `REBOUND 无事件推进未到达目标时间：预期 ${String(targetTimeSeconds)}，实际 ${String(timeSeconds)}`,
        );
      }
      return { type: 'advanced', timeSeconds };
    }
    if (status !== 1) {
      throw new Error(`advanceUntilEvent 失败，REBOUND 状态码为 ${String(status)}`);
    }

    try {
      const localContactTimeSeconds = nonNegativeFiniteNumber(
        'REBOUND local contact time',
        this.module._stary_reb_contact_time(handle),
      );
      const timeSeconds = finiteNumber(
        'REBOUND contact time',
        this.timeOriginSeconds + localContactTimeSeconds,
      );
      if (timeSeconds < currentTimeSeconds || timeSeconds > targetTimeSeconds) {
        throw new Error(
          `REBOUND 接触时间越界：${String(timeSeconds)} 不在 ${String(currentTimeSeconds)} 到 ${String(targetTimeSeconds)} 内`,
        );
      }
      const pairCount = this.module._stary_reb_contact_count(handle);
      if (!Number.isSafeInteger(pairCount) || pairCount <= 0) {
        throw new Error(`REBOUND 接触 pair 数量异常：${String(pairCount)}`);
      }
      const seenPairs = new Set<string>();
      const pairs: ReboundContactPair[] = [];
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const firstParticleIndex = this.readContactParticleIndex(handle, pairIndex, 0);
        const secondParticleIndex = this.readContactParticleIndex(handle, pairIndex, 1);
        if (firstParticleIndex >= secondParticleIndex) {
          throw new Error(
            `REBOUND 接触 pair 顺序异常：${String(firstParticleIndex)}, ${String(secondParticleIndex)}`,
          );
        }
        const firstId = this.bodyMetadata[firstParticleIndex]?.id;
        const secondId = this.bodyMetadata[secondParticleIndex]?.id;
        if (firstId === undefined || secondId === undefined) {
          throw new Error(`REBOUND 接触 pair 引用了不存在的粒子：${String(pairIndex)}`);
        }
        const [firstBodyId, secondBodyId] =
          compareUtf8(firstId, secondId) < 0 ? [firstId, secondId] : [secondId, firstId];
        const pairKey = `${String(firstParticleIndex)}:${String(secondParticleIndex)}`;
        if (seenPairs.has(pairKey)) {
          throw new Error(`REBOUND 接触 pair 重复：${pairKey}`);
        }
        seenPairs.add(pairKey);
        pairs.push({ firstBodyId, secondBodyId });
      }
      pairs.sort((left, right) => {
        const firstOrder = compareUtf8(left.firstBodyId, right.firstBodyId);
        return firstOrder !== 0 ? firstOrder : compareUtf8(left.secondBodyId, right.secondBodyId);
      });
      const snapshot = this.snapshot();
      if (this.timeSeconds !== timeSeconds) {
        throw new Error('REBOUND 接触快照时间与事件时间不一致');
      }
      return { type: 'contact', timeSeconds, pairs, snapshot };
    } catch (error) {
      this.module._stary_reb_discard_contact(handle);
      throw error;
    }
  }

  public clearPendingContact(): void {
    checkStatus('clearPendingContact', this.module._stary_reb_clear_contact(this.requireHandle()));
  }

  public snapshot(): ReboundSnapshot {
    const handle = this.requireHandle();
    const count = this.module._stary_reb_particle_count(handle);
    if (!Number.isSafeInteger(count) || count !== this.bodyMetadata.length) {
      throw new Error(
        `REBOUND 粒子数量异常：预期 ${String(this.bodyMetadata.length)}，实际为 ${String(count)}`,
      );
    }

    const bodies = this.bodyMetadata.map((metadata, particleIndex) =>
      this.readBody(handle, particleIndex, metadata),
    );
    const diagnostics = this.readDiagnostics(handle, bodies);
    return { bodies, diagnostics };
  }

  public destroy(): void {
    if (this.handle === 0) {
      return;
    }

    const handle = this.handle;
    this.handle = 0;
    this.module._stary_reb_destroy(handle);
  }

  private requireHandle(): ReboundHandle {
    if (this.handle === 0) {
      throw new Error('REBOUND simulation 已销毁');
    }
    return this.handle;
  }

  private assertTemporaryCopiesReleased(handle: ReboundHandle): void {
    const count = this.module._stary_reb_temporary_copy_count(handle);
    if (count !== 0) {
      throw new Error(`REBOUND 临时 simulation copy 未释放：${String(count)}`);
    }
  }

  private readContactParticleIndex(
    handle: ReboundHandle,
    pairIndex: number,
    memberIndex: 0 | 1,
  ): number {
    const particleIndex = this.module._stary_reb_contact_particle_index(
      handle,
      pairIndex,
      memberIndex,
    );
    if (
      !Number.isSafeInteger(particleIndex) ||
      particleIndex < 0 ||
      particleIndex >= this.bodyMetadata.length
    ) {
      throw new Error(
        `REBOUND 接触粒子下标异常：pair ${String(pairIndex)} member ${String(memberIndex)} = ${String(particleIndex)}`,
      );
    }
    return particleIndex;
  }

  private readBody(handle: ReboundHandle, particleIndex: number, metadata: BodyState): BodyState {
    const read = (component: ReboundParticleComponent, label: string): number =>
      finiteNumber(
        `particle[${String(particleIndex)}].${label}`,
        this.module._stary_reb_get_particle_value(handle, particleIndex, component),
      );

    return {
      ...metadata,
      spinAngularMomentumKgMetersSquaredPerSecond: {
        ...metadata.spinAngularMomentumKgMetersSquaredPerSecond,
      },
      materialLayers: metadata.materialLayers.map((layer) => ({ ...layer })),
      massKg: positiveFiniteNumber(
        `particle[${String(particleIndex)}].mass`,
        read(PARTICLE_COMPONENT.mass, 'mass'),
      ),
      radiusMeters: nonNegativeFiniteNumber(
        `particle[${String(particleIndex)}].radius`,
        read(PARTICLE_COMPONENT.radius, 'radius'),
      ),
      positionMeters: {
        x: read(PARTICLE_COMPONENT.x, 'x'),
        y: read(PARTICLE_COMPONENT.y, 'y'),
        z: read(PARTICLE_COMPONENT.z, 'z'),
      },
      velocityMetersPerSecond: {
        x: read(PARTICLE_COMPONENT.vx, 'vx'),
        y: read(PARTICLE_COMPONENT.vy, 'vy'),
        z: read(PARTICLE_COMPONENT.vz, 'vz'),
      },
    };
  }

  private readDiagnostics(handle: ReboundHandle, bodies: readonly BodyState[]): PhysicsDiagnostics {
    let momentumX = 0;
    let momentumY = 0;
    let momentumZ = 0;

    for (const body of bodies) {
      momentumX = finiteNumber(
        'totalLinearMomentumKgMetersPerSecond.x',
        momentumX + body.massKg * body.velocityMetersPerSecond.x,
      );
      momentumY = finiteNumber(
        'totalLinearMomentumKgMetersPerSecond.y',
        momentumY + body.massKg * body.velocityMetersPerSecond.y,
      );
      momentumZ = finiteNumber(
        'totalLinearMomentumKgMetersPerSecond.z',
        momentumZ + body.massKg * body.velocityMetersPerSecond.z,
      );
    }

    return {
      totalEnergyJoules: finiteNumber('totalEnergyJoules', this.module._stary_reb_energy(handle)),
      totalLinearMomentumKgMetersPerSecond: {
        x: momentumX,
        y: momentumY,
        z: momentumZ,
      },
      totalAngularMomentumKgMetersSquaredPerSecond: {
        x: finiteNumber(
          'totalAngularMomentumKgMetersSquaredPerSecond.x',
          this.module._stary_reb_angular_momentum_value(handle, VECTOR_COMPONENT.x),
        ),
        y: finiteNumber(
          'totalAngularMomentumKgMetersSquaredPerSecond.y',
          this.module._stary_reb_angular_momentum_value(handle, VECTOR_COMPONENT.y),
        ),
        z: finiteNumber(
          'totalAngularMomentumKgMetersSquaredPerSecond.z',
          this.module._stary_reb_angular_momentum_value(handle, VECTOR_COMPONENT.z),
        ),
      },
    };
  }
}

export async function createReboundSimulation(
  bodies: readonly BodyState[],
  options: CreateReboundSimulationOptions = {},
): Promise<ReboundEventSimulation> {
  const validatedBodies = validateBodies(bodies);
  const gravitationalConstant = positiveFiniteNumber(
    'gravitationalConstant',
    options.gravitationalConstant ?? DEFAULT_GRAVITATIONAL_CONSTANT,
  );
  const initialTimestepSeconds = positiveFiniteNumber(
    'initialTimestepSeconds',
    options.initialTimestepSeconds ?? DEFAULT_IAS15_INITIAL_TIMESTEP_SECONDS,
  );
  const initialTimeSeconds = nonNegativeFiniteNumber(
    'initialTimeSeconds',
    options.initialTimeSeconds ?? 0,
  );
  const factory = options.moduleFactory ?? createReboundModule;
  const module = await factory(moduleOptions(options.wasmBinary, options.locateFile));
  const handle = module._stary_reb_create(gravitationalConstant);
  if (handle === 0) {
    throw new Error('创建 REBOUND simulation 失败');
  }

  try {
    for (const body of validatedBodies) {
      checkStatus(
        `addParticle(${body.id})`,
        module._stary_reb_add_particle(
          handle,
          body.massKg,
          body.radiusMeters,
          body.positionMeters.x,
          body.positionMeters.y,
          body.positionMeters.z,
          body.velocityMetersPerSecond.x,
          body.velocityMetersPerSecond.y,
          body.velocityMetersPerSecond.z,
        ),
      );
    }
    checkStatus(
      'setIntegrator(ias15)',
      module._stary_reb_set_integrator(handle, IAS15_INTEGRATOR_CODE, initialTimestepSeconds),
    );
    checkStatus('moveToCenterOfMass', module._stary_reb_move_to_com(handle));

    return new ReboundSimulationAdapter(module, handle, validatedBodies, initialTimeSeconds);
  } catch (error) {
    module._stary_reb_destroy(handle);
    throw error;
  }
}
