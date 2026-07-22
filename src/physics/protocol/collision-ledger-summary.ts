import { compensatedSum } from '../collisions/vector';

const SUMMARY_RELATIVE_TOLERANCE = 1e-12;

export interface CollisionDissipationSummary {
  readonly deformationJoules: number;
  readonly fractureJoules: number;
  readonly heatJoules: number;
  readonly radiationJoules: number;
}

export interface CollisionLedgerSummaryLike {
  readonly accumulatedDissipation: CollisionDissipationSummary;
  readonly resolvedEventCount: number;
}

export type CollisionLedgerDeltaLike =
  | {
      readonly dissipation: CollisionDissipationSummary;
    }
  | {
      readonly relativeKineticEnergy: {
        readonly radiationJoules: number;
      };
    };

export function collisionLedgerDissipation(
  ledger: CollisionLedgerDeltaLike,
): CollisionDissipationSummary {
  return 'dissipation' in ledger
    ? ledger.dissipation
    : {
        heatJoules: 0,
        deformationJoules: 0,
        fractureJoules: 0,
        radiationJoules: ledger.relativeKineticEnergy.radiationJoules,
      };
}

export function createEmptyCollisionLedgerSummary(): CollisionLedgerSummaryLike {
  return {
    resolvedEventCount: 0,
    accumulatedDissipation: {
      heatJoules: 0,
      deformationJoules: 0,
      fractureJoules: 0,
      radiationJoules: 0,
    },
  };
}

export function advanceCollisionLedgerSummary(
  previous: CollisionLedgerSummaryLike,
  ledgerDelta: readonly CollisionLedgerDeltaLike[],
): CollisionLedgerSummaryLike {
  const sumField = (field: keyof CollisionDissipationSummary): number =>
    compensatedSum([
      previous.accumulatedDissipation[field],
      ...ledgerDelta.map((ledger) => collisionLedgerDissipation(ledger)[field]),
    ]);

  return {
    resolvedEventCount: previous.resolvedEventCount + ledgerDelta.length,
    accumulatedDissipation: {
      heatJoules: sumField('heatJoules'),
      deformationJoules: sumField('deformationJoules'),
      fractureJoules: sumField('fractureJoules'),
      radiationJoules: sumField('radiationJoules'),
    },
  };
}

function approximatelyEqual(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE);
  return Math.abs(left - right) <= SUMMARY_RELATIVE_TOLERANCE * scale;
}

export function collisionLedgerSummariesEqual(
  left: CollisionLedgerSummaryLike,
  right: CollisionLedgerSummaryLike,
): boolean {
  return (
    left.resolvedEventCount === right.resolvedEventCount &&
    approximatelyEqual(
      left.accumulatedDissipation.heatJoules,
      right.accumulatedDissipation.heatJoules,
    ) &&
    approximatelyEqual(
      left.accumulatedDissipation.deformationJoules,
      right.accumulatedDissipation.deformationJoules,
    ) &&
    approximatelyEqual(
      left.accumulatedDissipation.fractureJoules,
      right.accumulatedDissipation.fractureJoules,
    ) &&
    approximatelyEqual(
      left.accumulatedDissipation.radiationJoules,
      right.accumulatedDissipation.radiationJoules,
    )
  );
}

export function collisionLedgerSummaryContains(
  cumulative: CollisionLedgerSummaryLike,
  minimum: CollisionLedgerSummaryLike,
): boolean {
  const covers = (actual: number, required: number): boolean =>
    actual > required || approximatelyEqual(actual, required);
  return (
    cumulative.resolvedEventCount >= minimum.resolvedEventCount &&
    covers(
      cumulative.accumulatedDissipation.heatJoules,
      minimum.accumulatedDissipation.heatJoules,
    ) &&
    covers(
      cumulative.accumulatedDissipation.deformationJoules,
      minimum.accumulatedDissipation.deformationJoules,
    ) &&
    covers(
      cumulative.accumulatedDissipation.fractureJoules,
      minimum.accumulatedDissipation.fractureJoules,
    ) &&
    covers(
      cumulative.accumulatedDissipation.radiationJoules,
      minimum.accumulatedDissipation.radiationJoules,
    )
  );
}
