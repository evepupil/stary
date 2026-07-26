import { useEffect, useRef, type JSX } from 'react';

import type { CreationOverlayState, CreationPlacement } from '../../creation/model/creation-types';
import type { BodyState, PassiveCollisionAsset } from '../../../physics/protocol/schemas';
import {
  createObservatoryRenderer,
  disposeObservatoryRenderer,
  type ObservatoryRenderer,
  type RendererBackend,
} from './create-renderer';
import { loadObservatoryScene } from './observatory-scene-loader';
import type { ObservatoryScene } from './observatory-scene';
import './universe-viewport.css';

const EMPTY_PASSIVE_ASSETS: readonly PassiveCollisionAsset[] = [];

export interface UniverseViewportProps {
  readonly bodies: readonly BodyState[];
  readonly className?: string;
  readonly creationState?: CreationOverlayState | null;
  readonly dustCohorts?: readonly PassiveCollisionAsset[] | undefined;
  readonly focusBodyId: string | null;
  readonly onBackendChange?: (backend: RendererBackend) => void;
  readonly onError?: (error: Error) => void;
  readonly onCreationPlacementChange?: (placement: CreationPlacement) => void;
  readonly onSelectBody: (bodyId: string) => void;
  readonly selectedBodyId: string | null;
  readonly simulationTimeSeconds: number;
  readonly tracers?: readonly PassiveCollisionAsset[] | undefined;
}

export function UniverseViewport({
  bodies,
  className,
  creationState = null,
  dustCohorts = EMPTY_PASSIVE_ASSETS,
  focusBodyId,
  onBackendChange,
  onError,
  onCreationPlacementChange,
  onSelectBody,
  selectedBodyId,
  simulationTimeSeconds,
  tracers = EMPTY_PASSIVE_ASSETS,
}: UniverseViewportProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ObservatoryScene | null>(null);
  const pendingFocusBodyIdRef = useRef<string | null>(null);
  const bodiesRef = useRef(bodies);
  const creationStateRef = useRef(creationState);
  const focusBodyIdRef = useRef(focusBodyId);
  const passiveAssetsRef = useRef({ tracers, dustCohorts });
  const selectedBodyIdRef = useRef(selectedBodyId);
  const simulationTimeSecondsRef = useRef(simulationTimeSeconds);
  const onBackendChangeRef = useRef(onBackendChange);
  const onErrorRef = useRef(onError);
  const onCreationPlacementChangeRef = useRef(onCreationPlacementChange);
  const onSelectBodyRef = useRef(onSelectBody);

  useEffect(() => {
    bodiesRef.current = bodies;
    selectedBodyIdRef.current = selectedBodyId;
    simulationTimeSecondsRef.current = simulationTimeSeconds;
    passiveAssetsRef.current = { tracers, dustCohorts };
    const scene = sceneRef.current;
    scene?.update(bodies, selectedBodyId, simulationTimeSeconds, { tracers, dustCohorts });
    const pendingFocusBodyId = pendingFocusBodyIdRef.current;
    if (scene !== null && pendingFocusBodyId !== null && scene.focusBody(pendingFocusBodyId)) {
      pendingFocusBodyIdRef.current = null;
    }
  }, [bodies, dustCohorts, selectedBodyId, simulationTimeSeconds, tracers]);

  useEffect(() => {
    creationStateRef.current = creationState;
    sceneRef.current?.setCreationState(creationState);
  }, [creationState]);

  useEffect(() => {
    focusBodyIdRef.current = focusBodyId;
    if (focusBodyId === null) {
      pendingFocusBodyIdRef.current = null;
      sceneRef.current?.showOverview();
    } else if (sceneRef.current?.focusBody(focusBodyId) === true) {
      pendingFocusBodyIdRef.current = null;
    } else {
      pendingFocusBodyIdRef.current = focusBodyId;
    }
  }, [focusBodyId]);

  useEffect(() => {
    onBackendChangeRef.current = onBackendChange;
    onErrorRef.current = onError;
    onCreationPlacementChangeRef.current = onCreationPlacementChange;
    onSelectBodyRef.current = onSelectBody;
  }, [onBackendChange, onCreationPlacementChange, onError, onSelectBody]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) {
      return undefined;
    }

    let cancelled = false;
    let rendererToDispose: ObservatoryRenderer | null = null;
    let scene: ObservatoryScene | null = null;

    const rendererPromise = createObservatoryRenderer().then((createdRenderer) => {
      rendererToDispose = createdRenderer.renderer;
      return createdRenderer;
    });

    void Promise.all([rendererPromise, loadObservatoryScene()])
      .then(([{ backend, renderer }, { ObservatoryScene }]) => {
        if (cancelled) {
          disposeObservatoryRenderer(renderer);
          rendererToDispose = null;
          return;
        }

        scene = new ObservatoryScene({
          backend,
          mount,
          onError: (error) => onErrorRef.current?.(error),
          onCreationPlacementChange: (placement) => {
            onCreationPlacementChangeRef.current?.(placement);
          },
          onSelectBody: (bodyId) => {
            onSelectBodyRef.current(bodyId);
          },
          renderer,
        });
        rendererToDispose = null;
        sceneRef.current = scene;
        scene.update(
          bodiesRef.current,
          selectedBodyIdRef.current,
          simulationTimeSecondsRef.current,
          passiveAssetsRef.current,
        );
        if (focusBodyIdRef.current === null) {
          pendingFocusBodyIdRef.current = null;
          scene.showOverview();
        } else if (scene.focusBody(focusBodyIdRef.current)) {
          pendingFocusBodyIdRef.current = null;
        } else {
          pendingFocusBodyIdRef.current = focusBodyIdRef.current;
        }
        scene.setCreationState(creationStateRef.current);
        onBackendChangeRef.current?.(backend);
      })
      .catch(async (error: unknown) => {
        await rendererPromise.catch(() => undefined);
        if (scene !== null) {
          if (sceneRef.current === scene) {
            sceneRef.current = null;
          }
          scene.dispose();
          scene = null;
        }
        if (rendererToDispose !== null) {
          rendererToDispose.domElement.remove();
          disposeObservatoryRenderer(rendererToDispose);
          rendererToDispose = null;
        }
        if (!cancelled) {
          onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
        }
      });

    return () => {
      cancelled = true;
      if (sceneRef.current === scene) {
        sceneRef.current = null;
      }
      scene?.dispose();
    };
  }, []);

  const rootClassName = className ? `universe-viewport ${className}` : 'universe-viewport';

  return <div ref={mountRef} className={rootClassName} data-testid="universe-viewport" />;
}
