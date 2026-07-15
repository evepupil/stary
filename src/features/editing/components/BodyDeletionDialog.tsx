import { useEffect, useRef, type KeyboardEvent } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

import type { BodyEditingPhase } from '../use-body-editing';
import { BODY_EDITING_PHASE_LABELS } from './body-editing-labels';
import { BodyEditingConflictNotice } from './BodyEditingStatus';

interface BodyDeletionDialogProps {
  readonly canConfirm: boolean;
  readonly error: Error | null;
  readonly name: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onResync: () => void;
  readonly phase: BodyEditingPhase;
}

export function BodyDeletionDialog({
  canConfirm,
  error,
  name,
  onCancel,
  onConfirm,
  onResync,
  phase,
}: BodyDeletionDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const submitting = phase === 'submitting';

  useEffect(() => {
    const dialog = dialogRef.current;
    const parent = dialog?.parentElement;
    const siblingInertStates =
      dialog === null || parent === undefined || parent === null
        ? []
        : [...parent.children]
            .filter(
              (element): element is HTMLElement =>
                element instanceof HTMLElement && element !== dialog,
            )
            .map((element) => ({ element, inert: element.inert }));
    siblingInertStates.forEach(({ element }) => {
      element.inert = true;
    });
    cancelButtonRef.current?.focus();

    return () => {
      siblingInertStates.forEach(({ element, inert }) => {
        element.inert = inert;
      });
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape' && !submitting) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }

    const focusableButtons = [
      ...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const firstButton = focusableButtons[0];
    const lastButton = focusableButtons.at(-1);
    if (firstButton === undefined || lastButton === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === firstButton) {
      event.preventDefault();
      lastButton.focus();
    } else if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault();
      firstButton.focus();
    }
  }

  return (
    <aside
      aria-modal="true"
      aria-describedby="body-delete-description"
      aria-labelledby="body-delete-title"
      className="observatory-panel creation-panel body-editing-panel body-delete-dialog"
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      role="alertdialog"
    >
      <div className="panel-content creation-panel-content body-editing-panel-content">
        <div className="panel-heading creation-panel-heading">
          <p>
            <Trash2 aria-hidden="true" size={13} />
            删除天体
          </p>
          <span data-body-editing-phase={phase}>{BODY_EDITING_PHASE_LABELS[phase]}</span>
        </div>

        <div className="body-delete-warning">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <h2 id="body-delete-title">{`删除 ${name}？`}</h2>
            <p id="body-delete-description">确认后会从当前物理模拟中移除该天体。</p>
          </div>
        </div>

        {phase === 'conflicted' ? (
          <BodyEditingConflictNotice disabled={submitting} error={error} onResync={onResync} />
        ) : error === null ? null : (
          <p className="creation-error" role="alert">
            {error.message}
          </p>
        )}

        <div className="creation-actions body-editing-actions">
          <button disabled={submitting} onClick={onCancel} ref={cancelButtonRef} type="button">
            <X aria-hidden="true" size={16} />
            <span>取消删除</span>
          </button>
          <button
            className="body-delete-confirm-button"
            disabled={!canConfirm}
            onClick={onConfirm}
            type="button"
          >
            <Trash2 aria-hidden="true" size={16} />
            <span>{submitting ? '正在删除' : '确认删除'}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
