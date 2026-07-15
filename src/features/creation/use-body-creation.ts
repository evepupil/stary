import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ORBIT_PREVIEW_PROTOCOL_VERSION, requestTrajectoryPreview } from '../../physics/preview';
import type { UniverseSimulation } from '../observatory/simulation/use-universe-simulation';
import type { CreationPhase } from './components/CreationPanel';
import type { ObservatoryMode } from './components/CreationModeSwitcher';
import {
  buildCreationDraft,
  estimatePreviewDurationSeconds,
  getCreationCapacityError,
  getCreationPreset,
} from './model/body-presets';
import { captureCreationSnapshot } from './model/creation-draft';
import { toCreationPreview } from './model/creation-preview';
import type {
  CreationDraft,
  CreationOverlayState,
  CreationPlacement,
  CreationPreview,
  CreationPresetId,
  CreationSnapshot,
} from './model/creation-types';

const PREVIEW_SAMPLE_COUNT = 256;

interface UseBodyCreationOptions {
  readonly onCommitted: (bodyId: string) => void;
  readonly simulation: UniverseSimulation;
}

export interface BodyCreationController {
  readonly cancel: () => void;
  readonly confirm: () => void;
  readonly draft: CreationDraft | null;
  readonly enter: () => void;
  readonly error: Error | null;
  readonly mode: ObservatoryMode;
  readonly overlayState: CreationOverlayState | null;
  readonly phase: CreationPhase;
  readonly placement: CreationPlacement | null;
  readonly presetId: CreationPresetId;
  readonly preview: CreationPreview | null;
  readonly selectPreset: (presetId: CreationPresetId) => void;
  readonly updatePlacement: (placement: CreationPlacement) => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('创造工具发生未知错误');
}

export function useBodyCreation({
  onCommitted,
  simulation,
}: UseBodyCreationOptions): BodyCreationController {
  const [mode, setMode] = useState<ObservatoryMode>('observe');
  const [snapshot, setSnapshot] = useState<CreationSnapshot | null>(null);
  const [presetId, setPresetId] = useState<CreationPresetId>('rocky-planet');
  const [placement, setPlacement] = useState<CreationPlacement | null>(null);
  const [preview, setPreview] = useState<CreationPreview | null>(null);
  const [phase, setPhase] = useState<CreationPhase>('syncing');
  const [error, setError] = useState<Error | null>(null);
  const previewRevisionRef = useRef(0);
  const onCommittedRef = useRef(onCommitted);
  const resumeAfterCancelRef = useRef(false);

  useEffect(() => {
    onCommittedRef.current = onCommitted;
  }, [onCommitted]);

  const draftResult = useMemo(() => {
    if (snapshot === null || placement === null) {
      return { draft: null, error: null };
    }
    const capacityError = getCreationCapacityError(snapshot.bodies.length, presetId);
    if (capacityError !== null) {
      return { draft: null, error: capacityError };
    }
    return {
      draft: buildCreationDraft(snapshot, presetId, placement),
      error: null,
    };
  }, [placement, presetId, snapshot]);
  const draft = draftResult.draft;
  const effectiveError = error ?? draftResult.error;
  const effectivePhase: CreationPhase = draftResult.error === null ? phase : 'preview-error';

  useEffect(() => {
    if (
      mode !== 'create' ||
      snapshot !== null ||
      simulation.runState !== 'paused' ||
      simulation.commandPending ||
      simulation.bodySnapshotSimulationTimeSeconds !== simulation.simulationTimeSeconds
    ) {
      return undefined;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      try {
        setSnapshot(
          captureCreationSnapshot(
            simulation.bodies,
            simulation.bodyRevision,
            simulation.bodySnapshotSimulationTimeSeconds,
            simulation.simulationTimeSeconds,
          ),
        );
        setPhase('placing');
        setError(null);
      } catch (snapshotError) {
        setError(toError(snapshotError));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mode, simulation, snapshot]);

  useEffect(() => {
    if (
      mode !== 'create' ||
      snapshot === null ||
      draft === null ||
      placement?.phase !== 'placed' ||
      draft.referenceBodyId === null
    ) {
      return undefined;
    }

    const abortController = new AbortController();
    const draftRevision = previewRevisionRef.current + 1;
    previewRevisionRef.current = draftRevision;
    queueMicrotask(() => {
      if (!abortController.signal.aborted && previewRevisionRef.current === draftRevision) {
        setPreview(null);
        setPhase('previewing');
        setError(null);
      }
    });

    void requestTrajectoryPreview(
      {
        version: ORBIT_PREVIEW_PROTOCOL_VERSION,
        type: 'trajectoryPreviewRequest',
        requestId: `creation-preview-${String(draftRevision)}`,
        draftRevision,
        bodies: [...snapshot.bodies, ...draft.bodies],
        draftBodyIds: draft.bodies.map((body) => body.id),
        referenceBodyId: draft.referenceBodyId,
        durationSeconds: estimatePreviewDurationSeconds(snapshot.bodies, draft),
        sampleCount: PREVIEW_SAMPLE_COUNT,
      },
      { signal: abortController.signal },
    ).then(
      (result) => {
        if (previewRevisionRef.current !== draftRevision) {
          return;
        }
        try {
          setPreview(toCreationPreview(result));
          setPhase('ready');
        } catch (previewError) {
          setError(toError(previewError));
          setPhase('preview-error');
        }
      },
      (previewError: unknown) => {
        if (
          abortController.signal.aborted ||
          previewRevisionRef.current !== draftRevision ||
          (previewError instanceof Error && previewError.name === 'AbortError')
        ) {
          return;
        }
        setError(toError(previewError));
        setPhase('preview-error');
      },
    );

    return () => {
      abortController.abort();
    };
  }, [draft, mode, placement?.phase, snapshot]);

  const enter = useCallback(() => {
    if (mode === 'create') {
      return;
    }
    resumeAfterCancelRef.current = simulation.runState === 'running';
    setMode('create');
    setSnapshot(null);
    setPlacement(null);
    setPreview(null);
    setPhase('syncing');
    setError(null);
    void simulation.pause().catch((pauseError: unknown) => {
      setError(toError(pauseError));
    });
  }, [mode, simulation]);

  const cancel = useCallback(() => {
    if (phase === 'submitting') {
      return;
    }
    previewRevisionRef.current += 1;
    setMode('observe');
    setSnapshot(null);
    setPlacement(null);
    setPreview(null);
    setError(null);
    if (resumeAfterCancelRef.current) {
      resumeAfterCancelRef.current = false;
      void simulation.start().catch(() => undefined);
    }
  }, [phase, simulation]);

  const selectPreset = useCallback((nextPresetId: CreationPresetId) => {
    setPresetId(nextPresetId);
    setPreview(null);
    setError(null);
  }, []);

  const updatePlacement = useCallback((nextPlacement: CreationPlacement) => {
    setPlacement(nextPlacement);
    setPreview(null);
    setError(null);
    setPhase(nextPlacement.phase === 'dragging' ? 'dragging' : 'previewing');
  }, []);

  const confirm = useCallback(() => {
    if (snapshot === null || draft === null || preview === null || phase !== 'ready') {
      return;
    }
    setPhase('submitting');
    setError(null);
    void simulation
      .replaceBodies(
        [...snapshot.bodies, ...draft.bodies],
        snapshot.bodyRevision,
        snapshot.simulationTimeSeconds,
      )
      .then(
        () => {
          previewRevisionRef.current += 1;
          resumeAfterCancelRef.current = false;
          setMode('observe');
          setSnapshot(null);
          setPlacement(null);
          setPreview(null);
          setError(null);
          const committedBodyId = draft.bodies[0]?.id;
          if (committedBodyId !== undefined) {
            onCommittedRef.current(committedBodyId);
          }
        },
        (replacementError: unknown) => {
          setError(toError(replacementError));
          setPhase('ready');
        },
      );
  }, [draft, phase, preview, simulation, snapshot]);

  const overlayState = useMemo<CreationOverlayState | null>(() => {
    if (mode !== 'create') {
      return null;
    }
    return {
      enabled: true,
      cameraMode: 'creation',
      interactive: snapshot !== null && phase !== 'submitting',
      draftBodies: draft?.bodies ?? [],
      placement,
      preview,
      previewPending: effectivePhase === 'previewing',
      color: getCreationPreset(presetId).color,
    };
  }, [draft, effectivePhase, mode, phase, placement, presetId, preview, snapshot]);

  return {
    cancel,
    confirm,
    draft,
    enter,
    error: effectiveError,
    mode,
    overlayState,
    phase: effectivePhase,
    placement,
    presetId,
    preview,
    selectPreset,
    updatePlacement,
  };
}
