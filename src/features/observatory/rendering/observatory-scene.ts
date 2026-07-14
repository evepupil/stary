import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
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
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector2,
  Material,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { BodyState } from '../../../physics/protocol/schemas';
import {
  computeMetersToSceneUnit,
  computePositionRingRadius,
  physicalRadiusToSceneUnits,
  positionMetersToScene,
} from './coordinates';
import {
  computeCameraFitDistance,
  computeMinimumBillboardWorldRadius,
  OBSERVATORY_VERTICAL_FOV_DEGREES,
} from './camera-fit';
import {
  disposeObservatoryRenderer,
  renderObservatoryFrame,
  type ObservatoryRenderer,
  type RendererBackend,
} from './create-renderer';
import { sampleOsculatingOrbit } from './orbit';

const STAR_COUNT = 1_600;
const ORBIT_SEGMENTS = 256;

interface BodyVisual {
  readonly bodyId: string;
  readonly hitTarget: Mesh<CircleGeometry, MeshBasicMaterial>;
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
  private readonly pointer = new Vector2();
  private readonly raycaster = new Raycaster();
  private readonly renderer: ObservatoryRenderer;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly scene = new Scene();
  private animationFrame: number | null = null;
  private bodySetKey = '';
  private cameraWasInteracted = false;
  private disposed = false;
  private metersToSceneUnit = 1;
  private pointerDownPosition: Vector2 | null = null;
  private selectedBodyId: string | null = null;

  constructor(options: ObservatorySceneOptions) {
    this.backend = options.backend;
    this.mount = options.mount;
    this.onError = options.onError;
    this.onSelectBody = options.onSelectBody;
    this.renderer = options.renderer;

    const canvas = this.renderer.domElement;
    canvas.className = 'universe-viewport__canvas';
    canvas.dataset.rendererBackend = this.backend;
    canvas.setAttribute('aria-label', '太阳与地球的三维宇宙模拟视图');
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
      this.controls.addEventListener('start', this.handleControlsStart);

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
    const primary = findPrimaryBody(bodies);
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

    this.updateOrbits(primary, bodies);
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
    this.controls?.removeEventListener('start', this.handleControlsStart);
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
    const material = isPrimary
      ? new MeshBasicMaterial({ color: 0xffedb0 })
      : new MeshStandardMaterial({
          color: body.id === 'earth' ? 0x3979a8 : 0x8ba4b3,
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

    const hitTarget = new Mesh(
      new CircleGeometry(1, 48),
      new MeshBasicMaterial({
        colorWrite: false,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
        side: DoubleSide,
        transparent: true,
      }),
    );
    hitTarget.userData.bodyId = body.id;
    hitTarget.renderOrder = 4;
    this.scene.add(hitTarget);

    const light = isPrimary ? new PointLight(0xfff0c7, 3.2, 0, 1.8) : null;
    if (light !== null) {
      this.scene.add(light);
    }

    return {
      bodyId: body.id,
      hitTarget,
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
    visual.hitTarget.position.copy(visual.mesh.position);
    const selected = body.id === this.selectedBodyId;
    visual.ring.material.opacity = selected ? 0.92 : 0.22;
    visual.ring.material.color.setHex(selected ? 0x72f1d5 : 0x4cc9b0);

    visual.light?.position.copy(visual.mesh.position);
  };

  private readonly updateOrbits = (
    primary: BodyState | null,
    bodies: readonly BodyState[],
  ): void => {
    const activeOrbitIds = new Set<string>();

    if (primary !== null) {
      for (const body of bodies) {
        if (body.id === primary.id) {
          continue;
        }
        const points = sampleOsculatingOrbit(primary, body, this.metersToSceneUnit, ORBIT_SEGMENTS);
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
    this.scene.remove(visual.mesh, visual.ring, visual.hitTarget);
    visual.mesh.geometry.dispose();
    visual.mesh.material.dispose();
    visual.ring.geometry.dispose();
    visual.ring.material.dispose();
    visual.hitTarget.geometry.dispose();
    visual.hitTarget.material.dispose();
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
      const fitDistance = computeCameraFitDistance(10, this.camera.aspect);
      this.camera.position.set(0, 0, fitDistance);
      this.camera.lookAt(0, 0, 0);
      this.controls?.target.set(0, 0, 0);
      if (this.controls !== null) {
        this.controls.minDistance = Math.max(1, fitDistance * 0.08);
        this.controls.maxDistance = Math.max(48, fitDistance * 3);
        this.camera.far = Math.max(320, this.controls.maxDistance * 2 + 130);
        this.controls.update();
      }
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
  };

  private readonly renderFrame = (): void => {
    if (this.disposed) {
      return;
    }

    try {
      this.controls?.update();
      for (const visual of this.bodyVisuals.values()) {
        visual.ring.quaternion.copy(this.camera.quaternion);
        visual.hitTarget.quaternion.copy(this.camera.quaternion);
        const minimumWorldRadius = computeMinimumBillboardWorldRadius(
          this.camera.position.distanceTo(visual.ring.position),
          Math.max(1, this.mount.clientHeight),
          visual.bodyId === this.selectedBodyId ? 12 : 9,
        );
        visual.ring.scale.setScalar(
          computePositionRingRadius(visual.physicalRadiusSceneUnits, minimumWorldRadius),
        );
        visual.hitTarget.scale.setScalar(
          computeMinimumBillboardWorldRadius(
            this.camera.position.distanceTo(visual.hitTarget.position),
            Math.max(1, this.mount.clientHeight),
            20,
          ),
        );
      }
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
    this.pointer.set(
      ((event.clientX - canvasBounds.left) / canvasBounds.width) * 2 - 1,
      -((event.clientY - canvasBounds.top) / canvasBounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(
      [...this.bodyVisuals.values()].flatMap((visual) => [
        visual.mesh,
        visual.ring,
        visual.hitTarget,
      ]),
      false,
    );
    const firstIntersection = intersections[0];
    const bodyId = (firstIntersection?.object.userData as { readonly bodyId?: unknown } | undefined)
      ?.bodyId;
    if (typeof bodyId === 'string') {
      this.onSelectBody(bodyId);
    }
  };

  private readonly handlePointerCancel = (): void => {
    this.pointerDownPosition = null;
  };

  private readonly handleControlsStart = (): void => {
    this.cameraWasInteracted = true;
  };

  private rollbackConstruction(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.controls?.removeEventListener('start', this.handleControlsStart);
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

function findPrimaryBody(bodies: readonly BodyState[]): BodyState | null {
  let primary: BodyState | null = null;
  for (const body of bodies) {
    if (primary === null || body.massKg > primary.massKg) {
      primary = body;
    }
  }
  return primary;
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
