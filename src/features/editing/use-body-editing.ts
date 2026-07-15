import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PhysicsWorkerCommandError } from '../../physics/controller/physics-worker-controller';
import { ORBIT_PREVIEW_PROTOCOL_VERSION, requestTrajectoryPreview } from '../../physics/preview';
import type { BodyState } from '../../physics/protocol/schemas';
import {
  estimateBodyPreviewDurationSeconds,
  findDominantReferenceBody,
} from '../creation/model/body-presets';
import { captureCreationSnapshot } from '../creation/model/creation-draft';
import { toCreationPreview } from '../creation/model/creation-preview';
import type {
  CreationOverlayState,
  CreationPreview,
  CreationSnapshot,
} from '../creation/model/creation-types';
import { getCelestialCatalogEntry } from '../observatory/catalog';
import type { UniverseSimulation } from '../observatory/simulation/use-universe-simulation';
import {
  bodyStateToEditFields,
  deleteBody,
  parseBodyEditFields,
  replaceEditedBody,
  selectFallbackBodyIdAfterDeletion,
  updateBodyEditField,
  type BodyEditFieldErrors,
  type BodyEditFieldName,
  type BodyEditFields,
} from './model';

const PREVIEW_SAMPLE_COUNT = 256;
const PREVIEW_DEBOUNCE_MILLISECONDS = 250;

export type BodyEditingOperation = 'edit' | 'delete';
export type BodyEditingPhase =
  | 'syncing'
  | 'editing'
  | 'previewing'
  | 'preview-error'
  | 'ready'
  | 'delete-ready'
  | 'submitting'
  | 'conflicted';

interface BodyEditingCommitResult {
  readonly bodyId: string;
}

interface BodyDeletionCommitResult {
  readonly deletedBodyId: string;
  readonly fallbackBodyId: string | null;
}

interface UseBodyEditingOptions {
  readonly onDeleted: (result: BodyDeletionCommitResult) => void;
  readonly onEdited: (result: BodyEditingCommitResult) => void;
  readonly simulation: UniverseSimulation;
}

interface EditCandidate {
  readonly body: BodyState;
  readonly bodies: readonly BodyState[];
  readonly durationSeconds: number;
  readonly referenceBodyId: string | null;
}

interface DeleteCandidate {
  readonly bodies: readonly BodyState[];
  readonly fallbackBodyId: string | null;
}

export interface BodyEditingController {
  readonly acceptedPreviewRevision: number | null;
  readonly active: boolean;
  readonly candidateRevision: number;
  readonly canConfirm: boolean;
  readonly cancel: () => void;
  readonly confirm: () => void;
  readonly enterDelete: (bodyId: string) => void;
  readonly enterEdit: (bodyId: string) => void;
  readonly error: Error | null;
  readonly fieldErrors: BodyEditFieldErrors;
  readonly fields: BodyEditFields | null;
  readonly operation: BodyEditingOperation | null;
  readonly overlayState: CreationOverlayState | null;
  readonly phase: BodyEditingPhase;
  readonly preview: CreationPreview | null;
  readonly resync: () => void;
  readonly targetBody: BodyState | null;
  readonly updateField: (fieldName: BodyEditFieldName, value: string) => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('天体编辑工具发生未知错误');
}

function isSnapshotConflict(error: Error): boolean {
  return (
    error.name === 'AbortError' ||
    (error instanceof PhysicsWorkerCommandError &&
      (error.code === 'bodyRevisionConflict' || error.code === 'bodySnapshotConflict'))
  );
}

export function useBodyEditing({
  onDeleted,
  onEdited,
  simulation,
}: UseBodyEditingOptions): BodyEditingController {
  const [operation, setOperation] = useState<BodyEditingOperation | null>(null);
  const [targetBodyId, setTargetBodyId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<CreationSnapshot | null>(null);
  const [fields, setFields] = useState<BodyEditFields | null>(null);
  const [preview, setPreview] = useState<CreationPreview | null>(null);
  const [phase, setPhase] = useState<BodyEditingPhase>('syncing');
  const [error, setError] = useState<Error | null>(null);
  const [candidateRevision, setCandidateRevision] = useState(0);
  const [acceptedPreviewRevision, setAcceptedPreviewRevision] = useState<number | null>(null);
  const candidateRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);
  const sessionRevisionRef = useRef(0);
  const resumeAfterCancelRef = useRef(false);
  const onDeletedRef = useRef(onDeleted);
  const onEditedRef = useRef(onEdited);

  useEffect(() => {
    onDeletedRef.current = onDeleted;
    onEditedRef.current = onEdited;
  }, [onDeleted, onEdited]);

  useEffect(
    () => () => {
      sessionRevisionRef.current += 1;
      candidateRevisionRef.current += 1;
      previewRevisionRef.current += 1;
    },
    [],
  );

  const invalidateCandidatePreview = useCallback(() => {
    candidateRevisionRef.current += 1;
    previewRevisionRef.current += 1;
    setCandidateRevision(candidateRevisionRef.current);
    setAcceptedPreviewRevision(null);
  }, []);

  const targetBody = useMemo(
    () => (snapshot?.bodies ?? simulation.bodies).find((body) => body.id === targetBodyId) ?? null,
    [simulation.bodies, snapshot, targetBodyId],
  );

  const parseResult = useMemo(() => {
    if (operation !== 'edit' || targetBody === null || fields === null) {
      return null;
    }
    return parseBodyEditFields(targetBody, fields);
  }, [fields, operation, targetBody]);

  const editCandidateResult = useMemo<{
    readonly candidate: EditCandidate | null;
    readonly error: Error | null;
  }>(() => {
    if (snapshot === null || parseResult?.success !== true) {
      return { candidate: null, error: null };
    }
    try {
      const bodies = replaceEditedBody(snapshot.bodies, parseResult.body.id, parseResult.body);
      const referenceBody = findDominantReferenceBody(
        bodies.filter((body) => body.id !== parseResult.body.id),
        parseResult.body.positionMeters,
      );
      return {
        candidate: {
          body: parseResult.body,
          bodies,
          durationSeconds: estimateBodyPreviewDurationSeconds(
            bodies,
            parseResult.body,
            referenceBody?.id ?? null,
          ),
          referenceBodyId: referenceBody?.id ?? null,
        },
        error: null,
      };
    } catch (candidateError) {
      return { candidate: null, error: toError(candidateError) };
    }
  }, [parseResult, snapshot]);

  const deleteCandidateResult = useMemo<{
    readonly candidate: DeleteCandidate | null;
    readonly error: Error | null;
  }>(() => {
    if (operation !== 'delete' || snapshot === null || targetBody === null) {
      return { candidate: null, error: null };
    }
    try {
      const bodies = deleteBody(snapshot.bodies, targetBody.id);
      const declaredParentId = getCelestialCatalogEntry(targetBody.id)?.orbitParentId ?? null;
      return {
        candidate: {
          bodies,
          fallbackBodyId: selectFallbackBodyIdAfterDeletion(bodies, targetBody, declaredParentId),
        },
        error: null,
      };
    } catch (candidateError) {
      return { candidate: null, error: toError(candidateError) };
    }
  }, [operation, snapshot, targetBody]);

  useEffect(() => {
    if (
      operation === null ||
      targetBodyId === null ||
      snapshot !== null ||
      simulation.runState !== 'paused' ||
      simulation.commandPending ||
      simulation.bodySnapshotSimulationTimeSeconds !== simulation.simulationTimeSeconds
    ) {
      return undefined;
    }

    const sessionRevision = sessionRevisionRef.current;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || sessionRevisionRef.current !== sessionRevision) {
        return;
      }
      try {
        const nextSnapshot = captureCreationSnapshot(
          simulation.bodies,
          simulation.bodyRevision,
          simulation.bodySnapshotSimulationTimeSeconds,
          simulation.simulationTimeSeconds,
        );
        setSnapshot(nextSnapshot);
        const nextTarget = nextSnapshot.bodies.find((body) => body.id === targetBodyId);
        if (nextTarget === undefined) {
          setError(new Error(`天体 ${targetBodyId} 已不存在，请取消当前操作`));
          setPhase('conflicted');
          return;
        }
        if (operation === 'edit') {
          setFields((current) => current ?? bodyStateToEditFields(nextTarget));
          setPhase('editing');
        } else {
          setPhase('delete-ready');
        }
        setError(null);
      } catch (snapshotError) {
        setError(toError(snapshotError));
        setPhase('conflicted');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [operation, simulation, snapshot, targetBodyId]);

  useEffect(() => {
    const candidate = editCandidateResult.candidate;
    if (operation !== 'edit' || snapshot === null || candidate === null) {
      return undefined;
    }

    const abortController = new AbortController();
    const draftRevision = previewRevisionRef.current + 1;
    previewRevisionRef.current = draftRevision;
    const previewCandidateRevision = candidateRevisionRef.current;
    const sessionRevision = sessionRevisionRef.current;
    const timeoutId = window.setTimeout(() => {
      if (
        abortController.signal.aborted ||
        previewRevisionRef.current !== draftRevision ||
        sessionRevisionRef.current !== sessionRevision
      ) {
        return;
      }
      setPreview(null);
      setPhase('previewing');
      setError(null);
      void requestTrajectoryPreview(
        {
          version: ORBIT_PREVIEW_PROTOCOL_VERSION,
          type: 'trajectoryPreviewRequest',
          requestId: `body-edit-preview-${String(draftRevision)}`,
          draftRevision,
          bodies: [...candidate.bodies],
          draftBodyIds: [candidate.body.id],
          referenceBodyId: candidate.referenceBodyId,
          durationSeconds: candidate.durationSeconds,
          sampleCount: PREVIEW_SAMPLE_COUNT,
        },
        { signal: abortController.signal },
      ).then(
        (result) => {
          if (
            previewRevisionRef.current !== draftRevision ||
            candidateRevisionRef.current !== previewCandidateRevision ||
            sessionRevisionRef.current !== sessionRevision
          ) {
            return;
          }
          setAcceptedPreviewRevision(previewCandidateRevision);
          setPreview(toCreationPreview(result));
          setPhase('ready');
        },
        (previewError: unknown) => {
          if (
            abortController.signal.aborted ||
            previewRevisionRef.current !== draftRevision ||
            sessionRevisionRef.current !== sessionRevision ||
            (previewError instanceof Error && previewError.name === 'AbortError')
          ) {
            return;
          }
          setError(toError(previewError));
          setPhase('preview-error');
        },
      );
    }, PREVIEW_DEBOUNCE_MILLISECONDS);

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [editCandidateResult.candidate, operation, snapshot]);

  const enterOperation = useCallback(
    (nextOperation: BodyEditingOperation, bodyId: string) => {
      if (operation !== null) {
        return;
      }
      sessionRevisionRef.current += 1;
      invalidateCandidatePreview();
      resumeAfterCancelRef.current = simulation.runState === 'running';
      setOperation(nextOperation);
      setTargetBodyId(bodyId);
      setSnapshot(null);
      setFields(null);
      setPreview(null);
      setPhase('syncing');
      setError(null);
      const sessionRevision = sessionRevisionRef.current;
      void simulation.pause().catch((pauseError: unknown) => {
        if (sessionRevisionRef.current === sessionRevision) {
          setError(toError(pauseError));
          setPhase('conflicted');
        }
      });
    },
    [invalidateCandidatePreview, operation, simulation],
  );

  const enterEdit = useCallback(
    (bodyId: string) => {
      enterOperation('edit', bodyId);
    },
    [enterOperation],
  );

  const enterDelete = useCallback(
    (bodyId: string) => {
      enterOperation('delete', bodyId);
    },
    [enterOperation],
  );

  const cancel = useCallback(() => {
    if (phase === 'submitting') {
      return;
    }
    sessionRevisionRef.current += 1;
    invalidateCandidatePreview();
    setOperation(null);
    setTargetBodyId(null);
    setSnapshot(null);
    setFields(null);
    setPreview(null);
    setPhase('syncing');
    setError(null);
    if (resumeAfterCancelRef.current) {
      resumeAfterCancelRef.current = false;
      void simulation.start().catch(() => undefined);
    }
  }, [invalidateCandidatePreview, phase, simulation]);

  const updateField = useCallback(
    (fieldName: BodyEditFieldName, value: string) => {
      if (
        phase !== 'editing' &&
        phase !== 'previewing' &&
        phase !== 'preview-error' &&
        phase !== 'ready'
      ) {
        return;
      }
      invalidateCandidatePreview();
      setFields((current) =>
        current === null ? null : updateBodyEditField(current, fieldName, value),
      );
      setPreview(null);
      setError(null);
      setPhase('editing');
    },
    [invalidateCandidatePreview, phase],
  );

  const resync = useCallback(() => {
    if (operation === null || phase === 'submitting') {
      return;
    }
    sessionRevisionRef.current += 1;
    invalidateCandidatePreview();
    setSnapshot(null);
    setPreview(null);
    setPhase('syncing');
    setError(null);
    const sessionRevision = sessionRevisionRef.current;
    void simulation.pause().catch((pauseError: unknown) => {
      if (sessionRevisionRef.current === sessionRevision) {
        setError(toError(pauseError));
        setPhase('conflicted');
      }
    });
  }, [invalidateCandidatePreview, operation, phase, simulation]);

  const confirm = useCallback(() => {
    if (snapshot === null || targetBodyId === null || phase === 'submitting') {
      return;
    }
    const editCandidate = editCandidateResult.candidate;
    const deleteCandidate = deleteCandidateResult.candidate;
    const candidateBodies =
      operation === 'edit' &&
      phase === 'ready' &&
      preview !== null &&
      acceptedPreviewRevision === candidateRevisionRef.current
        ? editCandidate?.bodies
        : operation === 'delete' && phase === 'delete-ready'
          ? deleteCandidate?.bodies
          : undefined;
    if (candidateBodies === undefined) {
      return;
    }

    const sessionRevision = sessionRevisionRef.current;
    setPhase('submitting');
    setError(null);
    void simulation
      .replaceBodies(candidateBodies, snapshot.bodyRevision, snapshot.simulationTimeSeconds)
      .then(
        () => {
          if (sessionRevisionRef.current !== sessionRevision) {
            return;
          }
          sessionRevisionRef.current += 1;
          invalidateCandidatePreview();
          resumeAfterCancelRef.current = false;
          setOperation(null);
          setTargetBodyId(null);
          setSnapshot(null);
          setFields(null);
          setPreview(null);
          setPhase('syncing');
          setError(null);
          if (operation === 'edit') {
            onEditedRef.current({ bodyId: targetBodyId });
          } else {
            onDeletedRef.current({
              deletedBodyId: targetBodyId,
              fallbackBodyId: deleteCandidate?.fallbackBodyId ?? null,
            });
          }
        },
        (replacementError: unknown) => {
          if (sessionRevisionRef.current !== sessionRevision) {
            return;
          }
          const describedError = toError(replacementError);
          setError(describedError);
          setPhase(
            isSnapshotConflict(describedError)
              ? 'conflicted'
              : operation === 'edit'
                ? 'ready'
                : 'delete-ready',
          );
        },
      );
  }, [
    deleteCandidateResult.candidate,
    editCandidateResult.candidate,
    acceptedPreviewRevision,
    invalidateCandidatePreview,
    operation,
    phase,
    preview,
    simulation,
    snapshot,
    targetBodyId,
  ]);

  const fieldErrors = parseResult?.success === false ? parseResult.errors : {};
  const effectiveError = error ?? editCandidateResult.error ?? deleteCandidateResult.error;
  const canConfirm =
    (operation === 'edit' &&
      phase === 'ready' &&
      preview !== null &&
      acceptedPreviewRevision === candidateRevision) ||
    (operation === 'delete' &&
      phase === 'delete-ready' &&
      deleteCandidateResult.candidate !== null);
  const overlayState = useMemo<CreationOverlayState | null>(() => {
    const candidate = editCandidateResult.candidate;
    if (operation !== 'edit' || candidate === null) {
      return null;
    }
    return {
      enabled: true,
      cameraMode: 'preserve',
      interactive: false,
      draftBodies: [candidate.body],
      placement: null,
      preview,
      previewPending: phase === 'previewing',
      color: getCelestialCatalogEntry(candidate.body.id)?.color ?? 0xaeb8bd,
    };
  }, [editCandidateResult.candidate, operation, phase, preview]);

  return {
    acceptedPreviewRevision,
    active: operation !== null,
    candidateRevision,
    canConfirm,
    cancel,
    confirm,
    enterDelete,
    enterEdit,
    error: effectiveError,
    fieldErrors,
    fields,
    operation,
    overlayState,
    phase,
    preview,
    resync,
    targetBody,
    updateField,
  };
}
