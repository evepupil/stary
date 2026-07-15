import { AlertTriangle, RefreshCw } from 'lucide-react';

import type { CreationPreview } from '../../creation/model/creation-types';
import { getCelestialCatalogEntry } from '../../observatory/catalog';
import { formatDistance, formatSimulationTime } from '../../observatory/simulation';
import type { BodyEditingPhase } from '../use-body-editing';
import { BODY_EDITING_PHASE_LABELS } from './body-editing-labels';

function bodyName(bodyId: string): string {
  return getCelestialCatalogEntry(bodyId)?.name ?? bodyId;
}

function PreviewSummary({ preview }: { readonly preview: CreationPreview }) {
  if (preview.risk.kind === 'collision') {
    return (
      <div className="creation-risk creation-risk-collision" role="alert">
        <strong>
          <AlertTriangle aria-hidden="true" size={13} />
          碰撞风险
        </strong>
        <span>{`${bodyName(preview.risk.bodyId)} / ${bodyName(preview.risk.otherBodyId)}`}</span>
      </div>
    );
  }
  if (preview.risk.kind === 'escape') {
    return (
      <div className="creation-risk creation-risk-escape" role="status">
        <strong>逃逸风险</strong>
        <span>{bodyName(preview.risk.bodyId)}</span>
      </div>
    );
  }
  return (
    <div className="creation-risk creation-risk-stable" role="status">
      <strong>短期轨迹稳定</strong>
      <span>未发现碰撞趋势</span>
    </div>
  );
}

export function BodyEditingTrajectorySummary({
  phase,
  preview,
}: {
  readonly phase: BodyEditingPhase;
  readonly preview: CreationPreview | null;
}) {
  const pointCount = preview?.tracks.reduce((total, track) => total + track.points.length, 0) ?? 0;
  const busy = phase === 'syncing' || phase === 'previewing' || phase === 'submitting';

  return (
    <section aria-label="轨道预览" className="creation-preview-summary body-editing-preview">
      <div>
        <span>短期试算</span>
        <strong>
          {preview === null
            ? BODY_EDITING_PHASE_LABELS[phase]
            : formatSimulationTime(preview.durationSeconds)}
        </strong>
      </div>
      {preview === null ? (
        <div aria-live="polite" className="creation-risk creation-risk-pending" role="status">
          <strong>{busy ? BODY_EDITING_PHASE_LABELS[phase] : '等待轨迹'}</strong>
          <span>REBOUND / IAS15</span>
        </div>
      ) : (
        <PreviewSummary preview={preview} />
      )}
      {preview === null ? null : (
        <small>{`${String(preview.tracks.length)} 条轨迹 / ${String(pointCount)} 个采样点`}</small>
      )}
      {preview?.closestApproachMeters === null ||
      preview?.closestApproachMeters === undefined ? null : (
        <small>{`最近中心距离 ${formatDistance(preview.closestApproachMeters)}`}</small>
      )}
    </section>
  );
}

export function BodyEditingConflictNotice({
  disabled,
  error,
  onResync,
}: {
  readonly disabled: boolean;
  readonly error: Error | null;
  readonly onResync: () => void;
}) {
  return (
    <div className="body-editing-conflict" role="alert">
      <strong>正式状态已经变化</strong>
      <span>{error?.message ?? '当前表单基于旧快照，请重新同步后再操作。'}</span>
      <button disabled={disabled} onClick={onResync} type="button">
        <RefreshCw aria-hidden="true" size={14} />
        <span>重新同步</span>
      </button>
    </div>
  );
}
