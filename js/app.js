/**
 * Web Blender Studio - Main Application Controller
 * Coordinates Three.js Engine, SceneManager, Outliner, Inspector,
 * Rapid 3D DSL Scripting Engine, Exporters, and AI Copilot.
 */

import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { SceneManager } from './core/scene-manager.js';
import { MatCapStudio } from './core/matcap-studio.js';
import { EnvironmentStudio } from './core/environment-studio.js';
import { ShadingPopoverUI } from './ui/shading-popover.js';
import { Outliner } from './ui/outliner.js';
import { ViewportBudgetHUD } from './ui/viewport-budget-hud.js';
import { studio } from './scripting/rapid-api.js';
import { ScriptCodeEditor } from './scripting/code-editor.js';
import * as Modifiers from './core/modifiers.js';
import { StudioBridge } from './core/studio-bridge.js';
import { MaterialStudio } from './core/material-studio.js';
import { dataBlockRegistry } from './core/data-blocks.js';
import { blobStore } from './core/blob-store.js';
import { CameraManager } from './core/camera-manager.js';
import { CloudClient } from './cloud/cloud-client.js';
import { hasModalOverlay, isTextEntryTarget } from './core/interaction-guard.js';
import { modalTransformManager } from './core/modal-transform.js';
import { resolveEditableMesh, syncViewportModeOptions, switchViewportMode } from './core/mode-resolver.js';
import { bindLightHelpers } from './core/light-helper.js';
import { getSharedVoiceCoordinator } from './ai/voice-wake-router.js';
import { telemetry } from './core/telemetry.js';
import { resolveTemplateFromSearch } from './animation/motion-templates.js';
import {
  saveDraft,
  loadDraft,
  clearDraft,
  startAutosave,
  beginAutosaveSession,
  listCheckpoints,
  loadCheckpoint,
} from './core/autosave.js';

class BlenderApp {
  constructor() {
    this.engine = null;
    this.sceneManager = null;
    this.editMode = null;
    this.sculptMode = null;
    this.cameraManager = null;
    this.matcapStudio = null;
    this.environmentStudio = null;
    this.shadingPopover = null;
    this.outliner = null;
    this.inspector = null;
    this.codeEditor = null;
    this.exporter = null;
    this.aiCopilot = null;
    this.timelineEngine = null;
    this.timelineUI = null;
    this.materialStudio = null;
    this.rigSystem = null;
    this.materialShelf = null;
    this.poseShelf = null;
    this.modalTransform = modalTransformManager;
    this.graphEditor = null;
    this.uvEditor = null;
    this.mocapUI = null;
    this.cloud = null;
    this.cloudPanel = null;

    this.currentTransformMode = 'translate';
    this.currentShadingMode = 'solid';
    this.currentWorkspace = 'layout';
    this.isPlaying = false;
    this.currentFrame = 0;
    this._advancedLoaded = false;
    this._advancedPromise = null;

    this.init();
  }

  _installStaleBundleBanner() {
    if (typeof window === 'undefined' || this._staleBundleBound) return;
    this._staleBundleBound = true;
    window.addEventListener('studio:staleBundle', () => {
      if (document.getElementById('hunger-stale-bundle-banner')) return;
      const bar = document.createElement('div');
      bar.id = 'hunger-stale-bundle-banner';
      bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:#1b2130;color:#f3f6fc;border:1px solid #f97316;box-shadow:0 10px 30px rgba(0,0,0,0.55);font:12.5px Inter,system-ui,sans-serif;';
      bar.innerHTML = '<span><strong>Hunger Studio vừa cập nhật phiên bản mới.</strong> Tải lại trang để dùng AI Copilot &amp; Worker mới nhất.</span><button type="button" id="btn-stale-reload" style="padding:5px 11px;border:none;border-radius:6px;background:#f97316;color:#fff;font-weight:600;cursor:pointer;">Tải lại ngay</button>';
      document.body.appendChild(bar);
      bar.querySelector('#btn-stale-reload')?.addEventListener('click', () => window.location.reload());
    });
  }

  async init() {
    console.log('[BlenderApp] Initializing Hunger 3D Studio...');

    const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const requestedWorkspace = (urlParams.get('workspace') || urlParams.get('mode') || '').trim().toLowerCase();
    const initialTemplate = resolveTemplateFromSearch(typeof window !== 'undefined' ? window.location.search : '');
    const startInMotionMode = requestedWorkspace === 'motion' || Boolean(initialTemplate);
    this.currentWorkspace = startInMotionMode ? 'motion' : 'layout';

    try {
      telemetry.workspace = this.currentWorkspace;
      telemetry.installGlobalHandlers();
      window.hungerTelemetry = telemetry;
      this._installStaleBundleBanner();
    } catch (_) {}

    // Expose THREE globally to window
    window.THREE = THREE;
    window.Modifiers = Modifiers;

    try {
      // 1. Initialize 3D Engine
      const viewportContainer = document.getElementById('viewport-canvas-host');
      this.engine = new Engine({
        container: viewportContainer,
        clearColor: 0x282828,
        fov: 50
      });
      window.engine = this.engine;
      window.studioEngine = this.engine;
      window.scene = this.engine.scene;
      window.camera = this.engine.camera;
      window.renderer = this.engine.renderer;
      window.lodManager = this.engine.lodManager;
      window.viewportGovernor = this.engine.viewportGovernor;
      window.instancingSystem = this.engine.instancingSystem;
    } catch (e) {
      console.error('[BlenderApp] Engine init error:', e);
    }

    try {
      // 2. Initialize Scene Manager & Camera Manager
      if (this.engine) {
        this.sceneManager = new SceneManager(this.engine.scene);
        this.engine.attachSceneManager(this.sceneManager);
        window.sceneManager = this.sceneManager;

        this.cameraManager = new CameraManager(this.engine, { sceneManager: this.sceneManager });
        window.cameraManager = this.cameraManager;

        bindLightHelpers(this.sceneManager);
      }
    } catch (e) {
      console.error('[BlenderApp] SceneManager init error:', e);
    }

    try {
      // 3. Initialize Rapid 3D Modeling DSL
      studio.init({
        scene: this.engine ? this.engine.scene : null,
        camera: this.engine ? this.engine.camera : null,
        renderer: this.engine ? this.engine.renderer : null,
        THREE: THREE,
        sceneManager: this.sceneManager,
        logger: (msg, type) => {
          if (this.codeEditor) this.codeEditor.log(type || 'info', msg);
        }
      });
      window.studio = studio;
      window.bpy = studio.bpy;
    } catch (e) {
      console.error('[BlenderApp] Studio DSL init error:', e);
    }

    try {
      // 4. Initialize Outliner (Inspector loads in parallel split chunk below)
      if (this.sceneManager) {
        this.outliner = new Outliner('#outliner-container', this.sceneManager);
        window.outliner = this.outliner;
      }
    } catch (e) {
      console.error('[BlenderApp] Outliner init error:', e);
    }

    try {
      // 5. Initialize Scripting Code Editor
      this.codeEditor = new ScriptCodeEditor('#dock-scripting', {
        studio: studio,
        defaultPresetIndex: 0
      });
      window.codeEditor = this.codeEditor;
    } catch (e) {
      console.error('[BlenderApp] CodeEditor init error:', e);
    }

    try {
      // 6b. Cloud API client (CloudPanel UI chunk loads below)
      this.cloud = new CloudClient();
      window.cloudClient = this.cloud;
    } catch (e) {
      console.error('[BlenderApp] Cloud init error:', e);
    }

    try {
      // 8. Initialize MatCap Studio & Environment Studio
      if (this.engine) {
        this.matcapStudio = new MatCapStudio({
          scene: this.engine.scene,
          sceneManager: this.sceneManager
        });
        window.matcapStudio = this.matcapStudio;
        this.engine.matcapStudio = this.matcapStudio;

        this.environmentStudio = new EnvironmentStudio({
          scene: this.engine.scene,
          camera: this.engine.camera,
          lights: this.engine.lights,
          renderer: this.engine.renderer
        });
        window.environmentStudio = this.environmentStudio;
        this.engine.environmentStudio = this.environmentStudio;
        // Never let the cyclorama wall block the viewport when orbiting behind/aside it.
        if (typeof this.engine.addRenderCallback === 'function') {
          this.engine.addRenderCallback(
            () => this.environmentStudio.updateBackdropVisibility(this.engine.camera),
            { passive: true }
          );
        }

        this.shadingPopover = new ShadingPopoverUI({
          matcapStudio: this.matcapStudio,
          environmentStudio: this.environmentStudio,
          app: this
        });
        window.shadingPopover = this.shadingPopover;
      }
    } catch (e) {
      console.error('[BlenderApp] MatCap/Environment Studio init error:', e);
    }

    try {
      // 11. Initialize PBR Material Studio
      if (this.engine) {
        this.materialStudio = new MaterialStudio({ scene: this.engine.scene, THREE });
        window.materialStudio = this.materialStudio;
      }
    } catch (e) {
      console.error('[BlenderApp] MaterialStudio init error:', e);
    }

    try {
      window.voiceCoordinator = getSharedVoiceCoordinator();
    } catch (_) {}

    // 11b. 2-Phase Lazy Boot:
    // - In Motion workspace (`?workspace=motion` or `?template=...`), load ONLY the lean Motion core
    //   (Timeline, Exporter, RigSystem, MocapUI) so initial interactive load stays fast on 4G and
    //   heavy DCC/CAD/Sculpt/UV/Shader/STEM/AI chunks stay unloaded until the user clicks "Advanced".
    // - In full Studio mode, load critical interactive core first, mark interactive, then hydrate
    //   secondary panels asynchronously.
    try {
      if (startInMotionMode) {
        const [
          { TimelineEngine },
          { TimelineUI },
          { StudioExporter },
          { RigSystem },
          { MocapUI },
        ] = await Promise.all([
          import('./animation/timeline-engine.js'),
          import('./animation/timeline-ui.js'),
          import('./exporters/export-import.js'),
          import('./animation/rig-system.js'),
          import('./ui/mocap-ui.js'),
        ]);

        this.timelineEngine = new TimelineEngine({
          fps: 30,
          startFrame: 0,
          endFrame: 250,
          defaultInterpolation: 'smooth'
        });
        if (this.engine && this.sceneManager) {
          this.timelineEngine.bindEngine(this.engine, this.sceneManager);
        }
        window.timelineEngine = this.timelineEngine;

        const timelineContainer = document.getElementById('dock-timeline');
        if (timelineContainer) {
          this.timelineUI = new TimelineUI(timelineContainer, this.timelineEngine, this.sceneManager);
          window.timelineUI = this.timelineUI;
        }
        if (this.engine) {
          this.exporter = new StudioExporter(this.engine);
          if (this.sceneManager) this.exporter.bindSceneManager(this.sceneManager);
          window.exporter = this.exporter;
          this.exporter.setupUniversalDragAndDrop(document.getElementById('viewport-canvas-host'));
          this.shareDialog = null;

          this.rigSystem = new RigSystem({
            scene: this.engine.scene,
            engine: this.engine,
            sceneManager: this.sceneManager,
            THREE,
          });
          window.rigSystem = this.rigSystem;
        }
        this.mocapUI = new MocapUI(this);
        window.mocapUI = this.mocapUI;

        this._bindMenus();
        this._bindToolbar();
        this._bindViewportControls();
        this._bindBottomDock();
        this._bindWorkspaceTabs();
        this._bindResizers();
        this._bindShortcuts();
        this._bindSceneStats();

        try { this._createDefaultScene(); } catch (e) { console.error('[BlenderApp] Default scene error:', e); }
        try { this._startAutosave(); } catch (e) { console.warn('[BlenderApp] Autosave init error:', e); }

        await this.setWorkspace('motion');
        window.__STUDIO_INTERACTIVE_MS__ = telemetry.markInteractive({
          workspace: 'motion',
          template: initialTemplate?.id || null,
          deferredPanels: true,
        });

        this._handleCloudDeepLink().catch((err) => {
          console.warn('[BlenderApp] Cloud deep-link error:', err);
        });

        if (initialTemplate && this.mocapUI) {
          this.mocapUI.applyTemplate(initialTemplate.id).catch((err) => {
            telemetry.captureException(err, { subsystem: 'motion-template' });
          });
        }

        try {
          this.bridge = new StudioBridge();
          window.studioBridge = this.bridge;
        } catch (e) {
          console.warn('[BlenderApp] StudioBridge init error:', e);
        }
        console.log('[BlenderApp] Hunger Motion ready!');
        return;
      }

      // Full Studio Mode — Stage 1: Critical Interactive Core
      const [
        { Inspector },
        { EditMode },
        { TimelineEngine },
        { TimelineUI },
        { SimulationManager },
        { StudioExporter },
        { RigSystem },
        { MaterialShelf },
      ] = await Promise.all([
        import('./ui/inspector.js'),
        import('./core/edit-mode.js'),
        import('./animation/timeline-engine.js'),
        import('./animation/timeline-ui.js'),
        import('./simulation/simulation-manager.js'),
        import('./exporters/export-import.js'),
        import('./animation/rig-system.js'),
        import('./ui/material-shelf.js'),
      ]);

      try {
        if (this.sceneManager) {
          this.inspector = new Inspector('#inspector-container', this.sceneManager);
          window.inspector = this.inspector;
        }
        if (this.engine && this.sceneManager) {
          this.editMode = new EditMode(this.engine, { sceneManager: this.sceneManager });
          this.engine.setEditMode(this.editMode);
          window.editMode = this.editMode;
        }
        this.timelineEngine = new TimelineEngine({
          fps: 30,
          startFrame: 0,
          endFrame: 250,
          defaultInterpolation: 'smooth'
        });
        if (this.engine && this.sceneManager) {
          this.timelineEngine.bindEngine(this.engine, this.sceneManager);
        }
        window.timelineEngine = this.timelineEngine;

        const timelineContainer = document.getElementById('dock-timeline');
        if (timelineContainer) {
          this.timelineUI = new TimelineUI(timelineContainer, this.timelineEngine, this.sceneManager);
          window.timelineUI = this.timelineUI;
        }
        if (this.sceneManager) {
          this.simulationManager = new SimulationManager({
            sceneManager: this.sceneManager,
            engine: this.engine,
            timelineEngine: this.timelineEngine
          });
          this.simulationManager.groundEnabled = true;
          window.simulationManager = this.simulationManager;
        }
        if (this.engine) {
          this.exporter = new StudioExporter(this.engine);
          if (this.sceneManager) this.exporter.bindSceneManager(this.sceneManager);
          window.exporter = this.exporter;
          this.exporter.setupUniversalDragAndDrop(document.getElementById('viewport-canvas-host'));
          this.shareDialog = null;

          this.rigSystem = new RigSystem({
            scene: this.engine.scene,
            engine: this.engine,
            sceneManager: this.sceneManager,
            THREE,
          });
          window.rigSystem = this.rigSystem;

          const matContainer = document.getElementById('dock-materials');
          if (matContainer) {
            this.materialShelf = new MaterialShelf(matContainer, {
              materialStudio: this.materialStudio,
              sceneManager: this.sceneManager
            });
            window.materialShelf = this.materialShelf;
          }
        }
        if (this.engine && this.modalTransform) {
          this.modalTransform.bind(this.engine, this.sceneManager, this.editMode);
          window.modalTransformManager = this.modalTransform;
        }
      } catch (e) { console.error('[BlenderApp] Deferred core modules init error:', e); }

      // Bind core UI Elements & Events + Starter Scene + Autosave
      this._bindMenus();
      this._bindToolbar();
      this._bindViewportControls();
      this._bindBottomDock();
      this._bindWorkspaceTabs();
      this._bindResizers();
      this._bindShortcuts();
      this._bindSceneStats();

      try {
        this._createDefaultScene();
        syncViewportModeOptions(
          this.sceneManager?.getActiveObject?.(),
          this.sceneManager,
          this.rigSystem
        );
      } catch (e) { console.error('[BlenderApp] Default scene error:', e); }

      try {
        this._startAutosave();
      } catch (e) { console.warn('[BlenderApp] Autosave init error:', e); }

      // Mark interactive as soon as the core viewport & scene controls are live
      window.__STUDIO_INTERACTIVE_MS__ = telemetry.markInteractive({
        workspace: requestedWorkspace || 'layout',
        deferredPanels: true,
      });

      // Stage 2: Hydrate Advanced DCC / UV / Pro Keymap / AI / STEM / Mocap panels in canonical listener order
      await this._ensureAdvancedSubsystems();
    } catch (e) {
      console.error('[BlenderApp] Secondary chunk loading error:', e);
      telemetry.captureException(e, { subsystem: 'app.init', fatal: false });
    }

    // Check URL parameters for direct workspace or tab activation
    try {
      const targetTab = urlParams.get('tab');
      if (targetTab === 'hunyuan3d' || targetTab === 'hunyuan') {
        setTimeout(() => {
          document.querySelector('.dock-tab[data-pane="dock-hunyuan3d"]')?.click();
        }, 150);
      } else if (requestedWorkspace && ['viewport', 'modeling', 'scripting', 'ai'].includes(requestedWorkspace)) {
        await this.setWorkspace(requestedWorkspace);
      }
    } catch (_) {}

    try {
      // Initialize CLI & MCP Bridge last so ws.readyState === 1 implies full Studio readiness
      this.bridge = new StudioBridge();
      window.studioBridge = this.bridge;
    } catch (e) {
      console.warn('[BlenderApp] StudioBridge init error:', e);
    }

    console.log('[BlenderApp] Hunger 3D Studio ready!');
  }

  /**
   * Idempotently lazy-loads Advanced 3D DCC subsystems (Inspector/Edit/Sculpt/Paint/UV/Graph/
   * Shader Nodes/Asset Browser/Physics/Cloud/AI Copilot/STEM/PathTrace/Agent) on demand.
   */
  async _ensureAdvancedSubsystems() {
    if (this._advancedLoaded) return true;
    if (this._advancedPromise) return this._advancedPromise;
    this._advancedPromise = (async () => {
      const [
        { Inspector },
        { EditMode },
        { SimulationManager },
        { SculptMode },
        { PaintModeManager },
        { MaterialShelf },
        { CloudPanel },
        { AICopilot },
        { PhysicsPanel },
        { PoseShelf },
        { GraphEditorUI },
        { UVEditorUI },
        { MocapUI },
        { Hunyuan3DUI },
        { ShaderNodeEditorUI },
        { AssetBrowserUI },
        { BlenderModelingSuite },
        { BlenderProTools },
        { WorkspaceAreaManager },
        { StemTutorUI },
        { PathTraceRenderManager },
        { createAgent },
        { installToolCalling },
      ] = await Promise.all([
        import('./ui/inspector.js'),
        import('./core/edit-mode.js'),
        import('./simulation/simulation-manager.js'),
        import('./core/sculpt-mode.js'),
        import('./core/paint-mode.js'),
        import('./ui/material-shelf.js'),
        import('./ui/cloud-panel.js'),
        import('./ai/ai-copilot.js'),
        import('./ui/physics-panel.js'),
        import('./ui/pose-shelf.js'),
        import('./ui/graph-editor.js'),
        import('./ui/uv-editor.js'),
        import('./ui/mocap-ui.js'),
        import('./ui/hunyuan3d-ui.js'),
        import('./ui/shader-node-editor.js'),
        import('./ui/asset-browser.js'),
        import('./ui/blender-modeling-suite.js'),
        import('./core/blender-pro-keymap.js'),
        import('./ui/workspace-areas.js'),
        import('./ui/stem-tutor-ui.js'),
        import('./render/pathtrace-render.js'),
        import('./agent/agent-api.js'),
        import('./ai/agent-tool-bridge.js'),
      ]);

      try {
        if (!this.inspector && this.sceneManager) {
          this.inspector = new Inspector('#inspector-container', this.sceneManager);
          window.inspector = this.inspector;
        }
        if (!this.editMode && this.engine && this.sceneManager) {
          this.editMode = new EditMode(this.engine, { sceneManager: this.sceneManager });
          this.engine.setEditMode(this.editMode);
          window.editMode = this.editMode;
        }
        if (!this.sculptMode && this.engine && this.sceneManager) {
          this.sculptMode = new SculptMode(this.engine, { sceneManager: this.sceneManager });
          window.sculptMode = this.sculptMode;
        }
        if (!this.paintMode && this.engine && this.sceneManager) {
          this.paintMode = new PaintModeManager(this.engine, {
            sceneManager: this.sceneManager,
            dataBlockRegistry,
            blobStore,
          });
          window.paintMode = this.paintMode;
        }
        if (!this.simulationManager && this.sceneManager) {
          this.simulationManager = new SimulationManager({
            sceneManager: this.sceneManager,
            engine: this.engine,
            timelineEngine: this.timelineEngine
          });
          this.simulationManager.groundEnabled = true;
          window.simulationManager = this.simulationManager;
        }
        if (!this.materialShelf && this.engine) {
          const matContainer = document.getElementById('dock-materials');
          if (matContainer) {
            this.materialShelf = new MaterialShelf(matContainer, {
              materialStudio: this.materialStudio,
              sceneManager: this.sceneManager
            });
            window.materialShelf = this.materialShelf;
          }
        }
        if (this.engine && this.modalTransform && this.editMode) {
          this.modalTransform.bind(this.engine, this.sceneManager, this.editMode);
          window.modalTransformManager = this.modalTransform;
        }
      } catch (e) { console.error('[BlenderApp] Advanced core init error:', e); }

      try {
        if (!this.cloudPanel) {
          this.cloudPanel = new CloudPanel(this);
          window.cloudPanel = this.cloudPanel;
          this._handleCloudDeepLink();
        }
      } catch (e) { console.error('[BlenderApp] CloudPanel init error:', e); }

      try {
        if (!this.aiCopilot) {
          this.aiCopilot = new AICopilot({
            studio: studio,
            sceneManager: this.sceneManager,
            container: document.body
          });
          window.aiCopilot = this.aiCopilot;
        }
      } catch (e) { console.error('[BlenderApp] AICopilot init error:', e); }

      try {
        if (!this.physicsPanel && this.sceneManager && this.simulationManager) {
          this.physicsPanel = new PhysicsPanel('#dock-physics', {
            sceneManager: this.sceneManager,
            simulationManager: this.simulationManager,
            timelineEngine: this.timelineEngine
          });
          window.physicsPanel = this.physicsPanel;
        }
      } catch (e) { console.error('[BlenderApp] PhysicsPanel init error:', e); }

      try {
        if (!this.poseShelf) {
          const poseContainer = document.getElementById('dock-pose');
          if (poseContainer && this.rigSystem) {
            this.poseShelf = new PoseShelf(poseContainer, {
              rigSystem: this.rigSystem,
              sceneManager: this.sceneManager
            });
            window.poseShelf = this.poseShelf;
          }
        }
        if (!this.graphEditor) {
          this.graphEditor = new GraphEditorUI({
            timelineEngine: this.timelineEngine,
            sceneManager: this.sceneManager
          });
          window.graphEditor = this.graphEditor;
        }
        if (!this.uvEditor) {
          this.uvEditor = new UVEditorUI({ sceneManager: this.sceneManager });
          window.uvEditor = this.uvEditor;
        }
        if (!this.mocapUI) {
          this.mocapUI = new MocapUI(this);
          window.mocapUI = this.mocapUI;
        }
        if (!this.hunyuan3dUI) {
          this.hunyuan3dUI = new Hunyuan3DUI(this);
          window.hunyuan3dUI = this.hunyuan3dUI;
        }
        if (!this.shaderEditor) {
          const sgContainer = document.getElementById('dock-shader-editor');
          if (sgContainer) {
            this.shaderEditor = new ShaderNodeEditorUI(sgContainer, {
              sceneManager: this.sceneManager,
              engine: this.engine,
            });
            window.shaderEditor = this.shaderEditor;
          }
        }
        if (!this.assetBrowser) {
          const abContainer = document.getElementById('dock-asset-browser');
          if (abContainer) {
            this.assetBrowser = new AssetBrowserUI(abContainer, {
              engine: this.engine,
              sceneManager: this.sceneManager,
              materialStudio: this.materialStudio,
              dataBlockRegistry,
              blobStore,
              studio,
            });
            window.assetBrowser = this.assetBrowser;
          }
        }
      } catch (e) { console.error('[BlenderApp] Secondary editors init error:', e); }

      try {
        if (!this.modelingSuite) {
          this.modelingSuite = new BlenderModelingSuite(this);
          window.modelingSuite = this.modelingSuite;
        }
      } catch (e) { console.error('[BlenderApp] BlenderModelingSuite init error:', e); }

      try {
        if (!this.blenderProTools) {
          this.blenderProTools = new BlenderProTools(this);
          this.blenderProTools.init();
          window.blenderProTools = this.blenderProTools;
        }
      } catch (e) { console.error('[BlenderApp] BlenderProTools init error:', e); }

      try {
        if (!this.areaManager) {
          this.areaManager = new WorkspaceAreaManager(this);
          this.areaManager.init();
          this.engine?.attachAreaManager?.(this.areaManager);
          window.areaManager = this.areaManager;
        }
      } catch (e) { console.error('[BlenderApp] WorkspaceAreaManager init error:', e); }

      try {
        if (!this.stemTutor) {
          this.stemTutor = new StemTutorUI(this);
          window.stemTutor = this.stemTutor;
        }
      } catch (e) { console.error('[BlenderApp] StemTutorUI init error:', e); }

      try {
        if (!this.pathTraceRender) {
          this.pathTraceRender = new PathTraceRenderManager(this);
          window.pathTraceRender = this.pathTraceRender;
          this.pathTraceRender.bindUI();
        }
      } catch (e) { console.error('[BlenderApp] PathTraceRender init error:', e); }

      try {
        if (!window.agent && this.engine && this.sceneManager) window.agent = await createAgent(this);
        if (window.agent && this.aiCopilot) {
          await installToolCalling(this.aiCopilot, {
            agent: window.agent,
            maxSteps: 5,
            maxCatalogChars: 12000,
            approve: ({ tool, args }) => {
              if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                const preview = Array.isArray(args) && args.length ? JSON.stringify(args).slice(0, 120) : '';
                return Boolean(window.confirm(`AI Copilot yêu cầu thực thi công cụ phá hủy "${tool}"${preview ? ` (${preview})` : ''}. Bạn có cho phép?`));
              }
              return false;
            },
            onConfirmedDestructive: async (tool, args = []) => {
              const sm = this.sceneManager;
              if (tool === 'scene.clear') {
                studio.clearScene();
                if (this.aiCopilot?.conversationContext) {
                  this.aiCopilot.conversationContext.createdObjects = [];
                  this.aiCopilot.conversationContext.lastModelType = null;
                }
                this.outliner?.render?.();
                window.dispatchEvent(new CustomEvent('blender:scene-updated'));
                return { cleared: true };
              }
              if (tool === 'scene.delete' && args[0] && sm) {
                const targetId = String(args[0]);
                let obj = [...(sm.objects?.values?.() || [])].find(
                  (o) => o?.userData?.agentId === targetId || o?.userData?.id === targetId || o?.uuid === targetId || o?.name === targetId
                );
                if (!obj && window.agent?.scene?.info) {
                  const info = await window.agent.scene.info(targetId).catch(() => null);
                  const uuid = info?.data?.uuid;
                  if (uuid) obj = [...(sm.objects?.values?.() || [])].find((o) => o?.uuid === uuid);
                }
                if (obj) {
                  sm.removeObject(obj, true, false);
                  this.outliner?.render?.();
                  window.dispatchEvent(new CustomEvent('blender:scene-updated'));
                  return { agentId: targetId, deleted: true };
                }
              }
              return null;
            },
            onEvent: (ev) => {
              if (ev?.type === 'tool' && this.aiCopilot?.isGenerating) {
                this.aiCopilot._updateThinkingStep?.(
                  `🔧 <b>Agent Tool (Bước ${ev.step})</b>: Đang gọi <code>${this.aiCopilot._escapeHTML(ev.call?.tool || '')}</code>...`,
                  Math.min(82, 25 + ev.step * 12)
                );
              }
            }
          });
        }
      } catch (e) { console.error('[BlenderApp] Agent initialization error:', e); }

      this._advancedLoaded = true;
      return true;
    })();
    return this._advancedPromise;
  }

  // =========================================================================
  // DEFAULT STARTER SCENE
  // =========================================================================
  _createDefaultScene() {
    const defaultCube = studio.addCube({
      x: 0,
      y: 1.0,
      z: 0,
      width: 2.0,
      height: 2.0,
      depth: 2.0,
      name: 'Cube'
    });

    if (defaultCube) {
      defaultCube.userData.primitiveType = 'cube';
      defaultCube.userData.primitiveParams = { sizeX: 2.0, sizeY: 2.0, sizeZ: 2.0, segX: 1, segY: 1, segZ: 1, shadeSmooth: false };
      this.sceneManager.select(defaultCube);
    }

    if (this.cameraManager) {
      this.cameraManager.createCamera({
        name: 'Camera',
        position: { x: 7, y: 4.5, z: 8 },
        target: { x: 0, y: 1, z: 0 }
      });
      // Select the cube again so the default object stays active.
      if (defaultCube) this.sceneManager.select(defaultCube);
    }
  }

  /** Non-blocking studio toast notification + console log fallback. */
  notify(message, type = 'info') {
    if (this.exporter?.showToast) {
      this.exporter.showToast(message, type);
    }
    if (this.codeEditor?.log) {
      const logKind = type === 'warning' ? 'warn' : type;
      this.codeEditor.log(logKind, message);
    }
  }

  /** Non-blocking accessible info modal replacing synchronous window.alert(). */
  _showInfoDialog(title, bodyText) {
    if (typeof document === 'undefined') return;
    let backdrop = document.getElementById('wbs-info-dialog-backdrop');
    if (backdrop) backdrop.remove();
    backdrop = document.createElement('div');
    backdrop.id = 'wbs-info-dialog-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:100080;background:rgba(0,0,0,0.62);display:grid;place-items:center;padding:16px;';
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.style.cssText = 'background:#1e2228;border:1px solid #3c424c;border-radius:8px;padding:18px 20px;width:460px;max-width:92vw;max-height:82vh;overflow:auto;color:#e6e9ef;font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,0.55);';
    const heading = document.createElement('div');
    heading.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:10px;color:#fff;';
    heading.textContent = title;
    const pre = document.createElement('div');
    pre.style.cssText = 'white-space:pre-wrap;color:#c9d1d9;margin-bottom:14px;';
    pre.textContent = bodyText;
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'padding:5px 14px;border-radius:4px;border:1px solid #4c5564;background:#2c323b;color:#fff;cursor:pointer;';
    const close = () => backdrop.remove();
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
    });
    footer.appendChild(closeBtn);
    card.append(heading, pre, footer);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    closeBtn.focus();
  }

  // =========================================================================
  // TOP MENU BAR
  // =========================================================================
  async _handleCloudDeepLink() {
    if (!this.cloud || this._cloudDeepLinkHandled) return;
    const params = new URLSearchParams(window.location.search);
    const paid = params.get('cloud') === 'paid';
    const paymentCode = params.get('code') || '';
    const oauthError = params.get('error_description') || params.get('error') || '';
    const hash = window.location.hash || '';
    const hasHashAuth = /access_token=|error_description=/.test(hash);
    if (!paid && !oauthError && !hasHashAuth) return;

    this._cloudDeepLinkHandled = true;
    const panel = await this._ensureCloudPanel();
    let notice = '';
    let noticeTone = '';
    let recoveryMode = false;

    if (oauthError && !/access_token=/.test(hash)) {
      notice = `Cloud sign-in failed: ${String(oauthError).replace(/\+/g, ' ')}`;
      noticeTone = 'err';
      const url = new URL(window.location.href);
      url.searchParams.delete('error');
      url.searchParams.delete('error_code');
      url.searchParams.delete('error_description');
      try {
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch (_) {}
      panel?.open('account');
    }

    if (hasHashAuth) {
      try {
        await this.cloud.status();
        const session = await this.cloud.handleAuthHash(hash);
        if (session) {
          await this.cloud.syncCookieSession?.();
          recoveryMode = session.authType === 'recovery';
          telemetry.track('auth_signed_in', { method: session.authType || 'redirect' });
          notice = recoveryMode
            ? 'Recovery link verified. Set your new password below.'
            : `Signed in to Cloud: ${session.user?.email || session.user?.id || ''}`.trim();
          noticeTone = 'ok';
        }
      } catch (error) {
        notice = `Cloud sign-in failed: ${error.message || error}`;
        noticeTone = 'err';
      }
      panel?.open('account', { recoveryMode });
    }

    if (paid) {
      const url = new URL(window.location.href);
      url.searchParams.delete('cloud');
      url.searchParams.delete('code');
      try {
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch (_) {}
      telemetry.track('payment_return_redirect', { hasCode: Boolean(paymentCode) });
      panel?.open('credits', { paymentCode });
    }

    if (notice) panel?.notice(notice, noticeTone);
  }

  async _ensureCloudPanel() {
    if (this.cloudPanel) return this.cloudPanel;
    if (!this._cloudPanelPromise) {
      this._cloudPanelPromise = import('./ui/cloud-panel.js')
        .then(({ CloudPanel }) => {
          if (!this.cloudPanel) {
            this.cloudPanel = new CloudPanel(this);
            window.cloudPanel = this.cloudPanel;
          }
          return this.cloudPanel;
        })
        .catch((err) => {
          this._cloudPanelPromise = null;
          throw err;
        });
    }
    return this._cloudPanelPromise;
  }

  async _ensureFeedbackDialog() {
    if (this.feedbackDialog) return this.feedbackDialog;
    if (!this._feedbackDialogPromise) {
      this._feedbackDialogPromise = import('./ui/feedback-dialog.js')
        .then(({ FeedbackDialog }) => {
          if (!this.feedbackDialog) {
            this.feedbackDialog = new FeedbackDialog(this);
            window.feedbackDialog = this.feedbackDialog;
          }
          return this.feedbackDialog;
        })
        .catch((err) => {
          this._feedbackDialogPromise = null;
          throw err;
        });
    }
    return this._feedbackDialogPromise;
  }

  async _ensureShareDialog() {
    if (!this.shareDialog) {
      const { ShareDialog } = await import('./ui/share-dialog.js');
      this.shareDialog = new ShareDialog(this);
      window.shareDialog = this.shareDialog;
    }
    return this.shareDialog;
  }

  async _ensureVideoRenderManager() {
    if (!this.videoRenderManager) {
      const { VideoRenderManager } = await import('./ui/video-render-dialog.js');
      this.videoRenderManager = new VideoRenderManager(this);
      window.videoRenderManager = this.videoRenderManager;
    }
    return this.videoRenderManager;
  }

  async openRenderAnimationDialog(overrides = null) {
    const mgr = await this._ensureVideoRenderManager();
    return mgr.openDialog(overrides);
  }

  _bindMenus() {
    // Menu Dropdown toggle
    document.querySelectorAll('.menu-item').forEach(item => {
      const btn = item.querySelector('.menu-btn');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = item.classList.contains('open');
        document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
        if (!isOpen) item.classList.add('open');
      });
    });

    document.addEventListener('click', (e) => {
      // Clicking a submenu parent (Import/Export) must keep the menu open so
      // the flyout stays reachable; leaf items still close it via this handler.
      if (e.target.closest('.dropdown-submenu > .dropdown-item')) return;
      document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
    });

    // Toolbar/header/panel clicks must not swallow viewport shortcuts: keyboard focus
    // returns to the viewport canvas, as in Blender. Capture + microtask handles
    // sidebar/outliner buttons that call stopPropagation() in their click handlers.
    const returnFocusToCanvas = (clickedCtrl = null) => {
      if (hasModalOverlay() || isTextEntryTarget(document.activeElement)) return;
      if (clickedCtrl && typeof clickedCtrl.blur === 'function') {
        clickedCtrl.blur();
      }
      const activeEl = document.activeElement;
      if (activeEl && activeEl.matches?.('button, a, summary, [role="button"]')) {
        activeEl.blur();
      }
      document.querySelector('#viewport-canvas-host canvas')?.focus({ preventScroll: true });
    };

    document.addEventListener('click', (e) => {
      const zone = e.target.closest('.blender-toolbar, .viewport-header, .dock-tab');
      if (!zone || e.target.closest('input, select, textarea, [contenteditable], .cm-editor, .CodeMirror')) return;
      returnFocusToCanvas();
    });

    document.addEventListener('click', (e) => {
      if (e.detail <= 0) return;
      if (e.target.closest('input, select, textarea, [contenteditable], .cm-editor, .CodeMirror')) return;
      if (e.target.closest('.ss-backdrop, .cp-backdrop, .modal-backdrop, dialog, [role="dialog"]')) return;
      const inPanel = e.target.closest('.blender-header, .blender-sidebar, #sidebar-right, .outliner-panel, .inspector-panel, #outliner-container, #inspector-container, .dock-body, .blender-dock, #outliner-tree');
      if (!inPanel) return;
      const ctrl = e.target.closest('button, a, summary, [role="button"]');
      if (!ctrl || ctrl.matches('.top-menu-btn, [aria-haspopup="true"]')) return;
      queueMicrotask(() => returnFocusToCanvas(ctrl));
    }, { capture: true });

    // File Actions
    document.getElementById('btn-file-new')?.addEventListener('click', () => {
      if (confirm('Create a new project? Unsaved changes will be cleared.')) {
        studio.clearScene();
        this._createDefaultScene();
      }
    });

    const fileInput = document.getElementById('file-input-project');
    document.getElementById('btn-file-open')?.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.exporter.importProjectJSON(file);
      }
      fileInput.value = '';
    });

    document.getElementById('btn-file-save')?.addEventListener('click', () => {
      this.exporter.exportProjectJSON();
    });

    document.getElementById('btn-file-save-wbs')?.addEventListener('click', () => {
      this.exporter.exportProjectPackage().catch((err) => {
        console.error('[Save .wbs Error]', err);
      });
    });

    document.getElementById('btn-file-share')?.addEventListener('click', async () => {
      try {
        const dialog = await this._ensureShareDialog();
        dialog.open();
      } catch (err) {
        console.error('[ShareDialog] Không mở được hộp thoại chia sẻ:', err);
      }
    });

    document.getElementById('btn-file-cloud')?.addEventListener('click', async () => {
      try {
        const panel = await this._ensureCloudPanel();
        panel.open('account');
      } catch (err) {
        console.error('[CloudPanel] Failed to open account panel:', err);
      }
    });

    document.getElementById('btn-file-publish')?.addEventListener('click', async () => {
      try {
        const panel = await this._ensureCloudPanel();
        panel.open('community');
      } catch (err) {
        console.error('[CloudPanel] Failed to open community panel:', err);
      }
    });

    // Universal Blender Import Listeners
    const setupImportInput = (btnId, inputId, importMethod) => {
      const btn = document.getElementById(btnId);
      const input = document.getElementById(inputId);
      if (!btn || !input) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        input.click();
      });
      input.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
          try {
            if (files.length > 1 || files[0].name.toLowerCase().endsWith('.zip')) {
              await this.exporter.importBundle(files);
            } else {
              await importMethod(files[0]);
            }
          } catch (err) {
            console.error('[Import Error]', err);
          }
        }
        input.value = '';
      });
    };

    setupImportInput('btn-import-bundle', 'file-input-bundle', (file) => this.exporter.importBundle(file));
    setupImportInput('btn-import-gltf', 'file-input-gltf', (file) => this.exporter.importGLTF(file));
    setupImportInput('btn-import-fbx', 'file-input-fbx', (file) => this.exporter.importFBX(file));
    setupImportInput('btn-import-obj', 'file-input-obj', (file) => this.exporter.importOBJ(file));
    setupImportInput('btn-import-3ds', 'file-input-3ds', (file) => this.exporter.import3DS(file));
    setupImportInput('btn-import-usd', 'file-input-usd', (file) => this.exporter.importUSD(file));
    setupImportInput('btn-import-vox', 'file-input-vox', (file) => this.exporter.importVOX(file));
    setupImportInput('btn-import-cad', 'file-input-cad', (file) => this.exporter.importUniversal(file));
    setupImportInput('btn-import-stl', 'file-input-stl', (file) => this.exporter.importSTL(file));
    setupImportInput('btn-import-ply', 'file-input-ply', (file) => this.exporter.importPLY(file));
    setupImportInput('btn-import-dae', 'file-input-dae', (file) => this.exporter.importDAE(file));
    setupImportInput('btn-import-blend', 'file-input-blend', (file) => this.exporter.importBlend(file));

    // Universal Blender Export Listeners
    document.getElementById('btn-export-glb')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportGLTF(null, { binary: true });
    });

    document.getElementById('btn-export-glb-options')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!this.exportOptionsDialog) {
        const { ExportOptionsDialog } = await import('./ui/export-dialog.js');
        this.exportOptionsDialog = new ExportOptionsDialog(this);
      }
      this.exportOptionsDialog.open();
    });

    document.getElementById('btn-export-gltf')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportGLTF(null, { binary: false });
    });

    document.getElementById('btn-export-fbx')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportFBX();
    });

    document.getElementById('btn-export-usdz')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportUSDZ();
    });

    document.getElementById('btn-export-3mf')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.export3MF();
    });

    document.getElementById('btn-export-gamepack')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportGamePackGLB();
    });

    document.getElementById('btn-export-obj')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportOBJ();
    });

    document.getElementById('btn-export-stl')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportSTL();
    });

    document.getElementById('btn-export-ply')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exporter.exportPLY();
    });

    document.getElementById('btn-render-png')?.addEventListener('click', () => {
      this.exporter.captureRenderPNG({ scale: 2, camera: this.cameraManager?.getActiveCameraData() });
    });
    document.getElementById('btn-render-viewport')?.addEventListener('click', () => {
      this.exporter.captureRenderPNG({ scale: 2, camera: this.cameraManager?.getActiveCameraData() });
    });

    ['btn-render-transparent', 'btn-render-transparent-menu'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => {
        this.exporter.captureRenderPNG({ scale: 2, transparent: true, camera: this.cameraManager?.getActiveCameraData() });
      });
    });

    ['btn-render-animation', 'btn-file-render-animation'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => {
        this.openRenderAnimationDialog();
      });
    });

    // Edit Actions
    document.getElementById('btn-edit-undo')?.addEventListener('click', () => this.sceneManager.undo());
    document.getElementById('btn-edit-redo')?.addEventListener('click', () => this.sceneManager.redo());
    document.getElementById('btn-edit-duplicate')?.addEventListener('click', () => {
      if (this.engine?.duplicateSelection()) this.engine.setTransformMode('translate');
    });
    document.getElementById('btn-edit-duplicate-linked')?.addEventListener('click', () => {
      this.blenderProTools?.duplicateLinkedSelection?.();
    });
    document.getElementById('btn-edit-batch-gpu')?.addEventListener('click', () => {
      this.blenderProTools?.batchSelectionToGpuInstances?.();
    });
    document.getElementById('btn-edit-delete')?.addEventListener('click', () => {
      this.engine?.deleteSelection();
    });
    document.getElementById('btn-edit-group')?.addEventListener('click', () => {
      const selected = this.sceneManager?.getSelectedObjects?.() || [];
      if (selected.length > 1) this.sceneManager.groupObjects(selected);
    });
    document.getElementById('btn-edit-ungroup')?.addEventListener('click', () => {
      const active = this.sceneManager?.getActiveObject?.();
      if (active && active.isGroup) this.sceneManager.ungroup(active);
    });

    // Help Actions (Add menu + Left toolbar items are owned canonically by index.html + BlenderModelingSuite)
    document.getElementById('btn-help-shortcuts')?.addEventListener('click', () => {
      this._showInfoDialog(
        'Hunger Shortcuts',
        "• G: Grab / Translate\n" +
        "• R: Rotate\n" +
        "• S: Scale\n" +
        "• X / Delete: Delete selected object(s)\n" +
        "• Shift + D: Duplicate selected object(s)\n" +
        "• Numpad .: Frame Selection (Edit Mode: vertex/edge/face); F: Focus object\n" +
        "• Ctrl + Z: Undo\n" +
        "• Ctrl + Y: Redo\n" +
        "• Space: Play/Pause Timeline & Animation\n" +
        "• Ctrl + Enter: Run Script in Code Editor\n" +
        "• Shift + F12: Render viewport to PNG (F12 is reserved for DevTools)\n" +
        "• Ctrl + F12: Render Animation (Video MP4 / WebM / PNG ZIP · EEVEE & Rust Cycles)\n" +
        "• Numpad 1/3/7: Front / Right / Top (Ctrl: Back / Left / Bottom)\n" +
        "• Numpad 4/6/8/2: Orbit Left / Right / Up / Down\n" +
        "• Numpad 5: Perspective / Orthographic (or View menu)\n" +
        "• Numpad +/-: Zoom in/out\n" +
        "• 0 / Numpad 0: Toggle camera view\n" +
        "• Ctrl + G: Group selection (requires ≥ 2 objects)"
      );
    });

    document.getElementById('btn-help-ai')?.addEventListener('click', () => {
      if (this.aiCopilot) this.aiCopilot.show();
    });

    document.getElementById('btn-help-ai-settings')?.addEventListener('click', () => {
      if (this.aiCopilot) {
        this.aiCopilot.show();
        this.aiCopilot.openSettings();
      }
    });

    const openFeedback = async () => {
      try {
        const dialog = await this._ensureFeedbackDialog();
        dialog.open();
      } catch (err) {
        console.error('[FeedbackDialog] Failed to open:', err);
      }
    };
    document.getElementById('btn-beta-feedback')?.addEventListener('click', openFeedback);
    document.getElementById('btn-help-feedback')?.addEventListener('click', openFeedback);

    document.getElementById('btn-help-about')?.addEventListener('click', () => {
      this._showInfoDialog(
        'About Hunger',
        '3D web-native studio: modeling, rigging, AI mocap, animation, simulation, path tracing & interchange.\n' +
        'Familiar 3D workflow & shortcuts built for the web.\n\n' +
        'Open Help → Keyboard Shortcuts to view the full searchable shortcut list.'
      );
    });

    // Add -> Foliage / GPU Scatter quick launcher
    document.getElementById('btn-add-foliage-scatter')?.addEventListener('click', async () => {
      document.getElementById('menu-add')?.classList.remove('open');
      const instSys = this.engine?.instancingSystem;
      if (!instSys) return;
      const active = this.sceneManager?.getActiveObject?.();
      const surface = (active?.isMesh && !active.userData?.isScatterGroup) ? active : null;
      const group = await instSys.scatterOnSurface('grass', surface, {
        count: 5000,
        windSway: true,
        sceneManager: this.sceneManager,
      });
      if (group) {
        this.outliner?.render?.();
        this.inspector?.setTargetObject?.(group);
        this.notify?.(`🌿 Scattered ${group.userData.instanceCount.toLocaleString()} GPU grass instances (1 Outliner node)`, 'info');
      }
    });
  }

  // =========================================================================
  // LEFT TOOLBAR (Canonical controls wired in BlenderModelingSuite)
  // =========================================================================
  _bindToolbar() {
    // Fallback binding only when canonical markup has not been upgraded by BlenderModelingSuite.
    if (document.querySelector('aside.blender-toolbar')?.dataset.canonicalDom === '1') return;
    document.getElementById('tool-ai-fab')?.addEventListener('click', () => {
      if (this.aiCopilot) this.aiCopilot.toggle();
    });
  }

  // =========================================================================
  // VIEWPORT CONTROLS & SHADING
  // =========================================================================
  _bindViewportControls() {
    // Mode Selector (Object Mode / Edit Mode / Sculpt Mode / Paint / Weight Paint / Edit Bone / Pose Mode)
    const modeSelect = document.getElementById('viewport-mode');
    modeSelect?.addEventListener('change', (e) => {
      switchViewportMode(e.target.value, {
        engine: this.engine,
        sceneManager: this.sceneManager,
        editMode: this.editMode,
        sculptMode: this.sculptMode,
        paintMode: this.paintMode,
        rigSystem: this.rigSystem,
        notify: (msg, type) => this.notify(msg, type)
      });
      modeSelect.blur();
    });

    // Wave 2A Paint Toolbar Controls
    document.querySelectorAll('.paint-brush-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.paint-brush-btn').forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        const raw = e.currentTarget.dataset.paintBrush;
        const brush = (this.paintMode?.mode === 'vertex-paint')
          ? ({ draw: 'mix', soften: 'blur', erase: 'subtract', smear: 'smear' }[raw] || 'mix')
          : raw;
        this.paintMode?.setBrush(brush);
      });
    });
    document.getElementById('input-paint-color')?.addEventListener('input', (e) => {
      this.paintMode?.setColor(e.target.value);
    });
    document.getElementById('select-paint-slot')?.addEventListener('change', (e) => {
      this.paintMode?.setSlot(e.target.value);
    });
    document.getElementById('slider-paint-radius')?.addEventListener('input', (e) => {
      if (!this.paintMode) return;
      this.paintMode.radius = parseFloat(e.target.value);
      const out = document.getElementById('val-paint-radius');
      if (out) out.textContent = String(this.paintMode.radius);
    });
    document.getElementById('slider-paint-strength')?.addEventListener('input', (e) => {
      if (!this.paintMode) return;
      this.paintMode.strength = parseFloat(e.target.value);
      const out = document.getElementById('val-paint-strength');
      if (out) out.textContent = String(this.paintMode.strength);
    });
    document.getElementById('btn-paint-symx')?.addEventListener('click', (e) => {
      if (!this.paintMode) return;
      this.paintMode.symmetryX = !this.paintMode.symmetryX;
      e.currentTarget.classList.toggle('active', this.paintMode.symmetryX);
    });
    document.getElementById('btn-paint-fill')?.addEventListener('click', () => {
      if (!this.paintMode) return;
      if (this.paintMode.mode === 'vertex-paint') {
        this.paintMode.fillVertexColor();
      } else if (this.paintMode.targetMesh) {
        const info = this.paintMode.ensureMaterialAndSlot(this.paintMode.targetMesh, this.paintMode.activeSlot);
        const layer = info?.stack?.getActiveLayer(this.paintMode.activeSlot);
        if (layer) {
          const snapBefore = info.stack.snapshotSlot(this.paintMode.activeSlot);
          const col = new THREE.Color(this.paintMode.colorHex);
          const rgb = { r: 1, g: 1, b: 1 };
          col.getRGB(rgb, THREE.SRGBColorSpace);
          layer.surface.fill(Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255), 255);
          info.stack.compositeSlot(this.paintMode.activeSlot);
          this.paintMode._emitTextureUpdated?.();
          this.paintMode._notifyRender?.();
          const snapAfter = info.stack.snapshotSlot(this.paintMode.activeSlot);
          import('./core/paint-commands.js').then(({ PaintLayerStateCommand }) => {
            this.paintMode._recordCommand(new PaintLayerStateCommand(info.stack, this.paintMode.activeSlot, snapBefore, snapAfter));
          }).catch(() => {});
        }
      }
    });
    document.getElementById('btn-paint-dirty-vc')?.addEventListener('click', () => {
      this.paintMode?.dirtyVertexColors();
    });

    const blurOnMouseClick = (el, fn) => {
      el?.addEventListener('click', (e) => {
        fn(e);
        if (e.detail > 0) e.currentTarget?.blur?.();
      });
    };

    // Edit Mode Selection Mode Pills (Vertex / Edge / Face)
    blurOnMouseClick(document.getElementById('btn-mode-vertex'), () => {
      this.editMode?.setMode('vertex');
    });
    blurOnMouseClick(document.getElementById('btn-mode-edge'), () => {
      this.editMode?.setMode('edge');
    });
    blurOnMouseClick(document.getElementById('btn-mode-face'), () => {
      this.editMode?.setMode('face');
    });

    // Edit Mode Modeling Action Buttons
    blurOnMouseClick(document.getElementById('btn-edit-extrude'), () => {
      this.editMode?.extrude();
    });
    blurOnMouseClick(document.getElementById('btn-edit-inset'), () => {
      this.editMode?.inset();
    });
    blurOnMouseClick(document.getElementById('btn-edit-subdivide'), () => {
      this.editMode?.subdivide();
    });
    blurOnMouseClick(document.getElementById('btn-edit-bevel'), () => {
      this.editMode?.bevel();
    });
    blurOnMouseClick(document.getElementById('btn-edit-poke'), () => {
      this.editMode?.pokeFaces();
    });
    blurOnMouseClick(document.getElementById('btn-edit-linked'), () => {
      this.editMode?.selectLinked();
    });

    // Sculpt Mode UI Controls
    document.querySelectorAll('.sculpt-brush-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const brush = e.currentTarget.dataset.brush;
        this.sculptMode?.setBrush(brush);
      });
    });

    document.getElementById('btn-sculpt-symmetry')?.addEventListener('click', () => {
      if (this.sculptMode) {
        this.sculptMode.setSymmetry(!this.sculptMode.symmetryX);
      }
    });

    const radiusSlider = document.getElementById('slider-sculpt-radius');
    const radiusVal = document.getElementById('val-sculpt-radius');
    radiusSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.sculptMode?.setRadius(val);
      if (radiusVal) radiusVal.textContent = val.toFixed(2);
    });

    const strengthSlider = document.getElementById('slider-sculpt-strength');
    const strengthVal = document.getElementById('val-sculpt-strength');
    strengthSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.sculptMode?.setStrength(val);
      if (strengthVal) strengthVal.textContent = val.toFixed(2);
    });
    document.getElementById('btn-sculpt-mask-invert')?.addEventListener('click', () => {
      this.sculptMode?.invertMask();
    });
    document.getElementById('btn-sculpt-mask-clear')?.addEventListener('click', () => {
      this.sculptMode?.clearMask();
    });
    const voxelInput = document.getElementById('input-sculpt-voxel-size');
    voxelInput?.addEventListener('change', (e) => {
      this.sculptMode?.setVoxelSize(parseFloat(e.target.value));
    });
    document.getElementById('btn-sculpt-remesh')?.addEventListener('click', () => {
      const v = voxelInput ? parseFloat(voxelInput.value) : undefined;
      this.sculptMode?.voxelRemesh(v);
    });
    document.getElementById('btn-sculpt-dyntopo')?.addEventListener('click', () => {
      if (this.sculptMode) this.sculptMode.setDyntopo(!this.sculptMode.dyntopoEnabled);
    });
    document.getElementById('input-sculpt-dyntopo-detail')?.addEventListener('change', (e) => {
      if (this.sculptMode) this.sculptMode.setDyntopo(this.sculptMode.dyntopoEnabled, parseFloat(e.target.value));
    });
    document.getElementById('btn-edit-delete-geometry')?.addEventListener('click', () => {
      this.editMode?.deleteSelection();
    });

    // Shading Modes
    const shadingPills = document.querySelectorAll('.shading-pill-btn[data-mode]');
    shadingPills.forEach(btn => {
      btn.addEventListener('click', () => {
        shadingPills.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        this.currentShadingMode = mode;
        this._applyShadingMode(mode);
      });
    });

    // Toggle Grid
    let gridVisible = true;
    document.getElementById('btn-toggle-grid')?.addEventListener('click', (e) => {
      gridVisible = !gridVisible;
      if (this.engine.gridHelper) {
        this.engine.gridHelper.visible = gridVisible;
      }
      e.currentTarget.style.color = gridVisible ? 'var(--b-text-secondary)' : 'var(--b-text-dim)';
    });

    // Focus Object
    document.getElementById('btn-focus-object')?.addEventListener('click', () => {
      this.engine.focusSelection();
    });

    // Camera View (Numpad 0)
    document.getElementById('btn-toggle-camera-view')?.addEventListener('click', (e) => {
      if (!this.cameraManager) return;
      const selected = this.sceneManager.getActiveObject();
      const active = this.cameraManager.toggleViewCamera(selected);
      e.currentTarget.classList.toggle('active', !!active);
    });

    window.addEventListener('blender:cameraViewChanged', (e) => {
      document.getElementById('btn-toggle-camera-view')?.classList.toggle('active', !!e.detail?.active);
    });

    // Update Viewport Selection Info tag and mode selector options
    this.sceneManager.on('selectionChanged', ({ active }) => {
      const tag = document.getElementById('vp-selection-info');
      if (tag) {
        if (active) {
          tag.textContent = 'Selected: ';
          const strong = document.createElement('strong');
          strong.textContent = active.name || 'Object';
          tag.appendChild(strong);
        } else {
          tag.textContent = 'No Selection';
        }
      }
      syncViewportModeOptions(active, this.sceneManager, this.rigSystem);
    });
  }

  _setMeshWireframeState(obj, enabled) {
    if (!obj?.isMesh || !obj.material || obj.userData?.isSystemObject) return;
    if (this.matcapStudio && this.matcapStudio.isMatCapActive && obj.material?.userData?.isMatCapMaterial) {
      const styleId = obj.material.userData.matcapStyleId || this.matcapStudio.currentStyle;
      obj.material = this.matcapStudio.getMaterial(styleId, {
        flatShading: !!obj.material.flatShading,
        wireframe: Boolean(enabled),
      });
      return;
    }
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m || m.userData?.isMatCapMaterial) continue;
      if (enabled) {
        if (m.userData._preShadingWire === undefined) {
          m.userData._preShadingWire = !!m.wireframe;
        }
        m.wireframe = true;
      } else if (m.userData?._preShadingWire !== undefined) {
        m.wireframe = m.userData._preShadingWire;
        delete m.userData._preShadingWire;
      } else {
        m.wireframe = false;
      }
    }
  }

  _setMeshFlatLighting(enabled) {
    const sc = this.sceneManager?.scene;
    if (!sc) return;
    sc.traverse((obj) => {
      if (!obj.isMesh || !obj.material || obj.userData?.isSystemObject || obj.userData?.isHelper) return;
      if (enabled) {
        if (obj.userData.__preFlatMaterial !== undefined) return;
        obj.userData.__preFlatMaterial = obj.material;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        const flatMats = mats.map((m) => {
          const baseColor = m?.color?.clone ? m.color.clone() : new THREE.Color(0xd0d3d8);
          return new THREE.MeshBasicMaterial({
            color: baseColor,
            map: m?.map || null,
            vertexColors: Boolean(m?.vertexColors),
            wireframe: Boolean(m?.wireframe),
            side: m?.side ?? THREE.FrontSide,
            userData: { isFlatProxyMaterial: true },
          });
        });
        obj.material = Array.isArray(obj.material) ? flatMats : flatMats[0];
      } else if (obj.userData.__preFlatMaterial !== undefined) {
        const prev = Array.isArray(obj.material) ? obj.material : [obj.material];
        obj.material = obj.userData.__preFlatMaterial;
        delete obj.userData.__preFlatMaterial;
        prev.forEach((m) => {
          if (m?.userData?.isFlatProxyMaterial) {
            try { m.dispose(); } catch (_) {}
          }
        });
      }
    });
    this.sceneManager?.requestRender?.();
  }

  _applyShadingMode(mode) {
    const lightingType = this.shadingPopover?.currentLightingType || 'studio';
    if (mode !== 'solid' || lightingType !== 'flat') {
      this._setMeshFlatLighting(false);
    }

    if (mode === 'wireframe') {
      if (this.matcapStudio?.isMatCapActive) {
        this._wireframeSuspendedMatCap = true;
        this.matcapStudio.toggleMatCapMode(false);
      }
      this.sceneManager.traverseObjects((obj) => this._setMeshWireframeState(obj, true));
    } else if (mode === 'solid') {
      this.sceneManager.traverseObjects((obj) => this._setMeshWireframeState(obj, false));
      const wantMatcap = this.shadingPopover
        ? (lightingType === 'matcap' || (this._wireframeSuspendedMatCap && lightingType !== 'flat' && lightingType !== 'studio'))
        : Boolean(this._wireframeSuspendedMatCap);
      this._wireframeSuspendedMatCap = false;
      if (this.matcapStudio) {
        this.matcapStudio.toggleMatCapMode(Boolean(wantMatcap));
      }
      if (lightingType === 'flat') {
        this._setMeshFlatLighting(true);
      }
    } else if (mode === 'material') {
      this._wireframeSuspendedMatCap = false;
      this.matcapStudio?.toggleMatCapMode(false);
      if (this.environmentStudio && !this.environmentStudio.hdriEnabled) {
        this.environmentStudio.enableHdri(true);
      }
      if (this.engine?.renderer?.shadowMap) {
        if (this._savedShadowMapForMaterial === undefined) {
          this._savedShadowMapForMaterial = this.engine.renderer.shadowMap.enabled;
        }
        this.engine.renderer.shadowMap.enabled = false;
      }
      this.sceneManager.traverseObjects((obj) => this._setMeshWireframeState(obj, false));
    } else if (mode === 'rendered') {
      this._wireframeSuspendedMatCap = false;
      this.matcapStudio?.toggleMatCapMode(false);
      if (this.environmentStudio && !this.environmentStudio.hdriEnabled) {
        this.environmentStudio.enableHdri(true);
      }
      if (this.engine?.renderer?.shadowMap) {
        this.engine.renderer.shadowMap.enabled = true;
        this.engine.renderer.shadowMap.needsUpdate = true;
        delete this._savedShadowMapForMaterial;
      }
      if (this.engine?.rasterRenderer?.preset === 'fast') {
        this.engine.rasterRenderer.setPreset('studio');
      }
      this.sceneManager.traverseObjects((obj) => this._setMeshWireframeState(obj, false));
    }

    if (mode !== 'material' && this._savedShadowMapForMaterial !== undefined && this.engine?.renderer?.shadowMap) {
      this.engine.renderer.shadowMap.enabled = this._savedShadowMapForMaterial;
      delete this._savedShadowMapForMaterial;
    }
    this.sceneManager?.requestRender?.();
  }

  // =========================================================================
  // BOTTOM DOCK & TIMELINE
  // =========================================================================
  _bindBottomDock() {
    const dockTabsEl = document.querySelector('.dock-tabs');
    if (dockTabsEl) {
      dockTabsEl.addEventListener('wheel', (e) => {
        if (dockTabsEl.scrollWidth <= dockTabsEl.clientWidth) return;
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta !== 0) {
          dockTabsEl.scrollLeft += delta;
          e.preventDefault();
        }
      }, { passive: false });
    }

    const tabs = document.querySelectorAll('.dock-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        const paneId = tab.dataset.pane;
        document.querySelectorAll('.dock-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(paneId)?.classList.add('active');

        if (paneId === 'dock-timeline' && this.timelineUI) {
          setTimeout(() => {
            this.timelineUI._drawRuler();
            this.timelineUI._updateTrackView();
            this.timelineUI._updatePlayheadPosition();
          }, 50);
        } else if (paneId === 'dock-graph-editor' && this.graphEditor) {
          const dock = document.getElementById('bottom-dock');
          const dockH = dock ? dock.getBoundingClientRect().height : 0;
          if (dock && dockH < 280) {
            dock.style.height = `${Math.round(Math.min(window.innerHeight * 0.44, 300))}px`;
            this.engine.onResize();
          }
          setTimeout(() => {
            this.graphEditor.resize();
            this.graphEditor.render();
          }, 40);
        } else if (paneId === 'dock-uv-editor' && this.uvEditor) {
          const dock = document.getElementById('bottom-dock');
          const dockH = dock ? dock.getBoundingClientRect().height : 0;
          if (dock && dockH < 320) {
            dock.style.height = `${Math.round(Math.min(window.innerHeight * 0.48, 380))}px`;
            this.engine.onResize();
          }
          setTimeout(() => {
            this.uvEditor._updateCanvasSize?.();
            this.uvEditor.render();
          }, 40);
        } else if (paneId === 'dock-shader-editor' && this.shaderEditor) {
          setTimeout(() => {
            this.shaderEditor.syncFromSelection();
          }, 30);
        } else if (paneId === 'dock-asset-browser' && this.assetBrowser) {
          if (typeof this.assetBrowser.activate === 'function') {
            this.assetBrowser.activate();
          } else {
            this.assetBrowser.render();
          }
        } else if (paneId === 'dock-physics' && this.physicsPanel) {
          this.simulationManager?.ensureInit?.().then(() => this.physicsPanel?.refresh?.()).catch(() => {});
          setTimeout(() => this.physicsPanel.refresh(), 30);
        } else if (paneId === 'dock-mocap' && this.mocapUI) {
          const dock = document.getElementById('bottom-dock');
          const dockH = dock ? dock.getBoundingClientRect().height : 0;
          if (dock && dockH < 420) {
            dock.style.height = `${Math.round(Math.min(window.innerHeight * 0.62, 560))}px`;
            this.engine.onResize();
          }
          setTimeout(() => {
            this.mocapUI.onShow();
          }, 60);
        } else if (paneId === 'dock-hunyuan3d' && this.hunyuan3dUI) {
          const dock = document.getElementById('bottom-dock');
          const dockH = dock ? dock.getBoundingClientRect().height : 0;
          if (dock && dockH < 420) {
            dock.style.height = `${Math.round(Math.min(window.innerHeight * 0.60, 540))}px`;
            this.engine.onResize();
          }
          if (typeof this.hunyuan3dUI.onShow === 'function') {
            this.hunyuan3dUI.onShow();
          } else {
            this.hunyuan3dUI.refreshStatus();
          }
        } else if (paneId === 'dock-stem' && this.stemTutor) {
          const dock = document.getElementById('bottom-dock');
          const dockH = dock ? dock.getBoundingClientRect().height : 0;
          if (dock && dockH < 360) {
            dock.style.height = '420px';
            this.engine.onResize();
          }
          this.stemTutor.onShow?.();
        }
      });
    });

    // Timeline Play / Rewind are bound once by TimelineUI (_bindHeaderSync).

    // Bottom Dock Tab Overflow Navigation (prev/next + Panels menu for smaller screens)
    const navWrap = document.getElementById('dock-tabs-nav');
    const prevBtn = document.getElementById('btn-dock-tabs-prev');
    const nextBtn = document.getElementById('btn-dock-tabs-next');
    const menuBtn = document.getElementById('btn-dock-tabs-menu');
    if (dockTabsEl && navWrap) {
      let overflowMenu = document.getElementById('dock-tabs-overflow-menu');
      if (!overflowMenu) {
        overflowMenu = document.createElement('div');
        overflowMenu.id = 'dock-tabs-overflow-menu';
        overflowMenu.className = 'dock-tabs-overflow-menu';
        overflowMenu.hidden = true;
        document.body.appendChild(overflowMenu);
      }

      const updateTabNavState = () => {
        const overflow = dockTabsEl.scrollWidth > dockTabsEl.clientWidth + 2;
        navWrap.classList.toggle('has-overflow', overflow);
        if (prevBtn) prevBtn.disabled = dockTabsEl.scrollLeft <= 1;
        if (nextBtn) nextBtn.disabled = dockTabsEl.scrollLeft + dockTabsEl.clientWidth >= dockTabsEl.scrollWidth - 2;
      };

      const closeOverflowMenu = () => {
        overflowMenu.hidden = true;
        menuBtn?.setAttribute('aria-expanded', 'false');
      };

      const renderOverflowMenu = () => {
        overflowMenu.innerHTML = '';
        tabs.forEach((tab) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'dock-overflow-item' + (tab.classList.contains('active') ? ' active' : '');
          const label = tab.querySelector('span:first-child')?.textContent?.trim() || tab.textContent.trim();
          const badge = tab.querySelector('.dock-tab-badge')?.textContent?.trim() || '';
          const titleSpan = document.createElement('span');
          titleSpan.textContent = label;
          item.appendChild(titleSpan);
          if (badge) {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'dock-tab-badge';
            badgeSpan.textContent = badge;
            item.appendChild(badgeSpan);
          }
          item.addEventListener('click', () => {
            closeOverflowMenu();
            tab.click();
          });
          overflowMenu.appendChild(item);
        });
      };

      prevBtn?.addEventListener('click', () => {
        dockTabsEl.scrollBy({ left: -240, behavior: 'smooth' });
      });
      nextBtn?.addEventListener('click', () => {
        dockTabsEl.scrollBy({ left: 240, behavior: 'smooth' });
      });
      menuBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!overflowMenu.hidden) {
          closeOverflowMenu();
          return;
        }
        renderOverflowMenu();
        overflowMenu.hidden = false;
        menuBtn.setAttribute('aria-expanded', 'true');
        const r = menuBtn.getBoundingClientRect();
        const mh = Math.min(overflowMenu.scrollHeight || 300, 360);
        const top = Math.max(8, r.top - mh - 6);
        const left = Math.max(8, Math.min(window.innerWidth - 232, r.right - 220));
        overflowMenu.style.top = `${top}px`;
        overflowMenu.style.left = `${left}px`;
      });

      document.addEventListener('click', (e) => {
        if (!overflowMenu.hidden && !overflowMenu.contains(e.target) && e.target !== menuBtn) {
          closeOverflowMenu();
        }
      });
      dockTabsEl.addEventListener('scroll', updateTabNavState, { passive: true });
      window.addEventListener('resize', () => {
        closeOverflowMenu();
        updateTabNavState();
      });
      if (window.ResizeObserver) {
        new ResizeObserver(updateTabNavState).observe(dockTabsEl);
      }
      requestAnimationFrame(updateTabNavState);
    }
  }

  // =========================================================================
  // WORKSPACE SWITCHER (Clean Motion Workspace + Advanced DCC Toggle)
  // =========================================================================
  async setWorkspace(ws) {
    const targetWs = String(ws || 'layout').toLowerCase();
    const tabs = document.querySelectorAll('.workspace-tab');
    const bottomDock = document.getElementById('bottom-dock');

    if (targetWs === 'motion') {
      document.body.classList.add('workspace-motion');
      this.currentWorkspace = 'motion';
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.workspace === 'motion'));
      if (this.blenderProTools?.isBottomDockHidden?.()) {
        this.blenderProTools.toggleBottomDock(false);
      }
      if (bottomDock) {
        bottomDock.style.height = `${Math.round(Math.min(window.innerHeight * 0.56, 480))}px`;
      }
      document.querySelector('.dock-tab[data-pane="dock-mocap"]')?.click();
      this.mocapUI?.onShow?.();
      telemetry.setWorkspace('motion');
      this.engine?.onResize?.();
      return;
    }

    // Leaving Motion mode (Advanced / Layout / Modeling / Scripting / AI / Viewport)
    const wasMotion = document.body.classList.contains('workspace-motion');
    document.body.classList.remove('workspace-motion');
    if (wasMotion || !this._advancedLoaded) {
      await this._ensureAdvancedSubsystems();
    }

    const effectiveWs = targetWs === 'advanced' ? 'layout' : targetWs;
    this.currentWorkspace = effectiveWs;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.workspace === effectiveWs));
    telemetry.setWorkspace(targetWs === 'advanced' ? 'advanced' : effectiveWs);

    if (effectiveWs === 'viewport') {
      this.blenderProTools?.toggleBottomDock(true);
      this.engine?.onResize?.();
      return;
    }

    if (this.blenderProTools?.isBottomDockHidden?.()) {
      this.blenderProTools.toggleBottomDock(false);
    }

    if (effectiveWs === 'scripting') {
      if (bottomDock) bottomDock.style.height = '450px';
      document.querySelector('.dock-tab[data-pane="dock-scripting"]')?.click();
    } else if (effectiveWs === 'modeling') {
      if (bottomDock) bottomDock.style.height = 'var(--b-dock-height)';
      const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
      let targetMesh = resolveEditableMesh(active, this.sceneManager);
      if (!targetMesh && this.sceneManager) {
        const objs = this.sceneManager.getSelectableObjects();
        for (const obj of objs) {
          const resolved = resolveEditableMesh(obj, this.sceneManager);
          if (resolved) {
            targetMesh = resolved;
            this.sceneManager.select(obj);
            break;
          }
        }
      }
      if (targetMesh && this.editMode) {
        this.editMode.enter(targetMesh);
      } else {
        console.warn('[Workspace] Modeling requires a mesh in the scene.');
      }
    } else if (effectiveWs === 'ai') {
      if (bottomDock) bottomDock.style.height = '480px';
      document.querySelector('.dock-tab[data-pane="dock-hunyuan3d"]')?.click();
      if (this.aiCopilot) this.aiCopilot.show();
    } else {
      if (bottomDock) bottomDock.style.height = 'var(--b-dock-height)';
    }
    this.engine?.onResize?.();
  }

  _bindWorkspaceTabs() {
    const tabs = document.querySelectorAll('.workspace-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const ws = tab.dataset.workspace;
        this.setWorkspace(ws);
      });
    });
  }

  // =========================================================================
  // DRAGGABLE SPLITTERS / RESIZERS
  // =========================================================================
  _bindResizers() {
    // Horizontal Resizer (Viewport <-> Bottom Dock)
    const resizerDock = document.getElementById('resizer-bottom-dock');
    const bottomDock = document.getElementById('bottom-dock');
    let isDraggingDock = false;

    resizerDock?.addEventListener('mousedown', () => {
      isDraggingDock = true;
      resizerDock.classList.add('resizing');
      document.body.style.cursor = 'row-resize';
    });

    // Vertical Resizer (Center <-> Right Sidebar)
    const resizerSidebar = document.getElementById('resizer-sidebar');
    const sidebarRight = document.getElementById('sidebar-right');
    let isDraggingSidebar = false;

    resizerSidebar?.addEventListener('mousedown', () => {
      isDraggingSidebar = true;
      resizerSidebar.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
    });

    // Horizontal Resizer (Outliner <-> Inspector inside Right Sidebar)
    const resizerInspector = document.getElementById('resizer-inspector');
    const outlinerPanel = document.getElementById('outliner-panel');
    let isDraggingInspector = false;

    resizerInspector?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDraggingInspector = true;
      resizerInspector.classList.add('resizing');
      document.body.style.cursor = 'row-resize';
    });

    window.addEventListener('mousemove', (e) => {
      if (isDraggingDock) {
        const newHeight = window.innerHeight - e.clientY;
        if (newHeight >= 32 && newHeight <= window.innerHeight * 0.75) {
          bottomDock.style.height = `${newHeight}px`;
          this.engine.onResize();
        }
      }
      if (isDraggingSidebar) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= 200 && newWidth <= 600) {
          sidebarRight.style.width = `${newWidth}px`;
          this.engine.onResize();
        }
      }
      if (isDraggingInspector && outlinerPanel && sidebarRight) {
        const sbRect = sidebarRight.getBoundingClientRect();
        const maxH = Math.max(160, sbRect.height - 160);
        const newOutlinerH = Math.max(100, Math.min(maxH, e.clientY - sbRect.top));
        outlinerPanel.style.height = `${newOutlinerH}px`;
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingDock || isDraggingSidebar || isDraggingInspector) {
        isDraggingDock = false;
        isDraggingSidebar = false;
        isDraggingInspector = false;
        resizerDock?.classList.remove('resizing');
        resizerSidebar?.classList.remove('resizing');
        resizerInspector?.classList.remove('resizing');
        document.body.style.cursor = '';
        this.engine.onResize();
      }
    });
  }

  // =========================================================================
  // GLOBAL KEYBOARD SHORTCUTS
  // =========================================================================
  _bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      // If Modal Transform (G/R/S) is active, it handles its own keyboard input
      if (this.modalTransform && this.modalTransform.isActive) {
        return;
      }

      // Dialogs own the keyboard completely (save included).
      if (hasModalOverlay()) {
        return;
      }

      // Ctrl/Cmd + S: save the project and refresh the local autosave.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (this.exporter) this.exporter.exportProjectJSON();
        if (typeof this.saveAutosaveNow === 'function') {
          this.saveAutosaveNow().catch(() => {});
        }
        return;
      }

      // Don't trigger shortcuts while typing in inputs, textareas, or editors.
      if (isTextEntryTarget()) {
        return;
      }

      const key = e.key.toLowerCase();

      // Ctrl/Cmd+F12: Render Animation Studio dialog (standard Blender shortcut)
      if (e.key === 'F12' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        this.openRenderAnimationDialog();
        return;
      }

      // Shift+F12: render the viewport. Bare F12 is reserved by Chrome/Firefox
      // for DevTools and cannot be reliably captured by a web page.
      if (e.key === 'F12' && e.shiftKey) {
        e.preventDefault();
        this.exporter?.captureRenderPNG({ scale: 2, camera: this.cameraManager?.getActiveCameraData() });
        return;
      }

      // Edit Mode shortcuts are handled by EditMode.handleKeyDown (engine listener)
      // to avoid double-dispatching the same command.

      const isBrushPaintActive = Boolean(
        this.sculptMode?.isActive ||
        this.paintMode?.isActive ||
        this.rigSystem?.isWeightPaintMode
      );

      // Blender G: Modal Grab / Move
      if (!isBrushPaintActive && key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const started = this.modalTransform ? this.modalTransform.start('translate') : false;
        if (!started) document.getElementById('tool-move')?.click();
      }
      // Blender R: Modal Rotate
      else if (!isBrushPaintActive && key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const started = this.modalTransform ? this.modalTransform.start('rotate') : false;
        if (!started) document.getElementById('tool-rotate')?.click();
      }
      // Blender S: Modal Scale
      else if (!isBrushPaintActive && key === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const started = this.modalTransform ? this.modalTransform.start('scale') : false;
        if (!started) document.getElementById('tool-scale')?.click();
      }
      // Blender X / Delete, Shift+D, F and Space are handled once by the
      // engine/timeline core to avoid duplicated actions.

      // Ctrl/Cmd + G: Group selection (matches the Edit menu label)
      else if (key === 'g' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const selected = this.sceneManager.getSelectedObjects();
        if (selected.length > 1) this.sceneManager.groupObjects(selected);
      }
      // Shift + A: Add Object Menu
      else if (key === 'a' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const menuAdd = document.getElementById('menu-add');
        if (menuAdd) {
          menuAdd.classList.toggle('open');
        }
      }
      // Alt + A: Deselect All
      else if (key === 'a' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        this.sceneManager.clearSelection();
      }
      // A: Select All in Object Mode (Edit Mode dispatches its own A)
      else if (key === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (!this.editMode?.isActive) {
          e.preventDefault();
          const all = this.sceneManager.getSelectableObjects()
            .filter(o => o.parent === this.sceneManager.rootContainer);
          this.sceneManager.setSelection(all);
        }
      }
      // N: Toggle Viewport N-Panel Sidebar (Item / Tool / View)
      else if (key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (this.modelingSuite) {
          this.modelingSuite.toggleNPanel();
        }
      }
      // T: Toggle Left Toolbar
      else if (key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const toolbar = document.querySelector('.blender-toolbar');
        if (toolbar) {
          const isHidden = toolbar.style.display === 'none';
          toolbar.style.display = isHidden ? 'flex' : 'none';
        }
      }
      // H: Hide Selected Object
      else if (key === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const active = this.sceneManager.getActiveObject();
        if (active) this.sceneManager.setVisibility(active, false);
      }
      // Alt + H: Unhide All Objects
      else if (key === 'h' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        this.sceneManager.traverseObjects((obj) => {
          this.sceneManager.setVisibility(obj, true);
        });
      }
      // M: Move selected object(s) to Collection (Blender Object Mode)
      else if (!isBrushPaintActive && !this.editMode?.isActive && key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (this.outliner?.openMoveToCollectionMenu()) {
          e.preventDefault();
        }
      }
      // Z: Cycle Viewport Shading Mode (plain only — never swallow Cmd/Ctrl+Z)
      else if (key === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const modes = ['solid', 'wireframe', 'material', 'rendered'];
        const current = this.currentShadingMode || 'solid';
        const next = modes[(modes.indexOf(current) + 1) % modes.length];
        this.setShadingMode(next);
      }
      // Numpad 1 / 3 / 7: camera presets are handled by the engine core.
      // F3: Quick Operator Search / AI Copilot
      else if (e.key === 'F3') {
        e.preventDefault();
        if (this.aiCopilot) this.aiCopilot.toggle();
      }
      // Ctrl + Space: Toggle AI Copilot (leave Ctrl+Alt+Space for Fullscreen Viewport)
      else if (e.code === 'Space' && e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (this.aiCopilot) this.aiCopilot.toggle();
      }
      // F4: Toggle STEM Tutor 1-1 HUD (triệu hồi nhanh Giáo viên AI)
      else if (e.key === 'F4') {
        e.preventDefault();
        if (this.stemTutor) {
          const nextOpen = !this.stemTutor.bubbleOpen;
          if (nextOpen) {
            this.stemTutor.setBubbleOpen(true);
            this.stemTutor.setHudMinimized(false);
            this.stemTutor.goToStep(this.stemTutor.activeStepIndex, { speak: true });
          } else {
            this.stemTutor.stopWalkthrough?.({ stopVoice: true });
            this.stemTutor.setBubbleOpen(false);
            this.stemTutor.parkAvatar?.();
          }
        }
      }
      // Alt + Shift + V: Bật/tắt Lệnh gọi tự khởi động ("Thầy ơi..." / "Copilot ơi...")
      else if (key === 'v' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (this.stemTutor && typeof this.stemTutor.toggleWakeListening === 'function') {
          this.stemTutor.toggleWakeListening();
        } else {
          getSharedVoiceCoordinator().toggleWakeMode();
        }
      }
    });
  }

  setShadingMode(mode) {
    const validModes = ['wireframe', 'solid', 'material', 'rendered'];
    const cleanMode = String(mode).toLowerCase();
    if (!validModes.includes(cleanMode)) return false;
    const shadingPills = document.querySelectorAll('.shading-pill-btn[data-mode]');
    shadingPills.forEach(b => {
      if (b.dataset.mode === cleanMode) b.classList.add('active');
      else b.classList.remove('active');
    });
    this.currentShadingMode = cleanMode;
    this._applyShadingMode(cleanMode);
    if (this.engine && typeof this.engine.setViewportShading === 'function') {
      this.engine.setViewportShading(cleanMode);
    }
    return true;
  }

  // =========================================================================
  // AUTOSAVE & CRASH RECOVERY
  // =========================================================================

  _startAutosave() {
    if (!this.exporter || !this.sceneManager) return;
    this._timelineRevision = 0;
    if (this.timelineEngine && typeof this.timelineEngine.on === 'function') {
      const bumpTimeline = () => { this._timelineRevision += 1; };
      this.timelineEngine.on('tracksChanged', bumpTimeline);
      this.timelineEngine.on('keyframeAdded', bumpTimeline);
      this.timelineEngine.on('keyframeRemoved', bumpTimeline);
      this.timelineEngine.on('clipAttached', bumpTimeline);
    }

    this._stopAutosave = startAutosave(() => {
      try {
        return this.exporter.exportProjectData();
      } catch (_) {
        return null;
      }
    }, {
      intervalMs: 20000,
      initialRevision: (this.sceneManager?.revision ?? 0) + (this._timelineRevision || 0),
      getRevision: () => (this.sceneManager?.revision ?? 0) + (this._timelineRevision || 0),
    });

    beginAutosaveSession()
      .then((sessionInfo) => this._offerDraftRestore(sessionInfo))
      .catch(() => this._offerDraftRestore(null));
  }

  /**
   * Persists a project snapshot immediately.
   * @returns {Promise<number>} serialized size in bytes
   */
  async saveAutosaveNow() {
    if (!this.exporter) return 0;
    const data = this.exporter.exportProjectData();
    await saveDraft(data);
    const cps = await listCheckpoints();
    return cps?.[0]?.diskBytes || cps?.[0]?.rawBytes || 0;
  }

  async loadAutosaveDraft() {
    return loadDraft();
  }

  async clearAutosaveDraft() {
    return clearDraft();
  }

  async _offerDraftRestore(sessionInfo = null) {
    let draft = null;
    let checkpoints = [];
    try {
      draft = await loadDraft({ hydrate: false });
      checkpoints = await listCheckpoints();
    } catch (_) {
      return;
    }
    if (!draft || !draft.json || document.getElementById('autosave-restore-banner')) return;

    const crashDetected = Boolean(draft.crashDetected || sessionInfo?.crashDetected);
    const banner = document.createElement('div');
    banner.id = 'autosave-restore-banner';
    // Top-centre, over the viewport: keeps the Inspector's editable fields
    // (bottom-right) reachable while the prompt is on screen.
    banner.style.cssText = 'position:fixed;left:50%;top:84px;transform:translateX(-50%);z-index:90;background:#1f1f1f;' +
      `border:1px solid ${crashDetected ? '#d97706' : '#3d3d3d'};border-radius:8px;padding:10px 12px;max-width:380px;` +
      'font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#ddd;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.5)';
    const when = new Date(draft.savedAt || Date.now()).toLocaleString();
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;color:#fff;margin-bottom:4px';
    title.textContent = crashDetected ? 'Crash Recovery (Unclean Exit)' : 'Autosaved Draft';
    const detail = document.createElement('div');
    detail.style.cssText = 'color:#aaa;margin-bottom:8px';
    const backendTag = draft.dehydrated
      ? ` · ${(draft.storageBackend || 'blob').toUpperCase()} (${(draft.blobRefs || []).length} blobs)`
      : '';
    detail.textContent = `Saved at ${when}${backendTag}. Restore?`;

    let selectEl = null;
    if (Array.isArray(checkpoints) && checkpoints.length > 1) {
      selectEl = document.createElement('select');
      selectEl.id = 'autosave-checkpoint-select';
      selectEl.style.cssText = 'display:block;width:100%;margin-bottom:8px;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:4px;padding:3px 6px;font-size:11px;';
      checkpoints.forEach((cp, idx) => {
        const opt = document.createElement('option');
        opt.value = cp.id;
        const cpTime = new Date(cp.savedAt || Date.now()).toLocaleTimeString();
        const actualBytes = Number(cp.diskBytes || cp.rawBytes || 0);
        const sizeLabel = actualBytes > 0
          ? (actualBytes >= 1024 * 1024
            ? `${(actualBytes / (1024 * 1024)).toFixed(2)} MB`
            : `${(actualBytes / 1024).toFixed(1)} KB`)
          : 'draft';
        opt.textContent = `${idx === 0 ? 'Latest' : `Checkpoint #${idx + 1}`} — ${cpTime} (${sizeLabel})`;
        selectEl.appendChild(opt);
      });
    }

    const restore = document.createElement('button');
    restore.textContent = 'Restore';
    restore.style.cssText = 'margin-right:8px;padding:3px 10px;cursor:pointer';
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.style.cssText = 'padding:3px 10px;cursor:pointer';

    restore.onclick = async () => {
      try {
        let jsonToLoad = null;
        if (selectEl && selectEl.selectedIndex > 0) {
          const chosen = await loadCheckpoint(selectEl.value);
          if (chosen?.json) jsonToLoad = chosen.json;
        }
        if (!jsonToLoad) {
          const hydrated = draft.dehydrated ? await loadDraft({ hydrate: true }) : draft;
          jsonToLoad = hydrated?.json || draft.json;
        }
        const file = new File([jsonToLoad], 'autosave.blend.json', { type: 'application/json' });
        await this.exporter.importProjectJSON(file);
        await clearDraft();
      } catch (error) {
        console.error('[Autosave] Restore failed:', error);
      }
      banner.remove();
    };
    dismiss.onclick = async () => {
      await clearDraft();
      banner.remove();
    };

    banner.appendChild(title);
    banner.appendChild(detail);
    if (selectEl) banner.appendChild(selectEl);
    banner.appendChild(restore);
    banner.appendChild(dismiss);
    document.body.appendChild(banner);
  }

  // =========================================================================
  // REAL-TIME STATS TRACKER
  // =========================================================================
  _bindSceneStats() {
    const statObjects = document.getElementById('stat-objects');
    const statVerts = document.getElementById('stat-verts');
    const statFaces = document.getElementById('stat-faces');
    const statFps = document.getElementById('stat-fps');
    const statMs = document.getElementById('stat-ms');

    const updateStats = () => {
      let totalObjects = 0;
      let totalVerts = 0;
      let totalFaces = 0;

      this.sceneManager.traverseObjects((obj) => {
        // Exclude rootContainer itself, scene, helpers, and internal system objects
        if (!obj || obj === this.sceneManager.rootContainer || obj === this.engine?.scene) return;
        if (obj.userData?.isSystemObject || obj.userData?.isHelper || obj.isTransformControls) return;
        if (obj.name === 'GridHelper' || obj.name === 'Scene_Collection') return;

        if (!obj.userData?.hideInOutliner) {
          totalObjects++;
        }
        if (obj.isMesh && obj.visible && obj.geometry) {
          const mult = obj.isInstancedMesh ? Math.max(0, Number(obj.count ?? 0)) : 1;
          if (mult === 0) return;
          const geo = obj.geometry;
          if (geo.attributes && geo.attributes.position) {
            totalVerts += geo.attributes.position.count * mult;
          }
          if (geo.index) {
            totalFaces += (geo.index.count / 3) * mult;
          } else if (geo.attributes && geo.attributes.position) {
            totalFaces += (geo.attributes.position.count / 3) * mult;
          }
        }
      });

      if (statObjects) statObjects.innerText = totalObjects;
      if (statVerts) statVerts.innerText = totalVerts.toLocaleString();
      if (statFaces) statFaces.innerText = Math.round(totalFaces).toLocaleString();
      if (!this.budgetHud) this.budgetHud = new ViewportBudgetHUD(this);
      this.budgetHud.refresh();
    };

    let statsRafId = 0;
    const queueStatsUpdate = () => {
      if (statsRafId) return;
      statsRafId = requestAnimationFrame(() => {
        statsRafId = 0;
        updateStats();
      });
    };

    this.sceneManager.on('objectAdded', queueStatsUpdate);
    this.sceneManager.on('objectRemoved', queueStatsUpdate);
    this.sceneManager.on('sceneCleared', updateStats);
    this.sceneManager.on('hierarchyChanged', queueStatsUpdate);
    window.addEventListener('blender:geometryChanged', queueStatsUpdate);
    window.addEventListener('blender:sceneUpdated', queueStatsUpdate);

    // Initial stats
    setTimeout(updateStats, 200);

    // Event-driven FPS & GPU Frame-Time readout coupled to active Engine renders (ignores on-demand idle pauses)
    let activeIntervals = 0;
    let activeDtSum = 0;
    let activeMsSum = 0;
    let lastReportTs = performance.now();
    let lastRenderTs = 0;
    if (statFps && !statFps.innerText) statFps.innerText = '60';
    if (statMs && !statMs.innerText) statMs.innerText = '1.0ms';
    if (this.engine && typeof this.engine.onAfterRender === 'function') {
      this.engine.onAfterRender(() => {
        const now = performance.now();
        const renderMs = Math.max(0.1, Number(this.engine.lastRenderMs || 1.0));
        if (lastRenderTs === 0 || now - lastRenderTs > 120) {
          lastRenderTs = now;
          if (statMs && now - lastReportTs >= 250) {
            statMs.innerText = `${renderMs.toFixed(1)}ms`;
            lastReportTs = now;
          }
          return;
        }
        const dt = now - lastRenderTs;
        if (dt < 4) return;
        lastRenderTs = now;
        activeIntervals++;
        activeDtSum += dt;
        activeMsSum += renderMs;
        if (now - lastReportTs >= 350 && activeIntervals >= 2) {
          const cap = this.engine?.maxFPS > 0 ? this.engine.maxFPS : 60;
          const avgDt = activeDtSum / activeIntervals;
          const avgMs = activeMsSum / activeIntervals;
          const fps = Math.min(cap, Math.max(1, Math.round(1000 / avgDt)));
          if (statFps) statFps.innerText = String(fps);
          if (statMs) statMs.innerText = `${avgMs.toFixed(1)}ms`;
          activeIntervals = 0;
          activeDtSum = 0;
          activeMsSum = 0;
          lastReportTs = now;
        }
      });
    }
  }
}

// Bootstrap
function bootstrap() {
  if (!window.app) {
    try {
      window.app = new BlenderApp();
    } catch (e) {
      console.error('[BlenderApp Bootstrap Error]:', e);
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

