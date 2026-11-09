/**
 * Mission viewer 3D engine (MTV-09/12) — vanilla three.js, no reconciler.
 *
 * DESIGN LAWS:
 *  - The engine renders SceneState (pure projection output); it owns no
 *    selection, no mission data and no financial anything.
 *  - Placements are ILLUSTRATIVE: the contract carries no coordinates. Poses
 *    are discrete credible states derived from observed position_status —
 *    never continuous simulated motion and never a fabricated trajectory.
 *  - Resource law: one renderer per mount; every geometry/material/texture/
 *    listener/animation is disposed on unmount (acceptance #23/#24).
 *  - Failure law: WebGL init failure throws a typed error so the component
 *    can fall back to 2D (acceptance #15); context loss is reported without
 *    losing selection (acceptance #16); scene reinitialization performs no
 *    API writes (acceptance #17).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PhysicalViewSnapshot, SceneState, EventMarkerView } from './contract.js';

export class WebGLUnavailableError extends Error {
  constructor(cause: unknown) {
    super('WebGL is unavailable in this browser context', { cause });
    this.name = 'WebGLUnavailableError';
  }
}

export type FramingName = 'overview' | 'asset' | 'event';

export interface ThemeColors {
  sky: number;
  sea: number;
  seaDeep: number;
  fog: number;
  quay: number;
  quayEdge: number;
  structure: number;
  structureAccent: number;
  sun: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  exposure: number;
  markerNominal: number;
  markerBreach: number;
  markerHold: number;
  markerOffline: number;
}

export const THEMES: Record<'dark' | 'light', ThemeColors> = {
  dark: {
    sky: 0x0b1220,
    sea: 0x142842,
    seaDeep: 0x0c1a2c,
    fog: 0x0b1220,
    quay: 0x272730,
    quayEdge: 0x3f3f46,
    structure: 0x1a1a20,
    structureAccent: 0xe8b23e,
    sun: 0xd7e3f0,
    sunIntensity: 1.9,
    hemiSky: 0x2e4258,
    hemiGround: 0x11141a,
    exposure: 1.25,
    markerNominal: 0x5fa8d3,
    markerBreach: 0xf87171,
    markerHold: 0xe8b23e,
    markerOffline: 0x8e8e96,
  },
  light: {
    sky: 0xdfe9f0,
    sea: 0x9fc2d4,
    seaDeep: 0x7fa9c0,
    fog: 0xdfe9f0,
    quay: 0xc9c9ce,
    quayEdge: 0xa9a9b2,
    structure: 0x8e8e96,
    structureAccent: 0x8a6118,
    sun: 0xffffff,
    sunIntensity: 2.1,
    hemiSky: 0xdfe9f0,
    hemiGround: 0x9fc2d4,
    exposure: 1.0,
    markerNominal: 0x1d5a8a,
    markerBreach: 0xb4232a,
    markerHold: 0x7d4f03,
    markerOffline: 0x52525b,
  },
};

/** Illustrative world layout (meters). Documented as illustrative, not surveyed. */
const LAYOUT = {
  waterY: 0,
  quayTopY: 3.2,
  quayMinX: -75,
  quayMaxX: 75,
  quayNearZ: -46,
  quayFarZ: -22,
  berthZ: -14,
  vesselLengthM: 95,
  vesselBeamM: 20,
  uavCruiseY: 12,
  dockPad: { x: -34, z: -32 },
} as const;

const UAV_POSES: Record<string, { x: number; y: number; z: number; hover: boolean }> = {
  // on_station: hovering over WATER beside the hull (the hull occupies
  // z ∈ [berthZ−10, berthZ+10]); never inside the vessel volume.
  on_station: { x: 24, y: 11, z: 6, hover: true },
  transit: { x: -62, y: 16, z: 26, hover: true },
  returning: { x: -30, y: 13, z: 14, hover: true },
  docked: { x: LAYOUT.dockPad.x, y: LAYOUT.quayTopY, z: LAYOUT.dockPad.z, hover: false },
  off_station: { x: 66, y: 18, z: 42, hover: true },
  unknown: { x: 0, y: 12, z: 22, hover: true },
};

interface Disposable {
  dispose(): void;
}

export interface Viewer3dCallbacks {
  onSelectAsset(assetId: string): void;
  onContextLost(): void;
  onFrameDebug(info: { fps: number; triangles: number; calls: number }): void;
}

export class MissionViewer3d {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private container: HTMLElement;
  private markerLayer: HTMLElement;
  private readonly disposables: Disposable[] = [];
  private readonly theme: 'dark' | 'light';
  private readonly callbacks: Viewer3dCallbacks;
  private droneGroup: THREE.Group | null = null;
  private droneRotors: THREE.Object3D[] = [];
  private vesselGroup: THREE.Group | null = null;
  private markerEls = new Map<string, HTMLElement>();
  private markerAnchors = new Map<string, THREE.Vector3>();
  private lastState: SceneState | null = null;
  private snapshot: PhysicalViewSnapshot | null = null;
  private surfaceAssetId: string | null = null;
  private framing: FramingName = 'overview';
  private transitionFrom: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private transitionStart = 0;
  private transitionMs = 0;
  private reducedMotion = false;
  private disposed = false;
  private frames = 0;
  private lastFpsAt = performance.now();
  private lostContext = false;
  private modelFallback = false;

  constructor(
    container: HTMLElement,
    markerLayer: HTMLElement,
    theme: 'dark' | 'light',
    reducedMotion: boolean,
    callbacks: Viewer3dCallbacks,
  ) {
    this.container = container;
    this.markerLayer = markerLayer;
    this.theme = theme;
    this.reducedMotion = reducedMotion;
    this.callbacks = callbacks;

    let renderer: THREE.WebGLRenderer;
    try {
      // Test seam: harness param `?webgl=off` forces the constructor down the
      // exact failure path a WebGL-less browser takes (acceptance #15).
      if ((globalThis as { __MPV_FORCE_NO_WEBGL?: boolean }).__MPV_FORCE_NO_WEBGL === true) {
        throw new Error('forced by __MPV_FORCE_NO_WEBGL');
      }
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      throw new WebGLUnavailableError(error);
    }
    const gl = renderer.getContext();
    if (gl === null) throw new WebGLUnavailableError(new Error('getContext returned null'));
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none'; // camera gestures, not page scroll

    this.scene = new THREE.Scene();
    const t = THEMES[theme];
    this.scene.background = new THREE.Color(t.sky);
    this.scene.fog = new THREE.Fog(t.fog, 160, 460);

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.5, 900);
    this.camera.position.set(0, 58, 120);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = false; // determinism over feel
    this.controls.maxPolarAngle = Math.PI * 0.49; // never below the waterline
    this.controls.minDistance = 14;
    this.controls.maxDistance = 320;
    this.controls.target.set(0, 2, -12);
    this.applyThemeLights(t);

    this.buildHarbor();
    this.loadModels();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.animate();
  }

  // ------------------------------------------------------------------ scene

  private applyThemeLights(t: ThemeColors): void {
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = t.exposure;
    const hemi = new THREE.HemisphereLight(t.hemiSky, t.hemiGround, 0.9);
    const sun = new THREE.DirectionalLight(t.sun, t.sunIntensity);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -110;
    sun.shadow.camera.right = 110;
    sun.shadow.camera.top = 110;
    sun.shadow.camera.bottom = -60;
    sun.shadow.camera.far = 400;
    const fill = new THREE.AmbientLight(t.hemiSky, 0.25);
    for (const light of [hemi, sun, fill]) {
      this.scene.add(light);
      this.track(light as unknown as Disposable);
    }
  }

  private track<T extends Disposable>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  private buildHarbor(): void {
    const t = THEMES[this.theme];

    // Sea — one plane, two-depth gradient via a large canvas-free trick:
    // single standard material; depth reads through fog and lighting.
    const seaGeo = new THREE.PlaneGeometry(900, 700);
    const seaMat = new THREE.MeshStandardMaterial({
      color: t.sea,
      roughness: 0.32,
      metalness: 0.05,
    });
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, LAYOUT.waterY - 0.35, 0);
    sea.receiveShadow = false;
    this.scene.add(sea);
    this.track(seaGeo);
    this.track(seaMat);

    // Quay platform
    const quayW = LAYOUT.quayMaxX - LAYOUT.quayMinX;
    const quayD = LAYOUT.quayFarZ - LAYOUT.quayNearZ;
    const quayGeo = new THREE.BoxGeometry(quayW, LAYOUT.quayTopY, quayD);
    const quayMat = new THREE.MeshStandardMaterial({
      color: t.quay,
      roughness: 0.92,
      metalness: 0.02,
    });
    const quay = new THREE.Mesh(quayGeo, quayMat);
    quay.position.set(0, LAYOUT.quayTopY / 2, (LAYOUT.quayNearZ + LAYOUT.quayFarZ) / 2);
    quay.receiveShadow = true;
    quay.castShadow = true;
    this.scene.add(quay);
    this.track(quayGeo);
    this.track(quayMat);

    // Quay edge strip
    const edgeGeo = new THREE.BoxGeometry(quayW, 0.5, 1.1);
    const edgeMat = new THREE.MeshStandardMaterial({ color: t.quayEdge, roughness: 0.85 });
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.position.set(0, LAYOUT.quayTopY, LAYOUT.quayNearZ + 0.6);
    this.scene.add(edge);
    this.track(edgeGeo);
    this.track(edgeMat);

    // Bollards along the quay edge
    const bollardGeo = new THREE.CylinderGeometry(0.55, 0.7, 1.5, 12);
    const bollardMat = new THREE.MeshStandardMaterial({
      color: t.structure,
      roughness: 0.7,
      metalness: 0.35,
    });
    for (let x = LAYOUT.quayMinX + 12; x <= LAYOUT.quayMaxX - 12; x += 24) {
      const b = new THREE.Mesh(bollardGeo, bollardMat);
      b.position.set(x, LAYOUT.quayTopY + 0.75, LAYOUT.quayNearZ + 2.4);
      b.castShadow = true;
      this.scene.add(b);
    }
    this.track(bollardGeo);
    this.track(bollardMat);

    // Ops cabin on the quay
    const cabinGeo = new THREE.BoxGeometry(9, 4.4, 6.5);
    const cabinMat = new THREE.MeshStandardMaterial({ color: t.structure, roughness: 0.8 });
    const cabin = new THREE.Mesh(cabinGeo, cabinMat);
    cabin.position.set(-46, LAYOUT.quayTopY + 2.2, -33);
    cabin.castShadow = true;
    this.scene.add(cabin);
    this.track(cabinGeo);
    this.track(cabinMat);

    // UAV landing pad (docked pose target)
    const padGeo = new THREE.CylinderGeometry(2.6, 2.6, 0.18, 24);
    const padMat = new THREE.MeshStandardMaterial({ color: t.structureAccent, roughness: 0.6 });
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(LAYOUT.dockPad.x, LAYOUT.quayTopY + 0.09, LAYOUT.dockPad.z);
    this.scene.add(pad);
    this.track(padGeo);
    this.track(padMat);

    // Crane silhouette (harbor context; static, no decoration)
    const mastGeo = new THREE.BoxGeometry(1.6, 26, 1.6);
    const jibGeo = new THREE.BoxGeometry(22, 1.2, 1.4);
    const mastMat = new THREE.MeshStandardMaterial({ color: t.structure, roughness: 0.85 });
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(48, LAYOUT.quayTopY + 13, -36);
    mast.castShadow = true;
    const jib = new THREE.Mesh(jibGeo, mastMat);
    jib.position.set(38, LAYOUT.quayTopY + 25.4, -36);
    jib.castShadow = true;
    this.scene.add(mast, jib);
    this.track(mastGeo);
    this.track(jibGeo);
    this.track(mastMat);
  }

  private loadModels(): void {
    const loader = new GLTFLoader();
    const forceNoModels =
      (globalThis as { __MPV_FORCE_NO_MODELS?: boolean }).__MPV_FORCE_NO_MODELS === true;
    const uavUrl = forceNoModels
      ? new URL('./assets/does-not-exist.glb', import.meta.url).href
      : new URL('./assets/inspection-uav.glb', import.meta.url).href;
    const vesselUrl = forceNoModels
      ? new URL('./assets/does-not-exist.glb', import.meta.url).href
      : new URL('./assets/moored-vessel.glb', import.meta.url).href;

    loader.load(
      uavUrl,
      (gltf) => {
        if (this.disposed) return;
        const group = gltf.scene;
        group.scale.setScalar(1.9); // ≈1.1 m span inspection quad
        // Anti-collision strobe (mandatory equipment on inspection UAVs) —
        // the only element allowed to draw the eye; it is equipment, not
        // decoration. Reduced-motion: steady dim light instead of blink.
        const strobeMat = new THREE.MeshBasicMaterial({ color: 0xff5a5a });
        const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), strobeMat);
        strobe.position.set(0, 0.34, 0);
        strobe.name = '__strobe';
        group.add(strobe);
        this.track(strobe.geometry);
        this.track(strobeMat);
        group.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            this.track((o as THREE.Mesh).geometry);
            const m = (o as THREE.Mesh).material;
            for (const mat of Array.isArray(m) ? m : [m]) this.track(mat as Disposable);
          }
          if (/rotor/i.test(o.name)) this.droneRotors.push(o);
        });
        this.droneGroup = group;
        this.scene.add(group);
        if (this.lastState !== null) this.applyPoses(this.lastState);
      },
      undefined,
      () => {
        // Acceptance #13: missing GLB → credible placeholder, not a broken scene.
        this.modelFallback = true;
        this.droneGroup = this.placeholderUav();
        this.scene.add(this.droneGroup);
        if (this.lastState !== null) this.applyPoses(this.lastState);
      },
    );

    loader.load(
      vesselUrl,
      (gltf) => {
        if (this.disposed) return;
        const group = gltf.scene;
        group.scale.setScalar(97); // ≈95 m coastal vessel
        group.position.set(0, 0.4, LAYOUT.berthZ);
        group.rotation.y = 0; // length along X after authoring orientation check
        group.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            this.track((o as THREE.Mesh).geometry);
            const m = (o as THREE.Mesh).material;
            for (const mat of Array.isArray(m) ? m : [m]) this.track(mat as Disposable);
          }
        });
        this.vesselGroup = group;
        this.scene.add(group);
        this.applyVesselOrientation();
      },
      undefined,
      () => {
        this.modelFallback = true;
        this.vesselGroup = this.placeholderVessel();
        this.scene.add(this.vesselGroup);
      },
    );
  }

  /** Orient the vessel so its LONGEST dimension lies along X (alongside the quay). */
  private applyVesselOrientation(): void {
    const group = this.vesselGroup;
    if (group === null) return;
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    if (size.z > size.x) group.rotation.y = Math.PI / 2;
    const after = new THREE.Box3().setFromObject(group);
    const s = after.getSize(new THREE.Vector3());
    const k = LAYOUT.vesselLengthM / Math.max(s.x, 1);
    if (Number.isFinite(k) && k > 0 && k < 500) group.scale.multiplyScalar(k);
    const recenter = new THREE.Box3().setFromObject(group);
    const center = recenter.getCenter(new THREE.Vector3());
    group.position.x -= center.x;
    group.position.z -= center.z - LAYOUT.berthZ;
    // Settle the hull to the waterline.
    group.position.y -= recenter.min.y - 0.6;
  }

  private placeholderUav(): THREE.Group {
    const t = THEMES[this.theme];
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.32, 1.1),
      new THREE.MeshStandardMaterial({ color: t.structure, roughness: 0.6 }),
    );
    body.castShadow = true;
    g.add(body);
    for (const [dx, dz] of [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ] as const) {
      const rotor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12),
        new THREE.MeshStandardMaterial({ color: t.quayEdge, roughness: 0.5 }),
      );
      rotor.name = `Rotor_${dx < 0 ? 'L' : 'R'}${dz < 0 ? 'F' : 'B'}`;
      rotor.position.set(dx, 0.2, dz);
      g.add(rotor);
      this.droneRotors.push(rotor);
    }
    this.trackPlaceholder(g);
    return g;
  }

  private placeholderVessel(): THREE.Group {
    const t = THEMES[this.theme];
    const g = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(LAYOUT.vesselLengthM, 9, LAYOUT.vesselBeamM),
      new THREE.MeshStandardMaterial({ color: t.structure, roughness: 0.7 }),
    );
    hull.position.y = 3;
    hull.castShadow = true;
    const house = new THREE.Mesh(
      new THREE.BoxGeometry(12, 8, LAYOUT.vesselBeamM - 6),
      new THREE.MeshStandardMaterial({ color: t.quay, roughness: 0.8 }),
    );
    house.position.set(-LAYOUT.vesselLengthM / 2 + 10, 10, 0);
    g.add(hull, house);
    this.trackPlaceholder(g);
    this.applyVesselOrientation();
    return g;
  }

  private trackPlaceholder(group: THREE.Group): void {
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        this.track((o as THREE.Mesh).geometry);
        const m = (o as THREE.Mesh).material;
        for (const mat of Array.isArray(m) ? m : [m]) this.track(mat as Disposable);
      }
    });
  }

  // ------------------------------------------------------------------ state

  applyState(state: SceneState, snapshot: PhysicalViewSnapshot): void {
    this.lastState = state;
    this.snapshot = snapshot;
    this.surfaceAssetId = snapshot.assets.find((a) => a.kind === 'surface')?.assetId ?? null;
    this.applyPoses(state);
    this.syncMarkers(state);
    this.updateMarkerColors(state);
  }

  private applyPoses(state: SceneState): void {
    const uavPose = state.poses.find((p) => p.assetId === state.policy.uavAssetId);
    if (this.droneGroup !== null && uavPose !== undefined) {
      const target = UAV_POSES[uavPose.pose] ?? UAV_POSES.unknown!;
      this.droneGroup.position.set(target.x, target.y, target.z);
      this.droneGroup.rotation.y = 0.9; // heading over the hull inspection offset
      if (this.reducedMotion) this.droneRotors.forEach((r) => (r.rotation.y = 0));
    }
  }

  private syncMarkers(state: SceneState): void {
    // Anchor per marker: above its asset's illustrative position. Markers on
    // the same anchor fan out horizontally so each stays clickable.
    const uavPose = state.poses.find((p) => p.assetId === state.policy.uavAssetId);
    const uavWorld = UAV_POSES[uavPose?.pose ?? 'unknown'] ?? UAV_POSES.unknown!;
    const perAnchorCount = new Map<string, number>();
    for (const marker of state.markers) {
      const isUav = marker.assetId === state.policy.uavAssetId;
      const base = isUav
        ? new THREE.Vector3(uavWorld.x, uavWorld.y + 2.4, uavWorld.z)
        : new THREE.Vector3(18 + ((marker.journalSeq * 7) % 40), 16, LAYOUT.berthZ + 6);
      const anchorKey = `${base.x},${base.y},${base.z}`;
      const idx = perAnchorCount.get(anchorKey) ?? 0;
      perAnchorCount.set(anchorKey, idx + 1);
      base.x += idx * 1.6; // fan-out per stacked marker
      this.markerAnchors.set(marker.eventId, base);
    }
  }

  private updateMarkerColors(state: SceneState): void {
    const t = THEMES[this.theme];
    const colorOf: Record<EventMarkerView['severity'], number> = {
      nominal: t.markerNominal,
      breach: t.markerBreach,
      hold: t.markerHold,
      offline: t.markerOffline,
      recovery: t.markerNominal,
    };
    for (const marker of state.markers) {
      const el = this.markerEls.get(marker.eventId);
      if (el !== undefined) {
        const hex = `#${colorOf[marker.severity].toString(16).padStart(6, '0')}`;
        el.style.setProperty('--mpv-marker-color', hex);
        el.dataset.severity = marker.severity;
        el.dataset.selected = marker.selected ? 'true' : 'false';
      }
    }
  }

  /** React registers marker buttons; the engine positions them each frame. */
  registerMarkerElement(eventId: string, el: HTMLElement | null): void {
    if (el === null) this.markerEls.delete(eventId);
    else this.markerEls.set(eventId, el);
  }

  // ----------------------------------------------------------------- camera

  setFraming(framing: FramingName, animate = true): void {
    if (this.framing === framing && animate) return;
    this.framing = framing;
    const pose = this.cameraPoseFor(framing);
    if (this.reducedMotion || !animate) {
      this.camera.position.copy(pose.pos);
      this.controls.target.copy(pose.target);
      this.controls.update();
      this.transitionFrom = null;
      return;
    }
    this.transitionFrom = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
    };
    this.transitionStart = performance.now();
    this.transitionMs = 950;
  }

  private cameraPoseFor(framing: FramingName): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const last = this.lastState;
    if (framing === 'asset') {
      const uavPose = last?.poses.find((p) => p.assetId === last.policy.uavAssetId);
      const p = UAV_POSES[uavPose?.pose ?? 'unknown'] ?? UAV_POSES.unknown!;
      // Aim BELOW the subject: the orbit target renders at canvas center,
      // where the evidence HUD sits — offsetting the target keeps the asset
      // in the clear upper frame (acceptance #21: HUD never occludes the
      // subject; conversely the subject must not hide behind the HUD).
      return {
        pos: new THREE.Vector3(p.x + 10, p.y + 2.5, p.z + 14),
        target: new THREE.Vector3(p.x, p.y - 3.4, p.z - 1),
      };
    }
    if (framing === 'event' && last !== null && last.selected !== null) {
      const uavPose = last.poses.find((p) => p.assetId === last.policy.uavAssetId);
      const p = UAV_POSES[uavPose?.pose ?? 'unknown'] ?? UAV_POSES.unknown!;
      return {
        pos: new THREE.Vector3(p.x + 15, p.y + 3.4, p.z + 20),
        target: new THREE.Vector3(p.x, p.y - 3.6, p.z - 2),
      };
    }
    return { pos: new THREE.Vector3(10, 34, 62), target: new THREE.Vector3(4, 4, -8) };
  }

  /** Deterministic reset (acceptance #20). */
  resetCamera(): void {
    this.setFraming('overview');
  }

  // ------------------------------------------------------------------ loop

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.lostContext) return;
    // Raycast for asset selection only (no camera-as-authority, no writes).
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    if (this.droneGroup !== null) targets.push(this.droneGroup);
    if (this.vesselGroup !== null) targets.push(this.vesselGroup);
    const hits = ray.intersectObjects(targets, true);
    if (hits.length === 0 || this.lastState === null) return;
    const uavAssetId = this.lastState.policy.uavAssetId;
    const vesselAssetId = this.surfaceAssetId;
    if (this.droneGroup !== null && hitWithin(hits, this.droneGroup)) {
      this.callbacks.onSelectAsset(uavAssetId);
    } else if (
      vesselAssetId !== null &&
      this.vesselGroup !== null &&
      hitWithin(hits, this.vesselGroup)
    ) {
      this.callbacks.onSelectAsset(vesselAssetId);
    }
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.lostContext = true;
    this.callbacks.onContextLost();
  };

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    const now = performance.now();

    if (this.transitionFrom !== null) {
      const k = Math.min(1, (now - this.transitionStart) / this.transitionMs);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      const pose = this.cameraPoseFor(this.framing);
      this.camera.position.lerpVectors(this.transitionFrom.pos, pose.pos, e);
      this.controls.target.lerpVectors(this.transitionFrom.target, pose.target, e);
      if (k >= 1) this.transitionFrom = null;
    }

    // Rotor idle: observed-state illustration, stopped when docked/reduced.
    const last = this.lastState;
    if (this.droneGroup !== null && last !== null) {
      const pose = last.poses.find((p) => p.assetId === last.policy.uavAssetId);
      const spinning = pose !== undefined && pose.pose !== 'docked';
      if (spinning && !this.reducedMotion) {
        const spin = (now / 1000) * 18;
        for (const r of this.droneRotors) r.rotation.y = spin;
      }
      // Strobe blink (1.2 Hz), steady-dim when docked or reduced motion.
      const strobe = this.droneGroup.getObjectByName('__strobe');
      if (strobe !== undefined) {
        const material = (strobe as THREE.Mesh).material as THREE.MeshBasicMaterial;
        const airborne = pose !== undefined && pose.pose !== 'docked';
        material.color.setHex(
          airborne && !this.reducedMotion
            ? Math.sin(now / 420) > 0
              ? 0xff5a5a
              : 0x3a1212
            : 0x8a2f2f,
        );
      }
    }

    // Gentle sea bob ONLY for the UAV hover (2 cm amplitude) — reduced-motion
    // disables it; the vessel is moored and never moves.
    if (this.droneGroup !== null && last !== null && !this.reducedMotion) {
      const pose = last.poses.find((p) => p.assetId === last.policy.uavAssetId);
      if (pose !== undefined && pose.pose !== 'docked') {
        const p = UAV_POSES[pose.pose] ?? UAV_POSES.unknown!;
        this.droneGroup.position.y = p.y + Math.sin(now / 900) * 0.2;
      }
    }

    this.controls.update();
    this.projectMarkers();
    this.renderer.render(this.scene, this.camera);

    this.frames += 1;
    if (now - this.lastFpsAt >= 1000) {
      const info = this.renderer.info;
      this.callbacks.onFrameDebug({
        fps: Math.round((this.frames * 1000) / (now - this.lastFpsAt)),
        triangles: info.render.triangles,
        calls: info.render.calls,
      });
      this.frames = 0;
      this.lastFpsAt = now;
    }
  };

  private projectMarkers(): void {
    if (this.markerEls.size === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const v = new THREE.Vector3();
    for (const [eventId, el] of this.markerEls) {
      const anchor = this.markerAnchors.get(eventId);
      if (anchor === undefined) continue;
      v.copy(anchor).project(this.camera);
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      el.style.visibility = behind ? 'hidden' : 'visible';
    }
  }

  /** Debug surface for tests (acceptance #20/#23/#24). Read-only. */
  debug(): {
    camera: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    zoomLimits: { min: number; max: number };
    touchConfig: { oneFinger: string; twoFinger: string };
    triangles: number;
    calls: number;
    resources: number;
    modelFallback: boolean;
    contextLost: boolean;
    framing: FramingName;
    dronePosition: { x: number; y: number; z: number } | null;
  } {
    return {
      camera: {
        x: round2(this.camera.position.x),
        y: round2(this.camera.position.y),
        z: round2(this.camera.position.z),
      },
      target: {
        x: round2(this.controls.target.x),
        y: round2(this.controls.target.y),
        z: round2(this.controls.target.z),
      },
      zoomLimits: { min: this.controls.minDistance, max: this.controls.maxDistance },
      touchConfig: {
        // One finger rotates, two fingers dolly/pan — the OrbitControls touch
        // contract for this viewer (read-only exposure for tests).
        oneFinger:
          this.controls.touches.ONE === THREE.TOUCH.ROTATE
            ? 'rotate'
            : String(this.controls.touches.ONE),
        twoFinger:
          this.controls.touches.TWO === THREE.TOUCH.DOLLY_PAN
            ? 'dolly-pan'
            : String(this.controls.touches.TWO),
      },
      triangles: this.renderer.info.render.triangles,
      calls: this.renderer.info.render.calls,
      resources: this.disposables.length,
      modelFallback: this.modelFallback,
      contextLost: this.lostContext,
      framing: this.framing,
      dronePosition:
        this.droneGroup === null
          ? null
          : {
              x: round2(this.droneGroup.position.x),
              y: round2(this.droneGroup.position.y),
              z: round2(this.droneGroup.position.z),
            },
    };
  }

  /**
   * Test seam: place the camera at `meters` along its current direction from
   * the orbit target and run one controls update. The orbit control's
   * min/max clamp must pull any out-of-range request back inside bounds —
   * that clamp is exactly what this seam proves.
   */
  forceCameraDistance(meters: number): void {
    const dir = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, meters);
    this.controls.update();
  }

  simulateContextLoss(): void {
    const ext = this.renderer.getContext().getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      this.transitionFrom = null;
      this.droneRotors.forEach((r) => (r.rotation.y = 0));
      const last = this.lastState;
      const pose = last?.poses.find((p) => p.assetId === last.policy.uavAssetId);
      if (pose !== undefined && this.droneGroup !== null) {
        const p = UAV_POSES[pose.pose] ?? UAV_POSES.unknown!;
        this.droneGroup.position.y = p.y; // stop hover bob immediately
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.controls.dispose();
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // dispose must never throw out of unmount
      }
    }
    this.disposables.length = 0;
    this.markerEls.clear();
    this.markerAnchors.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.renderer.forceContextLoss();
  }
}

function hitWithin(hits: { object: THREE.Object3D }[], root: THREE.Object3D): boolean {
  return hits.some((h) => {
    let o: THREE.Object3D | null = h.object;
    while (o !== null) {
      if (o === root) return true;
      o = o.parent;
    }
    return false;
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
