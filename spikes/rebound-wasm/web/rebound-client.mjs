import createReboundModule from '../dist/rebound.mjs';

const COMPONENTS = ['mass', 'radius', 'x', 'y', 'z', 'vx', 'vy', 'vz'];

function checkStatus(operation, status) {
  if (status !== 0) {
    throw new Error(`${operation} failed with status ${status}`);
  }
}

export async function createReboundClient(moduleOptions = {}) {
  const module = await createReboundModule(moduleOptions);
  let handle = 0;

  function requireHandle() {
    if (handle === 0) {
      throw new Error('REBOUND simulation has not been created');
    }
  }

  return {
    create({ gravitationalConstant }) {
      if (handle !== 0) {
        throw new Error('REBOUND simulation already exists');
      }
      handle = module._stary_reb_create(gravitationalConstant);
      if (handle === 0) {
        throw new Error('create failed: gravitationalConstant must be finite and positive');
      }
    },
    reset({ gravitationalConstant }) {
      requireHandle();
      checkStatus('reset', module._stary_reb_reset(handle, gravitationalConstant));
    },
    addParticle({ mass, radius, position, velocity }) {
      requireHandle();
      checkStatus(
        'addParticle',
        module._stary_reb_add_particle(
          handle,
          mass,
          radius,
          position.x,
          position.y,
          position.z,
          velocity.x,
          velocity.y,
          velocity.z,
        ),
      );
    },
    setIntegrator(name, timestepSeconds) {
      requireHandle();
      const integrator = name === 'ias15' ? 0 : name === 'whfast' ? 1 : -1;
      checkStatus(
        'setIntegrator',
        module._stary_reb_set_integrator(handle, integrator, timestepSeconds),
      );
    },
    moveToCenterOfMass() {
      requireHandle();
      checkStatus('moveToCenterOfMass', module._stary_reb_move_to_com(handle));
    },
    integrate(targetTimeSeconds) {
      requireHandle();
      checkStatus('integrate', module._stary_reb_integrate(handle, targetTimeSeconds));
    },
    advanceUntilEvent(targetTimeSeconds) {
      requireHandle();
      const status = module._stary_reb_advance_until_event(handle, targetTimeSeconds);
      if (status === 0) {
        return { type: 'advanced', state: this.getState() };
      }
      if (status !== 1) {
        throw new Error(`advanceUntilEvent failed with status ${status}`);
      }
      const pairCount = module._stary_reb_contact_count(handle);
      const pairs = Array.from({ length: pairCount }, (_, pairIndex) => [
        module._stary_reb_contact_particle_index(handle, pairIndex, 0),
        module._stary_reb_contact_particle_index(handle, pairIndex, 1),
      ]);
      return {
        type: 'contact',
        timeSeconds: module._stary_reb_contact_time(handle),
        pairs,
        state: this.getState(),
      };
    },
    clearContact() {
      requireHandle();
      checkStatus('clearContact', module._stary_reb_clear_contact(handle));
    },
    getTemporaryCopyCount() {
      requireHandle();
      return module._stary_reb_temporary_copy_count(handle);
    },
    getState() {
      requireHandle();
      const count = module._stary_reb_particle_count(handle);
      if (count < 0) {
        throw new Error('getState failed');
      }
      const particles = Array.from({ length: count }, (_, particleIndex) =>
        Object.fromEntries(
          COMPONENTS.map((component, componentIndex) => [
            component,
            module._stary_reb_get_particle_value(handle, particleIndex, componentIndex),
          ]),
        ),
      );
      return { timeSeconds: module._stary_reb_get_time(handle), particles };
    },
    getDiagnostics() {
      requireHandle();
      return {
        energy: module._stary_reb_energy(handle),
        angularMomentum: {
          x: module._stary_reb_angular_momentum_value(handle, 0),
          y: module._stary_reb_angular_momentum_value(handle, 1),
          z: module._stary_reb_angular_momentum_value(handle, 2),
        },
      };
    },
    destroy() {
      if (handle !== 0) {
        module._stary_reb_destroy(handle);
        handle = 0;
      }
    },
  };
}
