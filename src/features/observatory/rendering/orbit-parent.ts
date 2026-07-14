import type { BodyState } from '../../../physics/protocol/schemas';
import { getCelestialCatalogEntry } from '../catalog';

export function findOrbitParent(body: BodyState, bodies: readonly BodyState[]): BodyState | null {
  const catalogEntry = getCelestialCatalogEntry(body.id);
  if (catalogEntry !== null) {
    if (catalogEntry.orbitParentId === null) {
      return null;
    }
    return bodies.find((candidate) => candidate.id === catalogEntry.orbitParentId) ?? null;
  }

  const primary = findMostMassiveBody(bodies);
  return primary?.id === body.id ? null : primary;
}

export function findMostMassiveBody(bodies: readonly BodyState[]): BodyState | null {
  let primary: BodyState | null = null;
  for (const body of bodies) {
    if (primary === null || body.massKg > primary.massKg) {
      primary = body;
    }
  }
  return primary;
}
