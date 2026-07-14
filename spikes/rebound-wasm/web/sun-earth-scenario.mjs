export const PHYSICAL_CONSTANTS = Object.freeze({
  gravitationalConstant: 6.6743e-11,
  sunMassKg: 1.98847e30,
  earthMassKg: 5.9722e24,
  astronomicalUnitMeters: 149_597_870_700,
  sunRadiusMeters: 695_700_000,
  earthRadiusMeters: 6_371_000,
});

export const ACCEPTANCE_LIMITS = Object.freeze({
  positionRelativeError: 1e-9,
  velocityRelativeError: 1e-9,
  periodRelativeError: 1e-10,
  radiusRelativeError: 1e-10,
  energyRelativeError1000Periods: 1e-9,
  angularMomentumRelativeError1000Periods: 1e-9,
});

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function relativePosition(state) {
  const [sun, earth] = state.particles;
  return subtract(earth, sun);
}

function relativeVelocity(state) {
  const [sun, earth] = state.particles;
  return {
    x: earth.vx - sun.vx,
    y: earth.vy - sun.vy,
    z: earth.vz - sun.vz,
  };
}

function relativeError(initial, final) {
  return Math.abs((final - initial) / initial);
}

function vectorRelativeError(initial, final) {
  return magnitude(subtract(final, initial)) / magnitude(initial);
}

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function evaluateOnePeriod(metrics) {
  const failures = Object.entries(ACCEPTANCE_LIMITS)
    .filter(([name]) => name in metrics)
    .filter(([name, limit]) => metrics[name] > limit)
    .map(([name, limit]) => `${name}=${metrics[name]} exceeds ${limit}`);
  return { passed: failures.length === 0, failures };
}

export function createSunEarthScenario(rebound) {
  const constants = PHYSICAL_CONSTANTS;
  const totalMass = constants.sunMassKg + constants.earthMassKg;
  const angularVelocity = Math.sqrt(
    (constants.gravitationalConstant * totalMass) /
      constants.astronomicalUnitMeters ** 3,
  );
  const periodSeconds = (2 * Math.PI) / angularVelocity;
  const sunDistance =
    (constants.astronomicalUnitMeters * constants.earthMassKg) / totalMass;
  const earthDistance =
    (constants.astronomicalUnitMeters * constants.sunMassKg) / totalMass;

  rebound.create({ gravitationalConstant: constants.gravitationalConstant });
  rebound.addParticle({
    mass: constants.sunMassKg,
    radius: constants.sunRadiusMeters,
    position: { x: -sunDistance, y: 0, z: 0 },
    velocity: { x: 0, y: -angularVelocity * sunDistance, z: 0 },
  });
  rebound.addParticle({
    mass: constants.earthMassKg,
    radius: constants.earthRadiusMeters,
    position: { x: earthDistance, y: 0, z: 0 },
    velocity: { x: 0, y: angularVelocity * earthDistance, z: 0 },
  });
  rebound.setIntegrator("ias15", periodSeconds / 1_000);
  rebound.moveToCenterOfMass();

  const initialState = rebound.getState();
  const initialPosition = relativePosition(initialState);
  const initialVelocity = relativeVelocity(initialState);
  const initialDiagnostics = rebound.getDiagnostics();

  return {
    periodSeconds,
    runOnePeriod() {
      rebound.integrate(periodSeconds);
      const finalState = rebound.getState();
      const finalPosition = relativePosition(finalState);
      const finalVelocity = relativeVelocity(finalState);
      const phaseError = wrapAngle(
        Math.atan2(finalPosition.y, finalPosition.x) -
          Math.atan2(initialPosition.y, initialPosition.x),
      );
      return {
        positionRelativeError: vectorRelativeError(initialPosition, finalPosition),
        velocityRelativeError: vectorRelativeError(initialVelocity, finalVelocity),
        periodRelativeError: Math.abs(phaseError) / (2 * Math.PI),
        radiusRelativeError: relativeError(
          magnitude(initialPosition),
          magnitude(finalPosition),
        ),
      };
    },
    runLongTerm(periods) {
      if (periods !== 1_000) {
        throw new Error("The M0 long-term acceptance run is fixed at 1000 periods");
      }
      const periodsPerSlice = 1;
      for (let completed = periodsPerSlice; completed <= periods; completed += periodsPerSlice) {
        rebound.integrate(periodSeconds * completed);
      }
      const finalDiagnostics = rebound.getDiagnostics();
      return {
        energyRelativeError1000Periods: relativeError(
          initialDiagnostics.energy,
          finalDiagnostics.energy,
        ),
        angularMomentumRelativeError1000Periods: relativeError(
          magnitude(initialDiagnostics.angularMomentum),
          magnitude(finalDiagnostics.angularMomentum),
        ),
      };
    },
    destroy() {
      rebound.destroy();
    },
  };
}
