import type { BodyState } from '../../../../physics/protocol/schemas';
import { parseCreatedBodyId } from '../../../creation/model/body-presets';
import { getCelestialCatalogEntry } from '../../catalog';

export type BodySurfaceKind =
  'star' | 'rocky' | 'gas-giant' | 'ice-giant' | 'airless' | 'black-hole';

export interface StellarLightParameters {
  readonly color: number;
  readonly intensity: number;
  readonly luminositySolar: number;
  readonly luminosityWatts: number;
}

export interface BodyAppearanceProfile {
  readonly bodyId: string;
  readonly surfaceKind: BodySurfaceKind;
  readonly baseColor: number;
  readonly roughness: number;
  readonly emissiveColor: number;
  readonly emissiveIntensity: number;
  readonly light: StellarLightParameters | null;
  readonly temperatureKelvin: number | null;
  readonly structureKey: string;
  readonly structureSeed: number;
}

export interface MainSequenceStarEstimate {
  readonly luminositySolar: number;
  readonly luminosityWatts: number;
  readonly temperatureKelvin: number;
}

const SOLAR_MASS_KG = 1.988_47e30;
const SOLAR_RADIUS_METERS = 696_340_000;
const SOLAR_LUMINOSITY_WATTS = 3.828e26;
const SOLAR_EFFECTIVE_TEMPERATURE_KELVIN = 5_772;
const MINIMUM_STELLAR_MASS_SOLAR = 0.08;
const MAXIMUM_STELLAR_MASS_SOLAR = 100;
const MINIMUM_STELLAR_RADIUS_SOLAR = 0.05;
const MAXIMUM_STELLAR_RADIUS_SOLAR = 100;
const MINIMUM_STELLAR_LUMINOSITY_SOLAR = 1e-4;
const MAXIMUM_STELLAR_LUMINOSITY_SOLAR = 1e6;
const MINIMUM_STELLAR_TEMPERATURE_KELVIN = 2_400;
const MAXIMUM_STELLAR_TEMPERATURE_KELVIN = 50_000;
const MINIMUM_COLOR_TEMPERATURE_KELVIN = 1_000;
const MAXIMUM_COLOR_TEMPERATURE_KELVIN = 40_000;
const MAXIMUM_ACTIVE_STELLAR_LIGHTS = 4;
const FALLBACK_BODY_COLOR = 0x8ba4b3;
const BLACK_HOLE_BASE_COLOR = 0x020204;
const BLACK_BODY_EMISSIVE_COLOR = 0x000000;

interface FixedAppearanceDefaults {
  readonly surfaceKind: Exclude<BodySurfaceKind, 'star' | 'black-hole'>;
  readonly temperatureKelvin: number;
}

const FIXED_APPEARANCE_DEFAULTS: Readonly<Record<string, FixedAppearanceDefaults>> = {
  mercury: { surfaceKind: 'airless', temperatureKelvin: 440 },
  venus: { surfaceKind: 'rocky', temperatureKelvin: 737 },
  earth: { surfaceKind: 'rocky', temperatureKelvin: 288 },
  moon: { surfaceKind: 'airless', temperatureKelvin: 250 },
  mars: { surfaceKind: 'rocky', temperatureKelvin: 210 },
  jupiter: { surfaceKind: 'gas-giant', temperatureKelvin: 165 },
  saturn: { surfaceKind: 'gas-giant', temperatureKelvin: 134 },
  uranus: { surfaceKind: 'ice-giant', temperatureKelvin: 76 },
  neptune: { surfaceKind: 'ice-giant', temperatureKelvin: 72 },
};

const ROUGHNESS_BY_SURFACE = {
  star: 1,
  rocky: 0.82,
  'gas-giant': 0.72,
  'ice-giant': 0.64,
  airless: 0.95,
  'black-hole': 1,
} as const satisfies Record<BodySurfaceKind, number>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampColorChannel(value: number): number {
  return Math.round(clamp(value, 0, 255));
}

function colorChannelsToHex(red: number, green: number, blue: number): number {
  return (clampColorChannel(red) << 16) | (clampColorChannel(green) << 8) | clampColorChannel(blue);
}

export function kelvinToSrgbHex(temperatureKelvin: number): number {
  if (!Number.isFinite(temperatureKelvin) || temperatureKelvin <= 0) {
    throw new RangeError('temperatureKelvin 必须是正有限数');
  }

  const temperatureHundreds =
    clamp(temperatureKelvin, MINIMUM_COLOR_TEMPERATURE_KELVIN, MAXIMUM_COLOR_TEMPERATURE_KELVIN) /
    100;
  const red =
    temperatureHundreds <= 66
      ? 255
      : 329.698_727_446 * (temperatureHundreds - 60) ** -0.133_204_759_2;
  const green =
    temperatureHundreds <= 66
      ? 99.470_802_586_1 * Math.log(temperatureHundreds) - 161.119_568_166_1
      : 288.122_169_528_3 * (temperatureHundreds - 60) ** -0.075_514_849_2;
  const blue =
    temperatureHundreds >= 66
      ? 255
      : temperatureHundreds <= 19
        ? 0
        : 138.517_731_223_1 * Math.log(temperatureHundreds - 10) - 305.044_792_730_7;

  return colorChannelsToHex(red, green, blue);
}

function estimateLuminositySolar(massSolar: number): number {
  if (massSolar < 0.43) {
    return 0.23 * massSolar ** 2.3;
  }
  if (massSolar < 2) {
    return massSolar ** 4;
  }
  if (massSolar < 55) {
    return 1.4 * massSolar ** 3.5;
  }
  return 32_000 * massSolar;
}

export function estimateMainSequenceStar(
  massKg: number,
  radiusMeters: number,
): MainSequenceStarEstimate {
  if (!Number.isFinite(massKg) || massKg <= 0) {
    throw new RangeError('massKg 必须是正有限数');
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new RangeError('radiusMeters 必须是非负有限数');
  }

  const massSolar = clamp(
    massKg / SOLAR_MASS_KG,
    MINIMUM_STELLAR_MASS_SOLAR,
    MAXIMUM_STELLAR_MASS_SOLAR,
  );
  const radiusSolar = clamp(
    radiusMeters / SOLAR_RADIUS_METERS,
    MINIMUM_STELLAR_RADIUS_SOLAR,
    MAXIMUM_STELLAR_RADIUS_SOLAR,
  );
  const luminositySolar = clamp(
    estimateLuminositySolar(massSolar),
    MINIMUM_STELLAR_LUMINOSITY_SOLAR,
    MAXIMUM_STELLAR_LUMINOSITY_SOLAR,
  );
  const temperatureKelvin = clamp(
    SOLAR_EFFECTIVE_TEMPERATURE_KELVIN * (luminositySolar / (radiusSolar * radiusSolar)) ** 0.25,
    MINIMUM_STELLAR_TEMPERATURE_KELVIN,
    MAXIMUM_STELLAR_TEMPERATURE_KELVIN,
  );

  return {
    luminositySolar,
    luminosityWatts: luminositySolar * SOLAR_LUMINOSITY_WATTS,
    temperatureKelvin,
  };
}

function stableStringHash(value: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

function resolveSurfaceDefaults(bodyId: string): {
  readonly surfaceKind: BodySurfaceKind;
  readonly temperatureKelvin: number | null;
} {
  if (bodyId === 'sun') {
    return { surfaceKind: 'star', temperatureKelvin: null };
  }

  const fixedDefaults = FIXED_APPEARANCE_DEFAULTS[bodyId];
  if (fixedDefaults !== undefined) {
    return fixedDefaults;
  }

  const createdIdentity = parseCreatedBodyId(bodyId);
  switch (createdIdentity?.presetId) {
    case 'star':
      return { surfaceKind: 'star', temperatureKelvin: null };
    case 'rocky-planet':
      return { surfaceKind: 'rocky', temperatureKelvin: 288 };
    case 'gas-giant':
      return { surfaceKind: 'gas-giant', temperatureKelvin: 165 };
    case 'moon':
      return { surfaceKind: 'airless', temperatureKelvin: 250 };
    case 'asteroid-cluster':
      return { surfaceKind: 'airless', temperatureKelvin: 180 };
    case 'black-hole':
      return { surfaceKind: 'black-hole', temperatureKelvin: null };
    case undefined:
      break;
  }

  const metadata = getCelestialCatalogEntry(bodyId);
  if (metadata?.group === 'star') {
    return { surfaceKind: 'star', temperatureKelvin: null };
  }
  if (metadata?.group === 'compact-object') {
    return { surfaceKind: 'black-hole', temperatureKelvin: null };
  }
  if (metadata?.group === 'outer-planet') {
    return { surfaceKind: 'gas-giant', temperatureKelvin: 165 };
  }
  if (metadata?.group === 'inner-planet') {
    return { surfaceKind: 'rocky', temperatureKelvin: 288 };
  }
  return { surfaceKind: 'airless', temperatureKelvin: null };
}

function stellarEmissiveIntensity(luminositySolar: number): number {
  return clamp(1 + Math.log10(luminositySolar + 1) * 0.5, 1, 4);
}

function stellarPointLightIntensity(luminositySolar: number): number {
  return clamp(3.2 * Math.sqrt(luminositySolar), 0.25, 64);
}

export function resolveBodyAppearance(body: BodyState): BodyAppearanceProfile {
  const { surfaceKind, temperatureKelvin: defaultTemperatureKelvin } = resolveSurfaceDefaults(
    body.id,
  );
  const metadata = getCelestialCatalogEntry(body.id);
  const structureSeed = stableStringHash(body.id);
  const structureKey = `${surfaceKind}:v1:${structureSeed.toString(16).padStart(8, '0')}`;

  if (surfaceKind === 'star') {
    const estimate = estimateMainSequenceStar(body.massKg, body.radiusMeters);
    const color = kelvinToSrgbHex(estimate.temperatureKelvin);
    return {
      bodyId: body.id,
      surfaceKind,
      baseColor: color,
      roughness: ROUGHNESS_BY_SURFACE[surfaceKind],
      emissiveColor: color,
      emissiveIntensity: stellarEmissiveIntensity(estimate.luminositySolar),
      light: {
        color,
        intensity: stellarPointLightIntensity(estimate.luminositySolar),
        luminositySolar: estimate.luminositySolar,
        luminosityWatts: estimate.luminosityWatts,
      },
      temperatureKelvin: estimate.temperatureKelvin,
      structureKey,
      structureSeed,
    };
  }

  return {
    bodyId: body.id,
    surfaceKind,
    baseColor:
      surfaceKind === 'black-hole'
        ? BLACK_HOLE_BASE_COLOR
        : (metadata?.color ?? FALLBACK_BODY_COLOR),
    roughness: ROUGHNESS_BY_SURFACE[surfaceKind],
    emissiveColor: BLACK_BODY_EMISSIVE_COLOR,
    emissiveIntensity: 0,
    light: null,
    temperatureKelvin: defaultTemperatureKelvin,
    structureKey,
    structureSeed,
  };
}

function compareBodyIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

export function selectActiveStellarLightIds(
  bodies: readonly BodyState[],
  requestedLimit = MAXIMUM_ACTIVE_STELLAR_LIGHTS,
): readonly string[] {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) {
    throw new RangeError('requestedLimit 必须是非负安全整数');
  }
  const limit = Math.min(requestedLimit, MAXIMUM_ACTIVE_STELLAR_LIGHTS);
  if (limit === 0) {
    return [];
  }

  return bodies
    .filter((body) => resolveSurfaceDefaults(body.id).surfaceKind === 'star')
    .toSorted((left, right) => right.massKg - left.massKg || compareBodyIds(left.id, right.id))
    .slice(0, limit)
    .map((body) => body.id);
}
