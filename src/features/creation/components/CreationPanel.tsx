import { Check, Plus, X } from 'lucide-react';

import { getCelestialCatalogEntry } from '../../observatory/catalog';
import {
  formatDistance,
  formatMass,
  formatSimulationTime,
  formatSpeed,
} from '../../observatory/simulation';
import { CREATION_PRESETS } from '../model/body-presets';
import type { CreationDraft, CreationPreview, CreationPresetId } from '../model/creation-types';

export type CreationPhase =
  'syncing' | 'placing' | 'dragging' | 'previewing' | 'preview-error' | 'ready' | 'submitting';

interface CreationPanelProps {
  readonly draft: CreationDraft | null;
  readonly error: Error | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onPresetChange: (presetId: CreationPresetId) => void;
  readonly phase: CreationPhase;
  readonly presetId: CreationPresetId;
  readonly preview: CreationPreview | null;
}

const phaseLabels: Record<CreationPhase, string> = {
  syncing: '同步正式快照',
  placing: '落点未设置',
  dragging: '速度向量调整中',
  previewing: '轨道试算中',
  'preview-error': '试算失败',
  ready: '可以写入模拟',
  submitting: '正在写入物理核心',
};

function bodyName(bodyId: string): string {
  return getCelestialCatalogEntry(bodyId)?.name ?? bodyId;
}

function PreviewSummary({ preview }: { readonly preview: CreationPreview }) {
  if (preview.risk.kind === 'collision') {
    return (
      <div className="creation-risk creation-risk-collision" role="status">
        <strong>碰撞风险</strong>
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
      <span>未发现碰撞或逃逸趋势</span>
    </div>
  );
}

export function CreationPanel({
  draft,
  error,
  onCancel,
  onConfirm,
  onPresetChange,
  phase,
  presetId,
  preview,
}: CreationPanelProps) {
  const primaryBody = draft?.bodies[0] ?? null;
  const speed =
    primaryBody === null
      ? 0
      : Math.hypot(
          primaryBody.velocityMetersPerSecond.x,
          primaryBody.velocityMetersPerSecond.y,
          primaryBody.velocityMetersPerSecond.z,
        );
  const busy = phase === 'syncing' || phase === 'previewing' || phase === 'submitting';

  return (
    <aside aria-label="创造工具" className="observatory-panel creation-panel">
      <div className="panel-content creation-panel-content">
        <div className="panel-heading creation-panel-heading">
          <p>
            <Plus aria-hidden="true" size={13} />
            创造工具
          </p>
          <span data-creation-phase={phase}>{phaseLabels[phase]}</span>
        </div>

        <div aria-label="天体类型" className="creation-preset-grid" role="radiogroup">
          {CREATION_PRESETS.map((preset) => (
            <button
              aria-checked={preset.id === presetId}
              disabled={phase === 'submitting'}
              key={preset.id}
              onClick={() => {
                onPresetChange(preset.id);
              }}
              role="radio"
              type="button"
            >
              <span
                aria-hidden="true"
                className="creation-preset-swatch"
                style={{ backgroundColor: `#${preset.color.toString(16).padStart(6, '0')}` }}
              />
              <span>
                <strong>{preset.label}</strong>
                <small>
                  {preset.bodyCount === 1 ? preset.typeLabel : `${String(preset.bodyCount)} 个天体`}
                </small>
              </span>
            </button>
          ))}
        </div>

        {primaryBody !== null && draft !== null ? (
          <dl className="creation-measurements">
            <div>
              <dt>质量</dt>
              <dd>{formatMass(primaryBody.massKg)}</dd>
            </div>
            <div>
              <dt>半径</dt>
              <dd>{formatDistance(primaryBody.radiusMeters)}</dd>
            </div>
            <div>
              <dt>初速度</dt>
              <dd>{formatSpeed(speed)}</dd>
            </div>
            <div>
              <dt>参考天体</dt>
              <dd>{draft.referenceBodyId === null ? '--' : bodyName(draft.referenceBodyId)}</dd>
            </div>
          </dl>
        ) : null}

        <section aria-label="轨道预览" className="creation-preview-summary">
          <div>
            <span>短期试算</span>
            <strong>
              {preview === null
                ? phaseLabels[phase]
                : formatSimulationTime(preview.durationSeconds)}
            </strong>
          </div>
          {preview === null ? (
            <div aria-live="polite" className="creation-risk creation-risk-pending" role="status">
              <strong>{busy ? phaseLabels[phase] : '等待轨迹'}</strong>
              <span>REBOUND / IAS15</span>
            </div>
          ) : (
            <PreviewSummary preview={preview} />
          )}
          {preview?.closestApproachMeters !== null &&
          preview?.closestApproachMeters !== undefined ? (
            <small>{`最近中心距离 ${formatDistance(preview.closestApproachMeters)}`}</small>
          ) : null}
        </section>

        {error !== null ? (
          <p className="creation-error" role="alert">
            {error.message}
          </p>
        ) : null}

        <div className="creation-actions">
          <button disabled={phase === 'submitting'} onClick={onCancel} type="button">
            <X aria-hidden="true" size={16} />
            <span>取消</span>
          </button>
          <button
            className="creation-confirm-button"
            disabled={phase !== 'ready' || preview === null}
            onClick={onConfirm}
            type="button"
          >
            <Check aria-hidden="true" size={16} />
            <span>确认创建</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
