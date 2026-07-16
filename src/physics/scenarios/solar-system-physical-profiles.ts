import type { MaterialLayer } from '../collisions/schemas';
import type { BodyState } from '../protocol/schemas';
import { SOLAR_SYSTEM_HORIZONS_RECORDS } from './solar-system-data';

export type SolarSystemBodyId = (typeof SOLAR_SYSTEM_HORIZONS_RECORDS)[number]['id'];

export type SolarSystemPhysicalBodyFields = Pick<
  BodyState,
  | 'collisionModel'
  | 'materialLayers'
  | 'momentOfInertiaFactor'
  | 'spinAngularMomentumKgMetersSquaredPerSecond'
>;

export interface SolarSystemPhysicalProfile {
  readonly id: SolarSystemBodyId;
  readonly collisionModel: BodyState['collisionModel'];
  readonly materialLayers: readonly MaterialLayer[];
  readonly momentOfInertiaFactor: number;
  readonly rotationPeriodSeconds: number;
  readonly spinAxisEclipticJ2000: Readonly<
    BodyState['spinAngularMomentumKgMetersSquaredPerSecond']
  >;
  readonly spinAngularMomentumKgMetersSquaredPerSecond: Readonly<
    BodyState['spinAngularMomentumKgMetersSquaredPerSecond']
  >;
}

export const SOLAR_SYSTEM_PHYSICAL_PROFILE_SOURCES = {
  bulkRotation: {
    retrievedOn: '2026-07-16',
    title: 'JPL Solar System Dynamics Planetary Physical Parameters',
    url: 'https://ssd.jpl.nasa.gov/planets/phys_par.html',
  },
  rotationalElements: {
    doi: '10.1007/s10569-017-9805-5',
    title:
      'Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015',
  },
  jupiterInterior: {
    doi: '10.1002/2017GL073160',
    title:
      'Comparing Jupiter interior structure models to Juno gravity measurements and the role of a dilute core',
  },
  saturnInterior: {
    doi: '10.1038/s41550-021-01448-3',
    title: 'A diffuse core in Saturn revealed by ring seismology',
  },
  iceGiantInteriorReview: {
    doi: '10.1007/s11214-020-00660-3',
    title: 'Uranus and Neptune: Origin, Evolution and Internal Structure',
  },
  approximation:
    '材料质量分数、部分转动惯量因子和巨行星内部边界是 STARY 将公开范围压缩到四个有序材料桶后的确定性产品近似',
} as const;

const JULIAN_DAY_SECONDS = 86_400;

export const SOLAR_SYSTEM_PHYSICAL_PROFILES = [
  {
    id: 'sun',
    collisionModel: 'stellar',
    materialLayers: [{ material: 'gas', massFraction: 1 }],
    momentOfInertiaFactor: 0.07,
    rotationPeriodSeconds: 25.38 * JULIAN_DAY_SECONDS,
    spinAxisEclipticJ2000: {
      x: 0.122_353_493_470_95,
      y: -0.031_037_870_247_053_8,
      z: 0.992_001_145_788_643,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 2.361_776_730_1e40,
      y: -5.991_207_739_3e39,
      z: 1.914_849_470_9e41,
    },
  },
  {
    id: 'mercury',
    collisionModel: 'gravitySolid',
    materialLayers: [
      { material: 'silicate', massFraction: 0.3 },
      { material: 'iron', massFraction: 0.7 },
    ],
    momentOfInertiaFactor: 0.346,
    rotationPeriodSeconds: 58.646 * JULIAN_DAY_SECONDS,
    spinAxisEclipticJ2000: {
      x: 0.091_376_412_299_941,
      y: -0.081_621_376_630_944_9,
      z: 0.992_465_768_755_81,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 7.700_518_307_3e28,
      y: -6.878_437_106_4e28,
      z: 8.363_756_717_2e29,
    },
  },
  {
    id: 'venus',
    collisionModel: 'gravitySolid',
    materialLayers: [
      { material: 'silicate', massFraction: 0.68 },
      { material: 'iron', massFraction: 0.32 },
    ],
    momentOfInertiaFactor: 0.337,
    rotationPeriodSeconds: 243.025 * JULIAN_DAY_SECONDS,
    spinAxisEclipticJ2000: {
      x: -0.018_690_814_169_142_1,
      y: -0.010_872_522_859_509_8,
      z: -0.999_766_193_523_448,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: -3.360_038_468_9e29,
      y: -1.954_548_086_1e29,
      z: -1.797_274_768_1e31,
    },
  },
  {
    id: 'earth',
    collisionModel: 'gravitySolid',
    materialLayers: [
      { material: 'silicate', massFraction: 0.675 },
      { material: 'iron', massFraction: 0.325 },
    ],
    momentOfInertiaFactor: 0.3307,
    rotationPeriodSeconds: 86_164.0905,
    spinAxisEclipticJ2000: { x: 0, y: 0.397_777_155_927_088, z: 0.917_482_062_071_274 },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 0,
      y: 2.325_282_162_3e33,
      z: 5.363_316_222_1e33,
    },
  },
  {
    id: 'moon',
    collisionModel: 'gravitySolid',
    materialLayers: [
      { material: 'silicate', massFraction: 0.98 },
      { material: 'iron', massFraction: 0.02 },
    ],
    momentOfInertiaFactor: 0.393,
    rotationPeriodSeconds: 27.321_661 * JULIAN_DAY_SECONDS,
    spinAxisEclipticJ2000: {
      x: -0.022_608_671_404_183_7,
      y: -0.015_480_518_782_389_3,
      z: 0.999_624_530_269_023,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: -5.244_744_235_7e27,
      y: -3.591_160_232_2e27,
      z: 2.318_922_195_5e29,
    },
  },
  {
    id: 'mars',
    collisionModel: 'gravitySolid',
    materialLayers: [
      { material: 'silicate', massFraction: 0.78 },
      { material: 'iron', massFraction: 0.22 },
    ],
    momentOfInertiaFactor: 0.366,
    rotationPeriodSeconds: 1.025_957 * JULIAN_DAY_SECONDS,
    spinAxisEclipticJ2000: {
      x: 0.446_158_726_925_366,
      y: -0.055_511_601_088_224_7,
      z: 0.893_230_570_755_927,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 8.535_194_497_6e31,
      y: -1.061_959_082_2e31,
      z: 1.708_785_728_6e32,
    },
  },
  {
    id: 'jupiter',
    collisionModel: 'gravityFluid',
    materialLayers: [
      { material: 'gas', massFraction: 0.9 },
      { material: 'ice', massFraction: 0.06 },
      { material: 'silicate', massFraction: 0.03 },
      { material: 'iron', massFraction: 0.01 },
    ],
    momentOfInertiaFactor: 0.254,
    rotationPeriodSeconds: 9.925 * 3_600,
    spinAxisEclipticJ2000: {
      x: -0.014_597_290_902_234_5,
      y: -0.035_804_400_438_641_4,
      z: 0.999_252_202_403_149,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: -6.048_791_070_5e36,
      y: -1.483_654_324e37,
      z: 4.140_677_773_4e38,
    },
  },
  {
    id: 'saturn',
    collisionModel: 'gravityFluid',
    materialLayers: [
      { material: 'gas', massFraction: 0.75 },
      { material: 'ice', massFraction: 0.15 },
      { material: 'silicate', massFraction: 0.07 },
      { material: 'iron', massFraction: 0.03 },
    ],
    momentOfInertiaFactor: 0.21,
    rotationPeriodSeconds: 10.656 * 3_600,
    spinAxisEclipticJ2000: {
      x: 0.085_478_831_860_462_8,
      y: 0.462_441_677_591_006,
      z: 0.882_519_724_499_451,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 5.665_984_366_1e36,
      y: 3.065_305_477_9e37,
      z: 5.849_802_638_8e37,
    },
  },
  {
    id: 'uranus',
    collisionModel: 'gravityFluid',
    materialLayers: [
      { material: 'gas', massFraction: 0.15 },
      { material: 'ice', massFraction: 0.65 },
      { material: 'silicate', massFraction: 0.14 },
      { material: 'iron', massFraction: 0.06 },
    ],
    momentOfInertiaFactor: 0.225,
    rotationPeriodSeconds: 17.24 * 3_600,
    spinAxisEclipticJ2000: {
      x: 0.211_999_581_542_551,
      y: 0.967_989_001_879_331,
      z: -0.134_363_200_566_376,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 2.696_458_182_3e35,
      y: 1.231_201_422_9e36,
      z: -1.708_988_050_5e35,
    },
  },
  {
    id: 'neptune',
    collisionModel: 'gravityFluid',
    materialLayers: [
      { material: 'gas', massFraction: 0.15 },
      { material: 'ice', massFraction: 0.65 },
      { material: 'silicate', massFraction: 0.14 },
      { material: 'iron', massFraction: 0.06 },
    ],
    momentOfInertiaFactor: 0.23,
    rotationPeriodSeconds: 16.11 * 3_600,
    spinAxisEclipticJ2000: {
      x: 0.358_576_508_908_414,
      y: -0.314_409_592_871_241,
      z: 0.878_959_325_093_94,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 5.548_145_604_1e35,
      y: -4.864_764_303_4e35,
      z: 1.359_987_114_2e36,
    },
  },
] as const satisfies readonly SolarSystemPhysicalProfile[];

const physicalProfileById = new Map<SolarSystemBodyId, SolarSystemPhysicalProfile>(
  SOLAR_SYSTEM_PHYSICAL_PROFILES.map((profile) => [profile.id, profile]),
);

export function getSolarSystemPhysicalProfile(id: SolarSystemBodyId): SolarSystemPhysicalProfile {
  const profile = physicalProfileById.get(id);
  if (profile === undefined) {
    throw new Error(`缺少太阳系天体物理资料：${id}`);
  }
  return profile;
}

export function cloneSolarSystemPhysicalBodyFields(
  id: SolarSystemBodyId,
): SolarSystemPhysicalBodyFields {
  const profile = getSolarSystemPhysicalProfile(id);
  return {
    collisionModel: profile.collisionModel,
    materialLayers: profile.materialLayers.map((layer) => ({ ...layer })),
    momentOfInertiaFactor: profile.momentOfInertiaFactor,
    spinAngularMomentumKgMetersSquaredPerSecond: {
      ...profile.spinAngularMomentumKgMetersSquaredPerSecond,
    },
  };
}
