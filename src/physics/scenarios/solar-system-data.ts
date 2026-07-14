export const SOLAR_SYSTEM_EPOCH = {
  isoTdb: '2000-01-01T12:00:00 TDB',
  julianDayTdb: 2_451_545,
  referenceFrame: 'J2000 ecliptic, ICRF, solar-system barycenter',
  source: 'JPL Horizons geometric vectors with DE441 solar-system barycenter',
  retrievedOn: '2026-07-14',
} as const;

export const HORIZONS_API_DOCUMENTATION_URL = 'https://ssd-api.jpl.nasa.gov/doc/horizons.html';

export const SOLAR_SYSTEM_HORIZONS_QUERY = {
  center: '@0',
  ephemerisType: 'VECTORS',
  makeEphemeris: 'YES',
  objectData: 'NO',
  outputUnits: 'KM-S',
  referencePlane: 'ECLIPTIC',
  referenceSystem: 'ICRF',
  startTime: 'JD2451545.0',
  stepSize: '1d',
  stopTime: 'JD2451545.1',
  vectorCorrection: 'NONE',
  vectorTable: '2',
} as const;

export interface HorizonsBodyRecord {
  readonly id: string;
  readonly horizonsId: number;
  readonly ephemerisSource: string;
  readonly gmKm3PerSecond2: number;
  readonly meanRadiusKm: number;
  readonly positionKm: readonly [x: number, y: number, z: number];
  readonly velocityKmPerSecond: readonly [vx: number, vy: number, vz: number];
}

// Fixed Horizons vectors use CENTER='@0', START_TIME='JD2451545.0', OUT_UNITS='KM-S',
// REF_PLANE='ECLIPTIC', REF_SYSTEM='ICRF', VEC_TABLE='2', and VEC_CORR='NONE'.
export const SOLAR_SYSTEM_HORIZONS_RECORDS = [
  {
    id: 'sun',
    horizonsId: 10,
    ephemerisSource: 'DE441',
    gmKm3PerSecond2: 132_712_440_041.93938,
    meanRadiusKm: 695_700,
    positionKm: [-1.067706805380953e6, -4.182752718194473e5, 3.08618172547682e4],
    velocityKmPerSecond: [9.312571926520472e-3, -1.282475570794162e-2, -1.633507186350417e-4],
  },
  {
    id: 'mercury',
    horizonsId: 199,
    ephemerisSource: 'DE441',
    gmKm3PerSecond2: 22_031.86855,
    meanRadiusKm: 2_439.4,
    positionKm: [-2.052943316123468e7, -6.733155053534345e7, -3.648992526494771e6],
    velocityKmPerSecond: [37.00430442920571, -11.17724068132644, -4.307791469376854],
  },
  {
    id: 'venus',
    horizonsId: 299,
    ephemerisSource: 'DE441',
    gmKm3PerSecond2: 324_858.592,
    meanRadiusKm: 6_051.84,
    positionKm: [-1.085242008575715e8, -5.303290247691983e6, 6.166496116973171e6],
    velocityKmPerSecond: [1.391218601189967, -35.15311993215464, -0.5602056890007159],
  },
  {
    id: 'earth',
    horizonsId: 399,
    ephemerisSource: 'DE441',
    gmKm3PerSecond2: 398_600.435436,
    meanRadiusKm: 6_371.01,
    positionKm: [-2.756674048281145e7, 1.442790215207299e8, 3.02506678288132e4],
    velocityKmPerSecond: [-29.78494749851088, -5.482119695478543, 1.843295986780902e-5],
  },
  {
    id: 'moon',
    horizonsId: 301,
    ephemerisSource: 'DE441',
    gmKm3PerSecond2: 4_902.800066,
    meanRadiusKm: 1_737.53,
    positionKm: [-2.785834886699916e7, 1.440040417790567e8, 6.652186445580423e4],
    velocityKmPerSecond: [-29.14141610952193, -6.213103678165645, -0.01148803177931867],
  },
  {
    id: 'mars',
    horizonsId: 499,
    ephemerisSource: 'mar099',
    gmKm3PerSecond2: 42_828.375662,
    meanRadiusKm: 3_389.92,
    positionKm: [2.06980433836461e8, -2.425327899844669e6, -5.125427142013255e6],
    velocityKmPerSecond: [1.171984975692608, 26.28323978975472, 0.5221336722766505],
  },
  {
    id: 'jupiter',
    horizonsId: 599,
    ephemerisSource: 'jup365_merged',
    gmKm3PerSecond2: 126_686_531.9,
    meanRadiusKm: 69_911,
    positionKm: [5.974999178516835e8, 4.391864046763535e8, -1.519599985573271e7],
    velocityKmPerSecond: [-7.900547720245487, 11.14339277065934, 0.1307023308637314],
  },
  {
    id: 'saturn',
    horizonsId: 699,
    ephemerisSource: 'sat441l',
    gmKm3PerSecond2: 37_931_206.234,
    meanRadiusKm: 58_232,
    positionKm: [9.573176521103407e8, 9.824380076875086e8, -5.518211788150036e7],
    velocityKmPerSecond: [-7.42190038683812, 6.723930997200832, 0.1775749426205731],
  },
  {
    id: 'uranus',
    horizonsId: 799,
    ephemerisSource: 'ura184_merged',
    gmKm3PerSecond2: 5_793_950.6103,
    meanRadiusKm: 25_362,
    positionKm: [2.157907112723417e9, -2.055043811740037e9, -3.559463949961483e7],
    velocityKmPerSecond: [4.646584677611653, 4.614773473441427, -0.04308521888870875],
  },
  {
    id: 'neptune',
    horizonsId: 899,
    ephemerisSource: 'nep098_merged',
    gmKm3PerSecond2: 6_835_099.97,
    meanRadiusKm: 24_624,
    positionKm: [2.513978816984908e9, -3.73913284289397e9, 1.906307876980734e7],
    velocityKmPerSecond: [4.47458791838248, 3.06315514301819, -0.1664119952893173],
  },
] as const satisfies readonly HorizonsBodyRecord[];
