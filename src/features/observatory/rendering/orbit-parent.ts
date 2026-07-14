import type { BodyState } from '../../../physics/protocol/schemas';
import { findDominantReferenceBody } from '../../creation/model/body-presets';
import { getCelestialCatalogEntry } from '../catalog';

export function findOrbitParent(body: BodyState, bodies: readonly BodyState[]): BodyState | null {
  const catalogEntry = getCelestialCatalogEntry(body.id);
  if (catalogEntry?.orbitParentId !== undefined) {
    if (catalogEntry.orbitParentId === null) {
      return null;
    }
    return bodies.find((candidate) => candidate.id === catalogEntry.orbitParentId) ?? null;
  }

  return findDominantReferenceBody(
    bodies.filter((candidate) => candidate.id !== body.id),
    body.positionMeters,
  );
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
