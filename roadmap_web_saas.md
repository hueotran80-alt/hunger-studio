# Lộ trình Thương mại hoá — Web Blender Studio (Web-Native SaaS)

> Tệp này là **bảng theo dõi tiến độ** của lộ trình 4 giai đoạn trong [AGENTS.md](AGENTS.md#3-lộ-trình-thực-thi-4-giai-đoạn).
> Cập nhật lần cuối: **26/11/2026** — Sau đợt vá P0, `bash tests/run_all.sh` đạt **68/68 nhóm, exit 0**: Python **124/124**, agent **16/16**, Rust **47/47**, browser **14/14 suite / 208 kiểm tra**, production `dist/` **9/9**. Build mới: **80,7 MB / 128 file**, entry **275,99 kB gzip**, **34,15 s**. Inspector XSS, cô lập Copilot/`agent.exec`, Supabase private Storage và refund-before-paid đã có regression cục bộ; xem `AUDIT.md` §13.
> **P0 Copilot đã mở lại và đóng lại sau hồi quy thực tế:** Copilot/STEM demo dùng dedicated Worker + scene mirror + command allowlist + transaction; `agent.exec` dùng Worker riêng. Guard **26/26**, Copilot Worker **17/17**, `agent.exec` isolation **7/7**, browser **43/43**. Server dev phải khởi động lại để Worker nhận CSP; Live Voice echo guard chặn lệnh điều hướng từ loa; serializer bỏ qua material null không hợp lệ.
> **Chưa thể public thương mại:** schema Supabase chưa áp live, còn edge refund external-ID-only; SePay/LemonSqueezy/Supabase thật, Docker/CI thật, thông tin liên hệ pháp lý và các hạn chế P1/P2 chưa hoàn tất. Gate xanh không thay thế kiểm chứng deployment.
> Mọi mục ghi ✅ **đều kèm test chạy được**; mục ⏳ là chưa làm; ⚠️ là làm được nhưng còn hạn chế đã đo.

## Bảng tổng quan

| Giai đoạn | Mục | Trạng thái | Test chứng minh |
|---|---|---|---|
| 1.1 | Pose tracking chạy trong trình duyệt (WASM), WebCodecs VideoDecoder tuần tự | ✅ (09/11/2026) | `tests/test_mocap_filters.mjs` (31), `tests/mocap-suite.html` (15), `tests/webcodecs-suite.html` (10/10) |
| 1.2 | 1-Euro filter + Foot-Lock IK chống trượt chân | ✅ | `tests/test_mocap_filters.mjs`, `tests/test_mocap_parity.py` (3) |
| 1.3 | Xuất GLB kèm `AnimationClip` + nhận rig Mixamo/VRM/CC | ✅ | `tests/test_glb_animation.mjs` (8), `tests/test_rig_mapping.mjs` (5), `tests/test_timeline_clip_playback.mjs` (9), `tests/godot_import_check.sh`, `tests/mocap-suite.html` (15) |
| 1.4 | Module toán chung `js/animation/mocap-math.js` — bỏ phần tính trùng lặp giữa `mocap-ui.js`, `camera-framing.js`, `mocap-filters.js`, `mocap-retargeter.js` | ✅ | `tests/test_mocap_math.mjs` (5), toàn bộ `tests/run_all.sh` (10 nhóm) |
| 2.1 | BVH/CSG chọn đỉnh, cắt Boolean + Web Worker mesh nặng + Nền Geometry Pipeline Phase 1 | ✅ (11/11/2026) | `tests/test_bvh_csg.mjs` (9), `tests/test_geometry_pipeline.mjs` (20), `tests/test_modifier_history.mjs` (5), `tests/geometry-worker-suite.html` (8/8), `bash tests/run_all.sh` (23 nhóm) |
| 2.2 | AI Copilot lắp ghép Prefab `.glb` | ✅ | `tests/test_prefab_library.mjs` (7), toàn bộ `run_all.sh` (12 nhóm) |
| 2.3 | Image-to-3D qua API thương mại ổn định | ✅ | `tests/test_image_to_3d_provider.py` (9), toàn bộ `run_all.sh` (12 nhóm) |
| 3.1 | Vite bundler (Additive production build, giữ dev server) | ✅ (09/11/2026) | `npm run build`, `dist/` ~6.3s, `vite.config.js` |
| 3.2 | Share/Embed 1-click (`?view=embed`, `#z=` payload) | ✅ | `tests/test_embed_core.mjs` (18), `tests/embed-suite.html` (6), `tests/browser-suite.html` (23/23) |
| 3.3 | Auth + Cloud save + Billing | ✅ mã nguồn; live chưa kiểm | `tests/test_cloud.py` (48/48), `tests/test_cloud_client.mjs` (17/17), `tests/cloud-suite.html` (11/11); private Storage/signed URL và refund-before-paid đã vá cục bộ, còn áp schema Supabase thật và edge refund external-ID-only |
| 2.4 | Rust mesh kernel (weld/topology/subdiv 30–40k tris: ~1.500–3.000 ms → 7–10 ms) | ✅ 11/11/2026 | `tests/test_mesh_kernel.mjs`, `run_all.sh` nhóm 21 |
| 2.5 | Deform modifiers (Solidify/Displace/Smooth/Randomize/EvenEdges) + Auto-Smooth normals | ✅ 11/11/2026 | `test_deform_modifiers.mjs` (9/9), `test_shading_normals.mjs` (6/6) |
| 2.6 | True Bevel + True Catmull-Clark (crease, simple mode, UV per-loop) | ✅ 11/11/2026 | `test_bevel_true.mjs` (5/5), `test_catmull_clark.mjs` (5/5) |
| 2.7 | Principled BSDF + procedural texture worker + post-processing (GTAO/Bloom/DOF/AgX) | ✅ 11/11/2026 | `test_material_realism.mjs` (7/7), `tests/render-suite.html` |
| 2.8 | Video export client-side: Rust video kernel + WebCodecs H.264 + MP4 muxer | ✅ 11/11/2026 | `test_video_export.mjs` (9/9), `tests/video-export-suite.html` |
| 2.9 | Path-traced stills, HERO frame, procedural HDRI + environment parity | ✅ 11/11/2026 | `test_pathtrace_environment.mjs` (9/9), `tests/pathtrace-suite.html` (18/18) |
| 2.10 | Rust CPU path tracer (BVH2/BVH4, GGX/clearcoat/transmission, NEE+MIS, denoise, AgX) + `rk_cli` | ✅ 12/11/2026 | `cargo test --release` (8), `test_rust_render.mjs` (9), `run_all.sh` 31/31 |
| W0 | Storage: OPFS/IDB BlobStore, DataBlocks, schema v5, autosave, `.wbs` ZIP | ✅ 11/2026 | `tests/test_wave0_storage.mjs` |
| W1 | Interchange: FBX 7.4 full, USDZ, 3MF, game pack (LOD/UCX/UV2) | ✅ 11/2026 | `tests/test_wave1_interchange.mjs` (6) |
| W2 | Surface: vertex/texture paint, Rust bake, shader node graph, asset browser | ✅ 11/2026 | `tests/test_wave2_surface.mjs` (5) |
| W3 | Modeling: curves/Text3D, 10 pro modifiers, subdiv levels, collections, dyntopo | ✅ 11/2026 | `tests/test_wave3_modeling.mjs` (5) |
| W4A | Graph Editor: Bezier solver, handles, extrapolation, undo, JSON | ✅ 11/2026 | `tests/test_wave4a_graph_editor.mjs` (5) |
| W4B | Actions, NLA mixer, sandboxed drivers | ✅ 11/2026 | `tests/test_wave4b_nla_drivers.mjs` (6) |
| W4C | Bone-heat auto weights, vertex groups, armature pro, IK/FK blend | ✅ 11/2026 | `tests/test_wave4c_rig_vertex.mjs` (6) |
| — | Blender Pro tools, workspace split/join, UV pipeline, Sculpt 2.0, image objects | ✅ 11/2026 | `test_blender_pro_tools.mjs`, `test_workspace_areas.mjs`, `test_uv_unwrap.mjs`, `test_sculpt_2.mjs`, `test_mouse_interaction.mjs`, `test_image_add.mjs` |
| — | **Thu gọn asset cho bản public** (policy + catalog lọc tự động) | ✅ 18/11/2026; đo lại 26/11/2026 | `npm run build` → 80,7 MB / 128 file, 0 file > 25 MB; entry 275,99 kB gzip; 6 Studio asset / 2.396 catalog item |
| — | **STEM Live Voice** (nghe liên tục, tự gửi sau khoảng lặng, barge-in, wake word, tự restart, echo guard chống lệnh từ loa) | ✅ 18/11/2026; hồi quy 26/11/2026 | `tests/test_stem_voice_session.mjs` (20/20), `tests/test_voice_wake_and_walkthrough.mjs` (11/11) |
| — | **AI Live Scene Digest** (hierarchy/poly/material/clip/selection trong prompt) | ✅ 18/11/2026 | `tests/test_scene_digest.mjs` (14/14) |
| — | **Agent tool-calling additive** (60 tool, JSON protocol, approve/timeout, runtime install) | ✅ 18/11/2026 | `tests/test_agent_tool_bridge.mjs` (25/25) + E2E Chromium |
| — | **Copilot/STEM Worker isolation + `agent.exec` Worker** (scene mirror, CSP/capability denial, command allowlist, transaction/conflict, asset staging) | ✅ mã nguồn và regression 26/11/2026 | guard **26/26**, Copilot Worker **17/17**, `agent.exec` isolation **7/7**, browser **43/43**, production `dist/` **9/9**, full gate **68/68** |
| — | **Boot optimization** (ShareDialog lazy, mocap lazy import, Rapier lazy) | ✅ 18–25/11/2026; build đo lại 26/11/2026 | server import 2,52 s → 0,65 s; entry Vite **`275,99 kB` gzip** (< 350 KB) |
| W1–3 | **Đợt 1–3 Audit Fix** (bảo mật/XSS, xoá `film`, `.wbs` Rig/Undo, Look-Dev/UV/Sculpt/Physics/UI, Mocap/PT/Embed AR/STEM/MCP) | ✅ 25/11/2026 | `test_wave1_bleeding_fixes.mjs` (11), `test_wave2_fixes.mjs`, `test_wave3_fixes.mjs` (16); browser 13/14 lượt đầu, chaos-ui chạy lại 7/7 |
| — | **Đợt 4 Pháp lý, Cloud Hardening, Bundle & CI** (`Mannequin_CC0`/`Bot_CC0`, legal docs, billing refund/account/expiry/test_mode, GDPR export/delete, `HttpOnly` + singleflight, `/api/cloud/ai/chat` + BYOK, `/healthz` + CSP, bỏ Google TTS scraper, `Dockerfile` + `.github/workflows/ci.yml`) | ⚠️ mã nguồn và full gate xong 26/11; live chưa kiểm | `test_cloud.py` (48/48), `test_security.py` (35), `test_cloud_client.mjs` (17), `47/47` Rust 4 crates, browser **208 kiểm tra**, `dist/` gate **9/9**, full gate **68/68**; Supabase schema chưa áp live |
| 5.1 | Rapier rigid body + Physics dock + bake timeline | ✅ | `tests/test_simulation_manager.mjs` (37), `tests/interaction-suite.html` (28/28), `run_all.sh` (20 nhóm) |
| 5.2 | Fixed/Revolute joint: local anchors/axes, undo, JSON, duplicate, bake | Xong 05/11/2026 | `test_simulation_manager.mjs`, `test_scene_history.mjs` (14/14), interaction-suite |
| 5.2+ | Revolute motor (Tắt/Tốc độ/Vị trí/Servo) + giới hạn góc, undo/redo, JSON, duplicate, bake; chưa soft body/cloth | ✅ 08/11/2026 | `test_simulation_manager.mjs` (51/51), `tests/interaction-suite.html` (42/42), `run_all.sh` (20 nhóm) |
| — | Viewport Orthographic (Numpad 5) + Numpad `.` focus Edit Mode; lưu project JSON, PNG/WebM đúng phép chiếu | ✅ 07/11/2026 | `tests/interaction-suite.html` (42), `tests/browser-suite.html` (23), `tests/mocap-suite.html` (15) |
| — | Rà soát quyền sở hữu phím + undo toàn cảnh | ✅ | `tests/interaction-suite.html` (42), `tests/test_scene_history.mjs` (14), `tests/test_light_helper.mjs` (6), `tests/browser-suite.html` (23/23) |
| 4.1 | STEM Mode (giáo trình 3D chấm điểm tự động + Icon Agent bay chỉ dẫn + Giọng nói 1-1) | ✅ 07/11/2026 | `tests/test_stem_tutor.mjs` (7/7), `tests/browser-suite.html` (23/23), `bash tests/run_all.sh` (20 nhóm) |
| 4.2 | Path Tracing PNG (web); đóng gói desktop đã bỏ khỏi lộ trình | ✅ PNG có; desktop không thuộc phạm vi | `tests/test_pathtrace_scene.mjs` (120), `tests/pathtrace-suite.html` (16 GPU/UI) |

---

## Giai đoạn 1 — Zero-Server-GPU Mocap ✅ (lõi xong)

### 1.1 Client-side WASM/WebGPU Mocap — ✅

**Đã làm**

- `js/animation/browser-mocap.js` — `BrowserMocapEngine`:
  - Nạp `@mediapipe/tasks-vision@0.10.14` **vendored** tại `vendor/mediapipe/` (18 MB: `vision_bundle.mjs` + 4 tệp WASM) → chạy **offline**, không cần CDN, không cần Python.
  - Model `models/pose_landmarker_full.task` (9 MB) phục vụ tại chỗ; nếu thiếu thì tự rơi xuống CDN.
  - `delegate: GPU` → tự fallback `CPU` khi máy không có WebGL2.
  - `processVideo(video, ...)`: seek từng mốc thời gian, **copy frame sang canvas 640 px** rồi mới suy luận (MediaPipe WASM không đọc được texture của `<video>` vừa seek trong Electron/Chromium — đây là lỗi thật đã gặp và đã sửa).
  - Kết quả trả về **đúng schema server** (`success, fps, videoFps, duration, numFrames, landmarks2D, mocapFrames, …`) nên phần retarget/overlay không phải sửa gì.
  - `AbortController` để huỷ giữa chừng; `dispose()` đóng landmarker (giải phóng WASM/GPU).
- `js/ui/mocap-ui.js` — thêm **“Nơi xử lý AI”**: `Trình duyệt (WASM · 0 đ server)` (mặc định) / `Server (Python MediaPipe)`. Thanh tiến trình hiển thị fps + ETA thật của trình duyệt.
- `mocap_engine.py` vẫn được giữ nguyên làm fallback CLI/server.

**Đo thực tế (cùng máy, cùng 120 frame `shuffle_dance.mp4`)**

| Đường xử lý | Thời gian | Tốc độ | Chi phí server |
|---|---|---|---|
| Python server (`mocap_engine.process_video`) | 38,63 s | 3,1 fps | CPU server |
| Trình duyệt (WASM, `frameStep=2`, seek) | 27,75 s | 4,3 fps | **0** |
| Trình duyệt (WebCodecs `VideoDecoder` tuần tự) | **0,37 s / 60f** | **161,8–230,9 fps** (decode) | **0** |

✅ **Nâng cấp WebCodecs VideoDecoder tuần tự (09/11/2026):**
- Sử dụng demuxer WebM gọn nhẹ (VP8/VP9/AV1) và MP4Box vendored (`vendor/mp4box/` cho MP4/H.264) trực tiếp trong trình duyệt, cấp frame tuần tự qua `VideoDecoder` iterator `openVideoFrameStream` (`js/animation/video-decoder.js`).
- Loại bỏ hoàn toàn độ trễ seek từng frame; tự động fallback về đường seek nếu trình duyệt không có WebCodecs hoặc demux lỗi.
- Chuẩn hoá reorder presentation order cho H.264 B-frame; unwrap `landmarkerFactory` stub trong `BrowserMocapEngine.init`.
- Tốc độ giải mã nhanh hơn **5,0× – 7,2×** so với seek. Test: `tests/webcodecs-suite.html` (10/10 PASS).

**Test**

- `tests/test_mocap_filters.mjs`: map landmark → 17 khớp, schema 21 khoá, shape lồng `[[33 landmarks]]`, huỷ, lỗi sampler, `dispose`.
- `tests/mocap-suite.html`: “Model MediaPipe thật (vendored WASM) chạy trên video mẫu” → **8/8 frame nhận dạng, 100%**, `engine: browser-wasm`.

### 1.2 Foot-Lock IK + 1-Euro Filter — ✅

**Đã làm**

- `js/animation/mocap-filters.js` — cổng JS thuần (không phụ thuộc Three.js) của pipeline Python:
  `gapFillSeries` → `filterJointSeries` (1-Euro) → `enforceBoneLengths` → `computeRootTrajectory` → `buildMocapFrames` → `detectFootContacts` / `applyFootLock`.
- **Foot-Lock IK**: phát hiện bàn chân chạm sàn theo *độ sâu so với hông* + tốc độ ngang (có hysteresis, **không phụ thuộc quy ước trục Y**), rồi neo cổ chân vào điểm chạm, giữ nguyên độ dài cẳng chân bằng cách giải lại độ cao so với đầu gối; ngón chân đi theo cổ chân.
- `MocapRetargeter.retarget()` nhận `options.footLock` (mặc định bật) và trả `footLock: {left, right}` để UI hiển thị.
- UI có ô **“Khoá bàn chân (Foot IK)”**.

**Test**

| Test | Kết quả |
|---|---|
| `detectFootContacts` nhận chân trụ / bỏ chân nhấc | ✅ |
| Độc lập quy ước trục Y (y-down MediaPipe vs y-up Three) | ✅ |
| Trượt chân 0,25 m → **0,0000 m** sau khi khoá | ✅ |
| Chân không chạm sàn giữ nguyên | ✅ |
| Độ dài cẳng chân không co giãn | ✅ |
| **Parity**: 1-Euro JS vs Python lệch < 1e-6; bone-length lệch < 1e-4 | ✅ |
| Retarget nhân vật thật (Michelle.glb) + foot-lock: 36 frame, 21 track | ✅ |
| Tư thế đứng: hông 1,026 · đầu 1,369 · hai chân 0,115 (dưới hông) | ✅ |

### 1.3 Rig Mixamo/VRM + xuất GLB kèm Animation — ✅ (02/11/2026)

**Đã làm**

- **Nút “⬇ Xuất GLB kèm hoạt cảnh”** (`MocapUI.exportAnimatedGLB`) trong card 3 của panel Mocap:
  xuất nhân vật đang áp mocap + `AnimationClip` của retargeter thành **một** `<tên>_mocap.glb`.
  Trả về `{blob, buffer, filename}` nên test kiểm chứng được chính file người dùng tải về.
- **Sửa lỗi exporter**: track trỏ tới node ngoài phạm vi xuất bị loại bỏ, và **clip còn 0 track bị bỏ**
  (trước đây clip rỗng vẫn sinh `animations[0]` rỗng trong file → Blender import ra action trống).
- **Rig VRM/VRoid**: `stripName()` hiểu `J_Bip_C_Hips`, `J_Bip_L_UpperArm`… và chuyển **bên L/R thành
  hậu tố** (`upperarml`, `footl`) để dùng lại bộ alias sẵn có mà không mất phân biệt trái/phải.
- **Character Creator**: bỏ tiền tố `CC_Base_`, thêm `leftupperleg`/`leftlowerleg`, và pass 3 cho phép
  mượn `CC_Base_NeckTwist01` làm xương cổ khi rig không có xương cổ trơn.
- Bộ đọc GLB độc lập `tests/glb-inspect.mjs` (không phụ thuộc Three.js/DOM) giải mã accessor trong
  BIN chunk → chứng minh keyframe **thật sự nằm trong file**, không chỉ có tên clip trong metadata.
- **Play trong Studio phát clip đã áp**: `TimelineEngine.attachClip()` gắn `AnimationClip` (mocap hoặc
  clip của file `.glb` import) vào vật thể và dùng `AnimationMixer` đặt thời điểm theo frame — nút Play
  và thanh tua phát đúng hoạt cảnh; `detachClip()` trả nhân vật về bind pose.

**Đo / bằng chứng**

| Kiểm chứng | Kết quả |
|---|---|
| Xuất Michelle.glb thật (36 frame, foot-lock) | **1.772,6 KB** · 1 animation · clip `Mocap_MediaPipe_Action` · 21 channel · 756 keyframe · 1,17 s |
| Keyframe quaternion trong BIN so với clip gốc | lệch < 1e-5 |
| Import lại bằng `GLTFLoader` | 65 xương · 21 track · mixer chạy |
| Rig map: VRM/VRoid | 18/18 xương lõi, đúng trái/phải |
| Rig map: Mixamo | 20/20 xương, bỏ qua ngón tay |
| Rig map: Character Creator | 18/18 xương lõi (neck → `NeckTwist01`) |
| Retarget lên skeleton VRM | 20 track, tên `J_Bip_*`, duration 0,77 s |
| Đối chứng âm (xuất không kèm animation) | bộ kiểm tra **phải** FAIL — và đã FAIL |
| **Import bằng Godot 4.7.2** (headless, engine thật) | 65 xương · clip `Mocap_MediaPipe_Action` **7,93 s** · **21/21 track giải được node** · 17/65 xương xoay · hông dịch theo track |
| Cùng file, fixture tự sinh 20 xương | 20 xương · 20 track · 19/20 xương chuyển động |
| **Play trong Studio** (timeline attachClip) | 0,5 s Play → xương tay xoay **17,73°**, frame 0 → 15; tua frame 10 đổi pose |

**Test**: `tests/test_glb_animation.mjs` (8) · `tests/test_rig_mapping.mjs` (5) · `tests/test_timeline_clip_playback.mjs` (9) ·
`tests/godot_import_check.sh` (import headless bằng Godot) · `tests/mocap-suite.html` 2 test mới (11 tổng).
File minh chứng: `audit/godot-import-demo.glb` (do chính Studio xuất) và `audit/godot-import-result.txt`.

> **Godot có thể bỏ bớt track**: importer của Godot tối ưu hoá và **xoá track hằng số**. Một take
tổng hợp gần như đứng yên (max lệch < 0,001 rad) chỉ còn 6 track sau import — đó là hành vi đúng
của Godot, không phải mất dữ liệu. Take thật từ video giữ đủ 21 track.

**Hạn chế (không tính là xong)**

- Đã import được bằng **Godot 4.7.2**; **Blender và Unity chưa thử** (máy chưa cài).
- Chưa có `.vrm` mẫu: mới kiểm chứng quy ước đặt tên VRM, chưa chạy trên file VRM thật (spring bone ngoài phạm vi).
- Xuất kèm texture nhúng; chưa có tuỳ chọn Draco/KTX2 để giảm dung lượng.

### 1.4 Module toán chung mocap-math.js — ✅ (02/11/2026)
**Đã làm**
- `js/animation/mocap-math.js` — module **thuần toán, không DOM/Three.js**:
  - `median()` (bỏ NaN), `clamp()`, `closestFrameIndexByTime()` (binary search
    timestamp, nhận cả mảng số lẫn mảng `{time}`) và `POSE_BONE_CONNECTIONS`
    (26 cặp khớp MediaPipe dùng vẽ overlay 2D).
- Nối các module dùng chung, xoá bản copy trùng lặp:
  - `js/ui/mocap-ui.js`: `_findClosestFrameIndex()` gọi `closestFrameIndexByTime()`;
    `this.boneConnections` = `POSE_BONE_CONNECTIONS` (bỏ khối khai báo tay 16 dòng).
  - `js/animation/camera-framing.js` + `js/animation/mocap-filters.js`: bỏ 2 bản
    `median()` riêng (trước đây hành vi bỏ NaN lệch nhau), `clamp()` dùng chung.
  - `js/animation/mocap-retargeter.js`: bỏ khối sort tay tính median `midHip`
    (step 7) — giờ mỗi trục 1 dòng `medianOf()`.
- **Test mới** `tests/test_mocap_math.mjs` (5 test) + thêm nhóm `5/10` vào
  `tests/run_all.sh` (trước đây 9 nhóm).

**Đo / bằng chứng**
| Kiểm chứng | Kết quả |
|---|---|
| `tests/test_mocap_math.mjs` | 5/5 PASS |
| Regression: mocap filters (31) · camera framing (9) · rig mapping (5) · timeline clip (9) · GLB (8) · Godot import | tất cả PASS |
| `bash tests/run_all.sh` (10 nhóm) | **ALL AUTOMATED SUITES PASSED** |

---

### 2.1 BVH picking + CSG Boolean — ✅ (02/11/2026)
**Đã làm**
- Vendored **`three-mesh-bvh@0.9.0`** + **`three-bvh-csg@0.0.17`** (bản ESM build,
  chỉ import `three` — tương thích three.js r160 của dự án) vào `vendor/`, khai
  báo thêm 2 alias trong import map của `index.html`.
- `js/core/bvh-accelerator.js` (mới): `ensureBVH()` build lazy `geometry.boundsTree`
  (cache theo `geometry.uuid + position.version`), `refitBVH()` cho kéo đỉnh,
  `disposeBVH()` khi thoát Edit Mode; lỗi build tự rớt về raycast tuyến tính.
- `js/core/edit-mode.js`:
  - `enter()` build BVH; `_buildTopology()` ensure lại sau mỗi lần đổi topology;
    `_syncBufferPositions()` chỉ **refit** (rẻ hơn build lại) khi kéo Gizmo;
    `exit()` giải phóng.
  - `handleRaycast()` dùng BVH lấy ứng viên tam giác gần tia nhấp trước, rồi mới
    quét đỉnh/cạnh **chỉ trên ứng viên** — chọn đỉnh/cạnh trên mesh hàng trăm
    nghìn đa giác không còn O(N) mỗi cú click. Chế độ mặt đi qua boundsTree tự
    động của `Raycaster`.
- `js/core/modifiers.js` thêm **Boolean thật** (`three-bvh-csg`):
  - `performBoolean(meshA, meshB, op)` — `difference / union / intersect`, chạy
    trong **world space** rồi quy kết quả về **local của mesh A** nên gắn thẳng
    vào mesh gốc không lệch vị trí (kể cả khi A/B đã xoay/dịch/scale).
  - `applyBoolean()` áp ngay lên mesh chính; expose qua `window.modifiers`.
- Hook resolve `three-mesh-bvh` / `three-bvh-csg` thêm vào
  `tests/three-resolve-hooks.mjs`; nhóm test **8/11** mới trong `run_all.sh`.

**Đo / bằng chứng**
| Kiểm chứng | Kết quả |
|---|---|
| `tests/test_bvh_csg.mjs` | 9/9 PASS |
| Difference khoan lỗ xuyên giữa hộp (ray qua tâm chẵn số hit) | ✅ |
| Union/intersect với mesh đã dịch → đúng bao hình, quy về local A | ✅ |
| Regression toàn bộ `run_all.sh` (11 nhóm, gồm Godot headless) | **ALL PASSED** |

**Hạn chế (không tính là xong)**
- Web Worker: chưa đẩy build BVH/CSG sang worker (vẫn main thread); là bước
  kế tiếp khi mesh > 1M tri.
- UI Boolean (menu chọn 2 mesh + op) chưa có — hiện gọi được qua
  `window.modifiers.performBoolean/applyBoolean` hoặc DSL.

---

### 2.2 AI Copilot Modular Prefab Assembly — ✅ (02/11/2026)
**Đã làm**
- `js/scripting/prefab-library.js` (mới):
  - Catalog prefab `.glb` có sẵn (michelle / soldier / head_scan) với id, từ
    khoá tìm kiếm (tiếng Việt không dấu + English), chiều cao chuẩn (m) và
    cờ rigged; `register()` cho phép thêm asset mới.
  - `search()` chấm điểm khớp mô tả tự nhiên; `loadTemplate()` nạp + cache
    template đã normalize về chiều cao chuẩn; `place()` clone, scale theo
    `height` (mét) hoặc `scale`, tự quay Soldier 180° theo quy ước, bật
    shadow, đăng ký vào SceneManager qua `_register()`.
  - `describeForAI()` sinh đoạn text ngắn liệt kê prefab + cú pháp gọi để
    nhúng vào **system prompt của Copilot** (không ngốn token).
- `js/scripting/rapid-api.js`: thêm `studio.placePrefab(id, opts)` (async,
  bắt lỗi log ra code editor), `studio.listPrefabs()`, `studio.searchPrefabs()`;
  expose `window.prefabLibrary`.
- `js/ai/ai-copilot.js`: system prompt giờ có mục **PREFAB LIBRARY** và rule
  "nhân vật/người → LUÔN `await studio.placePrefab(...)` thay vì dựng người
  bằng addCube/addSphere".
- **Test mới** `tests/test_prefab_library.mjs` (7 test, mock RapidStudio,
  không cần tải .glb) — nhóm 10/12 trong `run_all.sh`.

**Đo / bằng chứng**
| Kiểm chứng | Kết quả |
|---|---|
| `tests/test_prefab_library.mjs` | 7/7 PASS |
| `describeForAI()` liệt kê đủ 3 prefab + cú pháp | ✅ |
| Regression `run_all.sh` (12 nhóm) | **ALL PASSED** |

**Hạn chế (không tính là xong)**
- Catalog prefab chỉ gối đầu bằng 3 asset có sẵn trong repo; cần bổ sung mảng prefab phong phú hơn (cây, xe, nội thất — Draco/KTX2).
- Copilot offline NLP parser chưa biết tự map từ khoá tiếng Việt sang `placePrefab` (chỉ LLM online đọc được prompt mới); nếu muốn offline cũng dùng prefab, cần thêm rule parser.
- Chưa có UI browsable gallery cho prefab (Copilot dùng được ngay, UI để sau).

### Hotfix 2.2b — Camera-guard & Animation Engine-bridge (02/11/2026)
**Triệu chứng người dùng báo**: AI dựng xong mô hình thì **mất kiểm soát camera**;
AI **nói có animation nhưng không thấy gì chạy**.
**Nguyên nhân gốc**
1. AI sinh code tự dịch chuyển camera viewport (`engine.camera.position.set(...)`,
   `controls.target.set(...)`, `controls.enabled = false`, thậm chí
   `setupProStudio({ withTurntable: true })` — turntable **chiếm quyền** camera
   mỗi frame nên chuột không quay/zoom được).
2. `studio.animate()` trước đây chạy **RAF riêng** trong khi engine render loop
   (`engine.isRunning`) cũng đang chạy → 2 vòng lặp cạnh tranh, callback update
   bị gọi lệch nhịp/“đè” — animation trông như đứng yên hoặc giật.

**Đã sửa**
- `js/ai/ai-copilot.js` — sanitizer khi chạy code AI:
  - Vô hiệu `engine.camera.position.set/copy/...`, `controls.target.set/copy`,
    `controls.enabled = ...`, `camera.lookAt(...)`, tự tắt `withTurntable: true`.
  - System prompt thêm mục **CRITICAL CAMERA RULES** (cấm đụng camera người
    dùng, chỉ ĐỂ TẠO camera object khi cần) + **ANIMATION HONESTY RULES**
    (chỉ báo "có animation" khi code thật sự đăng ký `studio.animate()` hoặc
    keyframe + `playAnimation()`, và ghi rõ xem ở đâu).
- `js/scripting/rapid-api.js`:
  - `animate()` giờ **bridge vào `engine.addRenderCallback`** khi engine đang
    chạy (cùng nhịp render, không còn RAF riêng); giữ RAF fallback khi engine
    chưa start.
  - `setTurntable(true)` log cảnh báo rõ: camera bị chiếm, cách tắt
    (`studio.setTurntable(false)`).
- **Test mới** `tests/test_copilot_camera_guard.mjs` (5 test): sanitizer chặn
  đủ các mẫu camera-hijack, prompt chứa luật mới, animate bridge đúng engine
  callback + stopAnimations gỡ sạch, RAF fallback hoạt động. Nhóm `10b` trong
  `run_all.sh`.

| Kiểm chứng | Kết quả |
|---|---|
| `tests/test_copilot_camera_guard.mjs` | 5/5 PASS |
| Regression toàn bộ `run_all.sh` (12 nhóm) | **ALL PASSED** |

---

### 2.3 Cloud Image-to-3D API ổn định — ✅ (02/11/2026)
**Đã làm**
- `hunyuan3d_engine.py` thêm **lớp provider thương mại** cạnh Gradio/HF:
  - **Tripo3D** (`api.tripo3d.ai/v2/openapi`): submit `image_to_model` (base64
    PNG/JPEG) → poll `/task/{id}` → lấy `model.url` GLB.
  - **Meshy.ai** (`api.meshy.ai/openapi/v2/image-to-3d`, model meshy-5):
    submit `image_url` data-URI → poll status `SUCCEEDED/FAILED` → lấy
    `model_urls.glb.url`.
  - **Fal.ai** (`queue.fal.run/fal-ai/triposr/image-to-3d`): submit → poll
    `/requests/{id}/status` rồi `/requests/{id}` → lấy `mesh_file`/`glb_url`.
  - Pipeline chung `_run_provider_generation()`: submit → poll có progress
    cập nhật % + ETA → tải GLB về `models/hunyuan_outputs/` → đo số
    đỉnh/mặt/bbox bằng `_inspect_glb()` (đọc JSON chunk thật của file) →
    stats + outputGlb y hệt luồng Hunyuan cũ nên UI không cần đổi gì.
  - **API key**: env `TRIPO_API_KEY` / `MESHY_API_KEY` / `FAL_KEY` → fallback
    config `hunyuan3d.providerKey` (ghi 0600 như hfToken); `_public_config()`
    luôn ẩn key, chỉ báo `providerKeyConfigured`.
- `server.py`: `/api/hunyuan3d/config` giờ trả config đã qua `_public_config()`
  (không lộ providerKey lẫn hfToken).
- `js/ui/hunyuan3d-ui.js`: config tray thêm select **Nhà cung cấp**
  (Hunyuan mặc định / Tripo3D / Meshy / Fal) + ô API Key; nút Lưu gửi
  `mode` + `providerKey`; `generate()` luôn kèm lựa chọn hiện thời.
  Gradio/HF/Colab giữ nguyên làm fallback.
- **Test mới** `tests/test_image_to_3d_provider.py` (9 test, mock urlopen —
  không gọi mạng thật): key resolution + ẩn key, payload submit đúng schema
  từng provider, state machine poll Tripo/Meshy, extract GLB URL từng
  provider, inspector bbox GLB thật.

**Đo / bằng chứng**
| Kiểm chứng | Kết quả |
|---|---|
| `tests/test_image_to_3d_provider.py` | 9/9 PASS |
| Regression `run_all.sh` (12 nhóm) | **ALL PASSED** |
| `node --check` hunyuan3d-ui.js / prefab-library.js | OK |

**Hạn chế (không tính là xong)**
- Chưa chạy live với key thật (cần tài khoản Tripo/Meshy/Fal); endpoint +
  schema bám tài liệu công khai, payload đã mô phỏng đúng qua mock.
- Multi-view (4 ảnh) chỉ có trên luồng Hunyuan; provider thương mại nhận 1 ảnh.

---

## Giai đoạn 2 — Lõi 3D & AI thực chiến — ✅ HOÀN TẤT (2.1 – 2.10)

Cả 3 mục đã xong. Ghi chú kỹ thuật đã khảo sát:

- `three-mesh-bvh` + `three-bvh-csg`: **ĐÃ VENDORED & TÍCH HỢP (2.1 ✅)** — xem mục 2.1. Ghi chú còn lại: Web Worker cho build BVH/CSG khi mesh > 1M tri.
- Nên làm cùng lúc với Web Worker để không chặn UI (đã có tiền lệ `Outliner` gộp render theo rAF).
- AI Copilot (`js/ai/ai-copilot.js`, 2.841 dòng) hiện sinh code `addCube/addCylinder`; hướng nâng cấp: registry Prefab `.glb` + `StudioLoader`.

## Giai đoạn 3 — Web SaaS ✅ (3.1 – 3.3)

### 3.2 Share / Embed 1-Click — ✅ (02/11/2026)

**Đã làm**

- `embed.html` — trang xem 3D siêu nhẹ, chỉ nạp `three` + `GLTFLoader` (+Draco) + `OrbitControls`, **không** nạp editor/agent/AI. Nạp được:
  - `embed.html?glb=<URL .glb>` (tương đối, http(s) hoặc blob),
  - `embed.html#z=<gzip+base64url>` (mô hình nằm trong fragment, **không gửi lên server**),
  - `index.html?view=embed&...` → tự chuyển hướng sang `embed.html` (bỏ `token` khỏi URL).
- `js/embed/embed-core.js` — protocol thuần JS (không DOM/Three): duyệt và làm sạch tham số, chặn `javascript:`/`data:text/html`, gzip + base64url, giới hạn 96 KB, build link + mã `<iframe>`, chọn clip theo tên/độ dài.
- `js/embed/embed-viewer.js` — camera tự canh khung; **đo bounds bằng mẫu đỉnh đã skin** (không dùng `Box3.setFromObject`, vốn sai với GLB có mesh ×0.01 nhưng xương theo mét); 3 đèn + PMREM procedural; sàn/lưới/bóng co giãn theo kích thước mô hình; phát clip, seek, loop, auto-rotate, nền trong suốt; `postMessage` (`play/pause/toggle/seek/setclip/reset/state`) và `dispose()` giải phóng GPU.
- `js/ui/share-dialog.js` + menu **File → Share / Embed 3D…** — xuất cảnh ra `.glb` (tự tắt MatCap để lấy vật liệu PBR gốc rồi bật lại), tạo liên kết tự chứa / mã nhúng / tải `.glb`, xem trước bằng iframe, nhận URL `.glb` công khai khi mô hình quá lớn, cảnh báo khi chạy localhost.
- Không đổi định dạng `.blend.json`; autosave/undo/scene cũ giữ nguyên.

**Đo thực tế**

| Trường hợp | GLB | Liên kết / payload | Kết quả |
|---|---|---|---|
| Cảnh mặc định (1 cube) | 13,8 KB | 4,5 KB (`#z=`) | preview 12 tam giác |
| Fixture rig 20 xương (`tests/fixtures/embed-cube.glb`) | 48.228 B | 11.312 ký tự (gzip) | preview 272 tam giác, clip chạy |
| Michelle (28.106 tam giác, 2 clip) | 1,86 MB | 1,45 MB nén → **bị chặn** (>96 KB) | preview qua blob URL, tải `.glb` vẫn bật |
| Nhân vật Michelle qua `?glb=` | 3,1 MB | không nhét vào URL | tải + phát `SambaDance` OK |

**Hạn chế**

- Liên kết tự chứa chỉ hợp với cảnh < ~96 KB sau nén; dự án lớn dùng nút **☁ Cloud** trong dialog Share (3.3) để upload `.glb` và nhận liên kết `?glb=` ngắn. Preview blob chỉ sống trong tab đang mở.
- Viewer chỉ nhận `.glb/.gltf`; chưa có KTX2, chưa nhận `.blend.json`, chưa có comment/analytics.
- Link `127.0.0.1/localhost` chỉ mở trên máy tạo; UI đã cảnh báo.

**Test**

- `node tests/test_embed_core.mjs` → **18/18**: sanitize URL, gzip roundtrip, fallback fflate, giới hạn kích thước, chống lộ token, escape iframe.
- `tests/embed-suite.html` → **6/6**: hosted GLB, cờ URL, payload `#z=`, URL độc hại, postMessage, loop/controls/bg/dpr.
- `tests/browser-suite.html` → **42/42** (26/11/2026), gồm Share/Embed, Inspector XSS và Copilot Worker: tạo/sửa/reparent/selection, `scene.clear`, camera conflict, animation lifecycle, live modifier/Edit Mode, GLB texture/skeleton/clip, same-origin resources và capability denial.

**Luồng dữ liệu (trả lời câu hỏi “lưu ở đâu / gửi về đâu / xoá thì hỏng gì”)**

- **Trạng thái cảnh** nằm trong bộ nhớ Three.js; bản nháp tự động nằm ở IndexedDB `web-blender-studio/drafts/current` (20 s + khi ẩn tab). Xoá draft chỉ mất phục hồi sau crash, không ảnh hưởng phiên đang mở.
- **Trạng thái chia sẻ** nằm trong URL: fragment `#z=` (không lên server) hoặc `?glb=` trỏ tới file công khai. Viewer không giữ state lâu dài; đóng iframe là mất.
- **Phản hồi AI** đi `/api/ai/chat` → proxy server (`ai_config.json`) → nhà cung cấp, rồi quay về panel Copilot. Mã AI-generated được quét bổ trợ rồi chạy trong dedicated Worker với scene mirror; parent áp thay đổi qua transaction/allowlist. Xoá `ai_config.json` chỉ làm Copilot trả 400 “chưa cấu hình API key”.
- **Mocap** mặc định chạy WASM trong trình duyệt (không gửi frame lên server); chỉ khi chọn “Server” mới gọi `/api/mocap/*`.
- **Agent/MCP** đi `/api/agent/*` + WebSocket 8082 → `studio-bridge` → scene; xoá `agent_assets/` làm mất file agent đã tạo.
- **Xoá `embed.html`/`js/embed/*`** làm link chia sẻ 404 nhưng editor không sao. **Xoá `vendor/three`** làm cả editor lẫn viewer chết. **Xoá `__pycache__`** vô hại.

### 3.1 Vite Bundler (Additive Build) — ✅ (09/11/2026)

- Cấu hình `vite.config.js` + `package.json` theo nguyên tắc **Additive Production Build**:
  - Không sửa bất kỳ tệp HTML, JS hay CSS gốc nào; import map của `index.html` và `embed.html` được bóc tách trong bộ nhớ khi build.
  - Luồng phát triển dev bằng `python server.py` trên cổng :8080 được giữ nguyên 100%.
  - Hỗ trợ Rollup code-splitting, static dynamic-addon imports (`GLTFExporter`, `FBXLoader`, `OBJLoader`, `STLLoader`, `PLYLoader`), và tự động sao chép tài nguyên runtime (`models/`, `vendor/`) sang `dist/`.
  - Kiểm chứng: `npm run build` xuất ra `dist/` hoàn chỉnh trong ~6,3s; `dist/index.html` và `dist/embed.html` sẵn sàng cho môi trường CDN/SaaS tĩnh.

### 3.3 Auth/Cloud/Billing — ✅ (02/11/2026)

**Kiến trúc chọn: BFF same-origin thay vì gọi Supabase trực tiếp từ trình duyệt.** Trình duyệt chỉ nói chuyện với `/api/cloud/*`; server giữ service-role key, kiểm tra quota/credit và ghi ledger trong cùng transaction. Nhờ vậy không thể sửa credit từ DevTools, và đổi provider không phải sửa UI.

| Hạng mục | Cách làm | Tệp |
|---|---|---|
| Cấu hình | `cloud_config.json` (gitignored) + env `CLOUD_*`, `SUPABASE_*`, `SEPAY_*`, `LEMONSQUEEZY_*`; status public đã lọc secret | `cloud/config.py`, `cloud_config.example.json` |
| Auth local | Token HMAC `v1.payload.sig` (không thêm dependency), dev login chỉ khi `allow_dev_login` **và client là loopback** | `cloud/auth.py`, `cloud/service.py` |
| Auth Supabase | Xác thực access token qua `/auth/v1/user` (cache 60 s), magic-link implicit flow, refresh token phía client | `cloud/auth.py`, `js/cloud/cloud-client.js` |
| Lưu trữ local | SQLite + filesystem, transaction quota/credit, ghi file atomic, kiểm tra magic `glTF` | `cloud/store.py` |
| Lưu trữ Supabase | REST/RPC/Storage bằng service key; bucket `shared-models` **private**, Storage RLS bật và quyền trực tiếp của client bị thu hồi; public URL qua BFF signed URL, private URL owner-only; refund nếu upload lỗi. Chưa áp schema/kiểm live | `cloud/supabase.py`, `cloud/supabase_schema.sql` |
| Credit | Server-authoritative: tặng 100, lưu dự án 1/lần, upload GLB 5/lần; ledger có idempotency key | `cloud/store.py`, `cloud/supabase.py` |
| SePay VietQR | Tạo mã `WBS…`, URL `img.vietqr.io`; webhook xác thực HMAC `sha256=` **hoặc** `Authorization: Apikey`; xử lý underpaid/duplicate | `cloud/billing.py` |
| LemonSqueezy | Checkout API + `X-Signature` HMAC; redirect về `/?cloud=paid&code=…` | `cloud/billing.py` |
| UI | File → **Cloud / Tài khoản…**: 3 tab Tài khoản/Dự án/Credit, QR + polling + mô phỏng thanh toán ở provider local | `js/ui/cloud-panel.js` |
| Share | Nút **☁ Cloud** upload GLB đã xuất, đặt URL công khai và tạo `embed.html?glb=…` | `js/ui/share-dialog.js` |
| Server | `/api/cloud/*` đi qua Host/Origin guard; webhook và public asset bỏ qua studio token nhưng vẫn kiểm tra chữ ký/CORS; body limit theo loại request | `server.py`, `cloud/service.py` |

**Luồng dữ liệu (lưu ở đâu / gửi về đâu / xoá thì hỏng gì)**

- **Phiên đăng nhập** nằm trong `localStorage` key `wbs_cloud_session_v1`; token local do server ký, token Supabase do Supabase cấp. Xoá key = đăng xuất, **không** mất dự án trên Cloud.
- **Dự án/asset** nằm ở `cloud_data/` (provider local) hoặc Supabase Storage + bảng `cloud_projects`/`cloud_assets`. Xoá `cloud_data/` xoá toàn bộ tài khoản/dự án/ledger local; UI chỉ mất dữ liệu, editor vẫn chạy.
- **Credit** chỉ được ghi ở server trong bảng `cloud_ledger`; response trả số dư sau giao dịch. Sửa localStorage không đổi được credit.
- **Thanh toán** đi `/api/cloud/checkout` → SePay/Lemon; webhook công khai `/api/cloud/webhook/*` xác thực chữ ký rồi cộng credit **một lần**. Mất webhook secret = webhook bị từ chối (không cộng credit), checkout vẫn tạo được.
- **Liên kết chia sẻ Cloud** là `/api/cloud/public/assets/<id>` (local) hoặc URL Storage công khai ngắn hạn do BFF ký; asset private chỉ trả URL cho owner. Xoá asset làm link 404. Xoá `cloud/` hoặc tắt `cloud_config.json` làm panel báo “Cloud chưa bật” nhưng toàn bộ editor/share tự chứa vẫn hoạt động.
- **Service key Supabase không bao giờ về trình duyệt**; status chỉ trả `url` + `anonKey` cần cho Auth.

**Kiểm chứng**

- `python -m unittest tests.test_cloud` → **48/48**; `tests/test_security.py` → **35/35** (kết quả gate 26/11; kiểm tra thêm quota/ownership/GLB/CSP/SePay/Lemon/Supabase/schema).
- `node tests/test_cloud_client.mjs` → **17/17**: cache status, session, 402 hint, Supabase refresh/retry, magic-link hash/error, upload base64, logout, `absoluteUrl` (có test chống shadow `location`).
- `tests/cloud-suite.html` → **11/11**: status, login, 100 credit, save/upsert, round-trip + ownership, upload GLB + CORS, xoá asset → 404, checkout + simulate idempotent, panel render, delete/logout.
- `bash tests/run_all.sh` → **68/68 nhóm, exit 0** ngày 26/11/2026; gồm Python **124/124**, browser **14/14 suite / 208 kiểm tra** và production `dist/` **9/9**.

**Còn lại / hạn chế**

- Chưa chạy với project Supabase, cổng SePay và LemonSqueezy thật (cần credential + URL public); adapter đã test bằng fake và schema đã có test tĩnh.
- Local provider dùng dev login, không dành cho production; chưa có reset mật khẩu, xác thực email template riêng, R2/Cloudflare.
- Webhook thật cần server có URL công khai/HTTPS và secret khớp; mô phỏng thanh toán chỉ bật ở provider local.
- Chưa có phân quyền nhóm/team, hoá đơn VAT hay subscription định kỳ.

## Giai đoạn 4 — B2B EdTech & Tăng trưởng (web-only; 4.1 ✅)

### 4.1 Chế độ Giáo trình tương tác (STEM Mode) & Giáo viên AI kèm 1-1 — ✅ (07/11/2026)

**Đã làm**

- `js/education/stem-curriculum.js` — Bộ 6 bài học lập trình 3D & AI tiếng Việt (`STEM_LESSONS`) theo 3 cấp độ (**Cơ bản → Trung cấp → Nâng cao**):
  1. `lesson-01-primitives`: Khối hình học 3D đầu tiên & Hệ tọa độ (`addCube`, `addSphere`, đặt nổi trên sàn `Y >= 0.5`).
  2. `lesson-02-materials-lights`: Vật liệu PBR Kim loại & Ánh sáng Studio (`metalness >= 0.6`, `roughness <= 0.4`, `addLight`).
  3. `lesson-03-loops-architecture`: Vòng lặp `for` & Kiến trúc Hàng cột / Thành phố (`>= 5` đối tượng phân bố cách đều `>= 6m`).
  4. `lesson-04-prefab-stage`: Dựng Sân khấu Triển lãm & Hệ thống đèn đa điểm (`>= 2` đèn chiếu sáng).
  5. `lesson-05-animation`: Lập trình Hoạt cảnh thời gian thực 60 FPS (`studio.animate` / Timeline Keyframe).
  6. `lesson-06-physics`: Mô phỏng Vật lý Trọng lực & Va chạm Rapier 3D (`userData.physics.type = 'dynamic'`, `Y >= 2.5m`).
- **Auto-Grader (`gradeStemLesson`)**: Chấm điểm tự động thang 100 điểm dựa trên trạng thái thật của `sceneManager` (mesh, geometry, vị trí, màu sắc, PBR, đèn, callback animation, cấu hình vật lý Rapier) và mã nguồn DSL; trả về điểm số, xếp loại (`Xuất sắc (A+)`, `Giỏi (A)`, `Đạt (B)`, `Cần cố gắng (C)`), điểm từng tiêu chí và lời nhận xét bằng giọng nói của Giáo viên AI.
- **Icon Agent Giáo viên AI di chuyển trên giao diện (`js/ui/stem-tutor-ui.js` + `computeAvatarTargetPosition`)**:
  - Icon Robot Giáo viên nổi (`#stem-agent-avatar-root.agent-ui-root`) tự động bay mượt mà (`cubic-bezier`) tới từng nút bấm / bảng công cụ trên giao diện (`#menu-add`, `.dock-tab`, `#outliner-panel`, `#inspector-panel`, `#viewport-canvas-host`, `#timeline-controls-bar`…), hiển thị vòng sáng định vị (`#stem-target-beacon`) và bàn tay chỉ hướng (`up / down / left / right`), đồng thời cho phép người dùng kéo thả tự do bằng chuột.
  - Bong bóng thoại kèm 1-1 ngay cạnh Icon hiển thị tiến độ bước (`Bước k/N`), lời giảng, sóng âm trực quan và các nút thao tác nhanh: **◀ Trước**, **Tiếp ▶**, **🔊 Nghe lại**, **✨ Làm mẫu (Auto-Demo)**, **✅ Chấm bài**, **📚 Giáo trình**.
- **Giọng nói Giáo viên kèm 1-1 (`TutorVoiceEngine`)**:
  - Tích hợp Web Speech API (`window.speechSynthesis` ưu tiên giọng tiếng Việt `vi-VN`) kèm fallback âm báo nhẹ qua WebAudio khi chạy ở môi trường thiếu gói giọng nói hệ thống; hỗ trợ bật/tắt tiếng (`Mute/Unmute`) và đọc lại.
- Mở rộng `js/agent/agent-tutorial.js`: Khi gọi `agent.tutorial.step({ text, highlight })`, Icon Giáo viên tự động bay tới phần tử `highlight` và phát lời giảng `text`.
- **Test**: `node --import ./tests/three-resolve-hooks.mjs tests/test_stem_tutor.mjs` (**7/7 PASS**), `tests/browser-suite.html` (**23/23 PASS**), `bash tests/run_all.sh` (**19/19 nhóm PASS**), `tests/interaction-suite.html` (**40/40**, gồm 2 test STEM guided/grader).

**Bổ sung 07/11/2026 — hoàn thiện chuẩn giáo trình Blender & chấm điểm triệt để:**
- Bài 1 mở đầu bằng bước **điều hướng khung nhìn** (chuột giữa orbit/pan/zoom, Numpad 1/3/7/5) đúng lộ trình Blender fundamentals; các bước gắn `expectedAction` và tutor tự tick ✓ + chuyển bước khi học viên thao tác thật (orbit, add, transform commit, Tab, Extrude, modifier, đèn, keyframe/play, physics).
- Auto-grader chỉ chấm **trạng thái thật của cảnh** và **mã đã thực thi** (`blender:scriptExecuted`), không chấm chữ gõ dở trong editor; bỏ các đường vòng (thiếu đèn vẫn đạt, edit lưới bị tính là modifier, nhân vật idle bị tính là hoạt cảnh).
- `SceneManager` phát `transformChanged`/`blender:transformChanged` khi commit/undo/redo TransformCommand (nhận diện bằng cờ `isTransform`, bền với module nạp trùng qua query cache-bust); Edit Mode phát `blender:mode-changed` khi vào/ra.
- Server dev cần chạy bản `server.py` hiện tại để có `/api/tts` (giọng Việt neural); thiếu thì fallback Web Speech vẫn hoạt động.

### 4.2 Path Tracing PNG — có bản giới hạn (web); desktop ngoài phạm vi (07/11/2026)

- **Render → Path Tracing (chất lượng cao)…** → chọn Samples / độ phân giải → **Render** → **Tải PNG**. Đây là path tracing ảnh tĩnh, không thay luồng PNG viewport hay video hiện có.
- `js/render/pathtrace-render.js`: lazy-load `three-gpu-pathtracer` 0.0.23; dùng `PathTracingRenderer`/`PathTracingSceneGenerator` trực tiếp với Three r160, không dùng wrapper cần Scene API mới và không sửa `Scene.prototype`.
- Renderer WebGL riêng + snapshot PBR: giữ MatCap hiển thị, vật liệu đa vùng, texture, world transform (kể cả shear), instance/morph tĩnh; lọc đối tượng ẩn/helper/camera. Tách material groups và giới hạn drawRange trước khi dựng BVH; chuẩn hoá màu đỉnh RGB/RGBA. Có Perspective/Orthographic, nền alpha không làm sáng RGB, tiến độ, huỷ/đóng và giải phóng context riêng khi xong/lỗi/huỷ; dialog nằm trên HUD Giáo viên AI.
- Test: `tests/test_pathtrace_scene.mjs` **120/120**; `tests/pathtrace-suite.html` **18/18** (kết quả gate 25/11; các số 119/16 trong câu dưới là snapshot 07–08/11).
- Kiểm chứng giảm nhiễu hoàn tất **08/11/2026**: **20/20** nhóm tự động; các lượt regression đạt interaction **40/40**, browser **23/23**, mocap **15/15**, embed **6/6**, cloud **10/10** (không phải một chain duy nhất; lịch sử timeout chưa rõ nguyên nhân giữ trong `AUDIT.md` §12.4). GPU/UI **16/16** trong 51,605 s và browser **23/23** không có console error/exception. Đã bật/tắt giảm nhiễu, render/tải hai PNG Michelle 597×317, 32 samples qua menu/dialog thật bằng Chrome headless, xem ảnh và xác nhận Play tiếp tục đổi pose sau render; camera/geometry không đổi, alpha hai ảnh trùng hoàn toàn.
- SkinnedMesh được chụp thành mesh tĩnh theo tư thế hiện tại: morph trước skin, giữ normal/tangent đã biến dạng và world matrix; không sửa bind matrix, geometry, skeleton hoặc clip nguồn. Hỗ trợ attached/detached rig, skeleton nằm ngoài root và các mesh dùng chung geometry nhưng pose khác nhau. Nên Pause/tua trước khi render; Play vẫn tiếp tục trên cảnh gốc. Mesh thiếu skeleton/skin bị bỏ qua có thông báo.
- **Giảm nhiễu tuỳ chọn:** checkbox mặc định tắt; `js/render/pathtrace-denoise.js` dùng bộ lọc giữ biên `DenoiseMaterial` của vendor, chuyển RGB premultiplied về straight-alpha trước tone mapping và giữ alpha nguồn. Không sửa vendor/viewport; có thể huỷ ở bước lọc. Không phải AI, có thể làm mềm chi tiết nhỏ và không thay thế tăng Samples.
- **Giới hạn:** 200.000 tam giác; cạnh 2048 px / 2 MP; tối đa 256 samples / 3 phút; BVH và bake pose đồng bộ nên không huỷ giữa lúc dựng. Chưa instanced color; PMREM và HDR không phải RGBA half-float bị bỏ có thông báo. Texture được đóng gói ở 512 px, chỉ hỗ trợ UV0; UV1–UV3 báo lỗi rõ ràng.
- **Desktop (Tauri):** không làm và không nằm trong lộ trình thương mại (sản phẩm web-native). Chỉ là định hướng tương lai xa; không coi việc thiếu Tauri là điều kiện phát hành.

---

## Giai đoạn 5 — Physics nâng cao (5.1 ✅, 5.2 ✅, motor/giới hạn ✅ 08/11/2026)

- **5.1** Rapier WASM fixed-step 60 Hz deterministic, dock Physics, bake → Timeline (xem bảng tổng quan).
- **5.2** Fixed/Revolute joint: neo + trục local mỗi body, tắt va chạm nội bộ cặp khớp, undo/redo, group/xoá/undo, project JSON, duplicate remap UUID, bake.
- **Motor + giới hạn góc Revolute (08/11/2026):** `DEFAULT_REVOLUTE` mặc định tắt (`limitsEnabled:false`, `motorMode:'off'`) nên joint cũ giữ nguyên behaviour tự do. Bốn chế độ motor **Tắt / Tốc độ / Vị trí / Servo** dùng `configureMotor` + `setMotorMaxForce` (ForceBased) của Rapier 0.21; giới hạn góc dùng `setLimits` (±180°, kẹp target vào khoảng). Góc đọc tương đối so với lúc nối khớp, giữ nguyên khi body bị dựng lại (tham chiếu lưu theo spec, không serialize vào JSON).
- **UI:** mỗi khớp xoay trong dock Physics có 9 trường (giới hạn, góc dưới/trên, motor, tốc độ đích, góc đích, độ cứng, damping, mô-men tối đa) + ô góc trực tiếp; trường vô hiệu theo chế độ; nhập sai giữ giá trị cũ; mỗi lần chỉnh là một bước undo/redo.
- **Test:** `tests/test_simulation_manager.mjs` **51/51** (thêm 14 test motor/giới hạn/undo/JSON/duplicate/bake/góc xoay), `tests/interaction-suite.html` **42/42** (thêm 2 test UI motor + exporter/duplicate/bake/dispose), `bash tests/run_all.sh` **20/20 nhóm**. Đã xem dock ở khổ rộng: không tràn ngang, motor drives khớp tới đúng góc đích.
- **Hạn chế:** chưa soft body / cloth / weather; chưa chỉnh điểm neo sau khi tạo; motor chỉ cho Revolute (Fixed không có bậc tự do xoay).

---

## Giai đoạn 6 — Wave 0–4C & đóng gói public (11–18/11/2026)

Không nằm trong 4 giai đoạn gốc: đây là đợt nâng cấp depth-of-feature sau khi lõi 3D ổn định.

- **Wave 0 — Lưu trữ:** `js/core/blob-store.js` (OPFS + IndexedDB), `data-blocks.js`, migration **schema v5**, rolling autosave, `.wbs` ZIP chứa cả texture → mở lại đúng trên máy khác.
- **Wave 1 — Trao đổi:** FBX 7.4 (mesh/skin/blend shape), USDZ 64-byte aligned, 3MF OPC, game pack LOD0–2 + UCX + UV2 round-trip GLB.
- **Wave 2 — Surface:** paint 3D/2D cross-seam có undo theo tile, bake Rust (AO/normal/curvature/position/margin), shader node → GLSL + Rust path tracer, Asset Browser đặt theo pháp tuyến.
- **Wave 3 — Modeling:** curve/Text3D offline, 10 pro modifier, viewport vs render subdivision + multires, collection/view layer, transform orientation, dyntopo/voxel remesh.
- **Wave 4A/4B/4C — Animation & Rig:** Graph Editor Bezier đầy đủ, Actions + NLA + Driver sandbox, bone-heat weights, armature pro, IK/FK blend không pop.
- **Công cụ Blender Pro:** extrude/dissolve/bridge/knife/slide/loop, workspace split/join, UV LSCM/smart project/pack, Sculpt 2.0 (10 brush Rust WASM).

### Đóng gói asset cho bản public (18/11/2026; đo lại 26/11/2026)

`assets/asset-ship-policy.json` + plugin `ship-runtime-assets` trong `vite.config.js`:

| Hạng mục | Trước 18/11/2026 | Sau khi đo 26/11/2026 |
|---|---|---|
| Tổng `dist/` | 659 MB / 231 file | **80,7 MB / 128 file** |
| File > 25 MB (giới hạn host) | 6 | **0** |
| Asset Studio trong catalog | 43 | 6 (5,9 MB; policy ≤5 MB) |
| Thời gian build | 10,3 s | 34,15 s |
| Entry JS gzip | — | **275,99 kB** (<350 KB) |

- Không xoá asset gốc; `library.include` để ép ship asset lớn, `STUDIO_SHIP_ALL=1` để ship toàn bộ (self-host/LAN).
- Catalog trong `dist/assets/library/studio-catalog.json` được **sinh lại** theo đúng danh sách file đã ship (**2.396 item: 6 Studio + 2.390 Poly Haven CC0**) nên không có entry hỏng.
- `pose_landmarker_heavy.task` (29 MB) bị loại khỏi bản public; engine fallback `heavy → full` local (9 MB) → CDN, đã kiểm tra bằng mã nguồn `createLandmarker`.

---

- **Test 25/11/2026 (snapshot trước vá):** `tests/test_wave1_bleeding_fixes.mjs`, `tests/test_wave2_fixes.mjs`, `tests/test_wave3_fixes.mjs`, `tests/test_cloud.py` (45/45), `tests/test_security.py` (35/35), `tests/test_cloud_client.mjs` (17/17), `4/4` crates Rust (`cargo test --release`: 47/47), `node tests/run_browser_suites.mjs` (13/14 lượt đầu; `chaos-ui` chạy lại 7/7), `node tests/test_dist_production.mjs --build` (9/9). Toàn bộ `bash tests/run_all.sh` thoát mã 1 vì ngưỡng Sculpt và readiness race; chưa đạt gate xanh.
- **Test hồi quy và full gate 26/11/2026:** `tests/test_wave2_fixes.mjs` (10/10), `tests/test_copilot_guard.mjs` (26/26), `tests/test_copilot_worker.mjs` (17/17), `tests/test_agent_exec_isolation.mjs` (7/7), `tests/test_stem_voice_session.mjs` (20/20), `tests/test_voice_wake_and_walkthrough.mjs` (11/11), `tests/test_cloud.py` (48/48), Python (124/124), Rust (47/47), browser (14/14 suite / 208 kiểm tra), production `dist/` (9/9); `bash tests/run_all.sh` đạt **68/68 nhóm, exit 0**. Supabase live vẫn chưa chạy.

---

## Giai đoạn 7 — Hạn chế còn lại & Các mục chưa triển khai (cập nhật 26/11/2026)

1. **P0 trong phạm vi kiểm tra — đã đóng lại sau hồi quy 26/11/2026:**
   - **Inspector stored XSS — đã vá và kiểm Chromium:** `renderCurveSection()` dựng Curve/Text metadata bằng DOM API thay vì `innerHTML`; `tests/test_wave2_fixes.mjs` **10/10**, browser **43/43** cho suite chính.
   - **Copilot/`agent.exec` sandbox — đã chuyển sang Worker:** Copilot/STEM demo chạy trong dedicated Worker với scene mirror, CSP/capability denial, command allowlist, transaction/conflict và asset staging; `agent.exec` dùng Worker riêng. Không còn truyền `engine`/`studio`/`editMode`/`simulationManager`/`stemTutor`/`bpy`/THREE thật vào mã AI-generated. Bằng chứng: guard **26/26**, Copilot Worker **17/17**, isolation **7/7**, browser **208 kiểm tra**, `dist/` **9/9**. Server dev cũ thiếu CSP và Live Voice echo đã được sửa; `E_PERMISSION` không auto-repair. Đây không phải tuyên bố chống mọi exploit arbitrary-code.
   - **Supabase private asset — đã vá trong source/schema:** `shared-models` private, Storage RLS/revoke, public URL qua BFF signed URL, private URL owner-only; `tests/test_cloud.py` **48/48**. Còn áp `cloud/supabase_schema.sql` và kiểm end-to-end trên Supabase thật.
   - **Refund-before-paid — đã vá cục bộ cho đường tái hiện:** refund pending được lưu `refunded`, paid sau đó trả `already_refunded` và không cộng credit; local/Supabase đều có test. Còn edge case webhook chỉ có external ID khi payment row chưa gắn ID và chưa kiểm webhook thật.
2. **Hạ tầng Cloud Production thật:** Chưa kiểm thử end-to-end với project **Supabase** thật, cổng **SePay VietQR** / **LemonSqueezy** thật ngoài domain HTTPS công khai; chưa chạy `docker build` / GitHub Actions runner thật; chưa có **OAuth Google/GitHub**, **Reset Password** riêng, **Sentry / `/metrics`**, RPC gộp quota nguyên tử chống N+5 call, hay tách BFF sang **Cloudflare Workers**.
3. **CDN Asset (`dist/` < 15 MB):** Entry `index-*.js` đạt **`275,99 kB` gzip**, nhưng `dist/` tổng vẫn **`80,7 MB / 128 file`** vì chứa MediaPipe WASM và video/model mẫu tại chỗ (chưa đẩy ra Cloudflare R2 / CDN ngoài).
4. **Image-to-3D (Hunyuan3D):** `hunyuan3d_engine.py`, `hunyuan_2_1_gradio_app.py`, `js/ui/hunyuan3d-ui.js` vẫn giữ nguyên làm vùng ngoại lệ ngoài 4 Wave; API cloud trả phí thật chưa kiểm tài khoản thật. Audit 25/11 còn ghi nhận `image_path` không bị kiểm tra nằm trong thư mục cho phép (rủi ro đọc/ghi ngoài workspace).
5. **EdTech B2B & Giọng nói Offline:** Chưa có **Teacher Dashboard**, phân lớp / CSV / LTI / Google Classroom / lưu điểm & bài nộp STEM lên Cloud; đã bỏ cạo Google Translate TTS (dùng Web Speech API hoặc opt-in `STUDIO_TTS_ENDPOINT`), chưa tích hợp **Whisper WASM offline**.
6. **E-commerce AR, Physics chuyên sâu & Đối chứng DCC:** Embed mới xuất `.usdz` iOS AR Quick Look (chưa Android Scene Viewer / WebXR / annotation hotspots); Physics chưa có **Soft Body, Cloth Simulation, Weather**; chưa test với `.vrm` mẫu thật hoặc **Blender Cycles Desktop / Unity**. Import GLB đã qua Godot 4.7.2 headless; AI Copilot tool-calling vẫn qua JSON prompt (chưa Native tool-calling + streaming + đo pass-rate key trả phí thật).

## Quy ước kiểm chứng của lộ trình này

1. Mỗi mục chỉ được đánh ✅ khi có test chạy lại được bằng một lệnh:
   ```bash
   bash tests/run_all.sh                                   # backend + parity + Node
   # trình duyệt: http://127.0.0.1:8080/tests/mocap-suite.html
   ```
2. Sai lệch đo được (thời gian, drift, fps) phải ghi con số cụ thể, không ghi “nhanh hơn”.
3. Hạn chế phải ghi rõ là hạn chế, không tính là đã xong.
