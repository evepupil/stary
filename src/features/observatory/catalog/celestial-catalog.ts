import { getCreationPreset, parseCreatedBodyId } from '../../creation/model/body-presets';

export const CELESTIAL_GROUPS = [
  { id: 'star', label: '恒星', order: 0 },
  { id: 'inner-planet', label: '内行星', order: 1 },
  { id: 'outer-planet', label: '外行星', order: 2 },
  { id: 'satellite', label: '卫星', order: 3 },
  { id: 'compact-object', label: '致密天体', order: 4 },
  { id: 'minor-body', label: '小天体', order: 5 },
  { id: 'collision-remnant', label: '碰撞产物', order: 6 },
] as const;

export type CelestialGroupId = (typeof CELESTIAL_GROUPS)[number]['id'];

export interface CelestialCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly order: number;
  readonly color: number;
  readonly orbitParentId?: string | null;
  readonly group: CelestialGroupId;
}

export const CELESTIAL_CATALOG = [
  {
    id: 'sun',
    name: '太阳',
    type: 'G2V 恒星',
    order: 0,
    color: 0xffd27a,
    orbitParentId: null,
    group: 'star',
  },
  {
    id: 'mercury',
    name: '水星',
    type: '岩质行星',
    order: 1,
    color: 0x9c9691,
    orbitParentId: 'sun',
    group: 'inner-planet',
  },
  {
    id: 'venus',
    name: '金星',
    type: '岩质行星',
    order: 2,
    color: 0xd8a866,
    orbitParentId: 'sun',
    group: 'inner-planet',
  },
  {
    id: 'earth',
    name: '地球',
    type: '岩质行星',
    order: 3,
    color: 0x4d9bd6,
    orbitParentId: 'sun',
    group: 'inner-planet',
  },
  {
    id: 'moon',
    name: '月球',
    type: '天然卫星',
    order: 4,
    color: 0xb8b7b2,
    orbitParentId: 'earth',
    group: 'satellite',
  },
  {
    id: 'mars',
    name: '火星',
    type: '岩质行星',
    order: 5,
    color: 0xc96547,
    orbitParentId: 'sun',
    group: 'inner-planet',
  },
  {
    id: 'jupiter',
    name: '木星',
    type: '气态巨行星',
    order: 6,
    color: 0xcfa47a,
    orbitParentId: 'sun',
    group: 'outer-planet',
  },
  {
    id: 'saturn',
    name: '土星',
    type: '气态巨行星',
    order: 7,
    color: 0xd6c690,
    orbitParentId: 'sun',
    group: 'outer-planet',
  },
  {
    id: 'uranus',
    name: '天王星',
    type: '冰巨行星',
    order: 8,
    color: 0x77bfd0,
    orbitParentId: 'sun',
    group: 'outer-planet',
  },
  {
    id: 'neptune',
    name: '海王星',
    type: '冰巨行星',
    order: 9,
    color: 0x4169b0,
    orbitParentId: 'sun',
    group: 'outer-planet',
  },
] as const satisfies readonly CelestialCatalogEntry[];

const catalogById: ReadonlyMap<string, CelestialCatalogEntry> = new Map(
  CELESTIAL_CATALOG.map((entry) => [entry.id, entry]),
);

// Rust 碰撞内核以 `major-<FNV-1a 64 十六进制>` 形式生成主要残体的确定性 ID。
const COLLISION_REMNANT_ID_PATTERN = /^major-([0-9a-f]{16})$/;

function getCollisionRemnantCatalogEntry(bodyId: string): CelestialCatalogEntry | null {
  const hash = COLLISION_REMNANT_ID_PATTERN.exec(bodyId)?.[1];
  if (hash === undefined) {
    return null;
  }
  return {
    id: bodyId,
    name: `碰撞残体 ${hash.slice(0, 6)}`,
    type: '碰撞残体',
    order: 20_000,
    color: 0xc79a6b,
    group: 'collision-remnant',
  };
}

export function getCelestialCatalogEntry(bodyId: string): CelestialCatalogEntry | null {
  const catalogEntry = catalogById.get(bodyId);
  if (catalogEntry !== undefined) {
    return catalogEntry;
  }

  const remnantEntry = getCollisionRemnantCatalogEntry(bodyId);
  if (remnantEntry !== null) {
    return remnantEntry;
  }

  const identity = parseCreatedBodyId(bodyId);
  if (identity === null) {
    return null;
  }
  const preset = getCreationPreset(identity.presetId);
  const ordinalLabel = String(identity.ordinal).padStart(2, '0');
  const memberLabel =
    identity.memberIndex === null ? '' : `-${String(identity.memberIndex).padStart(2, '0')}`;
  const groupByPreset = {
    star: 'star',
    'rocky-planet': 'inner-planet',
    'gas-giant': 'outer-planet',
    moon: 'satellite',
    'black-hole': 'compact-object',
    'asteroid-cluster': 'minor-body',
  } as const satisfies Record<typeof identity.presetId, CelestialGroupId>;

  return {
    id: bodyId,
    name:
      identity.presetId === 'asteroid-cluster'
        ? `小行星 ${ordinalLabel}${memberLabel}`
        : `${preset.label} ${ordinalLabel}`,
    type: preset.typeLabel,
    order: 10_000 + identity.ordinal * 100 + (identity.memberIndex ?? 0),
    color: preset.color,
    group: groupByPreset[identity.presetId],
  };
}

export function celestialColorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
