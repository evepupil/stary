import { useEffect, useRef, type JSX } from 'react';

import type { BodyState } from '../../../physics/protocol/schemas';
import {
  createObservatoryRenderer,
  disposeObservatoryRenderer,
  type ObservatoryRenderer,
  type RendererBackend,
} from './create-renderer';
import type { ObservatoryScene } from './observatory-scene';
import './universe-viewport.css';

export interface UniverseViewportProps {
  readonly bodies: readonly BodyState[];
  readonly className?: string;
  readonly onBackendChange?: (backend: RendererBackend) => void;
  readonly onError?: (error: Error) => void;
  readonly onSelectBody: (bodyId: string) => void;
  readonly selectedBodyId: string | null;
}

export function UniverseViewport({
  bodies,
  className,
  onBackendChange,
  onError,
  onSelectBody,
  selectedBodyId,
}: UniverseViewportProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ObservatoryScene | null>(null);
  const bodiesRef = useRef(bodies);
  const selectedBodyIdRef = useRef(selectedBodyId);
  const onBackendChangeRef = useRef(onBackendChange);
  const onErrorRef = useRef(onError);
  const onSelectBodyRef = useRef(onSelectBody);

  useEffect(() => {
    bodiesRef.current = bodies;
    selectedBodyIdRef.current = selectedBodyId;
    sceneRef.current?.update(bodies, selectedBodyId);
  }, [bodies, selectedBodyId]);

  useEffect(() => {
    onBackendChangeRef.current = onBackendChange;
    onErrorRef.current = onError;
    onSelectBodyRef.current = onSelectBody;
  }, [onBackendChange, onError, onSelectBody]);

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

    void Promise.all([rendererPromise, import('./observatory-scene')])
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
          onSelectBody: (bodyId) => {
            onSelectBodyRef.current(bodyId);
          },
          renderer,
        });
        rendererToDispose = null;
        sceneRef.current = scene;
        scene.update(bodiesRef.current, selectedBodyIdRef.current);
        onBackendChangeRef.current?.(backend);
      })
      .catch((error: unknown) => {
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
