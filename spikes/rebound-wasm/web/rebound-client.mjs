import createReboundModule from "../dist/rebound.mjs";

const COMPONENTS = ["mass", "radius", "x", "y", "z", "vx", "vy", "vz"];

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
      throw new Error("REBOUND simulation has not been created");
    }
  }

  return {
    create({ gravitationalConstant }) {
      if (handle !== 0) {
        throw new Error("REBOUND simulation already exists");
      }
      handle = module._stary_reb_create(gravitationalConstant);
      if (handle === 0) {
        throw new Error("create failed: gravitationalConstant must be finite and positive");
      }
    },
    reset({ gravitationalConstant }) {
      requireHandle();
      checkStatus("reset", module._stary_reb_reset(handle, gravitationalConstant));
    },
    addParticle({ mass, radius, position, velocity }) {
      requireHandle();
      checkStatus(
        "addParticle",
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
      const integrator = name === "ias15" ? 0 : name === "whfast" ? 1 : -1;
      checkStatus(
        "setIntegrator",
        module._stary_reb_set_integrator(handle, integrator, timestepSeconds),
      );
    },
    moveToCenterOfMass() {
      requireHandle();
      checkStatus("moveToCenterOfMass", module._stary_reb_move_to_com(handle));
    },
    integrate(targetTimeSeconds) {
      requireHandle();
      checkStatus("integrate", module._stary_reb_integrate(handle, targetTimeSeconds));
    },
    getState() {
      requireHandle();
      const count = module._stary_reb_particle_count(handle);
      if (count < 0) {
        throw new Error("getState failed");
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
