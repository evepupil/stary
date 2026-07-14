export const CELESTIAL_GROUPS = [
  { id: 'star', label: '恒星', order: 0 },
  { id: 'inner-planet', label: '内行星', order: 1 },
  { id: 'outer-planet', label: '外行星', order: 2 },
  { id: 'satellite', label: '卫星', order: 3 },
] as const;

export type CelestialGroupId = (typeof CELESTIAL_GROUPS)[number]['id'];

export interface CelestialCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly order: number;
  readonly color: number;
  readonly orbitParentId: string | null;
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

export function getCelestialCatalogEntry(bodyId: string): CelestialCatalogEntry | null {
  return catalogById.get(bodyId) ?? null;
}

export function celestialColorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
