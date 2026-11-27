/**
 * Web Blender Studio - Tencent Hunyuan3D-2.1 Image-to-3D User Interface
 * File: js/ui/hunyuan3d-ui.js
 *
 * Professional UI for Tencent's state-of-the-art Hunyuan3D-2.1 pipeline:
 * - High-fidelity shape generation via Hunyuan3D-DiT
 * - Production-ready PBR texture synthesis via Hunyuan3D-Paint
 * - Multi-mode execution: Local Gradio server (7860), HuggingFace Space, or Local Repo CLI
 * - Instant 1-click test gallery + drag-and-drop upload
 * - Direct 3D scene injection with auto-framing, PBR shading, and material inspection
 */

export class Hunyuan3DUI {
  constructor(app, containerId = 'dock-hunyuan3d') {
    this.app = app;
    this.container = document.getElementById(containerId);
    this.engine = app?.engine || window.studioEngine || window.engine;
    this.sceneManager = app?.sceneManager || window.sceneManager;

    this.currentImage = null;
    this.currentImageRelPath = 'models/woman_face_portrait.jpg';
    this.isGenerating = false;
    this.pollTimer = null;
    this.serverStatus = null;
    this._lastOutputGlb = null;
    this.isMultiviewMode = false;
    this.multiviewSlots = { front: null, back: null, left: null, right: null };

    // The HF token lives on the server; never keep a copy in browser storage.
    try { localStorage.removeItem('hunyuan3d_hf_token'); } catch (_) {}

    this._mediaInitialized = false;
    if (this.container) {
      this._initUI();
      this._bindEvents();
    }
  }

  onShow() {
    if (!this._mediaInitialized) {
      this._mediaInitialized = true;
      const previewImg = document.getElementById('hy3d-preview-img');
      if (previewImg && !previewImg.getAttribute('src')) {
        previewImg.setAttribute('src', previewImg.dataset.src || this.currentImageRelPath || 'models/woman_face_portrait.jpg');
      }
      this.loadSamples();
    }
    this.refreshStatus();
  }

  _notify(message, type = 'info') {
    const exporter = this.app?.exporter || (typeof window !== 'undefined' ? window.exporter : null);
    if (exporter?.showToast) exporter.showToast(message, type);
    const sub = document.getElementById('hy3d-progress-subtext');
    if (sub) sub.textContent = message;
    this.app?.codeEditor?.log?.(type === 'warning' ? 'warn' : type, message);
  }

  _initUI() {
    this.container.innerHTML = `
      <div class="hunyuan-wrapper" style="display: flex; flex-direction: column; height: 100%; padding: 12px; background: #18181c; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; overflow-y: auto; box-sizing: border-box;">
        
        <!-- Header Banner (Clean User-Facing UI, zero dev endpoint/key/debug exposure) -->
        <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid #2e2e38; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 28px; height: 28px; border-radius: 6px; background: linear-gradient(135deg, #8e44ad, #3498db); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; color: #fff;">3D</div>
            <div>
              <div style="font-weight: 600; font-size: 13px; color: #fff;">Image to 3D Studio</div>
              <div style="font-size: 10px; color: #9aa0a6;">Chuyển đổi ảnh tham chiếu thành mô hình hoặc mặt phẳng dựng hình 3D</div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span id="hy3d-status-pill" style="font-size: 10px; padding: 3px 10px; border-radius: 10px; background: #3b2d13; color: #fbbf24; border: 1px solid #b45309; font-weight: 600;">🟠 Đang bảo trì</span>
          </div>
        </div>

        <!-- Maintenance / Unavailable Banner (shown when no reliable dedicated 3D GPU backend is connected) -->
        <div id="hy3d-maintenance-banner" style="background: linear-gradient(135deg, rgba(217, 119, 6, 0.14), rgba(142, 68, 173, 0.12)); border: 1px solid rgba(245, 158, 11, 0.45); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px;">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 240px;">
              <div style="font-weight: 700; font-size: 12px; color: #fbbf24; margin-bottom: 4px;">
                🛠️ Tính năng dựng mesh tự động từ 1 ảnh (Hunyuan3D) đang tạm bảo trì
              </div>
              <div id="hy3d-maintenance-desc" style="font-size: 11px; color: #d1d5db; line-height: 1.5;">
                Hệ thống hiện chưa gắn máy chủ GPU Image-to-3D chính thức nên tính năng tự sinh lưới GLB đang tạm khóa để tránh lỗi và chờ đợi không ổn định. Bạn có thể chọn ảnh bên dưới để <b>đặt làm Reference Blueprint trong 3D Viewport</b> hoặc gửi sang <b>AI Copilot 3D</b>.
              </div>
            </div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
              <button id="hy3d-btn-blueprint" style="background: #2563eb; color: #fff; border: none; padding: 6px 11px; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer;">📌 Đặt vào Viewport (Blueprint)</button>
              <button id="hy3d-btn-send-copilot" style="background: #7c3aed; color: #fff; border: none; padding: 6px 11px; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer;">🤖 Dựng bằng AI Copilot</button>
              <button id="hy3d-btn-open-assets" style="background: #1f2937; color: #e5e7eb; border: 1px solid #374151; padding: 6px 11px; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer;">📦 Kho Asset có sẵn</button>
            </div>
          </div>
        </div>

        <!-- Main Content 2-Column Grid -->
        <div style="display: grid; grid-template-columns: 260px 1fr; gap: 14px; flex: 1; min-height: 240px;">
          
          <!-- Left Column: Input Image & Samples -->
          <div style="display: flex; flex-direction: column; gap: 10px;">
            
            <!-- Drop Zone & Active Image Preview -->
            <div id="hy3d-dropzone" style="position: relative; width: 100%; height: 180px; border: 2px dashed #444458; border-radius: 8px; background: #121216; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; overflow: hidden; transition: all 0.2s ease;">
              <img id="hy3d-preview-img" data-src="models/woman_face_portrait.jpg" style="width: 100%; height: 100%; object-fit: contain; display: block;" alt="Input Preview" />
              <div id="hy3d-drop-prompt" style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(18, 18, 22, 0.85); padding: 6px; text-align: center; font-size: 10px; color: #aaa; pointer-events: none;">
                Kéo thả ảnh hoặc nhấn để chọn ảnh (PNG/JPG)
              </div>
              <input id="hy3d-file-input" type="file" accept="image/*" style="display: none;" />
            </div>

            <!-- Quick Samples Gallery -->
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #aaa; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
                <span>Ảnh mẫu tham chiếu</span>
                <span style="font-size: 9px; color: #666;">1-Click</span>
              </div>
              <div id="hy3d-samples-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;">
                <button class="hy3d-sample-chip" data-file="models/woman_face_portrait.jpg" style="background: #202028; border: 1px solid #3c3c4a; border-radius: 4px; padding: 4px; font-size: 10px; color: #ddd; cursor: pointer; text-align: left; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                  👩 Female Portrait
                </button>
                <button class="hy3d-sample-chip" data-file="models/man_face_portrait.jpg" style="background: #202028; border: 1px solid #3c3c4a; border-radius: 4px; padding: 4px; font-size: 10px; color: #ddd; cursor: pointer; text-align: left; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                  👨 Male Portrait
                </button>
                <button class="hy3d-sample-chip" data-file="models/real_flower_atlas.png" style="background: #202028; border: 1px solid #3c3c4a; border-radius: 4px; padding: 4px; font-size: 10px; color: #ddd; cursor: pointer; text-align: left; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                  🌸 Natural Flower
                </button>
                <button class="hy3d-sample-chip" data-file="models/real_leaf_atlas.png" style="background: #202028; border: 1px solid #3c3c4a; border-radius: 4px; padding: 4px; font-size: 10px; color: #ddd; cursor: pointer; text-align: left; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                  🍃 Leaf Branch
                </button>
              </div>
            </div>

          </div>

          <!-- Right Column: Generation Panel (Enabled only when verified GPU backend is active) -->
          <div style="display: flex; flex-direction: column; gap: 10px;">
            
            <div id="hy3d-ready-controls" style="display: none; flex-direction: column; gap: 10px;">
              <!-- Architecture Flow Badge -->
              <div style="display: flex; align-items: center; justify-content: space-between; background: #20202a; padding: 8px 12px; border-radius: 6px; border: 1px solid #333344; font-size: 11px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="color: #9b59b6; font-weight: bold;">Shape AI</span>
                  <span style="color: #666;">➔</span>
                  <span style="color: #3498db; font-weight: bold;">PBR Texture</span>
                  <span style="color: #666;">➔</span>
                  <span style="color: #2ecc71; font-weight: bold;">3D GLB</span>
                </div>
                <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: #aaa; cursor: pointer;">
                  <input id="hy3d-opt-rembg" type="checkbox" checked style="accent-color: #8e44ad;" /> Tách nền (rembg)
                </label>
              </div>

              <!-- Parameters Panel -->
              <div style="background: #1d1d24; border: 1px solid #2d2d38; border-radius: 6px; padding: 10px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; font-size: 11px;">
                <div>
                  <label style="display: block; color: #888; font-size: 10px; margin-bottom: 4px;">Pipeline Mode</label>
                  <select id="hy3d-opt-pipeline" style="width: 100%; background: #141418; border: 1px solid #3a3a48; color: #fff; padding: 4px; border-radius: 4px; font-size: 11px;">
                    <option value="all">Full PBR Asset (Shape + Texture)</option>
                    <option value="shape">Shape Geometry Only (Fast Mesh)</option>
                    <option value="texture">Texture Synthesis Only</option>
                  </select>
                </div>

                <div>
                  <div style="display: flex; justify-content: space-between; color: #888; font-size: 10px; margin-bottom: 4px;">
                    <span>Inference Steps</span>
                    <span id="hy3d-val-steps" style="color: #9b59b6; font-weight: bold;">30</span>
                  </div>
                  <input id="hy3d-opt-steps" type="range" min="15" max="60" value="30" style="width: 100%; accent-color: #9b59b6;" />
                </div>

                <div>
                  <div style="display: flex; justify-content: space-between; color: #888; font-size: 10px; margin-bottom: 4px;">
                    <span>Octree Resolution</span>
                    <span id="hy3d-val-octree" style="color: #3498db; font-weight: bold;">256</span>
                  </div>
                  <select id="hy3d-opt-octree" style="width: 100%; background: #141418; border: 1px solid #3a3a48; color: #fff; padding: 4px; border-radius: 4px; font-size: 11px;">
                    <option value="256">256 (Nhanh)</option>
                    <option value="384">384 (Cân bằng)</option>
                    <option value="512">512 (Chi tiết cao)</option>
                  </select>
                </div>
              </div>

              <!-- Generate Button -->
              <button id="hy3d-btn-generate" style="background: linear-gradient(135deg, #8e44ad 0%, #2980b9 100%); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 12px rgba(142, 68, 173, 0.35); transition: all 0.2s ease;">
                <span>⚡ Tạo mô hình 3D từ ảnh</span>
              </button>
            </div>

            <!-- Clean Workflow Guide when in Maintenance -->
            <div id="hy3d-maintenance-guide" style="background: #1d1d24; border: 1px solid #2d2d38; border-radius: 8px; padding: 14px; font-size: 11.5px; color: #b8bcc8; line-height: 1.6;">
              <div style="font-weight: 600; color: #fff; margin-bottom: 8px;">✨ Quy trình thay thế khuyên dùng ngay trong Studio:</div>
              <ul style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px;">
                <li><b>1. Reference Blueprint 3D:</b> Đặt ảnh chọn làm mặt phẳng tham chiếu ngay trong Viewport để dựng theo tỷ lệ chuẩn (Move <kbd>G</kbd>, Scale <kbd>S</kbd>).</li>
                <li><b>2. AI Copilot 3D (Vision):</b> Gửi trực tiếp ảnh đang xem sang AI Copilot để mô hình Cloud AI phân tích bố cục và dựng khối Three.js tự động.</li>
                <li><b>3. Kho Asset 3D tích hợp:</b> Chọn nhanh mô hình &amp; vật liệu PBR có sẵn trong tab <b>Asset Browser</b>.</li>
              </ul>
            </div>

            <!-- Progress Bar & Status Log -->
            <div id="hy3d-progress-container" style="display: none; background: #181820; border: 1px solid #333348; border-radius: 6px; padding: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-bottom: 6px;">
                <span id="hy3d-progress-label" style="font-weight: 600; color: #9b59b6;">Processing...</span>
                <span id="hy3d-progress-percent" style="color: #fff; font-weight: bold;">0%</span>
              </div>
              <div style="width: 100%; height: 6px; background: #282836; border-radius: 3px; overflow: hidden; margin-bottom: 8px;">
                <div id="hy3d-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #8e44ad, #3498db); transition: width 0.3s ease;"></div>
              </div>
              <div id="hy3d-progress-subtext" style="font-size: 10px; color: #888;">Đang xử lý...</div>
            </div>

            <!-- Result Card -->
            <div id="hy3d-result-card" style="display: none; background: #182218; border: 1px solid #27ae60; border-radius: 6px; padding: 10px; margin-top: auto;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="color: #2ecc71; font-size: 16px;">✔</span>
                  <span style="font-weight: 600; font-size: 12px; color: #fff;">Mô hình 3D PBR đã sẵn sàng!</span>
                </div>
                <span id="hy3d-res-stats" style="font-size: 10px; color: #88cca0;">PBR Material</span>
              </div>
              
              <div style="display: flex; gap: 8px;">
                <button id="hy3d-btn-add-scene" style="flex: 2; background: #27ae60; color: #fff; font-weight: 600; font-size: 11px; padding: 7px 12px; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
                  <span>📥 Đưa vào 3D Scene</span>
                </button>
                <button id="hy3d-btn-download" style="flex: 1; background: #2c3e50; color: #ecf0f1; font-size: 11px; padding: 7px 12px; border: 1px solid #34495e; border-radius: 4px; cursor: pointer;">
                  💾 Tải .GLB
                </button>
              </div>
            </div>

          </div>

        </div>

      </div>
    `;
  }

  _bindEvents() {
    // Steps & Octree controls
    const stepsSlider = document.getElementById('hy3d-opt-steps');
    const stepsVal = document.getElementById('hy3d-val-steps');
    if (stepsSlider && stepsVal) {
      stepsSlider.addEventListener('input', (e) => {
        stepsVal.textContent = e.target.value;
      });
    }

    const octreeSelect = document.getElementById('hy3d-opt-octree');
    const octreeVal = document.getElementById('hy3d-val-octree');
    if (octreeSelect && octreeVal) {
      octreeSelect.addEventListener('change', (e) => {
        octreeVal.textContent = e.target.value;
      });
    }

    // Dropzone & File Input
    const dropzone = document.getElementById('hy3d-dropzone');
    const fileInput = document.getElementById('hy3d-file-input');
    const previewImg = document.getElementById('hy3d-preview-img');

    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#8e44ad';
        dropzone.style.background = '#1a1622';
      });

      dropzone.addEventListener('dragleave', () => {
        dropzone.style.borderColor = '#444458';
        dropzone.style.background = '#121216';
      });

      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#444458';
        dropzone.style.background = '#121216';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          this.handleImageFile(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.handleImageFile(e.target.files[0]);
        }
      });
    }

    // Quick sample chips
    const sampleChips = this.container.querySelectorAll('.hy3d-sample-chip');
    sampleChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const filePath = chip.getAttribute('data-file');
        if (filePath && previewImg) {
          this.currentImageRelPath = filePath;
          this.currentImageDataUrl = null;
          previewImg.src = filePath;
        }
      });
    });

    // Alternative working workflows (Blueprint / AI Copilot Vision / Asset Browser)
    document.getElementById('hy3d-btn-blueprint')?.addEventListener('click', () => this.placeSelectedAsBlueprint());
    document.getElementById('hy3d-btn-send-copilot')?.addEventListener('click', () => this.sendToAICopilot());
    document.getElementById('hy3d-btn-open-assets')?.addEventListener('click', () => {
      document.querySelector('.dock-tab[data-pane="dock-asset-browser"]')?.click();
    });

    // Generate Button (active only when dedicated backend ready)
    document.getElementById('hy3d-btn-generate')?.addEventListener('click', () => this.generate());

    // Add to Scene Button
    document.getElementById('hy3d-btn-add-scene')?.addEventListener('click', () => this.addResultToScene());

    // Download GLB Button
    document.getElementById('hy3d-btn-download')?.addEventListener('click', () => {
      if (this._lastOutputGlb) {
        const a = document.createElement('a');
        a.href = '/' + this._lastOutputGlb;
        a.download = this._lastOutputGlb.split('/').pop() || 'image3d_model.glb';
        a.click();
      }
    });
  }

  async _getSelectedImageDataUrl() {
    if (this.currentImageDataUrl) return this.currentImageDataUrl;
    const src = this.currentImageRelPath ? ('/' + this.currentImageRelPath.replace(/^\/+/, '')) : '/models/woman_face_portrait.jpg';
    const resp = await fetch(src);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async placeSelectedAsBlueprint() {
    try {
      const dataUrl = await this._getSelectedImageDataUrl();
      const copilot = this.app?.aiCopilot || window.aiCopilot;
      if (copilot?.placeImageAsReferencePlane) {
        await copilot.placeImageAsReferencePlane(dataUrl, 4);
        this._notify('Đã đặt ảnh tham chiếu (Reference Blueprint) vào 3D Viewport.', 'success');
        return;
      }
      this._notify('Không tìm thấy module Reference Plane trong Viewport.', 'warning');
    } catch (err) {
      this._notify('Không thể đặt ảnh tham chiếu: ' + err.message, 'error');
    }
  }

  async sendToAICopilot() {
    try {
      const dataUrl = await this._getSelectedImageDataUrl();
      const copilot = this.app?.aiCopilot || window.aiCopilot;
      if (!copilot) {
        this._notify('AI Copilot chưa sẵn sàng.', 'warning');
        return;
      }
      const name = (this.currentImageRelPath || 'reference.png').split('/').pop();
      copilot.attachedImages.push({
        id: 'img_' + Date.now(),
        name,
        type: 'image/png',
        size: dataUrl.length,
        dataUrl,
      });
      copilot._renderAttachmentsTray?.();
      copilot.show();
      if (copilot.textarea && !copilot.textarea.value.trim()) {
        copilot.textarea.value = 'Hãy phân tích ảnh tham chiếu này và dựng mô hình 3D tương ứng bằng Three.js/studio DSL.';
      }
      copilot.textarea?.focus();
    } catch (err) {
      this._notify('Không thể chuyển ảnh sang AI Copilot: ' + err.message, 'error');
    }
  }

  async refreshStatus() {
    const pill = document.getElementById('hy3d-status-pill');
    const banner = document.getElementById('hy3d-maintenance-banner');
    const readyControls = document.getElementById('hy3d-ready-controls');
    const maintenanceGuide = document.getElementById('hy3d-maintenance-guide');
    try {
      const resp = await fetch('/api/hunyuan3d/status');
      const data = await resp.json();
      this.serverStatus = data;

      const ready = !!data.engineReady;
      if (banner) banner.style.display = ready ? 'none' : 'block';
      if (readyControls) readyControls.style.display = ready ? 'flex' : 'none';
      if (maintenanceGuide) maintenanceGuide.style.display = ready ? 'none' : 'block';

      if (pill) {
        if (ready) {
          pill.style.background = '#064e3b';
          pill.style.color = '#34d399';
          pill.style.borderColor = '#059669';
          pill.textContent = '🟢 GPU Backend Sẵn Sàng';
        } else {
          pill.style.background = '#3b2d13';
          pill.style.color = '#fbbf24';
          pill.style.borderColor = '#b45309';
          pill.textContent = '🟠 Đang bảo trì';
        }
      }
    } catch (_) {
      if (banner) banner.style.display = 'block';
      if (readyControls) readyControls.style.display = 'none';
      if (maintenanceGuide) maintenanceGuide.style.display = 'block';
      if (pill) {
        pill.style.background = '#3b2d13';
        pill.style.color = '#fbbf24';
        pill.style.borderColor = '#b45309';
        pill.textContent = '🟠 Đang bảo trì';
      }
    }
  }

  async loadSamples() {
    try {
      const resp = await fetch('/api/hunyuan3d/samples');
      const data = await resp.json();
      if (data.success && data.samples && data.samples.length > 0) {
        const grid = document.getElementById('hy3d-samples-grid');
        if (grid) {
          grid.innerHTML = data.samples.map(s => `
            <button class="hy3d-sample-chip" data-file="${s.file}" style="background: #202028; border: 1px solid #3c3c4a; border-radius: 4px; padding: 4px 6px; font-size: 10px; color: #ddd; cursor: pointer; text-align: left; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${s.desc}">
              ${s.name}
            </button>
          `).join('');

          grid.querySelectorAll('.hy3d-sample-chip').forEach(chip => {
            chip.addEventListener('click', () => {
              const file = chip.getAttribute('data-file');
              const previewImg = document.getElementById('hy3d-preview-img');
              if (file && previewImg) {
                this.currentImageRelPath = file;
                this.currentImageDataUrl = null;
                previewImg.src = file;
              }
            });
          });
        }
      }
    } catch (e) {
      console.warn('[Image3D] Could not load samples:', e);
    }
  }

  handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      this.currentImageDataUrl = e.target.result;
      const previewImg = document.getElementById('hy3d-preview-img');
      if (previewImg) {
        previewImg.src = e.target.result;
      }

      if (!this.serverStatus?.engineReady) return;

      // Upload to server only when an Image-to-3D backend is active
      try {
        const resp = await fetch('/api/hunyuan3d/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileData: e.target.result,
            fileName: file.name
          })
        });
        const res = await resp.json();
        if (res.success) {
          this.currentImageRelPath = res.filePath;
        }
      } catch (err) {
        console.error('[Image3D] Image upload error:', err);
      }
    };
    reader.readAsDataURL(file);
  }

  async generate() {
    if (this.isGenerating) return;
    if (!this.serverStatus?.engineReady) {
      this._notify('Tính năng tạo mô hình 3D trực tiếp từ ảnh hiện đang tạm bảo trì.', 'warning');
      return;
    }
    this.isGenerating = true;

    const btn = document.getElementById('hy3d-btn-generate');
    const progBox = document.getElementById('hy3d-progress-container');
    const resCard = document.getElementById('hy3d-result-card');

    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.innerHTML = '<span>⏳ Đang tạo mô hình 3D...</span>';
    }
    if (progBox) progBox.style.display = 'block';
    if (resCard) resCard.style.display = 'none';

    const steps = parseInt(document.getElementById('hy3d-opt-steps')?.value || '30', 10);
    const octreeResolution = parseInt(document.getElementById('hy3d-opt-octree')?.value || '256', 10);
    const rembg = document.getElementById('hy3d-opt-rembg')?.checked ?? true;
    const pipeline = document.getElementById('hy3d-opt-pipeline')?.value || 'all';

    try {
      const resp = await fetch('/api/hunyuan3d/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imagePath: this.currentImageRelPath,
          options: { steps, octreeResolution, rembg, pipeline }
        })
      });

      const res = await resp.json();
      if (!res.success) {
        this._notify(res.error || 'Dịch vụ tạo 3D từ ảnh đang tạm bảo trì.', 'warning');
        this._finishGeneration(false);
        return;
      }

      this._startProgressPolling();
    } catch (e) {
      console.error('[Image3D] Generate request failed:', e);
      this._notify('Không thể kết nối dịch vụ tạo 3D: ' + e.message, 'error');
      this._finishGeneration(false);
    }
  }

  _startProgressPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = setInterval(async () => {
      try {
        const resp = await fetch('/api/hunyuan3d/progress');
        const prog = await resp.json();

        const bar = document.getElementById('hy3d-progress-bar');
        const pct = document.getElementById('hy3d-progress-percent');
        const sub = document.getElementById('hy3d-progress-subtext');
        const lbl = document.getElementById('hy3d-progress-label');

        if (bar) bar.style.width = Math.min(100, prog.percent || 0) + '%';
        if (pct) pct.textContent = Math.round(prog.percent || 0) + '%';
        if (sub) sub.textContent = prog.message || 'Processing...';

        if (prog.stage === 'reasoning') {
          if (lbl) lbl.textContent = '🧠 AI 3D Spatial Reasoning (Inferring occluded angles)...';
        } else if (prog.stage === 'shape_generation') {
          if (lbl) lbl.textContent = 'Stage 1/2: Hunyuan3D-DiT Flow Matching...';
        } else if (prog.stage === 'texture_generation') {
          if (lbl) lbl.textContent = 'Stage 2/2: Hunyuan3D-Paint PBR Texture Baking...';
        } else if (prog.stage === 'complete') {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
          this._finishGeneration(true, prog);
        } else if (prog.stage === 'error') {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
          this._notify('Không thể hoàn tất tạo mô hình 3D: ' + (prog.error || 'Lỗi không xác định'), 'error');
          this._finishGeneration(false);
        }
      } catch (e) {
        console.warn('[Image3D] Poll error:', e);
      }
    }, 800);
  }

  _finishGeneration(success, progData = null) {
    this.isGenerating = false;
    const btn = document.getElementById('hy3d-btn-generate');
    const resCard = document.getElementById('hy3d-result-card');

    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1.0';
      btn.innerHTML = '<span>⚡ Tạo mô hình 3D từ ảnh</span>';
    }

    if (success && progData && progData.outputGlb) {
      this._lastOutputGlb = progData.outputGlb;
      if (resCard) {
        resCard.style.display = 'block';
        const statsEl = document.getElementById('hy3d-res-stats');
        if (statsEl) {
          const v = progData.stats?.vertices ? `${(progData.stats.vertices / 1000).toFixed(1)}k Verts` : 'High-Poly';
          const f = progData.stats?.faces ? ` • ${(progData.stats.faces / 1000).toFixed(1)}k Faces` : '';
          const dim = progData.stats?.dimensions;
          const dimStr = dim ? ` • Bounds: ${dim.width}m x ${dim.height}m (Depth ${dim.depth}m)` : '';
          statsEl.textContent = `${v}${f}${dimStr} • Full PBR`;
        }

        let tipEl = document.getElementById('hy3d-depth-tip');
        if (!tipEl) {
          tipEl = document.createElement('div');
          tipEl.id = 'hy3d-depth-tip';
          tipEl.style.marginTop = '8px';
          tipEl.style.padding = '8px 10px';
          tipEl.style.borderRadius = '6px';
          tipEl.style.fontSize = '11px';
          tipEl.style.lineHeight = '1.4';
          resCard.appendChild(tipEl);
        }

        const dz = progData.stats?.dimensions?.depth ?? 0;
        if (dz > 0 && dz < 0.12) {
          tipEl.style.display = 'block';
          tipEl.style.background = '#3b2d13';
          tipEl.style.border = '1px solid #d97706';
          tipEl.style.color = '#fef3c7';
          tipEl.innerHTML = `⚠️ <b>Shallow relief mesh (depth ${dz}m):</b> Because the source image is a close-up cropped on all 4 edges, the AI cannot infer full back and shoulder geometry. For a <b>full 360° volumetric 3D mesh</b>, use a full-body or uncropped object image with surrounding background margin.`;
        } else {
          tipEl.style.display = 'block';
          tipEl.style.background = '#064e3b';
          tipEl.style.border = '1px solid #059669';
          tipEl.style.color = '#d1fae5';
          tipEl.innerHTML = `✨ <b>Full 3D Volumetric Mesh (Depth ${dz}m):</b> The model has complete 360° depth and is ready for orbiting and editing in the 3D Viewport!`;
        }
      }
    }
  }

  async addResultToScene() {
    if (!this._lastOutputGlb) return;

    try {
      const eng = this.engine || window.studioEngine || window.engine;
      if (!eng || !eng.scene) {
        this._notify('3D Scene is not ready', 'warning');
        return;
      }

      // Load using exporter's GLTFLoader or window.THREE
      const { GLTFLoader } = await window.exporter._loadAddon('loaders/GLTFLoader.js');
      const loader = new GLTFLoader();

      const modelUrl = '/' + this._lastOutputGlb;

      loader.load(modelUrl, (gltf) => {
        const model = gltf.scene;
        const modelName = 'Hunyuan3D_' + (this._lastOutputGlb.split('/').pop().replace('.glb', '') || 'Model');
        model.name = modelName;

        // Auto-scale to realistic human scale (1.7m)
        const bbox = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        bbox.getSize(size);

        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
          const targetScale = 1.7 / maxDim;
          model.scale.set(targetScale, targetScale, targetScale);
        }

        // Center on floor
        const scaledBbox = new THREE.Box3().setFromObject(model);
        const center = new THREE.Vector3();
        scaledBbox.getCenter(center);
        model.position.x = -center.x;
        model.position.z = -center.z;
        model.position.y = -scaledBbox.min.y;

        // Clean up previous Hunyuan3D objects from scene
        const sc = eng.scene.getObjectByName('Scene_Collection') || eng.scene;
        const toRemove = [];
        sc.traverse(c => {
          if (c.name && c.name.startsWith('Hunyuan3D_') && c !== model) toRemove.push(c);
        });
        toRemove.forEach(c => c.parent && c.parent.remove(c));

        // Enable shadows and compute normals if missing
        model.traverse(child => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            if (child.geometry && !child.geometry.attributes.normal) {
              child.geometry.computeVertexNormals();
            }

            // Check if model already has embedded PBR texture map
            if (child.material && child.material.map) {
              child.material.roughness = child.material.roughness ?? 0.4;
              child.material.metalness = child.material.metalness ?? 0.05;
              child.material.side = THREE.DoubleSide;
              child.material.needsUpdate = true;
            } else {
              // When generated from shape-only mode, synthesize UV coordinates
              // and map the input reference image as high-res Albedo texture
              const geom = child.geometry;
              if (geom && !geom.attributes.uv && geom.attributes.position) {
                const pos = geom.attributes.position;
                const uvs = new Float32Array(pos.count * 2);
                const bbox = new THREE.Box3().setFromBufferAttribute(pos);
                const size = bbox.getSize(new THREE.Vector3());
                for (let i = 0; i < pos.count; i++) {
                  const x = pos.getX(i);
                  const y = pos.getY(i);
                  uvs[i * 2] = (x - bbox.min.x) / (size.x || 1.0);
                  uvs[i * 2 + 1] = (y - bbox.min.y) / (size.y || 1.0);
                }
                geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
              }

              const sourceImg = this.currentImageRelPath || 'models/woman_face_portrait.jpg';
              const texLoader = new THREE.TextureLoader();
              texLoader.load('/' + sourceImg, (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                child.material = new THREE.MeshStandardMaterial({
                  map: tex,
                  roughness: 0.35,
                  metalness: 0.05,
                  side: THREE.DoubleSide
                });
                child.material.needsUpdate = true;
              }, undefined, () => {
                // High quality fallback PBR clay
                child.material = new THREE.MeshStandardMaterial({
                  color: 0xe0e0e0,
                  roughness: 0.35,
                  metalness: 0.05,
                  side: THREE.DoubleSide
                });
              });
            }
          }
        });

        // Add directly to Scene Collection via sceneManager
        const sm = this.sceneManager || window.sceneManager;
        if (sm && typeof sm.addObject === 'function') {
          sm.addObject(model, null, true, true);
        } else {
          eng.scene.add(model);
        }

        // Frame camera smoothly to model
        if (eng.camera && eng.controls) {
          eng.camera.position.set(0, 1.4, 2.8);
          eng.controls.target.set(0, 0.9, 0);
          eng.camera.lookAt(0, 0.9, 0);
          eng.controls.update();
        }

        // Update scene outliner & tree
        if (window.outliner && typeof window.outliner.refresh === 'function') {
          window.outliner.refresh();
        }

        // Select the newly added object in viewport & inspector
        if (sm && typeof sm.select === 'function') {
          sm.select(model);
        }

        console.log(`[Hunyuan3D] Added ${modelName} to 3D scene!`);
      }, undefined, (err) => {
        console.error('[Hunyuan3D] Failed to load GLB into scene:', err);
        this._notify('Could not load model into 3D Viewport: ' + err.message, 'error');
      });

    } catch (e) {
      console.error('[Hunyuan3D] addResultToScene error:', e);
      this._notify('Failed to add model to 3D scene: ' + e.message, 'error');
    }
  }
}
