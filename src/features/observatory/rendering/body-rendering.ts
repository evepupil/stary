import { getCelestialCatalogEntry } from '../catalog';

export type BodyRenderingKind = 'black-hole' | 'solid' | 'star';

export interface BodyRenderingProfile {
  readonly color: number;
  readonly emitsLight: boolean;
  readonly kind: BodyRenderingKind;
}

const FALLBACK_BODY_COLOR = 0x8ba4b3;

export function resolveBodyRenderingProfile(bodyId: string): BodyRenderingProfile {
  const metadata = getCelestialCatalogEntry(bodyId);
  const color = metadata?.color ?? FALLBACK_BODY_COLOR;

  if (metadata?.group === 'star') {
    return { color, emitsLight: true, kind: 'star' };
  }
  if (metadata?.group === 'compact-object') {
    return { color, emitsLight: false, kind: 'black-hole' };
  }
  return { color, emitsLight: false, kind: 'solid' };
}
