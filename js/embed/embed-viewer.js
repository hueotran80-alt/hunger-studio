/**
 * Web Blender Studio — lightweight embed viewer.
 * Loads only three, GLTFLoader (+Draco), OrbitControls and the share codec.
 *
 * Supported URLs:
 *   embed.html?glb=/models/Michelle.glb&autoplay=1&grid=0
 *   embed.html#z=<gzip+base64url glb>
 *   index.html?view=embed&glb=...        (redirects to embed.html)
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { gunzipSync } from 'three/addons/libs/fflate.module.js';
import { parseEmbedLocation, decodeSharePayload, pickAnimationClip, normalizeHexColor } from './embed-core.js';
import { USDZExporter } from '../exporters/usdz-exporter.js';

const DRACO_DECODER_PATH = './vendor/three/addons/libs/draco/gltf/';
const MAX_PIXEL_RATIO = 2;

/**
 * Box3.setFromObject uses bind-pose geometry bounds, which are wrong for
 * skinned GLBs whose mesh node and skeleton use different scales (Michelle:
 * mesh ×0.01, bones in metres). Sample the real skinned positions instead.
 * @param {THREE.Object3D} root
 * @returns {THREE.Box3}
 */
function computeWorldBounds(root) {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  let sampledSkinned = false;

  root.traverse((node) => {
    if (!node.isSkinnedMesh || !node.geometry || !node.skeleton) return;
    const position = node.geometry.attributes && node.geometry.attributes.position;
    if (!position || typeof node.getVertexPosition !== 'function') return;
    node.skeleton.update();
    const step = Math.max(1, Math.floor(position.count / 4000));
    for (let i = 0; i < position.count; i += step) {
      node.getVertexPosition(i, point);
      point.applyMatrix4(node.matrixWorld);
      box.expandByPoint(point);
    }
    sampledSkinned = true;
  });

  root.traverse((node) => {
    if (node.isMesh && !node.isSkinnedMesh) {
      box.union(new THREE.Box3().setFromObject(node));
    } else if (node.isSkinnedMesh && !sampledSkinned) {
      box.union(new THREE.Box3().setFromObject(node));
    }
  });

  root.traverse((node) => {
    if (node.isBone) box.expandByPoint(node.getWorldPosition(point));
  });

  return box;
}

function modelLabel(src) {
  if (!src) return '3D Model';
  try {
    const path = src.startsWith('blob:') ? '' : new URL(src, 'http://local/').pathname;
    const name = decodeURIComponent((path || '').split('/').pop() || '');
    return name ? name.replace(/\.(glb|gltf)$/i, '') : '3D Model';
  } catch (_) {
    return '3D Model';
  }
}

export class EmbedViewer {
  /**
   * @param {HTMLElement} host
   * @param {{src:string|null,payload:string,options:object,error:string|null}} config
   */
  constructor(host, config) {
    this.host = host;
    this.config = config;
    this.options = config.options;
    this.src = config.src;
    this.payload = config.payload;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.model = null;
    this.mixer = null;
    this.action = null;
    this.clips = [];
    this.playing = false;
    this.ready = false;
    this.disposed = false;
    this._userMoved = false;
    this._clock = new THREE.Clock();
    this._envTarget = null;
    this._draco = null;
    this._arUrls = [];
    this._onMessage = this._handleMessage.bind(this);
    this._onFinished = this._handleFinished.bind(this);
    this._onContextLost = this._handleContextLost.bind(this);
    this._onContextRestored = this._handleContextRestored.bind(this);
    this._els = {
      loading: document.getElementById('embed-loading'),
      status: document.getElementById('embed-status'),
      error: document.getElementById('embed-error'),
      errorDetail: document.getElementById('embed-error-detail'),
      retry: document.getElementById('embed-retry'),
      controls: document.getElementById('embed-controls'),
      play: document.getElementById('embed-play'),
      reset: document.getElementById('embed-reset'),
      ar: document.getElementById('embed-ar'),
      fullscreen: document.getElementById('embed-fullscreen'),
      badge: document.getElementById('embed-badge')
    };

    document.body.classList.toggle('is-transparent', this.options.transparent);
    this.host.dataset.state = 'loading';
    this._bindUI();
    this._buildRenderer();
    this._buildScene();
    this._buildEnvironment();
    this._observeResize();
    window.addEventListener('message', this._onMessage);
  }

  _handleContextLost(event) {
    event?.preventDefault?.();
    if (this.disposed) return;
    this.renderer?.setAnimationLoop(null);
    this._setStatus('WebGL context lost — waiting to restore…');
    this.host.dataset.state = 'context-lost';
    this._emit('contextlost', {});
  }

  _handleContextRestored() {
    if (this.disposed) return;
    this._buildEnvironment();
    this._resize();
    this._startLoop();
    this.host.dataset.state = this.ready ? 'ready' : 'loading';
    this._emit('contextrestored', {});
  }

  _buildRenderer() {
    const bgParsed = !this.options.transparent ? normalizeHexColor(this.options.bg) : null;
    const needsAlpha = Boolean(this.options.transparent || (bgParsed && bgParsed.alpha < 1));
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: needsAlpha,
      powerPreference: 'high-performance'
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.options.shadow;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const ratio = this.options.dpr > 0
      ? this.options.dpr
      : Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(Math.max(0.5, ratio));
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.setAttribute('aria-label', '3D Model Viewer');
    this.renderer.domElement.addEventListener('webglcontextlost', this._onContextLost, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this._onContextRestored, false);
    this.host.prepend(this.renderer.domElement);
  }

  _buildScene() {
    this.scene = new THREE.Scene();
    if (!this.options.transparent) {
      const bgParsed = normalizeHexColor(this.options.bg) || { hex: '#1b1b1b', alpha: 1 };
      if (bgParsed.alpha < 1) {
        this.scene.background = null;
        this.renderer.setClearColor(bgParsed.hex, bgParsed.alpha);
      } else {
        this.scene.background = new THREE.Color(bgParsed.hex);
      }
    }

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    this.camera.position.set(3.4, 2.6, 4.8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enabled = this.options.controls;
    this.controls.autoRotate = this.options.autorotate && this.options.controls;
    this.controls.autoRotateSpeed = 1.1;
    this.controls.target.set(0, 1, 0);
    this.controls.addEventListener('start', () => { this._userMoved = true; });

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this.hemi = new THREE.HemisphereLight(0xdfe9ff, 0x2a2a33, 1.3);
    this.scene.add(this.hemi);

    this.keyLight = new THREE.DirectionalLight(0xfff4e6, 2.7);
    this.keyLight.position.set(5, 9, 7);
    this.keyLight.castShadow = this.options.shadow;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight(0xaec7ff, 1.05);
    this.fillLight.position.set(-6, 3.5, -3);
    this.scene.add(this.fillLight);
    this.scene.add(this.fillLight.target);

    this.rimLight = new THREE.DirectionalLight(0xffffff, 0.85);
    this.rimLight.position.set(0, 6, -9);
    this.scene.add(this.rimLight);
    this.scene.add(this.rimLight.target);

    this._buildGround();
    this._resize();
    this._startLoop();
  }

  _buildGround() {
    this.groundGroup = new THREE.Group();
    this.shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.26 });
    this.shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMaterial);
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = 0.002;
    this.shadowPlane.receiveShadow = true;
    this.shadowPlane.visible = this.options.shadow;
    this.groundGroup.add(this.shadowPlane);

    this.grid = new THREE.GridHelper(10, 20, 0x6a6a6a, 0x3a3a3a);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.grid.visible = this.options.grid;
    this.groundGroup.add(this.grid);

    this.groundGroup.visible = this.options.grid || this.options.shadow;
    this.scene.add(this.groundGroup);
  }

  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x26262b);
    const roomGeo = new THREE.BoxGeometry(12, 12, 12);
    const roomMat = new THREE.MeshBasicMaterial({ color: 0x3a3a42, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(roomGeo, roomMat));

    const panel = (w, h, color, position, rotation) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
      );
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      envScene.add(mesh);
      return mesh;
    };

    panel(4.5, 4.5, 0xffffff, [0, 5.8, 0], [Math.PI / 2, 0, 0]);
    panel(3, 4, 0xcfe2ff, [-5.8, 1.5, 0], [0, Math.PI / 2, 0]);
    panel(2, 3, 0xffe7c8, [5.8, 1.2, -1], [0, -Math.PI / 2, 0]);
    panel(2.5, 2.5, 0xffffff, [0, 2, -5.8], [0, 0, 0]);

    this._envTarget = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this._envTarget.texture;

    envScene.traverse((node) => {
      if (node.isMesh) node.material.dispose();
    });
    roomGeo.dispose();
    roomMat.dispose();
    pmrem.dispose();
  }

  _bindUI() {
    const { controls, play, reset, ar, fullscreen, retry, badge } = this._els;
    if (!this.options.ui) {
      if (controls) controls.hidden = true;
      if (badge) badge.hidden = true;
    } else if (!this.options.badge && badge) {
      badge.hidden = true;
    }

    play?.addEventListener('click', () => this.togglePlay());
    reset?.addEventListener('click', () => this.resetView());
    ar?.addEventListener('click', () => {
      this.viewInAR().catch((err) => {
        console.warn('[Embed] AR launch failed:', err);
      });
    });
    fullscreen?.addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      } else if (this.host.requestFullscreen) {
        this.host.requestFullscreen().catch(() => {});
      }
    });
    retry?.addEventListener('click', () => window.location.reload());
  }

  _observeResize() {
    const onResize = () => this._resize();
    this._resizeHandler = onResize;
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(onResize);
      this._resizeObserver.observe(this.host);
    }
  }

  _resize() {
    if (!this.renderer || !this.camera) return;
    const width = this.host.clientWidth || window.innerWidth || 1;
    const height = this.host.clientHeight || window.innerHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
  }

  _startLoop() {
    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return;
      const dt = Math.min(this._clock.getDelta(), 0.1);
      if (this.mixer && this.playing) this.mixer.update(dt);
      if (this.controls.enabled) this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  _setStatus(text) {
    if (this._els.status) this._els.status.textContent = text;
  }

  async load() {
    if (this.config.error) {
      this.showError(
        'Missing model link',
        'Add ?glb=<path-to-.glb> or open a shared link with embedded model (#z=...).'
      );
      return this;
    }

    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_DECODER_PATH);
    draco.setDecoderConfig({ type: 'wasm' });
    loader.setDRACOLoader(draco);
    if (typeof window !== 'undefined' && window.MeshoptDecoder && typeof loader.setMeshoptDecoder === 'function') {
      loader.setMeshoptDecoder(window.MeshoptDecoder);
    }
    this._draco = draco;

    try {
      let gltf;
      if (this.src) {
        this._setStatus('Loading model…');
        gltf = await loader.loadAsync(this.src, (event) => {
          if (event && event.total > 0) {
            const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
            this._setStatus(`Loading model… ${pct}%`);
          }
        });
      } else {
        this._setStatus('Decompressing model…');
        const bytes = await decodeSharePayload(this.payload, { gunzip: (buffer) => gunzipSync(buffer) });
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        gltf = await loader.parseAsync(buffer, '');
      }

      if (this.disposed) return this;
      this._install(gltf);
      return this;
    } catch (error) {
      this.showError(
        'Failed to load model',
        error && error.message ? error.message : String(error)
      );
      return this;
    } finally {
      if (this.disposed && this._draco) this._draco.dispose();
    }
  }

  _install(gltf) {
    const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!root) throw new Error('File does not contain any scene');

    this.model = root;
    this.modelGroup.add(root);
    root.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = this.options.shadow;
      node.receiveShadow = this.options.shadow;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (material && 'envMapIntensity' in material && material.envMapIntensity === undefined) {
          material.envMapIntensity = 0.9;
        }
      }
    });

    if (this.options.fit) this._fitModel(root);
    this._placeGround(root);
    this._setupAnimations(gltf.animations || []);

    if (this.options.ui && this._els.controls) this._els.controls.hidden = false;
    if (this.options.ui && this._els.ar) this._els.ar.hidden = false;
    if (this._els.loading) this._els.loading.hidden = true;
    this.ready = true;
    this.host.dataset.state = 'ready';
    this.host.dataset.clips = String(this.clips.length);

    const label = modelLabel(this.src) || root.name || '3D Model';
    document.title = `${label} — Hunger`;
    this._emit('loaded', {
      clips: this.clips.map((clip) => clip.name),
      clip: this.currentClip ? this.currentClip.name : null,
      animations: this.clips.length
    });
  }

  _fitModel(root) {
    const box = computeWorldBounds(root);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    root.position.y -= box.min.y;
    root.updateWorldMatrix(true, true);

    box.copy(computeWorldBounds(root));
    const center = box.getCenter(new THREE.Vector3());
    size.copy(box.getSize(new THREE.Vector3()));

    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect || 1;
    const fitHeight = size.y / (2 * Math.tan(vFov / 2));
    const fitWidth = size.x / (2 * Math.tan(vFov / 2) * Math.max(aspect, 0.2));
    const distance = Math.max(fitHeight, fitWidth, size.z / 2, 1e-4) * 1.45;
    const direction = new THREE.Vector3(1, 0.45, 1).normalize();

    this._homeTarget = center.clone();
    this._homePosition = center.clone().addScaledVector(direction, distance);
    this._homeDistance = distance;
    this._modelRadius = Math.max(size.x, size.y, size.z) * 0.75;

    this.controls.minDistance = Math.max(distance * 0.03, 1e-5);
    this.controls.maxDistance = Math.max(distance * 25, 0.01);
    this.camera.near = Math.max(distance / 200, 1e-6);
    this.camera.far = Math.max(distance * 40, 0.01);
    this.resetView();
    this._aimLights(center, Math.max(size.x, size.y, size.z, 1e-4));
  }

  _aimLights(center, extent) {
    const radius = Math.max(extent * 1.2, 1e-4);
    this.hemi.position.copy(center).add(new THREE.Vector3(0, radius * 2, 0));

    const aim = (light, offset) => {
      light.target.position.copy(center);
      light.position.copy(center).add(offset);
      light.target.updateMatrixWorld();
      light.updateMatrixWorld();
    };
    aim(this.keyLight, new THREE.Vector3(radius * 1.3, radius * 2.1, radius * 1.5));
    aim(this.fillLight, new THREE.Vector3(-radius * 1.8, radius * 1.1, -radius * 0.9));
    aim(this.rimLight, new THREE.Vector3(0, radius * 1.7, -radius * 2.4));

    const shadowCam = this.keyLight.shadow.camera;
    shadowCam.left = -radius * 1.6;
    shadowCam.right = radius * 1.6;
    shadowCam.top = radius * 1.6;
    shadowCam.bottom = -radius * 1.6;
    shadowCam.near = Math.max(radius * 0.01, 1e-6);
    shadowCam.far = Math.max(radius * 10, 0.001);
    shadowCam.updateProjectionMatrix();
    this.keyLight.shadow.normalBias = Math.max(extent * 0.01, 1e-7);

    const shadowRadius = Math.max(extent * 2.4, 1e-4);
    this.keyLight.shadow.radius = 2;
    this.shadowPlane.position.y = Math.max(extent * 0.001, 1e-7);
    this.shadowPlane.scale.set(shadowRadius * 2, shadowRadius * 2, 1);
    this.grid.scale.setScalar(Math.max(extent * 2.2, 1e-4) / 10);
  }

  _placeGround(root) {
    const box = computeWorldBounds(root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    this.groundGroup.position.x = center.x;
    this.groundGroup.position.z = center.z;
  }

  _setupAnimations(clips) {
    this.clips = Array.isArray(clips) ? clips.filter((clip) => clip && clip.tracks && clip.tracks.length) : [];
    if (!this.clips.length) {
      if (this._els.play) this._els.play.hidden = true;
      return;
    }
    this.mixer = new THREE.AnimationMixer(this.model);
    this.mixer.addEventListener('finished', this._onFinished);
    const clip = pickAnimationClip(this.clips, this.options.clip);
    if (clip) this.setClip(clip);
  }

  setClip(clipOrName) {
    if (!this.mixer || !this.clips.length) return false;
    const clip = typeof clipOrName === 'string'
      ? pickAnimationClip(this.clips, clipOrName)
      : clipOrName;
    if (!clip) return false;

    if (this.action) {
      this.action.stop();
      this.mixer.uncacheAction(this.action.getClip(), this.model);
    }
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.enabled = true;
    action.setLoop(this.options.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !this.options.loop;
    this.action = action;
    this.currentClip = clip;
    this.playing = this.options.autoplay;
    if (this.playing) action.play();
    this._syncPlayButton();
    this._emit('clipchange', { clip: clip.name });
    return true;
  }

  play() {
    if (!this.action) return false;
    if (this.action.paused) {
      this.action.paused = false;
      this.action.play();
    } else if (!this.action.isRunning()) {
      this.action.reset();
      this.action.play();
    }
    this.playing = true;
    this._syncPlayButton();
    this._emit('play', { clip: this.currentClip ? this.currentClip.name : null });
    return true;
  }

  pause() {
    if (!this.action) return false;
    this.playing = false;
    this.action.paused = true;
    this._syncPlayButton();
    this._emit('pause', { clip: this.currentClip ? this.currentClip.name : null });
    return true;
  }

  togglePlay() {
    return this.playing ? this.pause() : this.play();
  }

  seek(seconds) {
    if (!this.action || !this.currentClip) return false;
    const duration = this.currentClip.duration || 0;
    const time = Math.min(Math.max(Number(seconds) || 0, 0), duration);
    this.action.time = time;
    this.action.paused = !this.playing;
    this.mixer.update(0);
    return true;
  }

  resetView() {
    if (!this._homePosition || !this._homeTarget) return;
    this.camera.position.copy(this._homePosition);
    this.controls.target.copy(this._homeTarget);
    this.camera.lookAt(this._homeTarget);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this._userMoved = false;
    this._emit('viewreset', {});
  }

  _syncPlayButton() {
    if (!this._els.play) return;
    this._els.play.textContent = this.playing ? '⏸' : '▶';
    this._els.play.setAttribute('aria-label', this.playing ? 'Pause animation' : 'Play animation');
  }

  _handleFinished() {
    this.playing = false;
    this._syncPlayButton();
    this._emit('ended', { clip: this.currentClip ? this.currentClip.name : null });
  }

  _handleMessage(event) {
    const data = event && event.data;
    if (!data || data.type !== 'studio-embed') return;
    if (event.source && event.source !== window.parent && event.source !== window) return;
    const action = String(data.action || '').toLowerCase();
    let handled = true;
    if (action === 'play') this.play();
    else if (action === 'pause') this.pause();
    else if (action === 'toggle') this.togglePlay();
    else if (action === 'seek') this.seek(data.time);
    else if (action === 'setclip') this.setClip(String(data.clip || ''));
    else if (action === 'reset') this.resetView();
    else if (action === 'state') { /* reply below */ }
    else handled = false;
    if (handled) this._emit('state', this.getState());
  }

  getState() {
    return {
      ready: this.ready,
      playing: this.playing,
      clip: this.currentClip ? this.currentClip.name : null,
      clips: this.clips.map((clip) => clip.name),
      duration: this.currentClip ? this.currentClip.duration : 0,
      time: this.action ? this.action.time : 0,
      quality: {
        pixelRatio: this.renderer ? this.renderer.getPixelRatio() : 1,
        triangles: this._countTriangles()
      }
    };
  }

  _countTriangles() {
    let triangles = 0;
    (this.modelGroup || this.scene)?.traverse((node) => {
      if (node.isMesh && node.geometry) {
        const index = node.geometry.index;
        const position = node.geometry.attributes.position;
        triangles += index ? index.count / 3 : (position ? position.count / 3 : 0);
      }
    });
    return Math.round(triangles);
  }

  _emit(eventName, detail = {}) {
    const message = { type: 'studio-embed', event: eventName, ...detail };
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
    } catch (_) { /* cross-origin parent may be unreachable */ }
    window.dispatchEvent(new CustomEvent(`studio-embed:${eventName}`, { detail: message }));
  }

  async exportUSDZ() {
    if (!this.model) throw new Error('Model is not loaded yet');
    const exporter = new USDZExporter();
    const res = await exporter.parseAsync(this.model);
    const bytes = res?.bytes instanceof Uint8Array ? res.bytes : (res instanceof Uint8Array ? res : null);
    if (!bytes || !bytes.byteLength) {
      throw new Error('Failed to generate USDZ archive');
    }
    return bytes;
  }

  async viewInAR() {
    const label = (modelLabel(this.src) || this.model?.name || 'model').replace(/[^a-z0-9._-]+/gi, '_');
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isAndroid = /Android/i.test(ua);
    const isHttpsHosted = Boolean(this.src && /^https:/i.test(this.src));
    if (isAndroid && isHttpsHosted) {
      const sv = `https://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(this.src)}&mode=ar_preferred&title=${encodeURIComponent(label)}`;
      window.open(sv, '_blank', 'noopener');
      return { mode: 'scene-viewer', url: sv };
    }
    const bytes = await this.exportUSDZ();
    const blob = new Blob([bytes], { type: 'model/vnd.usdz+zip' });
    const url = URL.createObjectURL(blob);
    this._arUrls.push(url);
    const link = document.createElement('a');
    link.href = url;
    link.rel = 'ar';
    link.download = `${label}.usdz`;
    const img = document.createElement('img');
    link.appendChild(img);
    document.body.appendChild(link);
    link.click();
    link.remove();
    return { mode: 'usdz', url, bytes };
  }

  showError(title, detail) {
    if (this._els.loading) this._els.loading.hidden = true;
    if (this._els.error) this._els.error.hidden = false;
    if (this._els.errorDetail) {
      this._els.errorDetail.textContent = detail || title || 'Unknown error';
      if (title) this._els.errorDetail.dataset.title = title;
    }
    this.host.dataset.state = 'error';
    console.error('[Embed]', title, detail);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('message', this._onMessage);
    window.removeEventListener('resize', this._resizeHandler);
    this._resizeObserver?.disconnect();
    if (Array.isArray(this._arUrls)) {
      for (const u of this._arUrls) {
        try { URL.revokeObjectURL(u); } catch (_) {}
      }
      this._arUrls = [];
    }
    if (this.renderer) {
      this.renderer.domElement?.removeEventListener('webglcontextlost', this._onContextLost, false);
      this.renderer.domElement?.removeEventListener('webglcontextrestored', this._onContextRestored, false);
      this.renderer.setAnimationLoop(null);
    }
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this._onFinished);
      this.mixer.stopAllAction();
      if (this.model) this.mixer.uncacheRoot(this.model);
      this.mixer = null;
    }
    this.controls?.dispose();
    this._draco?.dispose();
    this.scene?.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        const list = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of list) {
          for (const value of Object.values(material)) {
            if (value && value.isTexture) value.dispose();
          }
          material.dispose?.();
        }
      }
    });
    this._envTarget?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.host.dataset.state = 'disposed';
  }
}

/**
 * Boots the viewer from the current location.
 * @param {HTMLElement} host
 * @returns {Promise<EmbedViewer|null>}
 */
export async function bootEmbed(host) {
  if (!host) return null;
  const config = parseEmbedLocation(window.location.search, window.location.hash);
  let viewer;
  try {
    viewer = new EmbedViewer(host, config);
  } catch (error) {
    host.dataset.state = 'error';
    const loading = document.getElementById('embed-loading');
    const errorBox = document.getElementById('embed-error');
    const detail = document.getElementById('embed-error-detail');
    if (loading) loading.hidden = true;
    if (errorBox) errorBox.hidden = false;
    if (detail) detail.textContent = error && error.message ? error.message : String(error);
    console.error('[Embed] Init failed:', error);
    return null;
  }
  window.studioEmbed = viewer;
  await viewer.load();
  if (viewer.ready) viewer._emit('ready', viewer.getState());
  return viewer;
}
