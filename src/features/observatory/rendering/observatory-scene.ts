import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  Material,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { BodyState } from '../../../physics/protocol/schemas';
import { getCelestialCatalogEntry } from '../catalog';
import {
  computeFocusCameraFrame,
  computeOverviewCameraFrame,
  type ObservatoryCameraFrame,
  type ObservatoryViewMode,
} from './camera-focus';
import {
  computeMetersToSceneUnit,
  computePositionRingRadius,
  physicalRadiusToSceneUnits,
  positionMetersToScene,
} from './coordinates';
import { computeMinimumBillboardWorldRadius, OBSERVATORY_VERTICAL_FOV_DEGREES } from './camera-fit';
import {
  disposeObservatoryRenderer,
  renderObservatoryFrame,
  type ObservatoryRenderer,
  type RendererBackend,
} from './create-renderer';
import { sampleOsculatingOrbit } from './orbit';
import { findMostMassiveBody, findOrbitParent } from './orbit-parent';
import {
  pickNearestScreenMarker,
  selectVisibleScreenMarkers,
  type ScreenMarkerCandidate,
} from './marker-layout';

const STAR_COUNT = 1_600;
const ORBIT_SEGMENTS = 256;
const MARKER_MINIMUM_SEPARATION_PIXELS = 18;
const MARKER_HIT_RADIUS_PIXELS = 20;
const MARKER_DIAGNOSTICS_QUERY_PARAMETER = 'markerDiagnostics';
const MARKER_DIAGNOSTICS_INTERVAL_MILLISECONDS = 100;

interface BodyVisual {
  readonly bodyId: string;
  readonly isPrimary: boolean;
  readonly mesh: Mesh<SphereGeometry, MeshBasicMaterial | MeshStandardMaterial>;
  readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  readonly light: PointLight | null;
  physicalRadiusSceneUnits: number;
}

interface OrbitVisual {
  readonly line: Line<BufferGeometry, LineBasicMaterial>;
}

export interface ObservatorySceneOptions {
  readonly backend: RendererBackend;
  readonly mount: HTMLDivElement;
  readonly onError: (error: Error) => void;
  readonly onSelectBody: (bodyId: string) => void;
  readonly renderer: ObservatoryRenderer;
}

export class ObservatoryScene {
  private readonly backend: RendererBackend;
  private readonly bodyVisuals = new Map<string, BodyVisual>();
  private readonly camera = new PerspectiveCamera(OBSERVATORY_VERTICAL_FOV_DEGREES, 1, 0.01, 320);
  private readonly controls: OrbitControls | null = null;
  private readonly mount: HTMLDivElement;
  private readonly onError: (error: Error) => void;
  private readonly onSelectBody: (bodyId: string) => void;
  private readonly orbitVisuals = new Map<string, OrbitVisual>();
  private readonly renderer: ObservatoryRenderer;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly scene = new Scene();
  private readonly exposeMarkerDiagnostics =
    new URLSearchParams(window.location.search).get(MARKER_DIAGNOSTICS_QUERY_PARAMETER) === '1';
  private animationFrame: number | null = null;
  private bodySetKey = '';
  private cameraWasInteracted = false;
  private disposed = false;
  private focusBodyId: string | null = null;
  private lastDiagnosticsUpdateTimeMilliseconds = Number.NEGATIVE_INFINITY;
  private latestBodies: readonly BodyState[] = [];
  private metersToSceneUnit = 1;
  private pointerDownPosition: Vector2 | null = null;
  private selectedBodyId: string | null = null;
  private updatingControlsProgrammatically = false;
  private viewMode: ObservatoryViewMode = 'overview';
  private visibleScreenMarkers: readonly ScreenMarkerCandidate[] = [];

  constructor(options: ObservatorySceneOptions) {
    this.backend = options.backend;
    this.mount = options.mount;
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
      this.scene.add(createStarField());

      canvas.addEventListener('pointerdown', this.handlePointerDown);
      canvas.addEventListener('pointerup', this.handlePointerUp);
      canvas.addEventListener('pointercancel', this.handlePointerCancel);

      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(this.mount);
      this.resize();
      this.animationFrame = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      this.rollbackConstruction();
      throw error;
    }
  }

  update(bodies: readonly BodyState[], selectedBodyId: string | null): void {
    if (this.disposed) {
      return;
    }

    this.selectedBodyId = selectedBodyId;
    this.latestBodies = bodies;
    const primary = findMostMassiveBody(bodies);
    const nextBodySetKey = bodies
      .map((body) => body.id)
      .toSorted()
      .join('\u0000');

    if (nextBodySetKey !== this.bodySetKey) {
      this.bodySetKey = nextBodySetKey;
      this.metersToSceneUnit = computeMetersToSceneUnit(bodies);
    }

    const activeBodyIds = new Set(bodies.map((body) => body.id));
    for (const [bodyId, visual] of this.bodyVisuals) {
      if (!activeBodyIds.has(bodyId)) {
        this.removeBodyVisual(visual);
        this.bodyVisuals.delete(bodyId);
      }
    }

    for (const body of bodies) {
      const isPrimary = primary?.id === body.id;
      let visual = this.bodyVisuals.get(body.id);
      if (visual !== undefined && visual.isPrimary !== isPrimary) {
        this.removeBodyVisual(visual);
        this.bodyVisuals.delete(body.id);
        visual = undefined;
      }
      if (visual === undefined) {
        visual = this.createBodyVisual(body, isPrimary);
        this.bodyVisuals.set(body.id, visual);
      }
      this.updateBodyVisual(visual, body);
    }

    this.updateOrbits(bodies);

    if (this.viewMode === 'focus') {
      this.followFocusedBody();
    }
  }

  focusBody(bodyId: string): boolean {
    const body = this.latestBodies.find((candidate) => candidate.id === bodyId);
    if (body === undefined) {
      return false;
    }

    const parent = findOrbitParent(body, this.latestBodies);
    const frame = computeFocusCameraFrame(body, parent, this.metersToSceneUnit, this.camera.aspect);
    this.focusBodyId = bodyId;
    this.viewMode = 'focus';
    this.cameraWasInteracted = false;
    this.applyCameraFrame(frame);
    return true;
  }

  showOverview(): void {
    this.focusBodyId = null;
    this.viewMode = 'overview';
    this.cameraWasInteracted = false;
    this.applyCameraFrame(computeOverviewCameraFrame(this.camera.aspect));
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
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);

    this.scene.traverse(disposeRenderable);
    this.scene.clear();
    canvas.remove();
    disposeObservatoryRenderer(this.renderer);
    this.bodyVisuals.clear();
    this.orbitVisuals.clear();
  }

  private readonly createBodyVisual = (body: BodyState, isPrimary: boolean): BodyVisual => {
    const geometry = new SphereGeometry(1, 48, 32);
    const color = getCelestialCatalogEntry(body.id)?.color ?? 0x8ba4b3;
    const material = isPrimary
      ? new MeshBasicMaterial({ color })
      : new MeshStandardMaterial({
          color,
          roughness: 0.9,
        });
    const mesh = new Mesh(geometry, material);
    mesh.userData.bodyId = body.id;
    mesh.renderOrder = 2;
    this.scene.add(mesh);

    const ringMaterial = new MeshBasicMaterial({
      blending: AdditiveBlending,
      color: 0x4cc9b0,
      depthTest: false,
      depthWrite: false,
      opacity: 0.22,
      side: DoubleSide,
      transparent: true,
    });
    const ring = new Mesh(new RingGeometry(0.78, 1, 64), ringMaterial);
    ring.userData.bodyId = body.id;
    ring.renderOrder = 3;
    this.scene.add(ring);

    const light = isPrimary ? new PointLight(0xfff0c7, 3.2, 0, 1.8) : null;
    if (light !== null) {
      this.scene.add(light);
    }

    return {
      bodyId: body.id,
      isPrimary,
      light,
      mesh,
      physicalRadiusSceneUnits: 0,
      ring,
    };
  };

  private readonly updateBodyVisual = (visual: BodyVisual, body: BodyState): void => {
    const scenePosition = positionMetersToScene(body.positionMeters, this.metersToSceneUnit);
    const physicalRadiusSceneUnits = physicalRadiusToSceneUnits(
      body.radiusMeters,
      this.metersToSceneUnit,
    );

    visual.mesh.position.set(scenePosition.x, scenePosition.y, scenePosition.z);
    visual.mesh.scale.setScalar(physicalRadiusSceneUnits);
    visual.mesh.userData.physicalRadiusMeters = body.radiusMeters;
    visual.physicalRadiusSceneUnits = physicalRadiusSceneUnits;

    visual.ring.position.copy(visual.mesh.position);
    const selected = body.id === this.selectedBodyId;
    visual.ring.material.opacity = selected ? 0.92 : 0.22;
    visual.ring.material.color.setHex(selected ? 0x72f1d5 : 0x4cc9b0);

    visual.light?.position.copy(visual.mesh.position);
  };

  private readonly updateOrbits = (bodies: readonly BodyState[]): void => {
    const activeOrbitIds = new Set<string>();

    for (const body of bodies) {
      const parent = findOrbitParent(body, bodies);
      if (parent === null) {
        continue;
      }
      const points = sampleOsculatingOrbit(parent, body, this.metersToSceneUnit, ORBIT_SEGMENTS);
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

  private readonly removeBodyVisual = (visual: BodyVisual): void => {
    this.scene.remove(visual.mesh, visual.ring);
    visual.mesh.geometry.dispose();
    visual.mesh.material.dispose();
    visual.ring.geometry.dispose();
    visual.ring.material.dispose();
    if (visual.light !== null) {
      this.scene.remove(visual.light);
      visual.light.dispose();
    }
  };

  private readonly resize = (): void => {
    if (this.disposed) {
      return;
    }
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    this.camera.aspect = width / height;
    if (!this.cameraWasInteracted) {
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
      this.controls?.update();
      for (const visual of this.bodyVisuals.values()) {
        visual.ring.quaternion.copy(this.camera.quaternion);
        const minimumWorldRadius = computeMinimumBillboardWorldRadius(
          this.camera.position.distanceTo(visual.ring.position),
          Math.max(1, this.mount.clientHeight),
          visual.bodyId === this.selectedBodyId ? 12 : 9,
        );
        visual.ring.scale.setScalar(
          computePositionRingRadius(visual.physicalRadiusSceneUnits, minimumWorldRadius),
        );
      }
      this.updateVisibleScreenMarkers(timestampMilliseconds);
      renderObservatoryFrame(this.renderer, this.scene, this.camera);
      this.animationFrame = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      this.animationFrame = null;
      this.onError(toError(error));
    }
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button === 0) {
      this.pointerDownPosition = new Vector2(event.clientX, event.clientY);
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
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
  };

  private readonly handleControlsChange = (): void => {
    if (!this.updatingControlsProgrammatically) {
      this.cameraWasInteracted = true;
    }
  };

  private computeCurrentFocusFrame(): ObservatoryCameraFrame | null {
    if (this.focusBodyId === null) {
      return null;
    }
    const body = this.latestBodies.find((candidate) => candidate.id === this.focusBodyId);
    if (body === undefined) {
      return null;
    }
    return computeFocusCameraFrame(
      body,
      findOrbitParent(body, this.latestBodies),
      this.metersToSceneUnit,
      this.camera.aspect,
    );
  }

  private followFocusedBody(): void {
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

    this.updatingControlsProgrammatically = true;
    try {
      const direction = this.camera.position.clone().sub(this.controls.target);
      if (direction.lengthSq() <= Number.EPSILON) {
        direction.set(0, 0, 1);
      }
      direction.normalize();
      this.controls.target.set(frame.target.x, frame.target.y, frame.target.z);
      this.camera.position.copy(this.controls.target).addScaledVector(direction, frame.distance);
      this.controls.minDistance = Math.max(1e-6, frame.halfExtent * 0.05);
      this.controls.maxDistance = Math.max(frame.distance * 4, frame.halfExtent * 12);
      this.camera.near = Math.max(1e-7, frame.distance * 1e-5);
      this.camera.far = Math.max(
        frame.distance * 12,
        frame.halfExtent * 64,
        this.viewMode === 'overview' ? 320 : 1,
      );
      this.camera.updateProjectionMatrix();
      this.controls.update();
    } finally {
      this.updatingControlsProgrammatically = false;
    }
  }

  private updateVisibleScreenMarkers(timestampMilliseconds: number): void {
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    const candidates: ScreenMarkerCandidate[] = [];
    this.camera.updateMatrixWorld();

    for (const visual of this.bodyVisuals.values()) {
      const projected = visual.mesh.position.clone().project(this.camera);
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
        visual.ring.visible = false;
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
      visual.ring.visible = visibleIds.has(visual.bodyId);
    }
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
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.scene.traverse(disposeRenderable);
    this.scene.clear();
    canvas.remove();
  }
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
