import type {
  BodyState,
  PhysicsDiagnostics,
  PositionMeters,
} from '../../../physics/protocol/schemas';

const ASTRONOMICAL_UNIT_METERS = 149_597_870_700;
const JULIAN_YEAR_SECONDS = 31_557_600;
const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
const MINUTE_SECONDS = 60;

const compactNumber = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export interface BodyViewModel {
  readonly id: string;
  readonly distanceFromOriginMeters: number;
  readonly distanceLabel: string;
  readonly massLabel: string;
  readonly speedMetersPerSecond: number;
  readonly speedLabel: string;
}

export interface DiagnosticMeasurementViewModel {
  readonly valueLabel: string;
  readonly relativeDrift: number | null;
  readonly relativeDriftLabel: string;
}

export interface DiagnosticsViewModel {
  readonly totalEnergy: DiagnosticMeasurementViewModel;
  readonly totalLinearMomentum: DiagnosticMeasurementViewModel;
  readonly totalAngularMomentum: DiagnosticMeasurementViewModel;
}

function formatClockPart(value: number): string {
  return String(value).padStart(2, '0');
}

function vectorMagnitude(vector: PositionMeters): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function formatScientific(value: number, unit: string): string {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return `${value.toExponential(3)} ${unit}`;
}

export function formatSimulationTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '--';
  }

  let remainingSeconds = Math.floor(seconds);
  const years = Math.floor(remainingSeconds / JULIAN_YEAR_SECONDS);
  remainingSeconds -= years * JULIAN_YEAR_SECONDS;
  const days = Math.floor(remainingSeconds / DAY_SECONDS);
  remainingSeconds -= days * DAY_SECONDS;
  const hours = Math.floor(remainingSeconds / HOUR_SECONDS);
  remainingSeconds -= hours * HOUR_SECONDS;
  const minutes = Math.floor(remainingSeconds / MINUTE_SECONDS);
  const wholeSeconds = remainingSeconds - minutes * MINUTE_SECONDS;
  const clock = `${formatClockPart(hours)}:${formatClockPart(minutes)}:${formatClockPart(wholeSeconds)}`;

  if (years > 0) {
    return `${String(years)}年 ${String(days)}天 ${clock}`;
  }
  if (days > 0) {
    return `${String(days)}天 ${clock}`;
  }
  return clock;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) {
    return '--';
  }
  if (meters >= ASTRONOMICAL_UNIT_METERS * 0.01) {
    return `${(meters / ASTRONOMICAL_UNIT_METERS).toFixed(3)} AU`;
  }
  if (meters >= 1_000) {
    return `${compactNumber.format(meters / 1_000)} km`;
  }
  return `${compactNumber.format(meters)} m`;
}

export function formatSpeed(metersPerSecond: number): string {
  if (!Number.isFinite(metersPerSecond) || metersPerSecond < 0) {
    return '--';
  }
  if (metersPerSecond >= 1_000) {
    return `${compactNumber.format(metersPerSecond / 1_000)} km/s`;
  }
  return `${compactNumber.format(metersPerSecond)} m/s`;
}

export function formatMass(kilograms: number): string {
  if (!Number.isFinite(kilograms) || kilograms < 0) {
    return '--';
  }
  return `${kilograms.toExponential(3)} kg`;
}

export function calculateRelativeScalarDrift(
  currentValue: number,
  baselineValue: number,
): number | null {
  if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue)) {
    return null;
  }
  if (baselineValue === 0) {
    return currentValue === 0 ? 0 : null;
  }
  return Math.abs(currentValue - baselineValue) / Math.abs(baselineValue);
}

export function calculateRelativeVectorDrift(
  currentValue: PositionMeters,
  baselineValue: PositionMeters,
): number | null {
  const baselineMagnitude = vectorMagnitude(baselineValue);
  const differenceMagnitude = Math.hypot(
    currentValue.x - baselineValue.x,
    currentValue.y - baselineValue.y,
    currentValue.z - baselineValue.z,
  );
  if (!Number.isFinite(baselineMagnitude) || !Number.isFinite(differenceMagnitude)) {
    return null;
  }
  if (baselineMagnitude === 0) {
    return differenceMagnitude === 0 ? 0 : null;
  }
  return differenceMagnitude / baselineMagnitude;
}

export function formatRelativeDrift(relativeDrift: number | null): string {
  if (relativeDrift === null || !Number.isFinite(relativeDrift) || relativeDrift < 0) {
    return '无可用基线';
  }
  if (relativeDrift === 0) {
    return '0';
  }
  if (relativeDrift < 0.0001) {
    return relativeDrift.toExponential(2);
  }
  return `${(relativeDrift * 100).toFixed(3)}%`;
}

export function createBodyViewModel(body: BodyState): BodyViewModel {
  const distanceFromOriginMeters = vectorMagnitude(body.positionMeters);
  const speedMetersPerSecond = vectorMagnitude(body.velocityMetersPerSecond);
  return {
    id: body.id,
    distanceFromOriginMeters,
    distanceLabel: formatDistance(distanceFromOriginMeters),
    massLabel: formatMass(body.massKg),
    speedMetersPerSecond,
    speedLabel: formatSpeed(speedMetersPerSecond),
  };
}

export function createDiagnosticsViewModel(
  diagnostics: PhysicsDiagnostics,
  baseline: PhysicsDiagnostics,
): DiagnosticsViewModel {
  const energyDrift = calculateRelativeScalarDrift(
    diagnostics.totalEnergyJoules,
    baseline.totalEnergyJoules,
  );
  const linearMomentumDrift = calculateRelativeVectorDrift(
    diagnostics.totalLinearMomentumKgMetersPerSecond,
    baseline.totalLinearMomentumKgMetersPerSecond,
  );
  const angularMomentumDrift = calculateRelativeVectorDrift(
    diagnostics.totalAngularMomentumKgMetersSquaredPerSecond,
    baseline.totalAngularMomentumKgMetersSquaredPerSecond,
  );

  return {
    totalEnergy: {
      valueLabel: formatScientific(diagnostics.totalEnergyJoules, 'J'),
      relativeDrift: energyDrift,
      relativeDriftLabel: formatRelativeDrift(energyDrift),
    },
    totalLinearMomentum: {
      valueLabel: formatScientific(
        vectorMagnitude(diagnostics.totalLinearMomentumKgMetersPerSecond),
        'kg m/s',
      ),
      relativeDrift: linearMomentumDrift,
      relativeDriftLabel: formatRelativeDrift(linearMomentumDrift),
    },
    totalAngularMomentum: {
      valueLabel: formatScientific(
        vectorMagnitude(diagnostics.totalAngularMomentumKgMetersSquaredPerSecond),
        'kg m^2/s',
      ),
      relativeDrift: angularMomentumDrift,
      relativeDriftLabel: formatRelativeDrift(angularMomentumDrift),
    },
  };
}
