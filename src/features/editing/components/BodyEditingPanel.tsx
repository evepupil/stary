import { Check, Pencil, X } from 'lucide-react';

import { getCelestialCatalogEntry } from '../../observatory/catalog';
import type { BodyEditingController } from '../use-body-editing';
import { BODY_EDITING_PHASE_LABELS } from './body-editing-labels';
import { BodyDeletionDialog } from './BodyDeletionDialog';
import { BodyEditingFields } from './BodyEditingFields';
import { BodyEditingConflictNotice, BodyEditingTrajectorySummary } from './BodyEditingStatus';

interface BodyEditingPanelProps {
  readonly controller: BodyEditingController;
}

function bodyName(bodyId: string): string {
  return getCelestialCatalogEntry(bodyId)?.name ?? bodyId;
}

export function BodyEditingPanel({ controller }: BodyEditingPanelProps) {
  const {
    active,
    canConfirm,
    cancel,
    confirm,
    error,
    fieldErrors,
    fields,
    operation,
    phase,
    preview,
    resync,
    targetBody,
    updateField,
  } = controller;

  if (!active || operation === null) {
    return null;
  }

  const name = targetBody === null ? '未知天体' : bodyName(targetBody.id);
  if (operation === 'delete') {
    return (
      <BodyDeletionDialog
        canConfirm={canConfirm}
        error={error}
        name={name}
        onCancel={cancel}
        onConfirm={confirm}
        onResync={resync}
        phase={phase}
      />
    );
  }

  const fieldsDisabled = phase === 'submitting' || phase === 'conflicted';
  const submitting = phase === 'submitting';

  function handleSubmit(event: { preventDefault(): void }): void {
    event.preventDefault();
    if (canConfirm) {
      confirm();
    }
  }

  return (
    <aside
      aria-label="天体参数编辑"
      className="observatory-panel creation-panel body-editing-panel"
    >
      <form
        className="panel-content creation-panel-content body-editing-panel-content"
        onSubmit={handleSubmit}
      >
        <div className="panel-heading creation-panel-heading">
          <p>
            <Pencil aria-hidden="true" size={13} />
            编辑参数
          </p>
          <span data-body-editing-phase={phase}>{BODY_EDITING_PHASE_LABELS[phase]}</span>
        </div>

        {fields === null ? (
          <div aria-live="polite" className="creation-risk creation-risk-pending" role="status">
            <strong>{BODY_EDITING_PHASE_LABELS[phase]}</strong>
            <span>等待正式物理快照</span>
          </div>
        ) : (
          <BodyEditingFields
            disabled={fieldsDisabled}
            errors={fieldErrors}
            fields={fields}
            name={name}
            onValueChange={updateField}
          />
        )}

        <BodyEditingTrajectorySummary phase={phase} preview={preview} />

        {phase === 'conflicted' ? (
          <BodyEditingConflictNotice disabled={submitting} error={error} onResync={resync} />
        ) : error === null ? null : (
          <p className="creation-error" role="alert">
            {error.message}
          </p>
        )}

        <div className="creation-actions body-editing-actions">
          <button disabled={submitting} onClick={cancel} type="button">
            <X aria-hidden="true" size={16} />
            <span>取消编辑</span>
          </button>
          <button className="creation-confirm-button" disabled={!canConfirm} type="submit">
            <Check aria-hidden="true" size={16} />
            <span>{submitting ? '正在保存' : '确认修改'}</span>
          </button>
        </div>
      </form>
    </aside>
  );
}
