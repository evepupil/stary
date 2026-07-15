import {
  AmbientLight,
  ArrowHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  PointLight,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  Material,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { BodyState, PositionMeters } from '../../../physics/protocol/schemas';
import type { CreationOverlayState, CreationPlacement } from '../../creation/model/creation-types';
import { getCelestialCatalogEntry } from '../catalog';
import { advanceAdaptiveExposure, computeTargetExposure } from './adaptive-exposure';
import { resolveBodyAssetPlan } from './assets/body-asset-plan';
import { TextureAssetCache } from './assets/texture-cache';
import {
  computeBodyInspectionCameraFrame,
  computeFocusCameraFrame,
  computeOverviewCameraFrame,
  type ObservatoryCameraFrame,
  type ObservatoryViewMode,
} from './camera-focus';
import {
  computeCameraNavigationSettings,
  computeCameraTransitionDurationMilliseconds,
  easeCameraTransitionProgress,
  interpolateCameraDistance,
} from './camera-navigation';
import {
  applyCreationCameraView,
  captureCreationCameraState,
  rescaleStoredCreationCameraState,
  restoreCreationCameraState,
  type StoredCreationCameraState,
} from './creation-camera';
import {
  computeMetersToSceneUnit,
  computePositionRingRadius,
  computeScenePhysicalExtentMeters,
  physicalRadiusToSceneUnits,
  positionMetersToScene,
  reprojectScenePosition,
  shouldRecomputeSceneScale,
} from './coordinates';
import { computeMinimumBillboardWorldRadius, OBSERVATORY_VERTICAL_FOV_DEGREES } from './camera-fit';
import {
  OBSERVATORY_TONE_MAPPING_EXPOSURE,
  disposeObservatoryRenderer,
  renderObservatoryFrame,
  type ObservatoryRenderer,
  type RendererBackend,
} from './create-renderer';
import {
  computeCombinedStellarTransmission,
  computeStellarVisibility,
  type StellarIlluminationSample,
} from './lighting/stellar-occlusion';
import { sampleOsculatingOrbit } from './orbit';
import { findMostMassiveBody, findOrbitParent } from './orbit-parent';
import {
  recordSceneCreated,
  recordSceneDisposed,
  snapshotRenderLifecycle,
} from './render-lifecycle-diagnostics';
import { resolveBodyAppearance, selectActiveStellarLightIds } from './appearance/body-appearance';
import {
  pickNearestScreenMarker,
  selectVisibleScreenMarkers,
  type ScreenMarkerCandidate,
} from './marker-layout';
import {
  BODY_LOD_THRESHOLDS,
  RENDER_SCALE_THRESHOLDS,
  computeProjectedRadiusPixels,
  selectBodyLod,
  selectRenderScaleTier,
  type RenderScaleTier,
} from './render-scale';
import { collectSceneResourceCounts } from './scene-resource-counts';
import {
  updateBodyEnvironmentLighting,
  updateBodyEnvironmentScale,
  updateBodyEnvironmentTime,
  updateBodyEnvironmentVisibility,
} from './visuals/body-environment';
import {
  snapshotBlackHoleTexturePool,
  updateBlackHoleScale,
  updateBlackHoleVisibility,
} from './visuals/black-hole';
import {
  createBodyVisual,
  disposeBodyVisual,
  isBodyVisualCompatible,
  updateBodyVisualAppearance,
  updateBodyVisualLod,
  updateBodyVisualStellarVisibility,
  type BodyVisual,
} from './visuals/body-visual';
import { updatePlanetaryRingShadow } from './visuals/planetary-ring';

const STAR_COUNT = 1_600;
const ORBIT_SEGMENTS = 256;
const MARKER_MINIMUM_SEPARATION_PIXELS = 18;
const MARKER_HIT_RADIUS_PIXELS = 20;
const MARKER_DIAGNOSTICS_QUERY_PARAMETER = 'markerDiagnostics';
const VISUAL_DIAGNOSTICS_QUERY_PARAMETER = 'visualDiagnostics';
const CLOUD_SHADOWS_QUERY_PARAMETER = 'cloudShadows';
const MARKER_DIAGNOSTICS_INTERVAL_MILLISECONDS = 100;
const CREATION_VELOCITY_DRAG_SECONDS = 10_000_000;

function usesCreationCamera(state: CreationOverlayState | null): boolean {
  return state?.enabled === true && state.cameraMode === 'creation';
}

function projectWorldPoint(
  worldPoint: Vector3,
  camera: PerspectiveCamera,
  width: number,
  height: number,
): { readonly x: number; readonly y: number; readonly z: number } {
  const projected = worldPoint.project(camera);
  return {
    x: Number((((projected.x + 1) / 2) * width).toFixed(2)),
    y: Number((((1 - projected.y) / 2) * height).toFixed(2)),
    z: Number(projected.z.toFixed(6)),
  };
}

interface OrbitVisual {
  readonly line: Line<BufferGeometry, LineBasicMaterial>;
}

interface CreationBodyVisual {
  readonly bodyId: string;
  readonly mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  physicalRadiusSceneUnits: number;
}

interface BodyLightingObservation {
  readonly dominantStarId: string | null;
  readonly illuminatedFraction: number;
  readonly illuminance: number;
  readonly lightDirection: Vector3 | null;
  readonly occluderIds: readonly string[];
  readonly stellarVisibility: number;
}

interface CameraTransitionState {
  readonly direction: Vector3;
  readonly durationMilliseconds: number;
  readonly endDistance: number;
  readonly endTarget: Vector3;
  startTimeMilliseconds: number | null;
  readonly startDistance: number;
  readonly startTarget: Vector3;
}

interface RenderScaleHistoryEntry {
  readonly distance: number;
  readonly frame: number;
  readonly from: RenderScaleTier;
  readonly projectedRadiusPixels: number;
  readonly to: RenderScaleTier;
}

export interface ObservatorySceneOptions {
  readonly backend: RendererBackend;
  readonly mount: HTMLDivElement;
  readonly onCreationPlacementChange: (placement: CreationPlacement) => void;
  readonly onError: (error: Error) => void;
  readonly onSelectBody: (bodyId: string) => void;
  readonly renderer: ObservatoryRenderer;
}

export class ObservatoryScene {
  private readonly backend: RendererBackend;
  private readonly bodyVisuals = new Map<string, BodyVisual>();
  private readonly camera = new PerspectiveCamera(OBSERVATORY_VERTICAL_FOV_DEGREES, 1, 0.01, 320);
  private readonly controls: OrbitControls | null = null;
  private readonly creationBodyVisuals = new Map<string, CreationBodyVisual>();
  private readonly creationPlane = new Plane(new Vector3(0, 0, 1), 0);
  private readonly creationRaycaster = new Raycaster();
  private readonly creationTrajectoryVisuals = new Map<
    string,
    Line<BufferGeometry, LineBasicMaterial>
  >();
  private readonly cloudShadowsEnabled =
    new URLSearchParams(window.location.search).get(CLOUD_SHADOWS_QUERY_PARAMETER) !== '0';
  private readonly creationVelocityArrow = new ArrowHelper(
    new Vector3(1, 0, 0),
    new Vector3(),
    1,
    0xf0c674,
    0.22,
    0.1,
  );
  private readonly mount: HTMLDivElement;
  private readonly onCreationPlacementChange: (placement: CreationPlacement) => void;
  private readonly onError: (error: Error) => void;
  private readonly onSelectBody: (bodyId: string) => void;
  private readonly orbitVisuals = new Map<string, OrbitVisual>();
  private readonly renderer: ObservatoryRenderer;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly scene = new Scene();
  private readonly starField = createStarField();
  private readonly textureCache = new TextureAssetCache();
  private readonly exposeMarkerDiagnostics =
    new URLSearchParams(window.location.search).get(MARKER_DIAGNOSTICS_QUERY_PARAMETER) === '1';
  private readonly exposeVisualDiagnostics =
    new URLSearchParams(window.location.search).get(VISUAL_DIAGNOSTICS_QUERY_PARAMETER) === '1';
  private animationFrame: number | null = null;
  private bodySetKey = '';
  private cameraTransition: CameraTransitionState | null = null;
  private cameraTransitionProgress = 1;
  private cameraWasInteracted = false;
  private creationCameraSnapshot: StoredCreationCameraState | null = null;
  private creationCameraSnapshotMetersToSceneUnit: number | null = null;
  private creationCameraWasInteracted = false;
  private creationDragStartScene: Vector3 | null = null;
  private creationPointerId: number | null = null;
  private creationState: CreationOverlayState | null = null;
  private disposed = false;
  private exposureTarget = OBSERVATORY_TONE_MAPPING_EXPOSURE;
  private focusBodyId: string | null = null;
  private focusedLightingObservation: BodyLightingObservation | null = null;
  private lastDiagnosticsUpdateTimeMilliseconds = Number.NEGATIVE_INFINITY;
  private lastVisualDiagnosticsUpdateTimeMilliseconds = Number.NEGATIVE_INFINITY;
  private lastExposureUpdateTimeMilliseconds: number | null = null;
  private latestBodies: readonly BodyState[] = [];
  private latestSimulationTimeSeconds = 0;
  private metersToSceneUnit = 1;
  private pointerDownPosition: Vector2 | null = null;
  private selectedBodyId: string | null = null;
  private renderFrameCount = 0;
  private renderScaleTier: RenderScaleTier = 'system';
  private renderScaleHistory: readonly RenderScaleHistoryEntry[] = [];
  private sceneOriginBodyId: string | null = null;
  private sceneOriginMeters: PositionMeters = { x: 0, y: 0, z: 0 };
  private scenePhysicalExtentMeters = 0;
  private updatingControlsProgrammatically = false;
  private viewMode: ObservatoryViewMode = 'overview';
  private visibleScreenMarkers: readonly ScreenMarkerCandidate[] = [];

  constructor(options: ObservatorySceneOptions) {
    this.backend = options.backend;
    this.mount = options.mount;
    this.onCreationPlacementChange = options.onCreationPlacementChange;
    this.onError = options.onError;
    this.onSelectBody = options.onSelectBody;
    this.renderer = options.renderer;

    const canvas = this.renderer.domElement;
    canvas.className = 'universe-viewport__canvas';
    canvas.dataset.rendererBackend = this.backend;
    canvas.setAttribute('aria-label', '太阳系多天体三维宇宙模拟视图');
    canvas.setAttribute('role', 'img');
    try {
      this.mount.append(canvas);

      this.camera.position.set(0, 0, 24);
      this.camera.lookAt(0, 0, 0);

      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.06;
      this.controls.enablePan = false;
      this.controls.minDistance = 4;
      this.controls.maxDistance = 48;
      this.controls.rotateSpeed = 0.55;
      this.controls.zoomSpeed = 0.8;
      this.controls.zoomToCursor = true;
      this.controls.addEventListener('change', this.handleControlsChange);

      this.scene.background = new Color(0x030506);
      this.scene.add(new AmbientLight(0x7f96a3, 0.18));
      this.scene.add(this.starField);
      this.creationVelocityArrow.visible = false;
      this.creationVelocityArrow.renderOrder = 6;
      this.scene.add(this.creationVelocityArrow);

      canvas.addEventListener('pointerdown', this.handlePointerDown);
      canvas.addEventListener('pointermove', this.handlePointerMove);
      canvas.addEventListener('pointerup', this.handlePointerUp);
      canvas.addEventListener('pointercancel', this.handlePointerCancel);

      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(this.mount);
      this.resize();
      this.animationFrame = requestAnimationFrame(this.renderFrame);
      recordSceneCreated();
    } catch (error) {
      this.rollbackConstruction();
      throw error;
    }
  }

  update(
    bodies: readonly BodyState[],
    selectedBodyId: string | null,
    simulationTimeSeconds = 0,
  ): void {
    if (this.disposed) {
      return;
    }
    if (!Number.isFinite(simulationTimeSeconds) || simulationTimeSeconds < 0) {
      throw new RangeError('simulationTimeSeconds 必须是非负有限数');
    }

    this.selectedBodyId = selectedBodyId;
    this.latestBodies = bodies;
    this.latestSimulationTimeSeconds = simulationTimeSeconds;
    const previousMetersToSceneUnit = this.metersToSceneUnit;
    const primary = findMostMassiveBody(bodies);
    const nextBodySetKey = bodies
      .map((body) => body.id)
      .toSorted()
      .join('\u0000');
    const nextPhysicalExtentMeters = computeScenePhysicalExtentMeters(bodies);

    if (
      nextBodySetKey !== this.bodySetKey ||
      shouldRecomputeSceneScale(this.scenePhysicalExtentMeters, nextPhysicalExtentMeters)
    ) {
      this.bodySetKey = nextBodySetKey;
      this.scenePhysicalExtentMeters = nextPhysicalExtentMeters;
      this.metersToSceneUnit = computeMetersToSceneUnit(bodies);
    }
    const focusedOriginBody =
      this.viewMode === 'focus' && !usesCreationCamera(this.creationState)
        ? (bodies.find((body) => body.id === this.focusBodyId) ?? null)
        : null;
    this.rebaseSceneOrigin(
      focusedOriginBody?.positionMeters ?? { x: 0, y: 0, z: 0 },
      focusedOriginBody?.id ?? null,
      previousMetersToSceneUnit,
    );

    const activeBodyIds = new Set(bodies.map((body) => body.id));
    const activeStellarLightIds = new Set(selectActiveStellarLightIds(bodies));
    for (const [bodyId, visual] of this.bodyVisuals) {
      if (!activeBodyIds.has(bodyId)) {
        disposeBodyVisual(this.scene, visual);
        this.bodyVisuals.delete(bodyId);
      }
    }

    for (const body of bodies) {
      const isPrimary = primary?.id === body.id;
      const appearance = resolveBodyAppearance(body);
      const lightActive = activeStellarLightIds.has(body.id);
      let visual = this.bodyVisuals.get(body.id);
      if (visual !== undefined && !isBodyVisualCompatible(visual, appearance, lightActive)) {
        disposeBodyVisual(this.scene, visual);
        this.bodyVisuals.delete(body.id);
        visual = undefined;
      }
      if (visual === undefined) {
        visual = createBodyVisual(
          this.scene,
          appearance,
          this.backend,
          isPrimary,
          'low',
          lightActive,
          this.metersToSceneUnit,
          resolveBodyAssetPlan(body.id),
          this.textureCache,
        );
        this.bodyVisuals.set(body.id, visual);
      }
      visual.isPrimary = isPrimary;
      updateBodyVisualAppearance(visual, appearance, this.metersToSceneUnit);
      this.updateBodyVisualTransform(visual, body);
      if (visual.environment !== null) {
        updateBodyEnvironmentTime(visual.environment, this.latestSimulationTimeSeconds);
      }
    }

    this.updateOrbits(bodies);
    this.updateCreationOverlay();

    if (!usesCreationCamera(this.creationState) && this.viewMode === 'focus') {
      this.followFocusedBody();
    }
  }

  focusBody(bodyId: string): boolean {
    const body = this.latestBodies.find((candidate) => candidate.id === bodyId);
    if (body === undefined) {
      return false;
    }

    this.focusBodyId = bodyId;
    this.viewMode = 'focus';
    if (usesCreationCamera(this.creationState)) {
      return true;
    }
    this.rebaseSceneOrigin(body.positionMeters, body.id, this.metersToSceneUnit);
    this.refreshWorldTransforms();
    const frame = this.computeCameraFrameForBody(body);
    this.cameraWasInteracted = false;
    this.beginCameraTransition(frame);
    return true;
  }

  showOverview(): void {
    this.focusBodyId = null;
    this.viewMode = 'overview';
    if (usesCreationCamera(this.creationState)) {
      return;
    }
    this.rebaseSceneOrigin({ x: 0, y: 0, z: 0 }, null, this.metersToSceneUnit);
    this.refreshWorldTransforms();
    this.cameraWasInteracted = false;
    this.beginCameraTransition(computeOverviewCameraFrame(this.camera.aspect));
  }

  setCreationState(state: CreationOverlayState | null): void {
    if (this.disposed) {
      return;
    }
    const wasUsingCreationCamera = usesCreationCamera(this.creationState);
    const nextUsesCreationCamera = usesCreationCamera(state);
    if (!wasUsingCreationCamera && nextUsesCreationCamera) {
      this.enterCreationCameraView();
    } else if (wasUsingCreationCamera && !nextUsesCreationCamera) {
      this.cancelCreationDrag();
      this.leaveCreationCameraView();
    }
    this.creationState = state;
    if (this.controls !== null) {
      this.controls.enabled = !nextUsesCreationCamera;
    }
    const canvas = this.renderer.domElement;
    canvas.dataset.creationActive = nextUsesCreationCamera ? 'true' : 'false';
    canvas.dataset.draftPreviewActive = state?.enabled === true ? 'true' : 'false';
    if (state?.enabled === true) {
      if (nextUsesCreationCamera) {
        canvas.dataset.creationStage = state.placement?.phase ?? 'placing';
      } else {
        delete canvas.dataset.creationStage;
      }
      canvas.dataset.creationPreviewRisk = state.preview?.risk.kind ?? 'none';
      canvas.dataset.creationPreviewTrackCount = String(state.preview?.tracks.length ?? 0);
    } else {
      delete canvas.dataset.creationStage;
      delete canvas.dataset.creationPreviewRisk;
      delete canvas.dataset.creationPreviewTrackCount;
    }
    this.updateCreationOverlay();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.controls?.removeEventListener('change', this.handleControlsChange);
    this.controls?.dispose();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);

    for (const visual of this.bodyVisuals.values()) {
      disposeBodyVisual(this.scene, visual);
    }
    this.bodyVisuals.clear();
    this.textureCache.dispose();
    this.scene.traverse(disposeRenderable);
    this.scene.clear();
    canvas.remove();
    disposeObservatoryRenderer(this.renderer);
    this.orbitVisuals.clear();
    this.creationBodyVisuals.clear();
    this.creationTrajectoryVisuals.clear();
    this.creationCameraSnapshot = null;
    recordSceneDisposed();
  }

  private readonly updateBodyVisualTransform = (visual: BodyVisual, body: BodyState): void => {
    const scenePosition = positionMetersToScene(
      body.positionMeters,
      this.metersToSceneUnit,
      this.sceneOriginMeters,
    );
    const physicalRadiusSceneUnits = physicalRadiusToSceneUnits(
      body.radiusMeters,
      this.metersToSceneUnit,
    );

    visual.root.position.set(scenePosition.x, scenePosition.y, scenePosition.z);
    visual.mesh.scale.setScalar(physicalRadiusSceneUnits);
    visual.halo?.scale.set(physicalRadiusSceneUnits * 3.2, physicalRadiusSceneUnits * 3.2, 1);
    visual.planetaryRing?.mesh.scale.setScalar(physicalRadiusSceneUnits);
    visual.planetaryRing?.shadowMesh.scale.setScalar(physicalRadiusSceneUnits * 1.0015);
    if (visual.blackHole !== null) {
      updateBlackHoleScale(visual.blackHole, physicalRadiusSceneUnits);
    }
    if (visual.environment !== null) {
      updateBodyEnvironmentScale(visual.environment, physicalRadiusSceneUnits);
    }
    visual.mesh.userData.physicalRadiusMeters = body.radiusMeters;
    visual.physicalRadiusSceneUnits = physicalRadiusSceneUnits;

    visual.markerRing.position.copy(visual.root.position);
    const selected = body.id === this.selectedBodyId;
    visual.markerRing.material.opacity = selected ? 0.92 : 0.22;
    visual.markerRing.material.color.setHex(selected ? 0x72f1d5 : 0x4cc9b0);
  };

  private rebaseSceneOrigin(
    nextOriginMeters: PositionMeters,
    nextOriginBodyId: string | null,
    previousMetersToSceneUnit: number,
  ): void {
    const originChanged =
      nextOriginMeters.x !== this.sceneOriginMeters.x ||
      nextOriginMeters.y !== this.sceneOriginMeters.y ||
      nextOriginMeters.z !== this.sceneOriginMeters.z;
    const scaleChanged = previousMetersToSceneUnit !== this.metersToSceneUnit;
    const originTracksSameBody =
      nextOriginBodyId !== null && nextOriginBodyId === this.sceneOriginBodyId;
    const coordinateFrameChanged = originChanged && !originTracksSameBody;
    const shouldReprojectCamera =
      coordinateFrameChanged ||
      (scaleChanged && this.viewMode === 'focus' && !usesCreationCamera(this.creationState));
    if (shouldReprojectCamera && this.controls !== null && previousMetersToSceneUnit > 0) {
      const previousOrigin = this.sceneOriginMeters;
      const reproject = (point: Vector3): Vector3 => {
        const projected = reprojectScenePosition(point, {
          nextMetersToSceneUnit: this.metersToSceneUnit,
          nextOriginMeters,
          originTracksSameBody,
          previousMetersToSceneUnit,
          previousOriginMeters: previousOrigin,
        });
        return new Vector3(projected.x, projected.y, projected.z);
      };
      this.camera.position.copy(reproject(this.camera.position));
      this.controls.target.copy(reproject(this.controls.target));
      if (this.cameraTransition !== null) {
        const scaleRatio = this.metersToSceneUnit / previousMetersToSceneUnit;
        this.cameraTransition = {
          ...this.cameraTransition,
          endDistance: this.cameraTransition.endDistance * scaleRatio,
          endTarget: reproject(this.cameraTransition.endTarget),
          startDistance: this.cameraTransition.startDistance * scaleRatio,
          startTarget: reproject(this.cameraTransition.startTarget),
        };
      }
      this.camera.updateMatrixWorld();
    }
    this.sceneOriginMeters = { ...nextOriginMeters };
    this.sceneOriginBodyId = nextOriginBodyId;
  }

  private refreshWorldTransforms(): void {
    for (const body of this.latestBodies) {
      const visual = this.bodyVisuals.get(body.id);
      if (visual !== undefined) {
        this.updateBodyVisualTransform(visual, body);
      }
    }
    this.updateOrbits(this.latestBodies);
    this.updateCreationOverlay();
  }

  private readonly updateOrbits = (bodies: readonly BodyState[]): void => {
    const activeOrbitIds = new Set<string>();

    for (const body of bodies) {
      const parent = findOrbitParent(body, bodies);
      if (parent === null) {
        continue;
      }
      const points = sampleOsculatingOrbit(
        parent,
        body,
        this.metersToSceneUnit,
        ORBIT_SEGMENTS,
        this.sceneOriginMeters,
      );
      if (points === null) {
        continue;
      }

      activeOrbitIds.add(body.id);
      let visual = this.orbitVisuals.get(body.id);
      if (visual === undefined) {
        const geometry = new BufferGeometry();
        const positions = new BufferAttribute(new Float32Array(points.length * 3), 3);
        positions.setUsage(DynamicDrawUsage);
        geometry.setAttribute('position', positions);
        const material = new LineBasicMaterial({
          color: 0x4f7477,
          depthWrite: false,
          opacity: 0.48,
          transparent: true,
        });
        const line = new Line(geometry, material);
        line.renderOrder = 1;
        visual = { line };
        this.orbitVisuals.set(body.id, visual);
        this.scene.add(line);
      }

      const positionAttribute = visual.line.geometry.getAttribute('position');
      for (const [index, point] of points.entries()) {
        positionAttribute.setXYZ(index, point.x, point.y, point.z);
      }
      positionAttribute.needsUpdate = true;
      visual.line.geometry.computeBoundingSphere();
      visual.line.material.color.setHex(body.id === this.selectedBodyId ? 0x4cc9b0 : 0x4f7477);
      visual.line.material.opacity = body.id === this.selectedBodyId ? 0.78 : 0.48;
    }

    for (const [bodyId, visual] of this.orbitVisuals) {
      if (!activeOrbitIds.has(bodyId)) {
        this.scene.remove(visual.line);
        visual.line.geometry.dispose();
        visual.line.material.dispose();
        this.orbitVisuals.delete(bodyId);
      }
    }
  };

  private readonly resize = (): void => {
    if (this.disposed) {
      return;
    }
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    this.camera.aspect = width / height;
    if (usesCreationCamera(this.creationState) && this.controls !== null) {
      applyCreationCameraView(this.camera, this.controls);
    } else if (!this.cameraWasInteracted) {
      const focusFrame = this.computeCurrentFocusFrame();
      this.applyCameraFrame(
        this.viewMode === 'focus' && focusFrame !== null
          ? focusFrame
          : computeOverviewCameraFrame(this.camera.aspect),
      );
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
  };

  private readonly renderFrame = (timestampMilliseconds: number): void => {
    if (this.disposed) {
      return;
    }

    try {
      if (!usesCreationCamera(this.creationState)) {
        if (this.cameraTransition === null) {
          this.controls?.update();
        } else {
          this.updateCameraTransition(timestampMilliseconds);
        }
      }
      let focusedProjectedRadiusPixels = 0;
      let focusedLightingObservation: BodyLightingObservation | null = null;
      for (const visual of this.bodyVisuals.values()) {
        const cameraDistance = Math.max(
          Number.EPSILON,
          this.camera.position.distanceTo(visual.root.position),
        );
        const projectedRadiusPixels =
          visual.physicalRadiusSceneUnits > 0
            ? computeProjectedRadiusPixels(
                visual.physicalRadiusSceneUnits,
                cameraDistance,
                this.camera.fov,
                Math.max(1, this.mount.clientHeight),
              )
            : 0;
        const observableProjectedRadiusPixels =
          projectedRadiusPixels * (visual.blackHole?.profile.observableOuterRadiusRatio ?? 1);
        const nextLod =
          observableProjectedRadiusPixels > 0
            ? selectBodyLod(observableProjectedRadiusPixels, visual.lod)
            : 'low';
        visual.projectedRadiusPixels = projectedRadiusPixels;
        visual.observableProjectedRadiusPixels = observableProjectedRadiusPixels;
        if (visual.blackHole !== null) {
          updateBlackHoleVisibility(visual.blackHole, observableProjectedRadiusPixels);
        }
        const requiresLightingObservation =
          visual.environment !== null ||
          visual.planetaryRing !== null ||
          visual.bodyId === this.focusBodyId;
        const lightingObservation = requiresLightingObservation
          ? this.computeBodyLightingObservation(visual.bodyId)
          : null;
        if (lightingObservation !== null) {
          updateBodyVisualStellarVisibility(visual, lightingObservation.stellarVisibility);
        } else if (visual.stellarVisibility !== 1) {
          updateBodyVisualStellarVisibility(visual, 1);
        }
        if (visual.environment !== null) {
          updateBodyEnvironmentVisibility(
            visual.environment,
            projectedRadiusPixels,
            this.cloudShadowsEnabled,
          );
          updateBodyEnvironmentLighting(
            visual.environment,
            lightingObservation?.illuminatedFraction ?? 0,
            lightingObservation?.stellarVisibility ?? 0,
            lightingObservation?.lightDirection ?? null,
          );
        }
        if (visual.planetaryRing !== null) {
          updatePlanetaryRingShadow(
            visual.planetaryRing,
            lightingObservation?.lightDirection ?? null,
          );
        }
        if (
          visual.bodyId === this.focusBodyId ||
          observableProjectedRadiusPixels >= BODY_LOD_THRESHOLDS.medium.defaultPixels
        ) {
          visual.assetBinding?.start();
        }
        updateBodyVisualLod(visual, nextLod, this.backend);
        if (visual.bodyId === this.focusBodyId) {
          focusedProjectedRadiusPixels = observableProjectedRadiusPixels;
          focusedLightingObservation = lightingObservation;
        }
        visual.markerRing.quaternion.copy(this.camera.quaternion);
        const minimumWorldRadius = computeMinimumBillboardWorldRadius(
          this.camera.position.distanceTo(visual.markerRing.position),
          Math.max(1, this.mount.clientHeight),
          visual.bodyId === this.selectedBodyId ? 12 : 9,
        );
        visual.markerRing.scale.setScalar(
          computePositionRingRadius(visual.physicalRadiusSceneUnits, minimumWorldRadius),
        );
      }
      const nextRenderScaleTier =
        focusedProjectedRadiusPixels > 0
          ? selectRenderScaleTier(focusedProjectedRadiusPixels, this.renderScaleTier)
          : 'system';
      if (nextRenderScaleTier !== this.renderScaleTier) {
        this.renderScaleHistory = [
          ...this.renderScaleHistory,
          {
            distance: this.camera.position.distanceTo(this.controls?.target ?? new Vector3()),
            frame: this.renderFrameCount,
            from: this.renderScaleTier,
            projectedRadiusPixels: Number(focusedProjectedRadiusPixels.toFixed(3)),
            to: nextRenderScaleTier,
          },
        ].slice(-8);
        this.renderScaleTier = nextRenderScaleTier;
      }
      if (!usesCreationCamera(this.creationState)) {
        this.applyCameraNavigation(this.renderScaleTier);
      }
      this.updateStarFieldForCamera();
      this.focusedLightingObservation = focusedLightingObservation;
      this.updateAdaptiveExposure(timestampMilliseconds, focusedLightingObservation);
      for (const visual of this.creationBodyVisuals.values()) {
        const minimumWorldRadius = computeMinimumBillboardWorldRadius(
          this.camera.position.distanceTo(visual.mesh.position),
          Math.max(1, this.mount.clientHeight),
          7,
        );
        visual.mesh.scale.setScalar(Math.max(visual.physicalRadiusSceneUnits, minimumWorldRadius));
      }
      this.updateVisibleScreenMarkers(timestampMilliseconds);
      renderObservatoryFrame(this.renderer, this.scene, this.camera);
      this.renderFrameCount += 1;
      this.updateVisualDiagnostics(timestampMilliseconds);
      this.animationFrame = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      this.animationFrame = null;
      this.onError(toError(error));
    }
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    if (this.creationState?.enabled === true && this.creationState.interactive) {
      const scenePosition = this.projectPointerToCreationPlane(event);
      if (scenePosition === null) {
        return;
      }
      event.preventDefault();
      this.creationDragStartScene = scenePosition;
      this.creationPointerId = event.pointerId;
      this.renderer.domElement.setPointerCapture(event.pointerId);
      this.emitCreationPlacement(scenePosition, scenePosition, 'dragging');
    } else {
      this.pointerDownPosition = new Vector2(event.clientX, event.clientY);
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (
      this.creationPointerId !== event.pointerId ||
      this.creationDragStartScene === null ||
      this.creationState?.enabled !== true ||
      !this.creationState.interactive
    ) {
      return;
    }
    const scenePosition = this.projectPointerToCreationPlane(event);
    if (scenePosition !== null) {
      event.preventDefault();
      this.emitCreationPlacement(this.creationDragStartScene, scenePosition, 'dragging');
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.creationPointerId === event.pointerId && this.creationDragStartScene !== null) {
      const scenePosition =
        this.projectPointerToCreationPlane(event) ?? this.creationDragStartScene;
      event.preventDefault();
      this.emitCreationPlacement(this.creationDragStartScene, scenePosition, 'placed');
      this.releaseCreationPointer(event.pointerId);
      return;
    }
    const pointerDownPosition = this.pointerDownPosition;
    this.pointerDownPosition = null;
    if (
      event.button !== 0 ||
      pointerDownPosition === null ||
      pointerDownPosition.distanceTo(new Vector2(event.clientX, event.clientY)) > 5
    ) {
      return;
    }

    const canvasBounds = this.renderer.domElement.getBoundingClientRect();
    if (canvasBounds.width <= 0 || canvasBounds.height <= 0) {
      return;
    }
    const bodyId = pickNearestScreenMarker(
      this.visibleScreenMarkers,
      {
        x: event.clientX - canvasBounds.left,
        y: event.clientY - canvasBounds.top,
      },
      MARKER_HIT_RADIUS_PIXELS,
    );
    if (bodyId !== null) {
      this.onSelectBody(bodyId);
    }
  };

  private readonly handlePointerCancel = (): void => {
    this.pointerDownPosition = null;
    this.cancelCreationDrag();
  };

  private readonly handleControlsChange = (): void => {
    if (!this.updatingControlsProgrammatically) {
      this.cameraTransition = null;
      this.cameraTransitionProgress = 1;
      this.cameraWasInteracted = true;
    }
  };

  private enterCreationCameraView(): void {
    const controls = this.controls;
    if (controls === null) {
      return;
    }

    this.updatingControlsProgrammatically = true;
    const dampingEnabled = controls.enableDamping;
    try {
      // Flush a pending damping delta before capturing the user's exact composition.
      controls.enableDamping = false;
      controls.update();
      this.creationCameraSnapshot = captureCreationCameraState(this.camera, controls);
      this.creationCameraSnapshotMetersToSceneUnit = this.metersToSceneUnit;
      this.creationCameraWasInteracted = this.cameraWasInteracted;
      this.cameraTransition = null;
      this.cameraTransitionProgress = 1;
      this.rebaseSceneOrigin({ x: 0, y: 0, z: 0 }, null, this.metersToSceneUnit);
      this.refreshWorldTransforms();
      applyCreationCameraView(this.camera, controls);
      this.updateStarFieldForCamera();
    } finally {
      controls.enableDamping = dampingEnabled;
      this.updatingControlsProgrammatically = false;
    }
  }

  private leaveCreationCameraView(): void {
    const controls = this.controls;
    const snapshot = this.creationCameraSnapshot;
    const snapshotMetersToSceneUnit = this.creationCameraSnapshotMetersToSceneUnit;
    if (controls === null || snapshot === null || snapshotMetersToSceneUnit === null) {
      return;
    }

    this.updatingControlsProgrammatically = true;
    try {
      const focusedBody = this.latestBodies.find((body) => body.id === this.focusBodyId) ?? null;
      this.rebaseSceneOrigin(
        this.viewMode === 'focus' && focusedBody !== null
          ? focusedBody.positionMeters
          : { x: 0, y: 0, z: 0 },
        this.viewMode === 'focus' ? (focusedBody?.id ?? null) : null,
        this.metersToSceneUnit,
      );
      this.refreshWorldTransforms();
      const scaleChanged = snapshotMetersToSceneUnit !== this.metersToSceneUnit;
      const snapshotToRestore =
        scaleChanged && this.viewMode === 'focus'
          ? rescaleStoredCreationCameraState(
              snapshot,
              this.metersToSceneUnit / snapshotMetersToSceneUnit,
            )
          : snapshot;
      restoreCreationCameraState(this.camera, controls, snapshotToRestore);
      if (scaleChanged && this.viewMode === 'focus') {
        this.applyCameraNavigation(this.renderScaleTier);
      }
      this.updateStarFieldForCamera();
      this.cameraWasInteracted = this.creationCameraWasInteracted;
      this.creationCameraSnapshot = null;
      this.creationCameraSnapshotMetersToSceneUnit = null;
    } finally {
      this.updatingControlsProgrammatically = false;
    }
  }

  private projectPointerToCreationPlane(event: PointerEvent): Vector3 | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }
    const pointer = new Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      1 - ((event.clientY - bounds.top) / bounds.height) * 2,
    );
    this.creationRaycaster.setFromCamera(pointer, this.camera);
    return this.creationRaycaster.ray.intersectPlane(this.creationPlane, new Vector3());
  }

  private emitCreationPlacement(
    startScenePosition: Vector3,
    endScenePosition: Vector3,
    phase: CreationPlacement['phase'],
  ): void {
    const inverseScale = 1 / this.metersToSceneUnit;
    this.onCreationPlacementChange({
      phase,
      positionMeters: {
        x: startScenePosition.x * inverseScale + this.sceneOriginMeters.x,
        y: startScenePosition.y * inverseScale + this.sceneOriginMeters.y,
        z: startScenePosition.z * inverseScale + this.sceneOriginMeters.z,
      },
      velocityMetersPerSecond: {
        x:
          ((endScenePosition.x - startScenePosition.x) * inverseScale) /
          CREATION_VELOCITY_DRAG_SECONDS,
        y:
          ((endScenePosition.y - startScenePosition.y) * inverseScale) /
          CREATION_VELOCITY_DRAG_SECONDS,
        z:
          ((endScenePosition.z - startScenePosition.z) * inverseScale) /
          CREATION_VELOCITY_DRAG_SECONDS,
      },
    });
  }

  private releaseCreationPointer(pointerId: number): void {
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    this.creationDragStartScene = null;
    this.creationPointerId = null;
  }

  private cancelCreationDrag(): void {
    if (this.creationPointerId !== null) {
      this.releaseCreationPointer(this.creationPointerId);
    } else {
      this.creationDragStartScene = null;
    }
  }

  private updateCreationOverlay(): void {
    const state = this.creationState;
    if (state?.enabled !== true) {
      this.clearCreationOverlay();
      this.updateCreationResourceDiagnostics();
      return;
    }

    const activeBodyIds = new Set(state.draftBodies.map((body) => body.id));
    for (const [bodyId, visual] of this.creationBodyVisuals) {
      if (!activeBodyIds.has(bodyId)) {
        this.scene.remove(visual.mesh);
        visual.mesh.geometry.dispose();
        visual.mesh.material.dispose();
        this.creationBodyVisuals.delete(bodyId);
      }
    }

    for (const body of state.draftBodies) {
      let visual = this.creationBodyVisuals.get(body.id);
      if (visual === undefined) {
        const material = new MeshBasicMaterial({
          color: state.color,
          depthTest: false,
          depthWrite: false,
          opacity: 0.76,
          transparent: true,
        });
        const mesh = new Mesh(new SphereGeometry(1, 32, 20), material);
        mesh.renderOrder = 5;
        visual = { bodyId: body.id, mesh, physicalRadiusSceneUnits: 0 };
        this.creationBodyVisuals.set(body.id, visual);
        this.scene.add(mesh);
      }
      const position = positionMetersToScene(
        body.positionMeters,
        this.metersToSceneUnit,
        this.sceneOriginMeters,
      );
      visual.mesh.position.set(position.x, position.y, position.z);
      visual.mesh.material.color.setHex(state.color);
      visual.mesh.material.opacity = state.previewPending ? 0.56 : 0.8;
      visual.physicalRadiusSceneUnits = physicalRadiusToSceneUnits(
        body.radiusMeters,
        this.metersToSceneUnit,
      );
    }

    this.updateCreationVelocityArrow(state);
    this.updateCreationTrajectories(state);
    this.updateCreationResourceDiagnostics();
  }

  private updateCreationVelocityArrow(state: CreationOverlayState): void {
    const placement = state.placement;
    if (placement === null) {
      this.creationVelocityArrow.visible = false;
      return;
    }
    const origin = positionMetersToScene(
      placement.positionMeters,
      this.metersToSceneUnit,
      this.sceneOriginMeters,
    );
    const velocityScene = new Vector3(
      placement.velocityMetersPerSecond.x,
      placement.velocityMetersPerSecond.y,
      placement.velocityMetersPerSecond.z,
    ).multiplyScalar(CREATION_VELOCITY_DRAG_SECONDS * this.metersToSceneUnit);
    const length = velocityScene.length();
    if (length <= Number.EPSILON) {
      this.creationVelocityArrow.visible = false;
      return;
    }

    this.creationVelocityArrow.position.set(origin.x, origin.y, origin.z);
    this.creationVelocityArrow.setDirection(velocityScene.normalize());
    this.creationVelocityArrow.setLength(
      length,
      Math.min(0.35, length * 0.24),
      Math.min(0.2, length * 0.16),
    );
    this.creationVelocityArrow.visible = true;
  }

  private updateCreationTrajectories(state: CreationOverlayState): void {
    for (const line of this.creationTrajectoryVisuals.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this.creationTrajectoryVisuals.clear();

    const preview = state.preview;
    if (preview === null) {
      return;
    }
    const color =
      preview.risk.kind === 'collision'
        ? 0xff665e
        : preview.risk.kind === 'escape'
          ? 0xf0c674
          : 0x4cc9b0;
    for (const track of preview.tracks) {
      if (track.points.length < 2) {
        continue;
      }
      const positions = new Float32Array(track.points.length * 3);
      for (const [index, point] of track.points.entries()) {
        const position = positionMetersToScene(
          point.positionMeters,
          this.metersToSceneUnit,
          this.sceneOriginMeters,
        );
        positions[index * 3] = position.x;
        positions[index * 3 + 1] = position.y;
        positions[index * 3 + 2] = position.z;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      const material = new LineBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        opacity: 0.9,
        transparent: true,
      });
      const line = new Line(geometry, material);
      line.renderOrder = 4;
      this.creationTrajectoryVisuals.set(track.bodyId, line);
      this.scene.add(line);
    }
  }

  private clearCreationOverlay(): void {
    for (const visual of this.creationBodyVisuals.values()) {
      this.scene.remove(visual.mesh);
      visual.mesh.geometry.dispose();
      visual.mesh.material.dispose();
    }
    this.creationBodyVisuals.clear();
    for (const line of this.creationTrajectoryVisuals.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this.creationTrajectoryVisuals.clear();
    this.creationVelocityArrow.visible = false;
  }

  private updateCreationResourceDiagnostics(): void {
    if (!this.exposeMarkerDiagnostics) {
      return;
    }
    const canvas = this.renderer.domElement;
    if (this.creationState?.enabled === true) {
      canvas.dataset.creationBodyVisualCount = String(this.creationBodyVisuals.size);
      canvas.dataset.creationTrajectoryVisualCount = String(this.creationTrajectoryVisuals.size);
      canvas.dataset.creationVelocityArrowVisible = String(this.creationVelocityArrow.visible);
      const maxTrackStartOffset = this.computeMaximumCreationTrackStartOffset();
      if (maxTrackStartOffset === null) {
        delete canvas.dataset.creationMaxTrackStartOffset;
      } else {
        canvas.dataset.creationMaxTrackStartOffset = String(maxTrackStartOffset);
      }
      return;
    }
    delete canvas.dataset.creationBodyVisualCount;
    delete canvas.dataset.creationMaxTrackStartOffset;
    delete canvas.dataset.creationTrajectoryVisualCount;
    delete canvas.dataset.creationVelocityArrowVisible;
  }

  private computeMaximumCreationTrackStartOffset(): number | null {
    let maximumOffset: number | null = null;
    for (const [bodyId, trajectory] of this.creationTrajectoryVisuals) {
      const visual = this.creationBodyVisuals.get(bodyId);
      const positions = trajectory.geometry.getAttribute('position');
      if (visual === undefined || positions.count === 0) {
        continue;
      }
      const offset = visual.mesh.position.distanceTo(
        new Vector3(positions.getX(0), positions.getY(0), positions.getZ(0)),
      );
      maximumOffset = Math.max(maximumOffset ?? 0, offset);
    }
    return maximumOffset;
  }

  private computeBodyLightingObservation(bodyId: string): BodyLightingObservation {
    const targetBody = this.latestBodies.find((body) => body.id === bodyId);
    const targetVisual = this.bodyVisuals.get(bodyId);
    if (targetBody === undefined || targetVisual === undefined) {
      return emptyBodyLightingObservation();
    }

    let dominant:
      | {
          readonly direction: Vector3;
          readonly illuminance: number;
          readonly starId: string;
        }
      | undefined;
    const illuminationSamples: StellarIlluminationSample[] = [];
    const occluderIds = new Set<string>();
    for (const starVisual of this.bodyVisuals.values()) {
      if (starVisual.light === null || starVisual.bodyId === bodyId) {
        continue;
      }
      const starBody = this.latestBodies.find((body) => body.id === starVisual.bodyId);
      if (starBody === undefined) {
        continue;
      }
      const direction = starVisual.root.position.clone().sub(targetVisual.root.position);
      const distanceSquared = direction.lengthSq();
      if (distanceSquared <= Number.EPSILON) {
        continue;
      }
      const occlusion = computeStellarVisibility(targetBody, starBody, this.latestBodies);
      const unoccludedIlluminance = starVisual.light.intensity / distanceSquared;
      const illuminance = unoccludedIlluminance * occlusion.visibility;
      illuminationSamples.push({
        unoccludedIlluminance,
        visibility: occlusion.visibility,
      });
      for (const occluderId of occlusion.occluderIds) {
        occluderIds.add(occluderId);
      }
      if (
        dominant === undefined ||
        illuminance > dominant.illuminance ||
        (illuminance === dominant.illuminance && starVisual.bodyId < dominant.starId)
      ) {
        dominant = {
          direction: direction.normalize(),
          illuminance,
          starId: starVisual.bodyId,
        };
      }
    }
    if (dominant === undefined) {
      return emptyBodyLightingObservation();
    }

    const cameraDirection = this.camera.position
      .clone()
      .sub(targetVisual.root.position)
      .normalize();
    return {
      dominantStarId: dominant.starId,
      illuminatedFraction: clampUnit((cameraDirection.dot(dominant.direction) + 1) / 2),
      illuminance: dominant.illuminance,
      lightDirection: dominant.direction,
      occluderIds: [...occluderIds].toSorted(),
      stellarVisibility: computeCombinedStellarTransmission(illuminationSamples),
    };
  }

  private updateAdaptiveExposure(
    timestampMilliseconds: number,
    lightingObservation: BodyLightingObservation | null,
  ): void {
    const focusedVisual =
      this.focusBodyId === null ? undefined : this.bodyVisuals.get(this.focusBodyId);
    this.exposureTarget = computeTargetExposure({
      illuminatedFraction: lightingObservation?.illuminatedFraction ?? 0,
      stellarVisibility: lightingObservation?.stellarVisibility ?? 0,
      surfaceKind: focusedVisual?.surfaceKind ?? null,
      viewMode: this.viewMode,
    });
    const previousTimestamp = this.lastExposureUpdateTimeMilliseconds;
    this.lastExposureUpdateTimeMilliseconds = timestampMilliseconds;
    if (previousTimestamp === null) {
      return;
    }
    this.renderer.toneMappingExposure = advanceAdaptiveExposure(
      this.renderer.toneMappingExposure,
      this.exposureTarget,
      Math.max(0, timestampMilliseconds - previousTimestamp) / 1_000,
    );
  }

  private computeCurrentFocusFrame(): ObservatoryCameraFrame | null {
    if (this.focusBodyId === null) {
      return null;
    }
    const body = this.latestBodies.find((candidate) => candidate.id === this.focusBodyId);
    if (body === undefined) {
      return null;
    }
    return this.computeCameraFrameForBody(body);
  }

  private computeCameraFrameForBody(body: BodyState): ObservatoryCameraFrame {
    const assetPlan = resolveBodyAssetPlan(body.id);
    const blackHole = this.bodyVisuals.get(body.id)?.blackHole ?? null;
    if (assetPlan.surface !== null || blackHole !== null) {
      return computeBodyInspectionCameraFrame(
        body,
        this.metersToSceneUnit,
        this.camera.aspect,
        blackHole?.profile.observableOuterRadiusRatio ?? assetPlan.ring?.outerRadiusRatio ?? 1,
        this.sceneOriginMeters,
      );
    }
    return computeFocusCameraFrame(
      body,
      findOrbitParent(body, this.latestBodies),
      this.metersToSceneUnit,
      this.camera.aspect,
      this.sceneOriginMeters,
    );
  }

  private followFocusedBody(): void {
    if (this.cameraTransition !== null) {
      return;
    }
    const frame = this.computeCurrentFocusFrame();
    if (frame === null || this.controls === null) {
      return;
    }

    const nextTarget = new Vector3(frame.target.x, frame.target.y, frame.target.z);
    const targetDelta = nextTarget.sub(this.controls.target);
    this.updatingControlsProgrammatically = true;
    try {
      this.camera.position.add(targetDelta);
      this.controls.target.set(frame.target.x, frame.target.y, frame.target.z);
      this.controls.update();
    } finally {
      this.updatingControlsProgrammatically = false;
    }
  }

  private applyCameraFrame(frame: ObservatoryCameraFrame): void {
    if (this.controls === null) {
      return;
    }
    this.cameraTransition = null;
    this.cameraTransitionProgress = 1;

    this.updatingControlsProgrammatically = true;
    try {
      const direction = this.camera.position.clone().sub(this.controls.target);
      if (direction.lengthSq() <= Number.EPSILON) {
        direction.set(0, 0, 1);
      }
      direction.normalize();
      this.controls.target.set(frame.target.x, frame.target.y, frame.target.z);
      this.camera.position.copy(this.controls.target).addScaledVector(direction, frame.distance);
      this.renderScaleTier = frame.tier;
      this.applyCameraNavigation(frame.tier, frame);
      this.controls.update();
      this.updateStarFieldForCamera();
    } finally {
      this.updatingControlsProgrammatically = false;
    }
  }

  private beginCameraTransition(frame: ObservatoryCameraFrame): void {
    const controls = this.controls;
    if (controls === null) {
      return;
    }
    const direction = this.camera.position.clone().sub(controls.target);
    const startDistance = direction.length();
    if (startDistance <= Number.EPSILON) {
      this.applyCameraFrame(frame);
      return;
    }
    direction.normalize();
    this.cameraTransition = {
      direction,
      durationMilliseconds: computeCameraTransitionDurationMilliseconds(
        startDistance,
        frame.distance,
      ),
      endDistance: frame.distance,
      endTarget: new Vector3(frame.target.x, frame.target.y, frame.target.z),
      startDistance,
      startTarget: controls.target.clone(),
      startTimeMilliseconds: null,
    };
    this.cameraTransitionProgress = 0;
  }

  private updateCameraTransition(timestampMilliseconds: number): void {
    const controls = this.controls;
    const transition = this.cameraTransition;
    if (controls === null || transition === null) {
      return;
    }
    transition.startTimeMilliseconds ??= timestampMilliseconds;
    const progress = Math.min(
      1,
      Math.max(
        0,
        (timestampMilliseconds - transition.startTimeMilliseconds) /
          transition.durationMilliseconds,
      ),
    );
    const eased = easeCameraTransitionProgress(progress);
    const target = transition.startTarget.clone().lerp(transition.endTarget, eased);
    const distance = interpolateCameraDistance(
      transition.startDistance,
      transition.endDistance,
      eased,
    );
    this.updatingControlsProgrammatically = true;
    const dampingEnabled = controls.enableDamping;
    try {
      controls.enableDamping = false;
      controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(transition.direction, distance);
      controls.update();
    } finally {
      controls.enableDamping = dampingEnabled;
      this.updatingControlsProgrammatically = false;
    }
    this.cameraTransitionProgress = progress;
    if (progress >= 1) {
      this.cameraTransition = null;
      this.cameraTransitionProgress = 1;
    }
  }

  private applyCameraNavigation(
    tier: RenderScaleTier,
    explicitFrame?: ObservatoryCameraFrame,
  ): void {
    const controls = this.controls;
    if (controls === null) {
      return;
    }
    const frame =
      explicitFrame ??
      (this.viewMode === 'focus'
        ? (this.computeCurrentFocusFrame() ?? computeOverviewCameraFrame(this.camera.aspect))
        : computeOverviewCameraFrame(this.camera.aspect));
    const currentDistance = Math.max(
      Number.EPSILON,
      this.camera.position.distanceTo(controls.target),
    );
    const overviewDistance = computeOverviewCameraFrame(this.camera.aspect).distance;
    const projectedRadiusPixels =
      this.focusBodyId === null
        ? undefined
        : this.bodyVisuals.get(this.focusBodyId)?.observableProjectedRadiusPixels;
    const settings = computeCameraNavigationSettings(
      tier,
      currentDistance,
      frame,
      overviewDistance,
      projectedRadiusPixels !== undefined && projectedRadiusPixels > 0
        ? projectedRadiusPixels
        : undefined,
    );
    controls.dampingFactor = settings.dampingFactor;
    controls.maxDistance = settings.maxDistance;
    controls.minDistance =
      this.cameraTransition === null
        ? settings.minDistance
        : Math.min(settings.minDistance, currentDistance * 0.9);
    controls.rotateSpeed = settings.rotateSpeed;
    controls.zoomSpeed = settings.zoomSpeed;
    if (this.camera.near !== settings.near || this.camera.far !== settings.far) {
      this.camera.near = settings.near;
      this.camera.far = settings.far;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateStarFieldForCamera(): void {
    const scale = Math.max(1e-12, this.camera.far / 320);
    this.starField.position.copy(this.camera.position);
    this.starField.scale.setScalar(scale);
    this.starField.material.size = 0.085 * scale;
  }

  private updateVisibleScreenMarkers(timestampMilliseconds: number): void {
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    const candidates: ScreenMarkerCandidate[] = [];
    this.camera.updateMatrixWorld();

    for (const visual of this.bodyVisuals.values()) {
      const projected = visual.root.position.clone().project(this.camera);
      const x = ((projected.x + 1) / 2) * width;
      const y = ((1 - projected.y) / 2) * height;
      if (
        projected.z < -1 ||
        projected.z > 1 ||
        x < -MARKER_HIT_RADIUS_PIXELS ||
        x > width + MARKER_HIT_RADIUS_PIXELS ||
        y < -MARKER_HIT_RADIUS_PIXELS ||
        y > height + MARKER_HIT_RADIUS_PIXELS
      ) {
        visual.markerRing.visible = false;
        continue;
      }

      const catalogOrder = getCelestialCatalogEntry(visual.bodyId)?.order ?? 1_000;
      candidates.push({
        bodyId: visual.bodyId,
        x,
        y,
        depth: projected.z,
        priority:
          visual.bodyId === this.selectedBodyId
            ? 10_000
            : visual.isPrimary
              ? 5_000
              : 1_000 - catalogOrder,
      });
    }

    this.visibleScreenMarkers = selectVisibleScreenMarkers(
      candidates,
      MARKER_MINIMUM_SEPARATION_PIXELS,
    );
    if (
      this.exposeMarkerDiagnostics &&
      timestampMilliseconds - this.lastDiagnosticsUpdateTimeMilliseconds >=
        MARKER_DIAGNOSTICS_INTERVAL_MILLISECONDS
    ) {
      this.lastDiagnosticsUpdateTimeMilliseconds = timestampMilliseconds;
      this.renderer.domElement.dataset.visibleBodyMarkers = JSON.stringify(
        this.visibleScreenMarkers.map((marker) => ({
          id: marker.bodyId,
          x: Number(marker.x.toFixed(2)),
          y: Number(marker.y.toFixed(2)),
        })),
      );
      this.renderer.domElement.dataset.cameraState = JSON.stringify({
        mode: this.viewMode,
        position: {
          x: Number(this.camera.position.x.toFixed(6)),
          y: Number(this.camera.position.y.toFixed(6)),
          z: Number(this.camera.position.z.toFixed(6)),
        },
        target: {
          x: Number((this.controls?.target.x ?? 0).toFixed(6)),
          y: Number((this.controls?.target.y ?? 0).toFixed(6)),
          z: Number((this.controls?.target.z ?? 0).toFixed(6)),
        },
      });
    }
    const visibleIds = new Set(this.visibleScreenMarkers.map((marker) => marker.bodyId));
    for (const visual of this.bodyVisuals.values()) {
      const focusedBodyIsVisibleWithoutMarker =
        visual.bodyId === this.focusBodyId &&
        visual.observableProjectedRadiusPixels >= RENDER_SCALE_THRESHOLDS.orbit.exitPixels;
      visual.markerRing.visible =
        visibleIds.has(visual.bodyId) && !focusedBodyIsVisibleWithoutMarker;
    }
  }

  private updateVisualDiagnostics(timestampMilliseconds: number): void {
    if (
      !this.exposeVisualDiagnostics ||
      timestampMilliseconds - this.lastVisualDiagnosticsUpdateTimeMilliseconds <
        MARKER_DIAGNOSTICS_INTERVAL_MILLISECONDS
    ) {
      return;
    }
    this.lastVisualDiagnosticsUpdateTimeMilliseconds = timestampMilliseconds;

    const lodCounts = { high: 0, low: 0, medium: 0 };
    let activeLightCount = 0;
    for (const visual of this.bodyVisuals.values()) {
      lodCounts[visual.lod] += 1;
      if (visual.light !== null) {
        activeLightCount += 1;
      }
    }

    const canvas = this.renderer.domElement;
    canvas.dataset.renderFrameCount = String(this.renderFrameCount);
    canvas.dataset.renderScaleTier = this.renderScaleTier;
    const cameraTarget = this.controls?.target ?? new Vector3();
    canvas.dataset.visualCameraState = JSON.stringify({
      distance: Number(this.camera.position.distanceTo(cameraTarget).toPrecision(8)),
      far: Number(this.camera.far.toPrecision(8)),
      maxDistance: Number((this.controls?.maxDistance ?? 0).toPrecision(8)),
      minDistance: Number((this.controls?.minDistance ?? 0).toPrecision(8)),
      near: Number(this.camera.near.toPrecision(8)),
      position: vectorDiagnostic(this.camera.position),
      rotateSpeed: this.controls?.rotateSpeed ?? 0,
      target: vectorDiagnostic(cameraTarget),
      transitionActive: this.cameraTransition !== null,
      transitionEndTarget:
        this.cameraTransition === null ? null : vectorDiagnostic(this.cameraTransition.endTarget),
      transitionProgress: Number(this.cameraTransitionProgress.toFixed(4)),
      zoomSpeed: this.controls?.zoomSpeed ?? 0,
    });
    const focusedLocalPosition =
      this.focusBodyId === null
        ? null
        : (this.bodyVisuals.get(this.focusBodyId)?.root.position ?? null);
    canvas.dataset.visualOriginState = JSON.stringify({
      bodyId: this.sceneOriginBodyId,
      focusedLocalPosition:
        focusedLocalPosition === null ? null : vectorDiagnostic(focusedLocalPosition),
      maxLocalMagnitude: Number(
        Math.max(
          0,
          ...[...this.bodyVisuals.values()].map((visual) => visual.root.position.length()),
        ).toPrecision(8),
      ),
      originMeters: this.sceneOriginMeters,
    });
    canvas.dataset.visualScaleHistory = JSON.stringify(this.renderScaleHistory);
    canvas.dataset.visualActiveLightCount = String(activeLightCount);
    canvas.dataset.visualActiveLightIds = JSON.stringify(
      [...this.bodyVisuals.values()]
        .filter((visual) => visual.light !== null)
        .map((visual) => visual.bodyId)
        .toSorted(),
    );
    canvas.dataset.visualAppearanceKinds = JSON.stringify(
      [...this.bodyVisuals.values()]
        .map((visual) => ({ id: visual.bodyId, kind: visual.surfaceKind }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    canvas.dataset.visualSurfaceResources = JSON.stringify(
      [...this.bodyVisuals.values()]
        .map((visual) => ({
          id: visual.bodyId,
          ...(visual.assetBinding?.diagnostics().surface ?? {
            assetId: null,
            bound: false,
            state: 'procedural',
          }),
        }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    canvas.dataset.visualAtmosphereResources = JSON.stringify(
      [...this.bodyVisuals.values()]
        .filter((visual) => (visual.environment?.atmosphereShells.length ?? 0) > 0)
        .map((visual) => {
          const environment = visual.environment;
          if (environment === null) {
            throw new Error('大气诊断缺少环境对象');
          }
          return {
            id: visual.bodyId,
            layerCount: environment.atmosphereShells.length,
            outerRadiusRatio: Math.max(
              ...environment.profile.atmosphereLayers.map((layer) => layer.radiusRatio),
            ),
            visible: environment.atmosphereShells.some((shell) => shell.mesh.visible),
          };
        })
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    canvas.dataset.visualCloudResources = JSON.stringify(
      [...this.bodyVisuals.values()]
        .filter((visual) => (visual.environment?.clouds ?? null) !== null)
        .map((visual) => {
          const clouds = visual.environment?.clouds;
          if (clouds === null || clouds === undefined) {
            throw new Error('云层诊断缺少环境对象');
          }
          return {
            id: visual.bodyId,
            phaseRadians: Number(clouds.phaseRadians.toFixed(6)),
            radiusRatio: clouds.profile.radiusRatio,
            shadowRadiusRatio: clouds.profile.shadowRadiusRatio,
            shadowVisible: clouds.shadowMesh.visible,
            visible: clouds.cloudMesh.visible,
            ...(visual.assetBinding?.diagnostics().clouds ?? {
              assetId: null,
              bound: false,
              state: 'procedural',
            }),
          };
        })
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    canvas.dataset.visualPlanetaryRingResources = JSON.stringify(
      [...this.bodyVisuals.values()]
        .filter((visual) => visual.planetaryRing !== null)
        .map((visual) => ({
          id: visual.bodyId,
          innerRadiusRatio: visual.planetaryRing?.innerRadiusRatio ?? 0,
          outerRadiusRatio: visual.planetaryRing?.outerRadiusRatio ?? 0,
          shadowOpacity: visual.planetaryRing?.shadowMesh.material.opacity ?? 0,
          shadowLatitudeOffset: visual.planetaryRing?.shadowLatitudeOffset ?? 0,
          shadowVisible: visual.planetaryRing?.shadowMesh.visible ?? false,
          visible: visual.planetaryRing?.mesh.visible ?? false,
          ...(visual.assetBinding?.diagnostics().ring ?? {
            assetId: null,
            bound: false,
            state: 'procedural',
          }),
        })),
    );
    canvas.dataset.visualBlackHoleResources = JSON.stringify(
      [...this.bodyVisuals.values()]
        .filter((visual) => visual.blackHole !== null)
        .map((visual) => {
          const blackHole = visual.blackHole;
          if (blackHole === null) {
            throw new Error('黑洞诊断缺少视觉对象');
          }
          return {
            accretionDiskVisible: false,
            haloVisible: blackHole.haloSprite?.visible ?? false,
            id: visual.bodyId,
            mode: blackHole.mode,
            observableOuterRadiusRatio: blackHole.profile.observableOuterRadiusRatio,
            observableProjectedRadiusPixels: Number(
              visual.observableProjectedRadiusPixels.toFixed(3),
            ),
            photonRingVisible: blackHole.photonRingSprite.visible && blackHole.group.visible,
            physicalProjectedRadiusPixels: Number(visual.projectedRadiusPixels.toFixed(3)),
            visible: blackHole.group.visible,
          };
        })
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    canvas.dataset.visualResourceCounts = JSON.stringify({
      atmosphereShells: [...this.bodyVisuals.values()].reduce(
        (count, visual) => count + (visual.environment?.atmosphereShells.length ?? 0),
        0,
      ),
      cloudLayers: [...this.bodyVisuals.values()].filter(
        (visual) => (visual.environment?.clouds ?? null) !== null,
      ).length,
      cloudShadows: [...this.bodyVisuals.values()].filter(
        (visual) => (visual.environment?.clouds?.shadowMesh ?? null) !== null,
      ).length,
      blackHoleEffects: [...this.bodyVisuals.values()].filter((visual) => visual.blackHole !== null)
        .length,
      blackHoleSprites: [...this.bodyVisuals.values()].reduce(
        (count, visual) =>
          count +
          (visual.blackHole === null ? 0 : 1 + (visual.blackHole.haloSprite === null ? 0 : 1)),
        0,
      ),
      blackHoleTexturePool: snapshotBlackHoleTexturePool(),
      planetaryRingMeshes: [...this.bodyVisuals.values()].filter(
        (visual) => visual.planetaryRing !== null,
      ).length,
      sceneGraph: collectSceneResourceCounts(this.scene),
      lifecycle: snapshotRenderLifecycle(),
      textureCache: this.textureCache.snapshot(),
    });
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    canvas.dataset.visualBodyProjections = JSON.stringify(
      [...this.bodyVisuals.values()]
        .map((visual) => {
          const projected = visual.root.position.clone().project(this.camera);
          return {
            id: visual.bodyId,
            radiusPixels: Number(visual.projectedRadiusPixels.toFixed(2)),
            x: Number((((projected.x + 1) / 2) * width).toFixed(2)),
            y: Number((((1 - projected.y) / 2) * height).toFixed(2)),
          };
        })
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    canvas.dataset.visualPlanetaryRingProjections = JSON.stringify(
      [...this.bodyVisuals.values()]
        .filter((visual) => visual.planetaryRing !== null)
        .map((visual) => {
          const ring = visual.planetaryRing;
          if (ring === null) {
            throw new Error('行星环诊断缺少视觉对象');
          }
          const center = projectWorldPoint(
            ring.mesh.localToWorld(new Vector3(0, 0, 0)),
            this.camera,
            width,
            height,
          );
          const outerX = projectWorldPoint(
            ring.mesh.localToWorld(new Vector3(ring.outerRadiusRatio, 0, 0)),
            this.camera,
            width,
            height,
          );
          const outerY = projectWorldPoint(
            ring.mesh.localToWorld(new Vector3(0, ring.outerRadiusRatio, 0)),
            this.camera,
            width,
            height,
          );
          return {
            axisX: { x: outerX.x - center.x, y: outerX.y - center.y },
            axisY: { x: outerY.x - center.x, y: outerY.y - center.y },
            center,
            id: visual.bodyId,
            innerRadiusFraction: ring.innerRadiusRatio / ring.outerRadiusRatio,
          };
        }),
    );
    canvas.dataset.visualLodCounts = JSON.stringify(lodCounts);
    canvas.dataset.visualToneMappingExposure = String(this.renderer.toneMappingExposure);
    canvas.dataset.visualExposureState = JSON.stringify({
      current: Number(this.renderer.toneMappingExposure.toFixed(6)),
      settled: Math.abs(this.renderer.toneMappingExposure - this.exposureTarget) < 0.01,
      target: Number(this.exposureTarget.toFixed(6)),
    });
    canvas.dataset.visualStellarOcclusion = JSON.stringify({
      bodyId: this.focusBodyId,
      dominantStarId: this.focusedLightingObservation?.dominantStarId ?? null,
      illuminatedFraction: Number(
        (this.focusedLightingObservation?.illuminatedFraction ?? 0).toFixed(6),
      ),
      illuminance: Number((this.focusedLightingObservation?.illuminance ?? 0).toPrecision(8)),
      occluderIds: this.focusedLightingObservation?.occluderIds ?? [],
      visibility: Number((this.focusedLightingObservation?.stellarVisibility ?? 0).toFixed(6)),
    });
    canvas.dataset.visualFocusedMarkerVisible = String(
      this.focusBodyId !== null &&
        (this.bodyVisuals.get(this.focusBodyId)?.markerRing.visible ?? false),
    );
  }

  private rollbackConstruction(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.controls?.removeEventListener('change', this.handleControlsChange);
    this.controls?.dispose();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.scene.traverse(disposeRenderable);
    this.scene.clear();
    this.textureCache.dispose();
    canvas.remove();
  }
}

function emptyBodyLightingObservation(): BodyLightingObservation {
  return {
    dominantStarId: null,
    illuminatedFraction: 0,
    illuminance: 0,
    lightDirection: null,
    occluderIds: [],
    stellarVisibility: 0,
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function vectorDiagnostic(vector: { readonly x: number; readonly y: number; readonly z: number }) {
  return {
    x: Number(vector.x.toPrecision(8)),
    y: Number(vector.y.toPrecision(8)),
    z: Number(vector.z.toPrecision(8)),
  };
}

function createStarField(): Points<BufferGeometry, PointsMaterial> {
  const positions = new Float32Array(STAR_COUNT * 3);
  const random = createSeededRandom(0x5354_4152);

  for (let index = 0; index < STAR_COUNT; index += 1) {
    const z = random() * 2 - 1;
    const azimuth = random() * Math.PI * 2;
    const radius = 68 + random() * 58;
    const horizontalRadius = Math.sqrt(1 - z * z) * radius;
    positions[index * 3] = Math.cos(azimuth) * horizontalRadius;
    positions[index * 3 + 1] = Math.sin(azimuth) * horizontalRadius;
    positions[index * 3 + 2] = z * radius;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const material = new PointsMaterial({
    color: 0xaebec2,
    depthWrite: false,
    opacity: 0.72,
    size: 0.085,
    sizeAttenuation: true,
    transparent: true,
  });
  return new Points(geometry, material);
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b_79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function disposeRenderable(object: Object3D): void {
  if ('geometry' in object && object.geometry instanceof BufferGeometry) {
    object.geometry.dispose();
  }
  if ('material' in object) {
    const material = object.material;
    if (Array.isArray(material)) {
      material.forEach((entry: Material) => {
        entry.dispose();
      });
    } else if (material instanceof Material) {
      material.dispose();
    }
  }
  if (object instanceof PointLight) {
    object.dispose();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
