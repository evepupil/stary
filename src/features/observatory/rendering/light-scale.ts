import { DEFAULT_SCENE_EXTENT } from './coordinates';

const ASTRONOMICAL_UNIT_METERS = 149_597_870_700;
const STELLAR_LIGHT_REFERENCE_SYSTEM_RADIUS_AU = 30;
export const MAXIMUM_STELLAR_LIGHT_INTENSITY = 1e12;
export const STELLAR_LIGHT_DISTANCE_DECAY = 2;
export const STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT =
  DEFAULT_SCENE_EXTENT / (ASTRONOMICAL_UNIT_METERS * STELLAR_LIGHT_REFERENCE_SYSTEM_RADIUS_AU);

export function computeScaledStellarLightIntensity(
  referenceIntensity: number,
  metersToSceneUnit: number,
): number {
  if (!Number.isFinite(referenceIntensity) || referenceIntensity < 0) {
    throw new RangeError('referenceIntensity 必须是非负有限数');
  }
  if (!Number.isFinite(metersToSceneUnit) || metersToSceneUnit <= 0) {
    throw new RangeError('metersToSceneUnit 必须是正有限数');
  }
  if (referenceIntensity === 0) {
    return 0;
  }

  const logarithmicIntensity =
    Math.log(referenceIntensity) +
    STELLAR_LIGHT_DISTANCE_DECAY *
      (Math.log(metersToSceneUnit) - Math.log(STELLAR_LIGHT_REFERENCE_METERS_TO_SCENE_UNIT));
  const maximumLogarithmicIntensity = Math.log(MAXIMUM_STELLAR_LIGHT_INTENSITY);
  if (logarithmicIntensity >= maximumLogarithmicIntensity) {
    return MAXIMUM_STELLAR_LIGHT_INTENSITY;
  }
  if (logarithmicIntensity <= Math.log(Number.MIN_VALUE)) {
    return 0;
  }
  return Math.exp(logarithmicIntensity);
}
