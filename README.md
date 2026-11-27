# Hunger 3D Studio / Hunger Motion

Studio 3D/AI và Video-to-3D Motion Capture chạy 100% trên trình duyệt theo phong cách Blender: dựng cảnh, mocap WASM (Pose + Face + Hand + Foot-Lock IK), animation, vật lý, Path Tracing (WebGPU / Rust SIMD128 / Three GPU), xuất GLB/FBX/BVH/USDZ/3MF/MP4 và chia sẻ 1-click. Chạy 100% Serverless trên Cloudflare Workers + R2 + Supabase (server Python chỉ dùng cho dev local / MCP CLI / `.blend` tùy chọn).

- **Landing Page Hunger Motion (Staging):** `https://hunger-studio-staging.hunger-studio-vn.workers.dev/motion`
- **Motion Workspace (gọn + 3 template Unity/VRM/TikTok):** `https://hunger-studio-staging.hunger-studio-vn.workers.dev/?workspace=motion`
- **Production Edge:** `https://hunger-studio.hunger-studio-vn.workers.dev`
- **Release Tag:** `v0.9.0-beta.1`

## Trạng thái mã nguồn và kiểm chứng ngày 27/11/2026 (`v0.9.0-beta.1`)

| Hạng mục | Số liệu thực đo |
|---|---|
| Module JS (`js/`) | **153** file, **141.581** dòng |
| Cloudflare Edge (`cloudflare/`) | **4** file, **2.527** dòng (`worker.js`, `cloud-bff.js`, `bridge-do.js`, `mcp-endpoint.js`) |
| Rust WASM (`crates/`) | **4** crate / **19** file / **18.525** dòng (`mesh_kernel`, `mocap_kernel`, `render_kernel`, `video_kernel`) |
| Backend Python | **20** file ngoài test / **10.959** dòng (**29** file / **13.860** dòng gồm test) |
| Giao diện HTML/CSS | `index.html` (1.264 L) + `motion.html` (357 L) + `embed.html` (118 L) + `css/blender-theme.css` (5.938 L) |
| Bộ test (`tests/`) | **106** file test · **Fast gate PASS (`exit 0`)**: Python **124/124** (Cloud **49/49**), agent bridge **16/16**, Rust **47/47**, Godot/Blender import PASS, P1 Hardening **15/15**, Beta Motion/Telemetry **8/8**, Cloudflare Worker **14/14**, Copilot Worker **19/19**, `agent.exec` isolation **13/13**, Hunger Skills **16/16**, guard **26/26** · **Browser gate PASS 2 lượt liên tiếp**: **14/14 suite / 208 kiểm tra** (`lod-instancing` 8/8, 0 blocked, 0 uncaught) · **Production `dist/` gate**: **9/9 PASS** |
| An toàn & P0/P1 (27/11) | **0 P0 / 0 P1 mở**: đóng toàn bộ P1 transaction/rollback (Copilot `studio.addCamera` + `CameraManager` undo/redo giữ nguyên `undoStack`, `studio.batchToInstances` detach `TransformControls` cũ và chọn scatter group, không dispose geometry trước rollback, khôi phục selection/camera), TextureLeaseRegistry, Inspector abort, Export Cancel (abort trong traverse + mutex settle), stale-bundle reload UX, đồng bộ 12 category Community, Edge Rate Limit AI, Telemetry/Sentry v7 (`/api/telemetry/event`) |
| Build đầy đủ (`npm run build`) | `dist/` **79,7 MB / 134 file**, **0 file > 25 MB**; entry Vite **315,85 kB gzip**; catalog **2.396 item** (6 Studio + 2.390 Poly Haven CC0); build **10,35 s** |
| Build CDN R2 (`npm run build:cdn`) | `dist/` **14,6 MB / 104 file** (`STUDIO_R2_CDN=1`, giảm **81,7%** — `models/`, `vendor/mediapipe/`, studio GLB phục vụ trực tiếp từ Cloudflare R2 `hunger-assets` kèm Range 206 + ETag 304) |
| Đo KPI độc lập trên Staging (4G, tắt cache) | **Standard 4G (4 Mbps / 100 ms RTT):** Landing `/motion` **852 ms** (8,3 KB), Motion Workspace interactive **2.583 ms** (`__STUDIO_INTERACTIVE_MS__`: 835 ms, 828,7 KB, `advLoaded: false`) · **Slow 4G (1,6 Mbps / 150 ms RTT):** Motion Workspace interactive **4.741 ms** (`__STUDIO_INTERACTIVE_MS__`: 1.543 ms, 827,2 KB, `advLoaded: false`) · **0 HTTP/COEP/JS error** (crash-free 100%) |

> Chi tiết kỹ thuật & quy trình phát hành xem [AUDIT.md](AUDIT.md), [AGENTS.md](AGENTS.md) và [docs/RELEASE_AND_GIT_WORKFLOW.md](docs/RELEASE_AND_GIT_WORKFLOW.md). Staging đang chạy phiên bản **`v0.9.0-beta.1`** (`e238b776-5a35-4f14-a1d4-8a5a5058a5bb`) với Cloudflare Workers + R2 + Supabase + Edge Telemetry + **Sentry live** (`sentryConfigured: true`, đã xác minh fatal smoke event `6b15fd458d6ead23dc4e005b4c1931da` với `sentryForwarded: 1`); trước GO Phase 2 còn bước gắn remote GitHub + bật protected `main`, và trước GA thu phí cần nạp secret SePay/LemonSqueezy live (`freeMode: false`) + Image-to-3D API.

Định vị: **Hunger Motion — 100% Browser Video-to-3D Motion Capture & AI 3D Studio** (workspace `Motion` gọn gàng với 3 template Unity Humanoid, VRM/VTuber, TikTok Dance 9:16; toàn bộ công cụ Blender Pro nằm gọn sau tab **Advanced**).

## Dùng để làm gì?

1. **Game indie / Roblox / Unity / content creator**: quay video bằng điện thoại → mocap trong trình duyệt → foot-lock IK → sửa keyframe → xuất `.glb` kèm animation.
2. **EdTech / STEM**: dạy lập trình 3D bằng tiếng Việt qua `studio.*` DSL trên máy yếu/Chromebook.
3. **E-commerce / product showcase**: nhập GLB → dựng studio, đèn, camera → render ảnh hoặc chia sẻ link/iframe.

## Tính năng đã có

### Không gian làm việc
- Viewport Three.js, camera, grid, gizmo, 4 chế độ shading (Solid/MatCap, Material Preview, Rendered, Wireframe).
- Outliner: chọn, đổi tên, ẩn/hiện, khoá; Inspector: scrub số Position/Rotation/Scale, sửa material.
- Phím tắt Blender: `G/R/S`, `Shift+D`, `X/Delete`, `Ctrl+Z/Y`, `Shift+A`, `Ctrl+G`, `Tab`, `Space`, Numpad `1/3/7/0/5/.`.
- Viewport Perspective/Orthographic (Numpad 5): giữ hướng nhìn, tâm xoay và tỷ lệ tại mặt phẳng tâm; lưu trong project JSON; ảnh PNG và video render dùng đúng phép chiếu hiện tại.
- Undo/Redo dùng command pattern cho thêm/xoá/transform/rename/visibility/group/duplicate.
- Cửa sổ hội thoại, ô nhập, code editor và modal transform được quản lý tập trung bởi `js/core/interaction-guard.js`.
- Camera hiển thị một object trong Outliner, frustum helper tự cập nhật; đèn Point/Sun/Spot có gizmo tự sinh.

### Dựng hình
- Primitive: cube, sphere, ico sphere, cylinder, cone, torus, plane, capsule, grid, circle.
- Procedural: cầu thang, toà nhà, cây, radial array, grid array.
- Edit Mode: vertex/edge/face, extrude, inset, subdivide, bevel, merge, loop cut, duplicate, delete.
- Sculpt Mode, modifier, BVH picking, CSG boolean.
- UV Editor, Graph Editor (F-Curve).
- Rapid 3D DSL (`studio.*`) trong tab Scripting, hỗ trợ shim `bpy.ops.mesh...`.

### Animation & Mocap
- Timeline keyframe object/bone, play/seek, clip đã gắn, Graph Editor.
- Rig system, pose editor, humanoid armature, articulated mannequin, auto-skin.
- Mocap MediaPipe chạy trong trình duyệt bằng WASM (không cần GPU server), có fallback server Python.
- Bộ lọc 1-Euro, gap-fill, bone-length, foot-lock IK chống trượt chân.
- Retarget Mixamo, VRM/VRoid (`J_Bip_*`), Character Creator.
- Xuất GLB kèm nhân vật + skeleton + một hoặc nhiều animation.
- Render video WebM/MP4 qua trình duyệt.

### AI & tự động hoá
- AI Copilot offline NLP + tùy chọn Gemini/OpenAI.
- **Cầu nối tool-calling additive** (`js/ai/agent-tool-bridge.js`): ghép Copilot với **60 tool** của agent API (68 definition, bỏ `exec` và tool chỉ dùng trình duyệt) qua giao thức JSON `{"tool":…,"args":[…]}` — tương thích proxy `/api/ai/chat` hiện tại; executor có `approve()` cho tool phá huỷ, timeout từng tool, giới hạn số bước; `installToolCalling()`/`uninstallToolCalling()` gắn-gỡ **tại runtime, không sửa file dự án**; fallback introspection khi manifest không nạp được. Test: `tests/test_agent_tool_bridge.mjs` (25/25).
- **Copilot chỉ thao tác cảnh, không sửa dự án** (`js/ai/copilot-runtime.js` + `copilot-exec-worker.js`): code AI-generated và STEM demo chạy trong dedicated module Worker với scene mirror Three.js, CSP hạn chế, capability denial, timeout/cancellation và live-command allowlist; parent kiểm tra URL asset, giới hạn payload, phát hiện xung đột scene/camera, áp diff transaction và gộp mỗi lượt thành một bước undo. `agent.exec` dùng Worker riêng với CSP/global bị chặn. Static guard vẫn được chạy trước Worker nhưng không còn được coi là ranh giới bảo mật chính. Test: guard **26/26**, Copilot Worker **19/19**, `agent.exec` isolation **13/13**, P1 Hardening **15/15**, browser **43/43**, production `dist/` **9/9**. Đây là kiểm soát rủi ro, không phải tuyên bố chống lại mọi exploit arbitrary-code.
- **Khởi động nhanh hơn**: ShareDialog + `embed-core` (~193 KB gzip) chỉ nạp khi mở Share; server chỉ import MediaPipe/`mocap_engine` ở lần gọi `/api/mocap/*` đầu tiên → import server **2,52 s → 0,65 s**, mocap vẫn khởi tạo đúng (2,6 s) khi cần.
- **Live scene digest** (`js/ai/scene-digest.js`): trước mỗi lượt, Copilot nhận bản tóm tắt cảnh thật (hierarchy, số object/mesh/group/light/camera, tổng tam giác/đỉnh, skinned/bones, material, animation clip, selection) trong ngân sách ~1.600 ký tự — thay cho cờ boolean cố định — kèm chỉ dẫn “build ON these objects”; object không tên nhận nhãn ổn định `Mesh#n`/`Group#n`. Test: `tests/test_scene_digest.mjs` (14/14).
- Prefab library: lắp nhân vật/cảnh GLB thay vì chỉ ghép primitive.
- Hunyuan3D Image-to-3D, hỗ trợ provider cloud bên cạnh Gradio.
- Agent/MCP/CLI: `server.py`, `studio_mcp.py`, `studio-cli.py`, `js/agent/*`.

### Giáo trình STEM & Giáo viên AI 1-1 (4.1)
- Mở: Help → **Giáo trình STEM & Giáo viên 1-1** hoặc dock tab **Giáo trình STEM (1-1)**.
- 6 bài theo lộ trình Blender: điều hướng khung nhìn → Object Mode (G/R/S, Shift+D) → Edit Mode (Extrude/Inset/Bevel) + PBR → Modifiers/Boolean → Sculpt + ánh sáng studio → Rig/Mocap/Timeline → Physics + xuất GLB.
- Mỗi bước có `expectedAction`: tutor nhận diện thao tác thật (orbit, add mesh, transform commit, Tab/Edit, extrude, gắn modifier, thêm đèn, keyframe/play, physics) và tự tick ✓ + chuyển bước.
- Chấm điểm tự động thang 100 dựa trên hình học thật của cảnh (topology, PBR, đèn, modifier, animation, physics) và **chỉ mã đã thực thi**, không chấm chữ gõ dở trong editor; XP lưu localStorage.
- Con trỏ giáo viên 44px không đè nút mục tiêu và tự né chuột; HUD lời giảng thu gọn được; giọng Việt qua `/api/tts` (prefetch) với fallback Web Speech.
- **Live voice hands-free** (`js/education/stem-voice-session.js` + nút `#stem-mic-btn`): nghe liên tục bằng Web Speech API, tự gửi câu hỏi sau ~1,1 s ngừng nói, **ngắt lời giáo viên (barge-in)** khi học sinh nói chen, tự khởi động lại phiên khi Chrome kết thúc, có wake word tuỳ chọn (`wakeWord`, ví dụ “thầy ơi”), báo lỗi micro rõ ràng (`E_UNSUPPORTED`, `E_MIC_DENIED`, `E_SUBMIT`). Câu trả lời có **timeout 9 s** rồi tự rơi về coach offline nên phiên không bao giờ treo ở “Đang xử lý…”. Echo guard chặn lệnh điều hướng bị nhận nhầm từ tiếng loa (ví dụ “xem lại” → “quay lại”) nhưng vẫn nhận “khoan đã”/“tiếp tục” thật. Test: `tests/test_stem_voice_session.mjs` (**20/20**).

### Vật lý
- Rapier WASM, fixed-step 60 Hz, deterministic.
- Body: Dynamic / Fixed / Kinematic.
- Collider: auto / box / sphere / capsule / convex.
- Mass, friction, restitution, linear/angular damping.
- Ground plane, Play/Pause/Step/Reset.
- Bake simulation thành keyframe position/rotation trên Timeline, nên GLB export không phụ thuộc Rapier.
- Fixed joint (hàn cứng) và Revolute joint (khớp xoay): trục X/Y/Z thế giới, neo tại trung điểm hai gốc vật thể; tắt va chạm giữa hai phía, giữ va chạm với cảnh.
- Trong dock **Physics**: chọn đúng 2 mesh → **Create Joint**. Đặt một phía **Fixed** nếu muốn làm điểm treo; mesh chưa có body được thêm **Dynamic**.
- Tạo/xoá joint có undo/redo; liên kết giữ qua group, xoá/undo và project JSON. Nhân bản cả cặp nối các bản sao, nhân bản riêng một phía bỏ liên kết ra ngoài.
- **Motor & giới hạn góc cho Revolute** (mặc định tắt, joint cũ giữ nguyên behaviour): trong dock Physics, mỗi khớp xoay có ô **Giới hạn góc** (góc dưới/trên ±180°) và **Motor** 4 chế độ **Tắt / Tốc độ / Vị trí / Servo** kèm tốc độ đích (°/s), góc đích (°), độ cứng, damping và mô-men tối đa (N·m). Góc khớp hiển thị trực tiếp theo thời gian thực, tính tương đối so với lúc nối khớp.
- Mỗi lần chỉnh motor/giới hạn là một bước undo/redo; cấu hình đi theo project JSON, nhân bản và bake. Giới hạn/target được kẹp vào khoảng cho phép; nhập sai giữ giá trị cũ. Chưa có soft body / cloth.
- Cấu hình lưu trong `object.userData.physics` và `object.userData.joints`.

### Nhập / xuất
- Nhập: GLB/GLTF, FBX, OBJ, STL, PLY, DAE.
- Xuất: GLB/GLTF, OBJ, STL, PLY, project JSON.
- Project JSON **schema v5**: hierarchy, group, light, camera, material, vertex, skin, texture, animation, timeline, data blocks và cấu hình Wave 0–4C.
- Render viewport PNG độ phân giải cao, nền trong suốt, shortcut `Shift+F12` (không đổi).
- **Render → Path Tracing (chất lượng cao)… → Render → Tải PNG**: ảnh tĩnh PBR từ camera hiện tại, chọn 32–256 samples và 0.5×/1×/2×. Dùng renderer/cảnh riêng, không thay MatCap hay viewport; có huỷ render.
- Tuỳ chọn **Giảm nhiễu** trong dialog mặc định tắt: bật trước Render để lọc giữ biên trên GPU, bảo toàn alpha nền. Đây không phải denoise AI; có thể làm mềm chi tiết nhỏ và không thay thế tăng Samples. Tắt để xuất ảnh chưa lọc như trước.
- Path Tracing hỗ trợ SkinnedMesh ở tư thế hiện tại, gồm morph và hướng normal/tangent; rig/clip nguồn không bị sửa. Pause timeline → tua đến khung hình mong muốn → Render; nếu đang Play, ảnh giữ tư thế lúc dựng snapshot, animation vẫn tiếp tục. Mesh thiếu rig/skin bị bỏ qua có thông báo.
- Giới hạn 2 MP / cạnh 2048 px / 200.000 tam giác, cần WebGL 2 + float render target. Chỉ hỗ trợ texture UV0; UV1–UV3 báo lỗi thay vì render sai. Bỏ PMREM/HDR không tương thích và thông báo trên kết quả. BVH và bake pose vẫn chạy đồng bộ, nút huỷ có hiệu lực sau bước này.

### Share / Embed
- **File → Share / Embed 3D…** xuất cảnh thành GLB rồi tạo:
  - link tự chứa `#z=` (gzip + base64 trong fragment, không gửi server), hoặc
  - link `embed.html?glb=…` sau khi upload Cloud.
- Viewer nhẹ hỗ trợ autoplay, loop, grid, controls, nền trong suốt, auto-rotate, `postMessage`.
- Giới hạn link tự chứa khoảng 96 KB sau nén; cảnh lớn dùng Cloud hoặc URL hosting riêng.

### Cloud Studio
- **File → Cloud / Tài khoản…**: đăng nhập, lưu/mở/xoá dự án, xem credit, nạp tiền.
- BFF same-origin `/api/cloud/*`; service key chỉ ở server.
- Provider `local` (SQLite + filesystem, dev) hoặc `supabase`.
- Credit server-authoritative: tặng 100, lưu dự án 1 credit, upload GLB 5 credit.
- Thanh toán SePay VietQR và LemonSqueezy; webhook xác thực chữ ký và chống ghi trùng.

### Năng lực bổ sung (Wave 0–4C, 11/2026)
- **Lưu trữ Wave 0:** `js/core/blob-store.js` (OPFS/IndexedDB), `data-blocks.js`, autosave cuộn, migration schema lên v5, file dự án **`.wbs` (ZIP)** đóng gói cả texture/asset.
- **Trao đổi Wave 1:** FBX 7.4 đầy đủ (mesh + skin + blend shape), **USDZ** (offset 64-byte), **3MF**, game pack (LOD0–2, UCX collision, UV2, round-trip GLB).
- **Bề mặt Wave 2:** vertex paint & texture paint 3D/2D (cross-seam, undo theo tile), bake bằng Rust WASM (AO, tangent normal high→low, curvature, position, margin dilation), shader node graph (GLSL + nhánh Rust path tracer), Asset Browser đặt asset theo pháp tuyến.
- **Dựng hình Wave 3:** curve Bezier/Circle/NURBS, Text3D offline + Convert to Mesh, 10 modifier chuyên nghiệp (Weld, SimpleDeform, Cast, Wave, Shrinkwrap, DataTransfer, Curve, Lattice, Skin, Remesh), subdivision viewport/render + multires, collection lồng nhau + view layer, transform orientation đầy đủ, dyntopo/voxel remesh.
- **Animation Wave 4A/4B:** Graph Editor F-Curve Bezier đầy đủ (4 kiểu handle, 4 kiểu extrapolation, chỉnh riêng từng trục), Action library, NLA mixer (Replace/Add/Multiply, scale/repeat/mute/solo), driver sandbox (chặn `prototype`/JS nguy hiểm).
- **Rigging Wave 4C:** auto weight bằng **bone heat** (Laplacian cotangent CG, tách chi bị che), vertex groups CRUD + mirror L↔R, armature pro (`use_connect`, bone collections), **IK/FK switch + blend không pop**.
- **Công cụ Blender Pro:** extrude vertex/cạnh, F, dissolve, bridge, knife, bevel, slide, loop select; workspace **split/join area** bằng kéo góc; UV pipeline chuẩn (seam, LSCM, smart project, projection, pack, stretch overlay); Sculpt 2.0 (10 brush Rust WASM, BVH sphere query, mask, voxel remesh).
### Nội dung mẫu
- Các nhân vật/asset CC0 như `Bot_CC0.glb`, `Mannequin_CC0.glb`, cùng catalog Poly Haven CC0.
- Video mẫu mocap.
- Bộ dự án film “Hạt Sáng” đã được loại khỏi lộ trình hiện hành; không còn tham chiếu tới `js/film/film-project.js` trong tài liệu này.

## Kiến trúc

```text
index.html                  entry + import map (không bundler)
js/app.js                   khởi tạo và nối các subsystem
js/core/                    engine, scene manager, edit/sculpt, camera, material,
                            interaction guard, light helper, autosave, bridge,
                            blob-store/data-blocks (OPFS/IDB), paint layers,
                            shader graph, collections, curve/text objects
js/animation/               timeline, rig, mocap, retarget, pose
js/scripting/               Rapid DSL, code editor, prefab library
js/ai/                      AI Copilot
js/simulation/              Rapier loader + SimulationManager
js/ui/                      outliner, inspector, panels, dock tools
js/exporters/               import/export + project JSON
js/embed/ + embed.html      viewer chia sẻ
js/cloud/                   CloudClient
js/agent/                   agent API/tools/tutorial
js/render/                  raster renderer, post-processing, video export (WebCodecs),
                            path tracing, Rust render bridge, procedural HDRI/textures
js/education/               STEM curriculum + tutor UI
crates/                     Rust WASM kernels: mesh_kernel, video_kernel,
                            render_kernel, mocap_kernel (+ native rk_cli)
scripts/                    build_studio_catalog.py, blend_to_glb.py, user-journey tests
cloud/                      BFF: config, auth, store, billing, Supabase
server.py                   HTTP 8080 + WebSocket 8082 + API/BFF
vendor/                     three r160, Rapier WASM, MediaPipe WASM
tests/                      68 nhóm trong run_all.sh + 14 browser suite
```

### Dữ liệu nằm ở đâu
- **Cảnh đang mở**: bộ nhớ Three.js (`SceneManager`).
- **Autosave**: IndexedDB key `web-blender-studio/drafts/current`.
- **File dự án**: JSON schema v5 tải xuống hoặc lưu Cloud; gói `.wbs` có thể chứa thêm texture/asset.
- **Cloud local**: `cloud_data/` (SQLite + file GLB), đã gitignore.
- **Chia sẻ tự chứa**: fragment URL `#z=`, không lên server.
- **Cấu hình vật lý**: `object.userData.physics`.
- **Cấu hình AI/Cloud**: `ai_config.json`, `cloud_config.json` (không commit).

## Cài đặt

Yêu cầu Python 3.11 cho MediaPipe server (trình duyệt không cần):

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py
```

Mở `http://localhost:8080`.

Sau khi cập nhật `server.py`, hãy khởi động lại tiến trình server. Nếu Copilot báo `requires the isolated Worker CSP`, response Worker đang thiếu header bảo mật — thường là vì server đang chạy bản cũ; không nên tắt sandbox để bỏ qua lỗi.

Mocap mặc định dùng WASM trong trình duyệt. Chỉ chọn “Server (Python MediaPipe)” khi cần dùng `mocap_engine.py`.

### Cloud (tuỳ chọn)

```bash
cp cloud_config.example.json cloud_config.json
```

Đặt `session_secret` ≥ 32 byte, sau đó chạy lại server. Các provider và webhook:

- `local`: dev login chỉ chấp nhận loopback; dữ liệu ở `cloud_data/`.
- `supabase`: điền `url`, `anon_key`, `service_key`, rồi chạy `cloud/supabase_schema.sql`. Schema đã được áp **live trên Supabase `fpkhjitqzieqofcviyqi`**: bucket `shared-models` và `studio-projects` ở chế độ **private**, bật Storage RLS (0 policy client), thu hồi quyền trực tiếp bảng và toàn bộ 8 RPC (gồm `cloud_reserve_asset` nguyên tử) khỏi `anon`/`authenticated`, `supabase db advisors` đạt 0 cảnh báo. Test Cloud cục bộ **49/49**; staging Cloudflare Worker đang kết nối trực tiếp tới project Supabase này (`cloud: true` trên `/healthz`).
- SePay: `/api/cloud/webhook/sepay`.
- LemonSqueezy: `/api/cloud/webhook/lemonsqueezy`, redirect `/?cloud=paid&code=…`.

Không có `cloud_config.json` thì Cloud tắt nhưng editor và Share tự chứa vẫn hoạt động.

### Chạy trong LAN

```bash
.venv/bin/python server.py --host 0.0.0.0 --token "$(openssl rand -hex 24)"
# mở http://<ip>:8080/?token=<token>
```

Mặc định server chỉ nghe `127.0.0.1`; API kiểm tra Host/Origin và không trả API key về client.

## Build production & thu gọn asset

```bash
npm run build                     # dist/ đầy đủ theo chính sách ship mặc định (79,7 MB / 134 file)
npm run build:cdn                 # dist/ CDN R2 (STUDIO_R2_CDN=1: 14,6 MB / 104 file, đẩy media sang R2)
STUDIO_SHIP_ALL=1 npm run build   # self-host/LAN: ship toàn bộ asset như cũ
```

`assets/asset-ship-policy.json` quyết định bản public ship gì — **không xoá file gốc** trong `assets/`, `models/`:

- `library.maxAssetMB: 5` — chỉ ship asset Studio đủ điều kiện (**6/45 asset, 5,9 MB**) và **tự lọc `assets/library/studio-catalog.json` trong `dist/`** để Asset Library không bao giờ trỏ tới file không tồn tại.
- `models.excludeDirs: hunyuan_inputs, hunyuan_outputs` — dữ liệu upload/xuất của server, không thuộc gói client (tiết kiệm 68 MB).
- `models.excludeFiles: pose_landmarker_heavy.task` — 29 MB, vượt giới hạn 25 MB/file của một số host; engine tự fallback `heavy → full` (9 MB) local hoặc R2 CDN.
- `vendor.excludeFiles: rapier/rapier.mjs` — bản build đã bundle Rapier (WASM base64) nên bản copy trong `vendor/` là dư 4,1 MB.
- `host.maxFileMB: 25` — build in cảnh báo nếu còn file vượt giới hạn host.

Kết quả đo 27/11/2026: bản đầy đủ `dist/` **79,7 MB / 134 file**, 0 file > 25 MB; entry Vite **315,85 kB gzip**; catalog **2.396 item** (6 Studio + 2.390 Poly Haven CC0); build **10,35 s**. Bản CDN (`npm run build:cdn`, `STUDIO_R2_CDN=1`) giảm xuống **14,6 MB / 104 file** (đã upload và phục vụ thực tế từ Cloudflare R2 `hunger-assets` trên staging). Muốn thêm asset lớn cho bản public, thêm đường dẫn vào `library.include` (bỏ qua ngưỡng 5 MB) hoặc dùng `STUDIO_SHIP_ALL=1`.

## Phím tắt chính

| Phím | Chức năng |
|---|---|
| `G` / `R` / `S` | Move / Rotate / Scale modal |
| `X` hoặc `Delete` | Xoá vùng chọn |
| `Shift+D` | Nhân bản |
| `Ctrl+G` | Group (cần ≥ 2 object) |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo (trong Edit Mode hoàn tác hình học) |
| `Tab` | Object ↔ Edit Mode |
| `Shift+A` | Menu Add |
| `Space` | Play/Pause timeline |
| `Numpad 1/3/7` | Front / Right / Top (Ctrl: Back / Left / Bottom) |
| `Numpad 4/6/8/2` | Orbit trái/phải/lên/xuống |
| `Numpad 5` | Perspective ↔ Orthographic (hoặc View → Perspective / Orthographic) |
| `Numpad .` | Canh khung vùng chọn; Edit Mode: đỉnh/cạnh/mặt đang chọn |
| `Numpad + / -` | Zoom in / out (Orthographic: đổi zoom) |
| `0` hoặc `Numpad 0` | Vào/ra camera view |
| `Shift+F12` | Render viewport PNG (`F12` là DevTools) |

## Kiểm thử

```bash
bash tests/run_all.sh
```

**Kết quả gate 27/11/2026 (`v0.9.0-beta.1`):**
- `bash tests/run_all.sh --fast` thoát mã **0** (Python **124/124**, Cloud **49/49**, agent bridge **16/16**, Rust **47/47**, Godot/Blender import PASS, P1 Hardening **15/15**, Beta Motion/Telemetry **8/8**, Cloudflare Worker **14/14**, Copilot Worker **19/19**, `agent.exec` isolation **13/13**, Hunger Skills **16/16**, guard **26/26**).
- `node tests/run_browser_suites.mjs` chạy **2 lượt liên tiếp** đều đạt **14/14 suite / 208 kiểm tra** (`lod-instancing` 8/8, `chaos-ui` 7/7, 0 blocked, 0 uncaught).
- `node tests/test_dist_production.mjs --build` đạt **9/9** (`dist/` 79,7 MB / 134 file, build 10,35 s).

**Các nhóm test trọng tâm chạy riêng:**

```bash
node tests/test_wave2_fixes.mjs                                              # 10/10 — Inspector metadata an toàn
node tests/test_copilot_guard.mjs                                            # 26/26 — static guard bổ trợ
node --import ./tests/three-resolve-hooks.mjs tests/test_copilot_worker.mjs  # 19/19 — Worker/serialization/asset/command/permission
node tests/test_agent_exec_isolation.mjs                                     # 13/13 — capability denial trong Worker
node --import ./tests/three-resolve-hooks.mjs tests/test_p1_hardening.mjs    # 15/15 — P1 transaction, addCamera, batchToInstances, lease, export cancel
node --import ./tests/three-resolve-hooks.mjs tests/test_beta_motion_telemetry.mjs # 8/8 — Telemetry, Sentry v7 forwarder, 3 templates, CDN
.venv/bin/python -m unittest discover -s tests -p 'test_cloud.py'            # 49/49 — private Storage/signed URL/atomic quota/refund ordering
node tests/run_browser_suites.mjs                                            # 14/14 suite / 208 kiểm tra
node tests/test_dist_production.mjs --build                                  # build + 9/9 production checks
```

Các test cục bộ bổ trợ nhưng không thay thế việc kích hoạt secret live trên môi trường thật (`SENTRY_DSN` trên staging, SePay/LemonSqueezy webhook thật, và CI trên remote GitHub).

Browser suite (cần server chạy):

```text
http://127.0.0.1:8080/tests/browser-suite.html        43 test
http://127.0.0.1:8080/tests/interaction-suite.html    50 test
http://127.0.0.1:8080/tests/embed-suite.html           6 test
http://127.0.0.1:8080/tests/mocap-suite.html          15 test
http://127.0.0.1:8080/tests/cloud-suite.html          11 test
http://127.0.0.1:8080/tests/pathtrace-suite.html      18 test GPU/UI
http://127.0.0.1:8080/tests/webcodecs-suite.html      11 test
http://127.0.0.1:8080/tests/geometry-worker-suite.html 8 test
http://127.0.0.1:8080/tests/asset-suite.html          10 test
http://127.0.0.1:8080/tests/character-suite.html      11 test
http://127.0.0.1:8080/tests/render-suite.html          5 test
http://127.0.0.1:8080/tests/video-export-suite.html    5 test
http://127.0.0.1:8080/tests/lod-instancing-suite.html  8 test
http://127.0.0.1:8080/tests/chaos-ui-suite.html        7 test
```

Browser suite cần tab hiển thị để `requestAnimationFrame` chạy. Khi chạy tự động trong tab ẩn, dùng Chrome headless + CDP; kết quả nằm trong `window.__SUITE_RESULTS__`, `__INTERACTION_RESULTS__`, `__EMBED_SUITE_RESULTS__`, `__MOCAP_SUITE_RESULTS__`, `__CLOUD_SUITE_RESULTS__`, `__PATH_TRACE_RESULTS__`, `__WEBCODECS_SUITE_RESULTS__`, `__GEOMETRY_WORKER_RESULTS__`.

## Giới hạn đã biết & Trạng thái Live (28/11/2026)

- **Đã live trên Staging (`https://hunger-studio-staging.hunger-studio-vn.workers.dev`, `v0.9.0-beta.1`):** Cloudflare Workers Edge, R2 CDN (`hunger-assets`, giảm `dist/` từ 79,7 MB xuống 14,6 MB), Supabase production (`fpkhjitqzieqofcviyqi` với private Storage RLS + 8 RPC + 0 advisor), Durable Objects bridge, Edge Telemetry (`/api/telemetry/event` HTTP 202 + `/api/telemetry/summary`), **Sentry error monitoring live** (`sentryConfigured: true`, `node scripts/verify_sentry_staging.mjs` PASS với `sentryForwarded: 1`, event `6b15fd458d6ead23dc4e005b4c1931da`), landing `/motion`, workspace Motion lazy-load và 3 template Unity/VRM/TikTok. Toàn bộ P0/P1 kỹ thuật đã đóng (gồm Copilot `addCamera` undo/redo, `batchToInstances` TransformControls và browser suite 14/14 PASS 2 lượt liên tiếp).
- **Chưa cấu hình tài khoản/hạ tầng ngoài trước GO Phase 2 / GA thu phí:**
  - **Git remote & protected `main`:** Git local đã sạch với tag `v0.9.0-beta.1`, `.githooks/`, CI/PR templates và hướng dẫn tại `docs/RELEASE_AND_GIT_WORKFLOW.md`, nhưng chưa gắn `git remote` GitHub nên branch protection và CI PR checks chưa chạy trên remote.
  - **Thanh toán SePay/LemonSqueezy & Auth SaaS:** Edge đang để `freeMode: true` (`billingEnabled: false`), chưa nạp secret webhook thật (còn edge refund external-ID-only), chưa có OAuth Google/GitHub và Reset Password riêng.
  - **Image-to-3D (Hunyuan3D):** đang ở chế độ bảo trì trên Cloudflare Edge (`mode: "maintenance"`) cho tới khi gắn Cloud 3D provider API trả phí hoặc `API_ORIGIN`.
- **Hạn chế kỹ thuật còn lại:**
  - Vẫn còn nhiều biến toàn cục `window.*` trong lớp tương thích dev; BVH/CSG mesh lớn (>20.000 tam giác) đã chạy Web Worker, nhưng các thao tác Edit/Sculpt khác vẫn trên một luồng CPU.
  - Joint Fixed/Revolute có motor/giới hạn góc; chưa chỉnh điểm neo sau tạo, chưa có soft body, cloth hoặc weather.
  - Link chia sẻ tự chứa `#z=` giới hạn ~96 KB sau nén; cảnh lớn dùng Cloud Share qua R2/Supabase.
  - Đã có `LICENSE`, `PRIVACY.md` (đã điền email liên hệ `hueotran80@gmail.com`), `TERMS.md`, `THIRD_PARTY_LICENSES.md` và `Mannequin_CC0.glb`/`Bot_CC0.glb` sạch bản quyền cho `dist/`; một số asset dev cũ ngoài `dist/` (`Michelle.glb`, cathedral, tượng) vẫn bị loại bởi `asset-ship-policy.json` (`requireCommercialSafe: true`).
  - `Dockerfile` và `.github/workflows/ci.yml` đã có sẵn trong repo nhưng chưa chạy thực tế trên Docker host / GitHub Actions runner.

## Còn lại trong roadmap

- **Hoàn tất cổng Phase 1 -> Phase 2:** thêm remote GitHub + bật branch protection cho `main` + xác nhận CI chạy trên PR.
- **Chuẩn bị GA thu phí:** bật SePay/LemonSqueezy live (`freeMode: false`), xử lý edge refund external-ID-only, bổ sung Google/GitHub OAuth + Reset Password, mở lại Image-to-3D qua Cloud 3D API.
- **Tối ưu & mở rộng sản phẩm:** nén GLB export (Meshopt/Draco/KTX2), SSE streaming cho AI Copilot, seed mẫu Community, Teacher Dashboard cloud cho STEM, soft body / cloth / weather, giảm phụ thuộc `window.*`.
- Đóng gói desktop Tauri **không thuộc lộ trình thương mại**; không thực hiện trừ khi có yêu cầu riêng.

## Tài liệu

- `AGENTS.md` — định hướng chiến lược và lộ trình.
- `roadmap_web_saas.md` — chi tiết từng giai đoạn, số đo và luồng dữ liệu.
- `AUDIT.md` — lỗi đã sửa, bảo mật và ma trận kiểm thử.