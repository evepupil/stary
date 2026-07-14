export type ReboundHandle = number;

export type ReboundWasmBinary = ArrayBuffer | Uint8Array;
export type ReboundIntegratorCode = 0 | 1;
export type ReboundParticleComponent = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ReboundVectorComponent = 0 | 1 | 2;

export interface ReboundModuleOptions {
  readonly locateFile?: (path: string, scriptDirectory: string) => string;
  readonly wasmBinary?: ReboundWasmBinary;
}

export interface ReboundEmscriptenModule {
  _stary_reb_create(gravitationalConstant: number): ReboundHandle;
  _stary_reb_destroy(handle: ReboundHandle): void;
  _stary_reb_reset(handle: ReboundHandle, gravitationalConstant: number): number;
  _stary_reb_add_particle(
    handle: ReboundHandle,
    mass: number,
    radius: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
  ): number;
  _stary_reb_set_integrator(
    handle: ReboundHandle,
    integrator: ReboundIntegratorCode,
    timestepSeconds: number,
  ): number;
  _stary_reb_move_to_com(handle: ReboundHandle): number;
  _stary_reb_integrate(handle: ReboundHandle, targetTimeSeconds: number): number;
  _stary_reb_particle_count(handle: ReboundHandle): number;
  _stary_reb_get_time(handle: ReboundHandle): number;
  _stary_reb_get_particle_value(
    handle: ReboundHandle,
    particleIndex: number,
    component: ReboundParticleComponent,
  ): number;
  _stary_reb_energy(handle: ReboundHandle): number;
  _stary_reb_angular_momentum_value(
    handle: ReboundHandle,
    component: ReboundVectorComponent,
  ): number;
}

export type ReboundModuleFactory = (
  options?: ReboundModuleOptions,
) => Promise<ReboundEmscriptenModule>;
