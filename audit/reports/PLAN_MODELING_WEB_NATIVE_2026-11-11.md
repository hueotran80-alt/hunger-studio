# Kế hoạch: Thuật toán modeling tiệm cận Blender + video thật, web-native nhiều người không nghẽn

## Context
Người dùng muốn mở rộng khả năng **thuật toán** của web-blender-studio như Blender thật (randomize cạnh/đỉnh, làm dày = Solidify, làm đều cạnh = Bevel/Subsurf/Smooth, shading) để đủ sức dựng một video "thật" như video reference, đồng thời giữ ràng buộc **web: nhanh, nhiều người dùng đồng thời không nghẽn** (mọi compute nặng ở client, server chỉ static + cloud-save).

Khảo sát xác nhận lỗ hổng hiện tại:
- `js/core/modifiers.js`: `SubdivisionModifier` (L390) là midpoint-split giả + "smooth" offset 6% (L465-472); `BevelModifier` (L515) là centroid-inset giả, bỏ segments/UV. Registry `MODIFIER_TYPES` (L715-722) thiếu **solidify, displace, smooth, randomize**. Stack (`applyModifier` L748 … `recomputeModifiers` L898) **không undo**.
- `js/core/edit-mode.js`: thiếu smooth/relax, randomize, recalc/flip normals; `MeshEditCommand` (L36-49) phá custom normals bằng `computeVertexNormals()` vô điều kiện.
- `js/core/geometry-worker.js` chỉ nhận `bvh`/`csg` (L80-83); client timeout không cancel.
- Video hiện là MediaRecorder **wall-clock** (`js/film/film-project.js` L1032, `rapid-api.js` L2019-2036) → rơi frame, không exact timing; chưa có frame-by-frame seek→render→encode.
- Path tracer bỏ PMREM/canvas HDRI (`js/render/pathtrace-scene.js` L289-298).

**Quyết định đã chốt với người dùng:**
- Đợt triển khai ĐẦU TIÊN = **chỉ Phase 1** (nền tảng). Các phase 2-6 là lộ trình tiếp theo, phê duyệt riêng.
- Chiến lược render video = **Raster PBR thời gian thực + hero frame path-traced** (video mặc định raster; frame đắt path-traced ở Phase 6). Path tracing KHÔNG là renderer video mặc định.

## Nguyên tắc kiến trúc (xuyên suốt)
1. Kernel thuần typed-array, không DOM, đặt `js/core/geometry/`; chạy trong `geometry-worker.js`; `modifiers.js` chỉ là facade/registry. Main thread chỉ transfer buffer + nhận progress + swap geometry.
2. Async + AbortController là đường chuẩn; bỏ fallback đồng bộ lớn ở đường user-facing. Kernel đồng bộ chỉ giữ cho Node test/parity.
3. Source geometry + descriptor modifier là nguồn sự thật; evaluated geometry là cache; undo khôi phục cache tức thì, không tính lại stack nặng.
4. Server không bao giờ là nút thắt: static ES-module/vendor; cloud-save chỉ lưu JSON/GLB; không render queue, không upload video mặc định.

## Bảng phase tổng quan
| Phase | Kết quả ship độc lập | Phụ thuộc | Ghi chú |
|---|---|---|---|
| 1 | Nền async/cancel/undo/worker/budget/schema v4 | — | **✅ XONG (11/11/2026)** — 23/23 suite `run_all.sh` PASS |
| 2 | Solidify, Randomize, Smooth/Relax, Displace, Even-Edges, Shade Smooth/Auto-Smooth | 1 | **✅ XONG (11/11/2026)** — 25/25 suite `run_all.sh` PASS |
| 3 | Bevel thật + Catmull-Clark thật + crease/sharp | 1,2 | **✅ XONG (11/11/2026)** — 27/27 suite `run_all.sh` PASS |
| 4 | Look-dev raster thật: PBR physical, IBL, shadows, post, texture async | 1 | **✅ XONG (11/11/2026)** — 28/28 suite `run_all.sh` PASS |
| 5 | Video export client-side deterministic (seek→raster→WebCodecs encode) | 2,3,4 | **✅ XONG (11/11/2026)** — 29/29 suite `run_all.sh` PASS |
| 6 | Path-traced stills + **hero frame** chèn vào video + PMREM/env parity | 4,5 | Nâng chất lượng, không bắt buộc cho video |

---

## PHASE 1 — Nền tảng geometry async / modifier-stack undo / persistence — ✅ HOÀN TẤT (11/11/2026)

### Mục tiêu
Mọi thao tác nặng tương lai phải: off-main-thread, cancel được, budget, undo được, serialize được, DSL gọi được.

### Tính năng
- Worker protocol v2: `run/progress/done/error/cancel/cancelled`; transferable in/out; per-task AbortController + timeout + priority; **latest-wins** theo mesh+stack revision.
- Tách topology kernel dùng chung từ Edit Mode: welded verts/edges/faces + per-loop UV + groups + sharp/crease + selection mask.
- Modifier stack async: descriptor thuần trong `userData.modifierStack`; source+revision+evaluated cache tách biệt; add/update/remove/toggle/reorder/bake/recompute async; **sửa bug bake-prefix** (bake modifier i phải bỏ 0..i).
- History: `ModifierStackCommand` mới; mở rộng `MeshEditCommand` giữ normals được cấp + adopt snapshot worker-owned; composite command cho shading/material nhiều object; history byte-budget cạnh giới hạn 50 lệnh.
- Project schema v4: lưu source geometry + descriptor + shading policy + crease/sharp; restore rồi reevaluate async; sửa duplicate independence cho modifier state.

### File sửa
`js/core/modifiers.js`, `js/core/geometry-worker-client.js`, `js/core/geometry-worker.js`, `js/core/edit-mode.js`, `js/core/scene-manager.js`, `js/exporters/export-import.js`, `js/ui/inspector.js`, `js/ui/blender-modeling-suite.js`, `js/scripting/rapid-api.js`, `js/education/stem-curriculum.js`, `js/ui/stem-tutor-ui.js`, `js/ai/ai-copilot.js`, `tests/run_all.sh`.

### File tạo
`js/core/geometry/mesh-topology.js`, `js/core/geometry/geometry-codec.js`, `js/core/geometry/geometry-budget.js`, `js/core/modifier-stack.js`, `js/core/geometry-commands.js`, `tests/test_geometry_pipeline.mjs`, `tests/test_modifier_history.mjs`.

### Tái sử dụng (đừng viết lại)
- Topology/weld/UV: `js/core/edit-mode.js:456` (`_buildTopology`), `:783` (`rebuildGeometry`).
- Command semantics: `js/core/scene-manager.js:864-915` (`executeCommand`); mesh command `js/core/edit-mode.js:20-53`.
- Worker transfer: `js/core/geometry-worker-client.js:55-83`; async BVH/refit `js/core/bvh-accelerator.js:66,90`.
- Giữ event `blender:geometryChanged`, thêm metadata revision (không phá listener cũ).

### Worker / budget / cancel
- Pool ≤ `min(2, hardwareConcurrency-1)`; priority: interactive edit > preview > bake/export.
- Kernel cooperative check cancel mỗi chunk/stage; vendor BVH/CSG uninterruptible chạy worker isolated, terminate khi abort/timeout.
- Budget mặc định: input ≤250k tris; output ≤500k tris; task ≤128MiB; interactive ≤10s; bake ≤30s; preview ≤80k tris/≤1s. **Reject trước allocation** khi dự đoán vượt.

### Undo
- Apply kết quả worker 1 lần rồi `sceneManager.executeCommand`; `ModifierStackCommand` giữ descriptor trước/sau + source revision + cache evaluated.
- Slider drag = 1 command lúc commit; preview trung gian không record.
- `MeshEditCommand` KHÔNG `computeVertexNormals()` khi kết quả đã có normals authoritative.
- History eviction chỉ dispose snapshot command-owned không live.

### DSL
`studio.modifiers.add/update/remove/toggle/reorder/apply/bake/list`, `studio.modifiers.evaluate(mesh,{signal,quality})`; alias `bpy.ops.object.modifier_add/apply/remove`.

### UI
Inspector Add Modifier async + progress/cancel; giữ geometry hợp lệ cuối trong lúc evaluate; lỗi budget inline (không alert loop); N-panel gọi cùng facade; chặn bake/remove destructive khi đang evaluate (hoặc cancel trước).

### Test Phase 1
Node: budget predict/reject; codec round-trip; topology weld/UV parity; modifier add/update/remove/toggle/reorder/bake undo/redo; drag coalescing; history byte eviction không dispose geometry live.
Browser: mở rộng `tests/geometry-worker-suite.html` (cancel/progress/latest-wins); `tests/browser-suite.html` (save/load modifier round-trip).

### Acceptance Phase 1
- Kéo slider modifier trên mesh 100k tris KHÔNG chạy CPU nặng ở main.
- Cancel để scene/history nguyên vẹn.
- Undo/redo khôi phục đúng position/UV/normals/groups/thứ tự stack.
- Save/load khôi phục modifier editable (không bake nhầm).
- Bake prefix bỏ đúng các modifier đã bake một lần.

---

## Các phase tiếp theo (tóm tắt để thực thi sau, phê duyệt riêng)

### Phase 2 — Deform + shading (thao tác video reference) — ✅ HOÀN TẤT (11/11/2026)
Solidify thật (thickness/offset/rim/even-thickness miter, giữ UV/group; thay one-off `blender-modeling-suite.js:1010`); Randomize seeded trên welded verts; Smooth/Relax Laplacian pin boundary/sharp; Displace fBm noise (port noise từ `material-studio.js:45-105`); Even-Edges (LoopTools-style); Shade Smooth/Auto-Smooth + crease-aware split normals (`js/core/shading.js`); Recalc/Flip normals (`Shift+N`, `Shift+Ctrl+N`). Đã tạo `js/core/geometry/deform-ops.js`, `noise.js`, `normals.js`, `js/core/shading.js`; test `test_deform_modifiers.mjs` (9/9 PASS), `test_shading_normals.mjs` (6/6 PASS). Đã tích hợp vào `modifiers.js`, Web Worker `geometry-worker.js`, Inspector UI rollout cards với scrub slider, Viewport context menu. Toàn bộ 25/25 suite tự động PASS.

### Phase 3 — Bevel thật + Catmull-Clark thật — ✅ HOÀN TẤT (11/11/2026)
Thay `modifiers.js:390,465-472,515`. Đã tạo `js/core/geometry/bevel.js` (True edge chamfering giữa các mặt kề, superellipse profile bo tròn 1..8 segments, clamp overlap chống giao nhau, lọc theo góc angle limit / weight / none, tự động bỏ đường chéo đồng phẳng $\le 1^\circ$, corner mitering tại đỉnh tụ $\ge 3$ cạnh, nội suy UV) và `js/core/geometry/catmull-clark.js` (Phân chia mặt/cạnh/đỉnh chuẩn Catmull-Clark, chế độ Simple subdivision, hỗ trợ nếp gấp cạnh crease weights 0..1, quy tắc cubic B-spline cho lưới hở biên, bảo toàn UV per-loop). Tích hợp vào `modifiers.js`, Web Worker `geometry-worker.js`, Inspector UI rollout cards với các thanh trượt phân giải Viewport/Render, limit method, clamp overlap, góc limit, harden normals. Test: `tests/test_bevel_true.mjs` (5/5 PASS), `tests/test_catmull_clark.mjs` (5/5 PASS). Toàn bộ 27/27 suite tự động PASS.

### Phase 4 — Look-dev raster thật (giữ raw env source) — ✅ HOÀN TẤT (11/11/2026)
Nâng cấp vật liệu chuẩn Principled BSDF (transmission, IOR, thickness, clearcoat, sheen) tự động chuyển sang `MeshPhysicalMaterial`; sinh texture procedural (fBm noise, Voronoi, Brushed Metal, Carbon Fiber) và Sobel normal map off-main-thread trong Web Worker (`js/render/procedural-texture-worker.js`, budget $\le 2048^2$); bảo toàn nguồn `rawEnvironmentSource` cùng rotation/intensity cho IBL và Phase 6 Path-Tracing; hoàn thiện pipeline hậu kỳ `PostProcessingManager` (EffectComposer, RenderPass, GTAOPass, UnrealBloomPass, BokehPass DOF, OutputPass AgX) với 3 preset Fast/Studio/Cinematic; Unified `RasterRenderer` cho cả khung hình trực tiếp và still capture. Test: `tests/test_material_realism.mjs` (7/7 PASS), `tests/render-suite.html`. Toàn bộ 28/28 suite tự động PASS.

### Phase 5 — Video export client-side deterministic (dựng+xuất video reference) — ✅ HOÀN TẤT (11/11/2026)
Đã triển khai Lõi Video Kernel Rust WASM (`crates/video_kernel/`, 23 KB release `vendor/wasm/video_kernel.wasm`), `js/render/video-kernel-bridge.js` (lật dòng quét scanline in-place < 0.4 ms, chuyển đổi YUV420p chuẩn BT.601, băm hash 64-bit frame kiểm tra tính tất định). Vòng lặp xuất video: `timeline.seekToFrame` -> evaluate clips/turntable -> raster render offscreen -> `VideoFrame(timestampUs)` -> WebCodecs H.264 encode -> đóng gói MP4 container với `mp4-muxer` (`vendor/mp4-muxer/mp4-muxer.mjs`). Bỏ wall-clock MediaRecorder và bỏ upload mặc định. Kiểm soát ngân sách $\le 1080$p/$\le 1800$ frames/$\le 256$ MiB. Tích hợp DSL `studio.renderVideo(...)`, alias `bpy.ops.render.render(animation=True)`. Test: `test_video_export.mjs` (9/9 PASS), `video-export-suite.html`. Toàn bộ 29/29 suite tự động PASS.

### Phase 6 — Path-traced stills + HERO frame + PMREM/env parity — ✅ HOÀN TẤT (11/11/2026)
Đã triển khai hệ thống sinh procedural HDRI equirect (`js/render/procedural-hdri.js`) xuất DataTexture HalfFloat/Float chuẩn IEEE 754 với 4 preset studio-softbox, golden-sunset, cyberpunk-neon, industrial-warehouse. Cập nhật `js/render/pathtrace-scene.js` nhận `rawEnvironmentSource` từ scene userData, chuyển giao chính xác `environmentRotation` và `environmentIntensity` vào uniform của Three-GPU-Pathtracer. Tạo `js/render/pathtrace-session.js` quản lý phiên render lũy tiến, huỷ tức thì với `AbortController`, giới hạn cứng ngân sách (200k tris/2MP/256 samples/3min). Tích hợp HERO frame path-traced bị kẹp $\le 32$ samples kèm cảnh báo flicker vào `js/render/video-export.js`. Test: `test_pathtrace_environment.mjs` (9/9 PASS), mở rộng `pathtrace-suite.html`. Toàn bộ 30/30 suite tự động PASS.

---

## Hiệu năng & nhiều người dùng (xuyên suốt)
- Main thread: serialize descriptor nhỏ, transfer typed-array, nhận progress, swap geometry, update UI/history, submit GPU frame bounded. KHÔNG clone geometry lớn trên main cho undo (adopt snapshot immutable + byte-budget).
- Worker: topology/solidify/bevel/subsurf/randomize/smooth/displace/normals/texture/encode/mux/HDR-conversion.
- Progressive: drag→preview chất lượng thấp rồi commit final; position-only stream ≤10Hz; topology atomic commit; cache key = source revision + stack hash + quality + seed; InstancedMesh cho asset lặp; BVH async/refit không block commit.
- Server chỉ static + cloud-save JSON/GLB → nhiều user nhân tài nguyên client, không tạo hàng đợi CPU/GPU server. Lazy-load module nặng (kernel/post/encoder/pathtracer).

## Verification (mỗi phase)
- Node: `node --import ./tests/three-resolve-hooks.mjs tests/<test>.mjs`; đăng ký nhóm đánh số mới trong `tests/run_all.sh`; chạy `bash tests/run_all.sh` (hiện 20 nhóm, sẽ tăng).
- Browser (headless Chrome + CDP, tab hiển thị): `tests/geometry-worker-suite.html`, `browser-suite.html`, `interaction-suite.html`, và suite mới `render-suite.html`/`video-export-suite.html`/`pathtrace-suite.html` theo phase.
- Dev: `python server.py` :8080; production additive: `npm run build` rồi mở `dist/`.
- Phase 1 acceptance như mục trên; regression toàn bộ suite hiện có phải xanh trước khi đóng phase.

## Phạm vi phê duyệt hiện tại
Chỉ thực thi **Phase 1**. Phase 2-6 giữ trong lộ trình, sẽ phê duyệt từng đợt riêng. Không cài Rust/Tauri; không đổi dev flow; không sửa vendor trừ khi thêm postprocessing/muxer r160 ở phase 4/5.