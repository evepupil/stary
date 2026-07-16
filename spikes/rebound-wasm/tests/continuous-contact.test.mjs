import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createReboundClient } from '../web/rebound-client.mjs';

const wasmBinary = await readFile(new URL('../dist/rebound.wasm', import.meta.url));

async function createLinearClient(particles, timestepSeconds) {
  const rebound = await createReboundClient({ wasmBinary });
  rebound.create({ gravitationalConstant: 1 });
  for (const particle of particles) {
    rebound.addParticle({ mass: 0, ...particle });
  }
  rebound.setIntegrator('ias15', timestepSeconds);
  return rebound;
}

function particle({ x, y = 0, vx, vy = 0, radius = 1, mass }) {
  return {
    ...(mass === undefined ? {} : { mass }),
    radius,
    position: { x, y, z: 0 },
    velocity: { x: vx, y: vy, z: 0 },
  };
}

async function createTurnaroundClient() {
  const rebound = await createReboundClient({ wasmBinary });
  rebound.create({ gravitationalConstant: 1 });
  rebound.addParticle(particle({ x: 0, vx: 0, radius: 0.76, mass: 100 }));
  rebound.addParticle(particle({ x: 1.5, vx: 1, vy: 7, radius: 0.76, mass: 0 }));
  rebound.setIntegrator('ias15', 1);
  return rebound;
}

async function createStationaryContactGroups(groupSizes) {
  const rebound = await createReboundClient({ wasmBinary });
  rebound.create({ gravitationalConstant: 1 });
  for (let groupIndex = 0; groupIndex < groupSizes.length; groupIndex += 1) {
    for (let index = 0; index < groupSizes[groupIndex]; index += 1) {
      rebound.addParticle(particle({ x: groupIndex * 10, vx: 0, mass: 0 }));
    }
  }
  rebound.setIntegrator('ias15', 1);
  return rebound;
}

function pairMotion(state) {
  const first = state.particles[0];
  const second = state.particles[1];
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const dz = second.z - first.z;
  const dvx = second.vx - first.vx;
  const dvy = second.vy - first.vy;
  const dvz = second.vz - first.vz;
  const distance = Math.hypot(dx, dy, dz);
  return {
    distance,
    radialSpeed: (dx * dvx + dy * dvy + dz * dvz) / distance,
  };
}

test('continuous contact finds a high-speed mid-step crossing and releases every copy', async () => {
  const rebound = await createLinearClient(
    [particle({ x: -10, vx: 10 }), particle({ x: 10, vx: -10 })],
    2,
  );
  try {
    const result = rebound.advanceUntilEvent(2);
    assert.equal(result.type, 'contact');
    assert.ok(Math.abs(result.timeSeconds - 0.9) <= 1e-9);
    assert.deepEqual(result.pairs, [[0, 1]]);
    assert.equal(result.state.timeSeconds, result.timeSeconds);
    assert.equal(rebound.getTemporaryCopyCount(), 0);
    assert.throws(() => rebound.integrate(2), /status -3/);

    rebound.clearContact();
    rebound.clearContact();
  } finally {
    rebound.destroy();
  }
});

test('tangent contact uses the distance minimum and acknowledgement prevents a repeat', async () => {
  const tangent = await createLinearClient(
    [particle({ x: -10, y: 2, vx: 1 }), particle({ x: 0, vx: 0 })],
    20,
  );
  try {
    const contact = tangent.advanceUntilEvent(20);
    assert.equal(contact.type, 'contact');
    assert.ok(Math.abs(contact.timeSeconds - 10) <= 1e-9);
    tangent.clearContact();
    assert.deepEqual(tangent.advanceUntilEvent(20), {
      type: 'advanced',
      state: {
        timeSeconds: 20,
        particles: [
          { mass: 0, radius: 1, x: 10, y: 2, z: 0, vx: 1, vy: 0, vz: 0 },
          { mass: 0, radius: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
        ],
      },
    });
  } finally {
    tangent.destroy();
  }

  const outside = await createLinearClient(
    [particle({ x: -10, y: 2.001, vx: 1 }), particle({ x: 0, vx: 0 })],
    20,
  );
  try {
    assert.equal(outside.advanceUntilEvent(20).type, 'advanced');
    assert.equal(outside.getTemporaryCopyCount(), 0);
  } finally {
    outside.destroy();
  }

  const innerOffset = 2 - 1e-10;
  const shallowPenetration = await createLinearClient(
    [particle({ x: -10, y: innerOffset, vx: 1 }), particle({ x: 0, vx: 0 })],
    20,
  );
  try {
    const expectedEntryTime = 10 - Math.sqrt(4 - innerOffset * innerOffset);
    const result = shallowPenetration.advanceUntilEvent(20);
    assert.equal(result.type, 'contact');
    assert.ok(Math.abs(result.timeSeconds - expectedEntryTime) <= 1e-9);
  } finally {
    shallowPenetration.destroy();
  }
});

test('initial overlap is reported only while approaching or stationary', async () => {
  const approaching = await createLinearClient(
    [particle({ x: 0, vx: 1 }), particle({ x: 1, vx: -1 })],
    1,
  );
  try {
    const result = approaching.advanceUntilEvent(0);
    assert.equal(result.type, 'contact');
    assert.equal(result.timeSeconds, 0);
  } finally {
    approaching.destroy();
  }

  const separating = await createLinearClient(
    [particle({ x: 0, vx: -1 }), particle({ x: 1, vx: 1 })],
    1,
  );
  try {
    assert.equal(separating.advanceUntilEvent(0).type, 'advanced');
    const result = separating.advanceUntilEvent(1);
    assert.equal(result.type, 'advanced');
    assert.equal(result.state.timeSeconds, 1);
    assert.equal(separating.getTemporaryCopyCount(), 0);
  } finally {
    separating.destroy();
  }
});

test('time clustering keeps every pair whose root is inside the event tolerance', async () => {
  const rebound = await createLinearClient(
    [
      particle({ x: 0, vx: 500 }),
      particle({ x: 10, vx: -500 }),
      particle({ x: 0, y: 100, vx: 500 }),
      particle({ x: 10.0000005, y: 100, vx: -500 }),
    ],
    0.02,
  );
  try {
    const result = rebound.advanceUntilEvent(0.02);
    assert.equal(result.type, 'contact');
    assert.ok(Math.abs(result.timeSeconds - 0.008) <= 1e-9);
    assert.deepEqual(result.pairs, [
      [0, 1],
      [2, 3],
    ]);
    assert.equal(rebound.getTemporaryCopyCount(), 0);
  } finally {
    rebound.destroy();
  }
});

test('time-tolerance clustering keeps pairs inside the common distance tolerance', async () => {
  const rebound = await createLinearClient(
    [
      particle({ x: 0, vx: 0.05 }),
      particle({ x: 2.0008, vx: -0.05 }),
      particle({ x: 0, y: 100, vx: 0.05 }),
      particle({ x: 2.00080000005, y: 100, vx: -0.05 }),
    ],
    0.02,
  );
  try {
    const result = rebound.advanceUntilEvent(0.02);
    assert.equal(result.type, 'contact');
    assert.ok(Math.abs(result.timeSeconds - 0.008) <= 1e-9);
    assert.deepEqual(result.pairs, [
      [0, 1],
      [2, 3],
    ]);
  } finally {
    rebound.destroy();
  }
});

test('no-event advance is value-for-value equal to the legacy integrate path', async () => {
  const particles = [particle({ x: -10, y: 20, vx: 10 }), particle({ x: 0, vx: 0 })];
  const legacy = await createLinearClient(particles, 2);
  const eventAware = await createLinearClient(particles, 2);
  try {
    legacy.integrate(2);
    const result = eventAware.advanceUntilEvent(2);
    assert.equal(result.type, 'advanced');
    assert.deepEqual(result.state, legacy.getState());
    assert.equal(eventAware.getTemporaryCopyCount(), 0);
  } finally {
    legacy.destroy();
    eventAware.destroy();
  }
});

test('a strongly curved circular near-pass is not mistaken for a chord crossing', async () => {
  const rebound = await createReboundClient({ wasmBinary });
  rebound.create({ gravitationalConstant: 1 });
  rebound.addParticle(particle({ x: 0, vx: 0, radius: 1, y: 0, vy: 0, mass: 100 }));
  rebound.addParticle(particle({ x: 10, vx: 0, radius: 1, y: 0, vy: Math.sqrt(10), mass: 0 }));
  rebound.setIntegrator('ias15', 20);
  try {
    const halfPeriod = Math.PI * Math.sqrt(10);
    const result = rebound.advanceUntilEvent(halfPeriod);
    assert.equal(result.type, 'advanced');
    assert.equal(result.state.timeSeconds, halfPeriod);
    assert.equal(rebound.getTemporaryCopyCount(), 0);
  } finally {
    rebound.destroy();
  }
});

test('a separating overlap is re-armed even when the interval ends farther outward', async () => {
  const rebound = await createTurnaroundClient();
  const reference = await createTurnaroundClient();
  try {
    assert.equal(rebound.advanceUntilEvent(0).type, 'advanced');
    const result = rebound.advanceUntilEvent(0.85);
    assert.equal(result.type, 'contact');
    assert.ok(Math.abs(result.timeSeconds - 0.14456716184257185) <= 1e-9);
    assert.deepEqual(result.pairs, [[0, 1]]);
    assert.equal(rebound.getTemporaryCopyCount(), 0);

    reference.integrate(0.03);
    const separated = pairMotion(reference.getState());
    assert.ok(separated.distance > 1.52);
    assert.ok(separated.radialSpeed > 0);

    reference.integrate(0.12);
    const returning = pairMotion(reference.getState());
    assert.ok(returning.distance > 1.52);
    assert.ok(returning.radialSpeed < 0);

    reference.integrate(0.85);
    const outwardEnd = pairMotion(reference.getState());
    assert.ok(outwardEnd.distance > 1.5);
    assert.ok(outwardEnd.radialSpeed > 0);
  } finally {
    rebound.destroy();
    reference.destroy();
  }
});

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function contactingPairs(state) {
  const pairs = [];
  for (let firstIndex = 0; firstIndex < state.particles.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < state.particles.length; secondIndex += 1) {
      const first = state.particles[firstIndex];
      const second = state.particles[secondIndex];
      const distance = Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
      if (distance <= first.radius + second.radius) {
        pairs.push([firstIndex, secondIndex]);
      }
    }
  }
  return pairs;
}

async function createGravityClient(particles, timestepSeconds) {
  const rebound = await createReboundClient({ wasmBinary });
  rebound.create({ gravitationalConstant: 0.05 });
  for (const entry of particles) {
    rebound.addParticle(entry);
  }
  rebound.setIntegrator('ias15', timestepSeconds);
  return rebound;
}

test('seeded 2..10 body gravity cases match a 200x finer REBOUND reference', async () => {
  const horizonSeconds = 2;
  const referenceStepSeconds = horizonSeconds / 200;
  for (let bodyCount = 2; bodyCount <= 10; bodyCount += 1) {
    const random = createRandom(0x5a17 + bodyCount);
    const yOffset = (random() - 0.5) * 0.5;
    const speed = 3.5 + random();
    const particles = [
      {
        mass: 6 + random() * 4,
        ...particle({ x: -5, y: -yOffset, vx: speed }),
      },
      {
        mass: 6 + random() * 4,
        ...particle({ x: 5, y: yOffset, vx: -speed }),
      },
    ];
    for (let index = 2; index < bodyCount; index += 1) {
      particles.push({
        mass: 1 + random() * 4,
        ...particle({
          x: 12 + random() * 18,
          y: 15 + index * 9 + random() * 4,
          vx: (random() - 0.5) * 2,
          vy: (random() - 0.5) * 2,
          radius: 0.3 + random() * 0.5,
        }),
      });
    }

    const reference = await createGravityClient(particles, referenceStepSeconds);
    let referenceContact = null;
    try {
      for (let sample = 1; sample <= 200; sample += 1) {
        const timeSeconds = sample * referenceStepSeconds;
        reference.integrate(timeSeconds);
        const pairs = contactingPairs(reference.getState());
        if (pairs.length > 0) {
          referenceContact = { pairs, timeSeconds };
          break;
        }
      }
    } finally {
      reference.destroy();
    }
    assert.notEqual(referenceContact, null);

    const rebound = await createGravityClient(particles, horizonSeconds);
    try {
      const result = rebound.advanceUntilEvent(horizonSeconds);
      assert.equal(result.type, 'contact');
      assert.ok(result.timeSeconds <= referenceContact.timeSeconds + 1e-9);
      assert.ok(referenceContact.timeSeconds - result.timeSeconds <= referenceStepSeconds + 1e-9);
      assert.ok(
        referenceContact.pairs.some((pair) =>
          result.pairs.some((candidate) => candidate[0] === pair[0] && candidate[1] === pair[1]),
        ),
      );
      assert.equal(rebound.getTemporaryCopyCount(), 0);
    } finally {
      rebound.destroy();
    }
  }
});

test('contact-set capacity accepts 4096 pairs and rejects the next pair', async () => {
  const atCapacity = await createStationaryContactGroups([91, 2]);
  try {
    const result = atCapacity.advanceUntilEvent(0);
    assert.equal(result.type, 'contact');
    assert.equal(result.pairs.length, 4096);
    assert.equal(new Set(result.pairs.map((pair) => pair.join(':'))).size, 4096);
    assert.equal(atCapacity.getTemporaryCopyCount(), 0);
  } finally {
    atCapacity.destroy();
  }

  const overflow = await createStationaryContactGroups([91, 2, 2]);
  try {
    assert.throws(() => overflow.advanceUntilEvent(0), /status -7/);
    assert.equal(overflow.getState().timeSeconds, 0);
    assert.equal(overflow.getTemporaryCopyCount(), 0);
  } finally {
    overflow.destroy();
  }
});

test('continuous contact rejects non-IAS15 simulations', async () => {
  const rebound = await createLinearClient(
    [particle({ x: -10, vx: 1 }), particle({ x: 10, vx: -1 })],
    1,
  );
  try {
    rebound.setIntegrator('whfast', 1);
    assert.throws(() => rebound.advanceUntilEvent(1), /status -5/);
    assert.equal(rebound.getTemporaryCopyCount(), 0);
  } finally {
    rebound.destroy();
  }
});
