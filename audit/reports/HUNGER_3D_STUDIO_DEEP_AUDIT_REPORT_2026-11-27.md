# 1. Kiểm định Lỗi, Rủi ro & Hồi quy tiềm ẩn

**Phạm vi kiểm chứng:** audit read-only; không sửa/tạo tệp. Tôi chạy `node tests/test_parametric_cad.mjs` (**7/7 PASS**) và các probe in-memory cho export, material, interleaved geometry, decimate, mixer, GLB và texture. Không chạy full gate/build/browser/DCC vì có thể sinh artifact. Kết quả `66/66 --fast` trong yêu cầu là do bạn cung cấp, không phải lượt chạy lại của tôi.

## P0 — chặn phát hành

| Mức | File:line | Nguyên nhân và bằng chứng | Cách sửa cụ thể |
|---|---|---|---|
| **[P0]** | [js/core/geometry/parametric-cad.js:484-553](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L484), [js/exporters/export-import.js:2300-2318](file:///Users/trantuan/Downloads/web-blender-studio/js/exporters/export-import.js#L2300), [GLTFExporter.js:1834-1836](file:///Users/trantuan/Downloads/web-blender-studio/vendor/three/addons/exporters/GLTFExporter.js#L1834) | `indexGeometry()` tạo geometry mới nhưng bỏ `groups`, `tangent`, `uv1` và attribute khác. Optimizer mặc định áp dụng cho mọi geometry non-indexed ≥300 vertex. Với mesh multi-material, `GLTFExporter` trả `null` khi `groups.length === 0`. **Probe thực tế:** `optimize:false` → 1 mesh/2 primitive; `optimize:true` → **0 mesh**. Đây là mất dữ liệu im lặng trong đường export mặc định. | Fix an toàn ngay: bỏ qua index tối ưu khi `groups.length > 0` hoặc có attribute chưa được hỗ trợ. Fix đầy đủ: copy `groups`, remap toàn bộ attribute qua weld map, bảo toàn `drawRange`; thêm test so sánh semantic GLB optimized/unoptimized. |

## P1 — vá trước khi nâng cấp tiếp

| Mức | File:line | Nguyên nhân và bằng chứng | Cách sửa cụ thể |
|---|---|---|---|
| **[P1]** | [parametric-cad.js:879-890](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L879), [parametric-cad.js:1028-1042](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L1028), [procedural-texture-worker.js:198-203](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-worker.js#L198), [procedural-texture-worker.js:612-623](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-worker.js#L612), [procedural-texture-client.js:139-179](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-client.js#L139), [copilot-exec-worker.js:68-98](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-exec-worker.js#L68), [copilot-runtime.js:606-619](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-runtime.js#L606) | Không có preflight finite/budget cho grid, merge, instance count, `cells`, `courses`, `octaves`; `cells: Infinity` có thể tạo vòng lặp cấp phát vô hạn. Timeout Worker sau đó chạy **đồng bộ trên main thread**, biến timeout thành freeze. Command/result cũng chỉ giới hạn 500 lệnh/64 args, không giới hạn byte, độ sâu hoặc độ dài string. | Dùng chung `DEFAULT_GEOMETRY_BUDGET`; validate integer/finite/range trước cấp phát; ước tính triangle/byte output. Thêm `MAX_COMMAND_BYTES`, depth và string/array caps ở cả Worker và parent. Timeout phải terminate Worker; không fallback đồng bộ với input vượt budget. |
| **[P1]** | [parametric-cad.js:1031](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L1031), [parametric-cad.js:1049-1051](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L1049), [parametric-cad.js:1173-1196](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L1173), [modifiers.js:273-310](file:///Users/trantuan/Downloads/web-blender-studio/js/core/modifiers.js#L273) | Các nhánh non-indexed truy cập trực tiếp `.array` như thể buffer liền màng. Với `InterleavedBufferAttribute` có stride/offset, dữ liệu bị lệch; probe mirror thậm chí ném `RangeError: offset is out of bounds`. | Chỉ dùng `.array` khi xác nhận `BufferAttribute` liền mục; ngược lại deinterleave qua `getX/getY/getZ/getW`. Thêm test stride > itemSize, offset ≠ 0 cho merge/mirror/worker codec. |
| **[P1]** | [export-import.js:1103-1137](file:///Users/trantuan/Downloads/web-blender-studio/js/exporters/export-import.js#L1103), [export-import.js:2263-2272](file:///Users/trantuan/Downloads/web-blender-studio/js/exporters/export-import.js#L2263) | GLB mặc định JPEG cho **mọi slot**, gồm `normalMap`, `roughnessMap`, `metalnessMap`, `aoMap`; `.wbs`/autosave lại monkeypatch toàn cục `ImageUtils.getDataURL` thành WebP q0.88 cho mọi texture >128px. JPEG/WebP không hoán đổi kênh glTF, nhưng gây artifact/quantization. Proxy q92/4:2:0 trên normal PNG: sai góc trung bình **3,29°**, material xấu nhất **18,86°**, p95 tới **40,25°**; roughness G có max error 55/255. | Chỉ JPEG/WebP cho albedo/emissive có màu. Normal/roughness/metalness/ao/clearcoat-normal luôn PNG. Bỏ monkeypatch toàn cục; clone material/texture theo slot hoặc serializer riêng có `mimeType`. Test pixel-hash/data-map angular error sau GLB và WBS round-trip. |
| **[P1]** | [export-import.js:2166-2225](file:///Users/trantuan/Downloads/web-blender-studio/js/exporters/export-import.js#L2166) | Material signature bỏ sót `thickness`, attenuation, iridescence, anisotropy, clearcoat-normal, nhiều map khác và texture rotation/center/flipY/channel/sampler. Packed metal-rough cache lại chỉ key theo `texture.image`. **Probe:** hai PhysicalMaterial khác `thickness` bị gộp thành một; material thứ hai lấy `thickness=0.2` thay vì `2.0`. | Mặc định tắt dedup material cho tới khi signature bao phủ toàn bộ trạng thái GLTF-relevant. Cache packed MR theo texture object/signature đầy đủ, copy transform/filter/anisotropy. Test thickness, iridescence, anisotropy, clearcoatNormalMap và cùng bitmap với transform khác nhau. |
| **[P1]** | [copilot-exec-worker.js:394](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-exec-worker.js#L394), [copilot-exec-worker.js:812](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-exec-worker.js#L812), [copilot-exec-worker.js:852-863](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-exec-worker.js#L852), [copilot-exec-worker.js:908](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-exec-worker.js#L908), [rapid-api.js:950-961](file:///Users/trantuan/Downloads/web-blender-studio/js/scripting/rapid-api.js#L950), [rapid-api.js:3083-3089](file:///Users/trantuan/Downloads/web-blender-studio/js/scripting/rapid-api.js#L3083) | Worker façade lệch hợp đồng Rapid API: `addGroup` bỏ options/parent/transform; `scatter(target,options)` không tương ứng `(source,surface,opts)`; camera rời mirror, screenshot trả `null`, video/PBR trả `{ok:true,deferred:true}`; thiếu `savePose`, `listPrefabs`, `searchPrefabs`; `getObject` chỉ theo tên. PBR deferred không cập nhật mirror nên `applyProceduralPBR()` rồi `setColor()` có thể bị PBR ghi đè sai thứ tự. | Dùng chung schema façade sinh từ RapidStudio; giữ đúng overload/args/return. Async parent-owned trả job handle và RPC lấy kết quả thật, không trả success giả. Đồng bộ mirror theo thứ tự command hoặc apply diff/live command đúng sequencing. |
| **[P1]** | [studio-bridge.js:493-516](file:///Users/trantuan/Downloads/web-blender-studio/js/core/studio-bridge.js#L493), [server.py:2703-2707](file:///Users/trantuan/Downloads/web-blender-studio/server.py#L2703), [studio_mcp.py:103-116](file:///Users/trantuan/Downloads/web-blender-studio/studio_mcp.py#L103) | `studio_execute_dsl` vẫn đi `/api/execute` → `AsyncFunction` trong **main realm**, có `window`, DOM, storage, cookie backend; không Worker/guard/transaction. `/api/execute` có token khi cấu hình, nhưng token holder vẫn vượt khỏi mô hình Copilot Worker. Timeout chỉ dừng chờ phản hồi, không hủy JavaScript đang chạy. | Mặc định route DSL qua `CopilotRuntime`/`agent.exec` đã nâng cấp parity. Nếu giữ legacy, tách chế độ privileged, cảnh báo rõ, dùng Worker terminable và transaction; không quảng bá đây là sandbox. |
| **[P1]** | [copilot-runtime.js:1088-1104](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-runtime.js#L1088), [copilot-runtime.js:1127-1195](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/copilot-runtime.js#L1127), [scene-manager.js:1125-1129](file:///Users/trantuan/Downloads/web-blender-studio/js/core/scene-manager.js#L1125) | Conflict check chạy trước `dispatchLiveCommands`; timer đã bị xóa. Trong lúc await render/video/tutor, người dùng có thể transform/delete object. `executeCommand()` đẩy thao tác đó vào batch AI đang mở, khiến undo AI hoàn tác cả thao tác người dùng; không có conflict check cuối. | Giữ deadline tới commit; khóa/queue input trong transaction hoặc tách job dài ra ngoài; hash scene/selection/camera lại trước commit. Mỗi LIVE command cần undo adapter riêng; camera/render/tutor/upload không được nằm chung batch geometry. |
| **[P1]** | [rapid-api.js:1557-1596](file:///Users/trantuan/Downloads/web-blender-studio/js/scripting/rapid-api.js#L1557), [rapid-api.js:1629-1642](file:///Users/trantuan/Downloads/web-blender-studio/js/scripting/rapid-api.js#L1629) | `RapidStudio` lưu engine ở `this._engine`, nhưng mixer dùng `this.engine`; lớp không có getter. Camera setup bị bỏ và `AnimationMixer.update()` không được đăng ký. **Probe:** mixer/action được tạo nhưng `addRenderCallback` = **0**. Overload object của `loadHumanWithAnimation({character,animation,x,y,z,showBones})` cũng bị bỏ qua. | Dùng `this._engine || window.engine || window.studioEngine`; hỗ trợ overload object; test bone transform thay đổi sau delta thật, không chỉ kiểm clip tồn tại. |
| **[P1]** | [rapid-api.js:316-367](file:///Users/trantuan/Downloads/web-blender-studio/js/scripting/rapid-api.js#L316) | `mergeMeshes({removeSources})` và `addInstancedMesh({removeSource})` xóa source bằng `recordHistory=false`, rồi mới tạo result. Undo chỉ gỡ result; source gốc đã mất. | Bọc remove + add trong `CompositeCommand`/transaction; undo phải khôi phục source, parent, selection và resource ownership. |
| **[P1]** | [agent-ui.js:539-543](file:///Users/trantuan/Downloads/web-blender-studio/js/agent/agent-ui.js#L539), [engine.js:1513-1517](file:///Users/trantuan/Downloads/web-blender-studio/js/core/engine.js#L1513) | Agent chỉ nhận diện đúng `delete|del|x`; engine lại xóa với mọi tổ hợp không Ctrl/Alt. Vì vậy `agent.ui.shortcut("Shift+X")` hoặc `Shift+Delete` xóa selection mà không dialog. | Normalize key + modifiers; mọi biến thể destructive phải `requiresConfirm`; đồng bộ manifest, executor và engine. |
| **[P1]** | [material-studio.js:842-863](file:///Users/trantuan/Downloads/web-blender-studio/js/core/material-studio.js#L842), [material-studio.js:1338-1362](file:///Users/trantuan/Downloads/web-blender-studio/js/core/material-studio.js#L1338), [modifiers.js:1073-1094](file:///Users/trantuan/Downloads/web-blender-studio/js/core/modifiers.js#L1073), [rust-scene-pack.js:508-530](file:///Users/trantuan/Downloads/web-blender-studio/js/render/rust-scene-pack.js#L508) | Vertex AO/color bị mất trên nhiều chặng: upgrade/preset không copy `vertexColors`; QEM decimate không remap `color`; Rust packer lấy trung bình tối đa 192 mẫu rồi nhân vào material. **Probe:** `vertexColors:true → false`; decimate có màu → output không màu. | Copy `vertexColors` và mọi map khi upgrade/preset; QEM phải nhận/remap color hoặc bypass khi có attribute chưa được hỗ trợ; Rust packer truyền color per-vertex/per-triangle thay vì average tint. |
| **[P1]** | [procedural-texture-client.js:144-147](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-client.js#L144), [procedural-texture-client.js:211-231](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-client.js#L211), [rapid-api.js:502-516](file:///Users/trantuan/Downloads/web-blender-studio/js/scripting/rapid-api.js#L502), [material-studio.js:58-60](file:///Users/trantuan/Downloads/web-blender-studio/js/core/material-studio.js#L58), [material-studio.js:763-789](file:///Users/trantuan/Downloads/web-blender-studio/js/core/material-studio.js#L763) | Cache gọi “LRU” nhưng không refresh hit; eviction/`clearCache()` dispose texture đang được material khác dùng. Với repeat=1, Rapid API gán chính texture cache vào material. 24 entry 2K có thể chiếm khoảng **1,5 GiB GPU** nếu tính ba map RGBA + mipmaps. MaterialStudio noise key bỏ `persistence/lacunarity`, không eviction; `setUVRepeat` mutate texture dùng chung và dùng height làm roughness. | LRU theo byte, refcount/lease hoặc clone khi gán material; không dispose tài nguyên còn lease. Key canonical đầy đủ; roughness map riêng; transform clone per material. |
| **[P1]** | [build_hung_nghia_v2_hunger.js:2394-2408](file:///Users/trantuan/Downloads/web-blender-studio/exports/build_hung_nghia_v2_hunger.js#L2394), [asset-ship-policy.json:4-13](file:///Users/trantuan/Downloads/web-blender-studio/assets/asset-ship-policy.json#L4), [vite.config.js:293-299](file:///Users/trantuan/Downloads/web-blender-studio/vite.config.js#L293) | Builder bắt buộc load `Mary_Statue_Sorrows.glb` nhưng nuốt mọi lỗi. Asset 6,4 MB vượt `maxAssetMB:5` và không có trong include nên bị loại khỏi `dist/`; file V4 hiện tại cũng không còn node `Altar_Statue_Duc_Me_CC0`. Delivery im lặng thiếu asset. | Fail build khi required asset thiếu; optimize statue <5 MB hoặc đưa vào include/CDN được phê duyệt; assert node/material/texture bắt buộc trong GLB cuối. |
| **[P1] Potential** | [server.py:1725-1746](file:///Users/trantuan/Downloads/web-blender-studio/server.py#L1725), [server.py:1786](file:///Users/trantuan/Downloads/web-blender-studio/server.py#L1786) | `/api/agent/*` chỉ kiểm client IP/Host loopback, không kiểm `STUDIO_TOKEN` như `/api/*` thường. Nếu reverse proxy cùng máy vẫn forward và rewrite Host thành `127.0.0.1:8080`, request từ xa có thể gọi agent/upload/exec mà không token. Chưa kiểm chứng proxy thật. | Áp token cho toàn bộ agent endpoints khi public; chỉ tin forwarded IP/Host của proxy đã khai báo `STUDIO_TRUSTED_PROXIES`; thêm test proxy loopback có/không token. |

## P2 — hiệu năng, lifecycle và độ tin cậy kiểm chứng

| Mức | File:line | Nguyên nhân và bằng chứng | Cách sửa cụ thể |
|---|---|---|---|
| **[P2]** | [parametric-cad.js:499-535](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L499) | Weld dùng string key cho mỗi vertex. Benchmark Node trên **195.072 vertex** mất **0,47–0,53 giây**, tạo nhiều string/Map entry và có thể block main thread. Fixed scale `1e-4` cũng có thể weld sai chi tiết cơ khí rất nhỏ. | Dùng `weldAndExtractTopology` Rust cho mesh lớn; JS fallback dùng typed numeric hash + so sánh chính xác khi collision. Scale theo bounding diagonal và khai báo tolerance. |
| **[P2] Potential** | [procedural-texture-worker.js:269-279](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-worker.js#L269), [procedural-texture-worker.js:374-377](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-worker.js#L374), [procedural-texture-worker.js:469-479](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-worker.js#L469), [procedural-texture-worker.js:518-527](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-worker.js#L518), [procedural-texture-client.js:106-128](file:///Users/trantuan/Downloads/web-blender-studio/js/render/procedural-texture-client.js#L106) | Một số pattern dùng hash/ID không wrap; proxy đo cạnh biên cho thấy albedo `checkered_marble` chênh **4,96×** cạnh nội bộ, `ashlar_stone` **2,63×**. CanvasTexture `flipY=true` và DataTexture `flipY=false` có thể làm đổi chiều normal dọc. Chưa render xác minh trực quan. | Wrap hash modulo block/course, bảo đảm parity và noise chu kỳ; thống nhất quy ước flipY/normal; test slope có hướng và seam metric. |
| **[P2]** | [bvh-accelerator.js:79-100](file:///Users/trantuan/Downloads/web-blender-studio/js/core/bvh-accelerator.js#L79), [bvh-accelerator.js:182-190](file:///Users/trantuan/Downloads/web-blender-studio/js/core/bvh-accelerator.js#L182), [mesh-kernel-bridge.js:27-40](file:///Users/trantuan/Downloads/web-blender-studio/js/core/mesh-kernel-bridge.js#L27), [mesh-kernel-bridge.js:140-158](file:///Users/trantuan/Downloads/web-blender-studio/js/core/mesh-kernel-bridge.js#L140), [parametric-cad.js:1115-1117](file:///Users/trantuan/Downloads/web-blender-studio/js/core/geometry/parametric-cad.js#L1115), [modifier-stack.js:122-136](file:///Users/trantuan/Downloads/web-blender-studio/js/core/modifier-stack.js#L122) | `disposeBVH()` không abort request; kết quả muộn có thể gắn lại boundsTree. Node bridge bỏ qua `ArrayBuffer` được truyền vào. Rust output buffer giữ capacity high-water. `buildInstancedMesh([])` tạo **1 instance ảo** — đã probe. Modifier mutate không restore descriptor/state nếu evaluate ném lỗi. | AbortSignal/token cho BVH; nhận byte source trước nhánh Node; export clear-output sau khi copy; empty list → count 0; modifier mutate dùng try/catch khôi phục snapshot. |
| **[P2]** | [agent-exec-worker.js:41-90](file:///Users/trantuan/Downloads/web-blender-studio/js/agent/agent-exec-worker.js#L41), [agent-tool-bridge.js:8](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/agent-tool-bridge.js#L8), [agent-tool-bridge.js:138-140](file:///Users/trantuan/Downloads/web-blender-studio/js/ai/agent-tool-bridge.js#L138), [app.js:482](file:///Users/trantuan/Downloads/web-blender-studio/js/app.js#L482), [studio-bridge.js:208-215](file:///Users/trantuan/Downloads/web-blender-studio/js/core/studio-bridge.js#L208) | `agent.exec` dựng mọi object có geometry thành `Mesh`, mất light/camera/instancing/skin và nhiều capability. Manifest thực tế **66 tool**, không phải 68; catalog bị cắt cứng ở **3.400 ký tự**. Badge quảng bá `/mcp` nhưng server Python không có route đó. | Dùng chung snapshot codec/facade; sinh catalog/prompt từ schema, phân nhóm thay vì cắt chuỗi; sửa/loại bỏ badge MCP endpoint không tồn tại. |
| **[P2]** | [test_parametric_cad.mjs:91-114](file:///Users/trantuan/Downloads/web-blender-studio/tests/test_parametric_cad.mjs#L91), [test_parametric_cad.mjs:135-165](file:///Users/trantuan/Downloads/web-blender-studio/tests/test_parametric_cad.mjs#L135), [run_all.sh:554-568](file:///Users/trantuan/Downloads/web-blender-studio/tests/run_all.sh#L554), [godot_import_check.sh:28-35](file:///Users/trantuan/Downloads/web-blender-studio/tests/godot_import_check.sh#L28), [blender_import_check.sh:22-29](file:///Users/trantuan/Downloads/web-blender-studio/tests/blender_import_check.sh#L22) | Test tên “watertight” chỉ kiểm count/index/bbox; PBR chỉ kiểm độ dài buffer. `--fast` bỏ browser và production build. Godot/Blender mặc định chỉ kiểm fixture skinned, không kiểm GLB static tối ưu, vertex color, normal/roughness JPEG/WebP. Hai artifact GLB hiện có cũng không cùng scene hash: V2 **157.390 unique / 242.986 rendered tris**, V4 **297.258 / 504.022**, nodes **278→348**, materials **76→42**, images **71→41**. | Thêm topology/manifold/degenerate/finite-attribute tests, deterministic PBR hash/seam, optimizer semantic parity, static DCC import và benchmark A/B cùng scene UUID/hash. Full gate phải bao gồm browser + dist. |

### Trả lời trực tiếp các nghi vấn chính

- **JPEG trên normal/roughness:** hợp lệ về schema glTF và không hoán đổi kênh tuyến tính, nhưng **không an toàn chất lượng**; nên PNG cho data map.
- **`indexGeometry` string key:** đúng là có chi phí GC/block; ngoài ra còn có lỗi P0 bỏ groups/attribute.
- **`vertexColors` Uint8:** hiện tại GLB có `COLOR_0 = UNSIGNED_BYTE, normalized=true`, là accessor hợp lệ. Three path tracer và Rust packer đọc qua `getX()` nên hiểu normalized; tuy nhiên Rust packer **làm mất chi tiết per-vertex do lấy trung bình**, và Blender/Godot chưa được test trên GLB static tối ưu này.
- **`clearCache()`/shared material:** **có** dispose nhầm texture đang được object khác dùng. Three thường upload lại được, nhưng gây giật VRAM/GPU; không nên coi cache là owner duy nhất khi material còn lease.

---

# 2. Khoảng trống Tính năng Dựng hình & Tối ưu Web

## Nền đã có — không nên viết lại

- Boolean sync/async/modifier đã tồn tại trong [modifiers.js:582-689](file:///Users/trantuan/Downloads/web-blender-studio/js/core/modifiers.js#L582) và [modifiers.js:946-1047](file:///Users/trantuan/Downloads/web-blender-studio/js/core/modifiers.js#L946); `Modifiers.applyBoolean` cũng đã có trong `LIVE_COMMANDS`.
- Rust `mesh_kernel` đã có QEM simplify, surface scatter và LOD culling tại [crates/mesh_kernel/src/lib.rs:1500](file:///Users/trantuan/Downloads/web-blender-studio/crates/mesh_kernel/src/lib.rs#L1500), [crates/mesh_kernel/src/lib.rs:2047](file:///Users/trantuan/Downloads/web-blender-studio/crates/mesh_kernel/src/lib.rs#L2047), [crates/mesh_kernel/src/lib.rs:2253](file:///Users/trantuan/Downloads/web-blender-studio/crates/mesh_kernel/src/lib.rs#L2253).
- Decal projection đã có ở agent API: [agent-geometry.js:724-792](file:///Users/trantuan/Downloads/web-blender-studio/js/agent/agent-geometry.js#L724). Thiếu là façade `studio.*`, Worker parity và UI, không phải thuật toán decal.
- Draco **import** đã có tại [export-import.js:2506-2517](file:///Users/trantuan/Downloads/web-blender-studio/js/exporters/export-import.js#L2506); export compression thì chưa.

| Khoảng trống | API/implementation đề xuất | Rust WASM | Copilot Worker / LIVE_COMMANDS |
|---|---|---|---|
| **Parametric history/constraint graph** | `studio.createParametric({params, operations, constraints})`, rebuild dirty subset; JSON/WBS round-trip. Hiện CAD chủ yếu là geometry tức thời, modifier stack không phải constraint graph. | Preflight triangle/byte, weld/index/merge. | Worker chạy JSON spec thuần; LIVE chỉ cho parent-owned modifier/asset. Không serialize closure/function. |
| **Multi-profile loft thật** | `buildLoftGeometry({sections, caps, twist, parallelTransport})`; resample profile, scale/rotate section, UV và normal theo frame. `addLoft()` hiện chỉ alias surface grid tại [rapid-api.js:312-314](file:///Users/trantuan/Downloads/web-blender-studio/js/scripting/rapid-api.js#L312). | Ban đầu có thể JS/Worker; đưa tessellation vào Rust nếu benchmark >50k tris cho thấy cần. | Bắt buộc facade Worker `addLoft({sections})`; không cần LIVE nếu chạy hoàn toàn trong mirror. |
| **Boolean CSG public** | `studio.boolean({target, operands, operation, solver})` non-destructive; dùng lại `three-bvh-csg`/modifier hiện có. | Cleanup/weld/remap attribute sau CSG. | Expose façade Worker; dùng lại LIVE `Modifiers.applyBoolean` khi CSG cần parent BVH/scene. |
| **Cơ khí chuẩn thương mại** | Gear/involute, thread, pipe elbow, sheet-metal bend, draft/tolerance inspection. Đây là các algorithm có tham số, không phải preset hardcode. | Topology nặng: gear/thread tessellation, bend, weld, QEM. | Facade Worker + parity test; LIVE cho operation cần parent selection/undo. |
| **3D curves + instanced scatter** | `studio.createCurve3D`, `sampleCurve`, `scatterOnCurve/Surface` với seed, density, normal alignment, exclusion mask. Curve UI hiện mới chủ yếu Bezier tại [curve-objects.js:311](file:///Users/trantuan/Downloads/web-blender-studio/js/core/curve-objects.js#L311). | Dùng lại `mesh_kernel_scatter_surface`; thêm curve sampling nếu cần. | Facade Worker; LIVE `studio.scatter` hiện đã có nhưng phải sửa signature. |
| **Decal/signage/muntin/relief** | Mở rộng decal hiện có thành `studio.decal`; thêm text/signage, muntin grid, relief heightfield. Muntin nên là geometry/profile sweep, không chỉ texture. | Projection/clip cho mesh rất lớn; displacement heightfield. | Decal thuần có thể Worker; texture fetch/apply parent-owned qua asset/LIVE command. |
| **Procedural PBR generic** | Recipe schema: noise/voronoi/warp/color-ramp/mask, seed, scale, world/UV, output channel. Serialize recipe để WBS regenerate, không chỉ lưu bitmap. | **Không đưa vào `mesh_kernel`.** Tiến trình pixel thuộc Web Worker/GPU. | Worker facade + parent texture worker; LIVE `studio.applyProceduralPBR` phải trả job thật và cập nhật mirror. |
| **Meshopt / quantization / Draco export** | Post-process GLB: `KHR_mesh_quantization` có error bound; `EXT_meshopt_compression` mặc định preset Web; Draco tùy chọn DCC; fallback plain GLB. | Không dùng `mesh_kernel` làm codec; dùng meshoptimizer WASM/Draco encoder. | Parent-owned export job; LIVE `studio.exportModel`/`studio.optimizeForWeb` có approval và progress. Phải vendor `MeshoptDecoder` và gắn vào mọi `GLTFLoader`, vì hiện Studio chưa configure. |
| **Auto-LOD thống nhất** | Expose LOD0/1/2, screen-space error, hysteresis, export LOD; hiện import auto-LOD đã có tại [export-import.js:3547-3565](file:///Users/trantuan/Downloads/web-blender-studio/js/exporters/export-import.js#L3547). | Dùng lại QEM + `cull_and_lod_instances`. | Facade Worker; LIVE `studio.enableAutoLOD`/`disableAutoLOD` đã có, cần job/result thật. |
| **`studio.inspectSceneBudget()`** | Báo unique/rendered tris, geometry bytes, texture bytes + mipmaps, draw calls, materials, instances, animation, estimated GLB, heap/VRAM nếu có. | Triangle/byte planner và LOD counts. JS đọc `renderer.info`. | Read-only RPC, **không đưa vào LIVE mutation**; mirror trả báo cáo cùng schema. |

**Nguyên tắc:** pure CAD/material logic chạy trong Worker mirror; `LIVE_COMMANDS` chỉ chứa thao tác parent-owned như DOM/Blob/export, texture worker, camera/render, job Rust và transaction. Không mở rộng allowlist cho mọi hàm thuần.

---

# 3. Khoảng trống Giao diện Web & AI Copilot cho Người dùng cuối

## Bằng chứng hiện trạng

- Material Shelf chỉ có **24 preset** tại [material-shelf.js:23-35](file:///Users/trantuan/Downloads/web-blender-studio/js/ui/material-shelf.js#L23) và [material-shelf.js:67-85](file:///Users/trantuan/Downloads/web-blender-studio/js/ui/material-shelf.js#L67).
- Inspector đã có procedural legacy, nhưng chỉ **6 pattern** tại [inspector.js:2512-2528](file:///Users/trantuan/Downloads/web-blender-studio/js/ui/inspector.js#L2512); nó gọi generator đồng bộ tại [inspector.js:3047-3051](file:///Users/trantuan/Downloads/web-blender-studio/js/ui/inspector.js#L3047) và dùng `heightCanvas` làm roughness tại [inspector.js:3085-3093](file:///Users/trantuan/Downloads/web-blender-studio/js/ui/inspector.js#L3085). Chín pattern kiến trúc mới chưa có trong UI.
- File → Export gọi exporter trực tiếp, không dialog tùy chọn: [index.html:161-197](file:///Users/trantuan/Downloads/web-blender-studio/index.html#L161), [app.js:838-847](file:///Users/trantuan/Downloads/web-blender-studio/js/app.js#L838).
- Header đã có Objects/Verts/Faces/FPS/Frame tại [index.html:385-392](file:///Users/trantuan/Downloads/web-blender-studio/index.html#L385), và tracker tại [app.js:2029-2071](file:///Users/trantuan/Downloads/web-blender-studio/js/app.js#L2029). Chưa có budget RAM/VRAM/GLB tổng hợp.
- Agent mới có `observe.performance` với `gpuMemMB:null` tại [agent-api.js:178](file:///Users/trantuan/Downloads/web-blender-studio/js/agent/agent-api.js#L178); catalog Copilot bị cắt ở 3.400 ký tự.

## Thiết kế tích hợp không phá bố cục Blender 4.x

### Material / Procedural PBR

- **Material Shelf:** giữ grid 24 preset, thêm tab **Architectural / Procedural** với 9 card preview 128px; không thêm dock.
- **Inspector → Material:** thêm accordion “Procedural recipe” ngay dưới texture slots: pattern, seed, resolution, repeat/world-space, roughness range, bump, color1/2, output slots, cache bytes. Preview sinh asynchronous, có Cancel.
- **Advanced:** hiển thị badge `Albedo sRGB`, `Normal linear`, `Roughness linear`, `Mipmaps`, `Anisotropy`; cảnh báo nếu data map định encode lossy.
- Dùng cùng một `ProceduralTextureClient` cho UI và DSL để UI/API không lệch hành vi.

### Export Dialog

Thêm `js/ui/export-dialog.js`, mở từ File → Export → **glTF/GLB Options…**; giữ nút quick export cũ.

- Preset: **Web Share**, **Game/Engine**, **DCC Interchange**, **Archive/Lossless**.
- Texture: Auto/JPEG color + PNG data/PNG all; Max texture 512/1024/2048/4096.
- Geometry: weld/index, quantization error, meshopt, Draco optional, LOD0 only.
- Dự kiến: GLB bytes, unique/rendered tris, draw calls, texture VRAM, thời gian export.
- Cảnh báo cụ thể nếu người dùng chọn JPEG cho normal/roughness; sau export xuất `export-report.json` gồm scene hash, options, extension, counts, warnings.

### Viewport Budget HUD

- Không thêm panel mới. Thêm chip **Budget…** vào header stats hiện có; click mở popover.
- Chip chính: FPS, Draw calls, Rendered tris, Texture VRAM, Geometry RAM, Estimated GLB.
- Màu theo tier: xanh/amber/đỏ; tooltip giải thích unique vs rendered tris.
- Dùng chung dữ liệu với `studio.inspectSceneBudget()` để HUD, Copilot và Export Dialog không có ba con số khác nhau.

### AI Copilot

- Thay catalog bị cắt bằng catalog phân nhóm `scene / geometry / material / animation / export / observe`.
- Hiển thị capability chips: `CAD`, `PBR`, `Budget`, `Export`, `Worker-safe`, `Unsupported`.
- Thêm prompt templates: **Inspect budget**, **Optimize for web**, **Apply architectural PBR**, **Build parametric model**.
- Async operation phải hiển thị job/progress/result thật; không trả “deferred success”.
- Thêm tool read-only `scene.budget`; `scene.optimize` và `export.model` phải có approval rõ ràng.
- Sửa/loại badge `/mcp` endpoint không tồn tại, hoặc triển khai HTTP MCP authenticated thật.

---

# 4. Thiết kế Bộ Skill Dựng hình Chuẩn hóa cho Hunger

## Hiện trạng cần thay thế

- Có **14 skill**, nhưng **12/14** trỏ tới `../text-to-blender/references/mcp-backends.md` không tồn tại, ví dụ [blender-modeling/SKILL.md:12](file:///Users/trantuan/Downloads/web-blender-studio/.agents/skills/blender-modeling/SKILL.md#L12).
- [reference-to-3d/SKILL.md:21-25](file:///Users/trantuan/Downloads/web-blender-studio/.agents/skills/reference-to-3d/SKILL.md#L21) yêu cầu chuỗi năm skill không có trong repo.
- Phần lớn skill hướng `bpy`/Blender desktop; ngay cả web pipeline vẫn dùng `bpy.context` và `.blend`.
- Skill Hưng Nghĩa nhận V2 tại [hung-nghia-gothic-archviz/SKILL.md:6](file:///Users/trantuan/Downloads/web-blender-studio/.agents/skills/hung-nghia-gothic-archviz/SKILL.md#L6), builder lại ghi V4; màu `weathered_concrete` và muntin đã lệch nhau.
- Builder là monolith hardcode, không transaction, không camera/export/QA; chỉ trả counts tại [build_hung_nghia_v2_hunger.js:2841-2848](file:///Users/trantuan/Downloads/web-blender-studio/exports/build_hung_nghia_v2_hunger.js#L2841).

## Kiến trúc 8 skill mô-đun

| Skill | Trigger | Quy trình chuẩn | Đầu ra / gate |
|---|---|---|---|
| **`hunger-orchestrator`** | Mọi yêu cầu end-to-end, reference-locked, nhiều phase. | Capability discovery → đọc project contract → chọn skill → stage gate → transaction → delivery. | Không bắt đầu mutate nếu thiếu capability/asset/budget. |
| **`hunger-project-contract`** | Project có reference, cần build lặp lại hoặc nhiều agent. | Trích dimensions/parts/materials/assets/shots/budgets thành JSON; validate license/hash/URI. | Toàn bộ tên công trình, tọa độ, hex, ảnh tham chiếu nằm ở đây, không nằm trong generic skill. |
| **`hunger-parametric-cad`** | H Hollow/mechanical/product/landscape modeling. | Blockout → profile/path/sections → topology preflight → generate → manifold/finite check → modifier. | Closed mesh: boundary/non-manifold/degenerate = 0; mọi attribute finite. |
| **`hunger-surface-pbr`** | Material, UV, texture, texel density, look-dev. | Phân loại surface → UV/texel density → recipe → Worker generate → seam/channel check → apply. | Data map PNG; deterministic hash; seam metric đạt; texture budget đạt. |
| **`hunger-character-mocap`** | Nhân vật, rig, skin, mocap, animation. | Rig contract → import/auto-skin → weight check → retarget → foot-lock → clip/export. | Không đổi tên xương; track không mồ côi; skin weight hợp lệ. |
| **`hunger-camera-look`** | Camera, lighting, render, reference look. | Bbox/reference → shot contract → camera → three-point/HDRI → look calibration → render. | Không hardcode lens/vị trí/energy; multi-zoom crop và exposure đạt threshold. |
| **`hunger-runtime-budget-agent`** | Scene lớn, Copilot/Worker/MCP, batch operation. | Preflight → dry-run → instance/LOD → facade parity → transaction → timeout/abort → rollback. | Không vượt code/asset/geometry/texture/message budget; async có job thật. |
| **`hunger-multizoom-qa-delivery`** | Mỗi milestone và final. | Shot matrix → topology/material check → multi-zoom → GLB/WBS export → reimport → credits/hash/budget. | 0 missing texture/clipping/z-fighting/uncaught; DCC import PASS. |

### Quy tắc chống hardcode chung

- Generic skill **cấm** `bpy`, `mcp__blender`, tên Hưng Nghĩa, tên ảnh wiki, absolute path, fixed world coordinate/material hex.
- “0% hardcode” không có nghĩa không có tham số; nó nghĩa là **algorithm tách khỏi project data**.
- Mọi mutation qua `studio.*`/agent facade; không `scene.add`, DOM hay engine object trực tiếp trong recipe generic.
- JSON-only contract, seed deterministic, đơn vị mét/Y-up, UUID/tên ổn định.
- Mọi asset/reference có URI, author, license, SHA-256, bytes; required asset phải có trong `dist/` hoặc approved remote URL.
- Không nuốt lỗi bằng `catch (_) {}`; thiếu capability trả `E_UNSUPPORTED`.

### Ngân sách bắt buộc đề xuất

| Tier | Rendered tris | Draw calls | Texture VRAM | GLB |
|---|---:|---:|---:|---:|
| Product/mobile | ≤50k / ≤30k | ≤60 / ≤40 | ≤64 / ≤32 MiB | ≤8 / ≤5 MiB |
| Architecture | ≤750k | ≤350 | ≤96 MiB | ≤24 MiB |

Giữ các hard cap hiện có: code ≤200.000 byte, asset ≤50 MiB, mỗi geometry op input ≤250k/output ≤500k tris, texture ≤2048², snapshot ≤20 triệu array elements. Override phải ghi lý do trong project contract.

### Multi-zoom QA bắt buộc

1. Shot matrix: overview, 3/4, front/side/back, detail macro, interior/cavity; khoảng cách suy từ bounding diagonal hoặc project contract.
2. Reference-locked: IoU ≥0,95, bbox error ≤2%, centroid drift ≤1%, part count exact.
3. Topology: boundary/non-manifold/degenerate = 0 cho closed mesh; tất cả attribute finite.
4. Surface: không thiếu texture, seam bất thường, stretched UV, z-fighting, clipping; LOD không pop rõ.
5. Delivery: GLB/WBS reimport, node/material/texture counts, credits/hash, budget report; Godot/Blender static import PASS.

### Portability

- Dùng chung `SKILL.md` + `references/` + deterministic scripts; không gắn tool-specific vào nội dung generic.
- Qoder/Antigravity gọi `studio.*`; MCP adapter map tới `studio_agent_call`, `studio_execute_dsl`, `studio_capture_viewport`, `studio_export_model`.
- Host thiếu DOM/Worker/screenshot phải dừng hoặc trả `E_UNSUPPORTED`, không giả lập thành công.
- Skill `hung-nghia-gothic-archviz` nên thu còn thành **project profile** tham chiếu các Hunger skill chung, chỉ chứa dữ liệu/reference riêng của công trình.

---

# 5. Lộ trình Thực thi Ưu tiên

## Phase 1 — Vá P0/P1 và chốt hợp đồng dữ liệu

**File sửa:**  
`js/core/geometry/parametric-cad.js`, `js/core/modifiers.js`, `js/core/material-studio.js`, `js/render/procedural-texture-worker.js`, `js/render/procedural-texture-client.js`, `js/exporters/export-import.js`, `js/ai/copilot-exec-worker.js`, `js/ai/copilot-runtime.js`, `js/scripting/rapid-api.js`, `js/core/studio-bridge.js`, `js/agent/agent-ui.js`, `js/core/engine.js`, `server.py`, `studio_mcp.py`.

**Nghiệm thu đo được:**

- GLB optimized/unoptimized có cùng node UUID, mesh/primitive/material-slot counts; multi-material không mất mesh; `groups/tangent/uv1` còn nguyên.
- Normal/roughness sau GLB và WBS round-trip có pixel-hash/angular error **0** ở preset lossless.
- 100% public Rapid method có parity test Worker; không còn async result giả.
- Inject user edit giữa LIVE command → `E_TX_CONFLICT`; thao tác user không bị undo cùng AI.
- Mixer đăng ký đúng 1 render callback; bone transform đổi sau 500 ms; overload object được áp dụng.
- `Shift+X/Delete` luôn yêu cầu confirm; merge/instancing undo khôi phục source.
- Full gate hiện tại **68/68**, browser **0 blocked/0 uncaught**, không chỉ `--fast`.

**Test bổ sung:** `tests/test_glb_optimizer.mjs`, `tests/test_procedural_contract.mjs`, `tests/test_copilot_parity.mjs`, `tests/test_copilot_transaction.mjs`, `tests/test_rapid_animation.mjs`, `tests/test_agent_shortcuts.mjs`, mở rộng `test_parametric_cad.mjs` và `test_agent_server.py`.

## Phase 2 — Nâng cấp lõi CAD/PBR/nén GLB và đồng bộ Copilot

**File sửa/tạo:**  
`js/core/geometry/parametric-cad.js`, `js/core/modifiers.js`, `js/core/mesh-kernel-bridge.js`, `crates/mesh_kernel/src/lib.rs`, `js/render/procedural-texture-worker.js`, `js/render/procedural-texture-client.js`, `js/core/material-studio.js`, `js/scripting/rapid-api.js`, `js/ai/copilot-exec-worker.js`, `js/ai/copilot-runtime.js`, `js/agent/agent-manifest.js`, `js/ai/agent-tool-bridge.js`, `js/exporters/export-import.js`, `package.json`, `vite.config.js`, tạo `vendor/meshopt/meshopt_decoder.module.js` và `js/core/scene-budget.js`.

**Nghiệm thu đo được:**

- Multi-profile loft ≥3 section: closed manifold, degenerate=0, mọi attribute finite; Boolean volume parity ±1%.
- Rust weld 195k vertex ≤100 ms trên máy tham chiếu; JS fallback cho kết quả tương đương.
- Scatter cùng seed cho matrix hash giống hệt; Auto-LOD giữ LOD0 bất biến.
- Preset Web 512, PNG data maps + meshopt: mục tiêu GLB **≤12 MiB** cho fixture Hưng Nghĩa; nếu chưa đạt phải báo cáo, không ngầm chuyển data map sang JPEG.
- Export ≤2 s, JS heap peak ≤256 MB, texture VRAM ≤96 MB, viewport ≥55 FPS trên cùng máy benchmark.
- GLB meshopt mở lại được trong Studio, Godot và Blender; fallback plain GLB khi encoder/decoder lỗi.
- `studio.inspectSceneBudget()` báo unique/rendered tris chính xác; geometry bytes sai số 0%, VRAM estimate ±15%.

**Test bổ sung:** `tests/test_multi_profile_loft.mjs`, `tests/test_boolean_facade.mjs`, `tests/test_meshopt_export.mjs`, `tests/test_scene_budget.mjs`, `tests/test_parametric_history.mjs`, `tests/test_mechanical_tools.mjs`; thêm Rust unit tests và static DCC import.

## Phase 3 — Lên Web UI

**File sửa/tạo:**  
`index.html`, `css/blender-theme.css`, `js/app.js`, `js/ui/material-shelf.js`, `js/ui/inspector.js`, `js/ai/ai-copilot.js`, tạo `js/ui/export-dialog.js` và `js/ui/viewport-budget-hud.js`.

**Nghiệm thu đo được:**

- UI và DSL tạo cùng scene hash/material/export options.
- Layout 1280×720, 1440×900, 1920×1080: không overlap, không che viewport, keyboard focus rõ.
- Budget HUD cập nhật trong 1 frame sau add/delete/dispose; con số khớp `inspectSceneBudget()`.
- Export Cancel/abort không để texture/temp geometry; 10 vòng export liên tiếp không tăng heap/VRAM bất thường.
- Copilot hiển thị job thật, catalog không bị cắt, destructive action có approval.

**Test bổ sung:** mở rộng `tests/browser-suite.html`, `tests/render-suite.html`, `tests/lod-instancing-suite.html`; thêm `tests/parametric-ui-suite.html` cho Material/Export/Budget/Copilot.

## Phase 4 — Xây dựng và kiểm thử bộ Skill Hunger

**File tạo/sửa:**  
Tạo `.agents/skills/hunger-orchestrator/`, `hunger-project-contract/`, `hunger-parametric-cad/`, `hunger-surface-pbr/`, `hunger-character-mocap/`, `hunger-camera-look/`, `hunger-runtime-budget-agent/`, `hunger-multizoom-qa-delivery/`; thu gọn `hung-nghia-gothic-archviz` thành project profile; cập nhật `skills-lock.json`.

**Nghiệm thu đo được:**

- 8/8 skill lint PASS; 0 dead link, 0 TODO, 0 banned literal trong generic skill; mỗi skill có positive/negative eval.
- Hai project chưa từng thấy — một sản phẩm cơ khí và một cảnh kiến trúc/landscape — chạy cùng bộ generic skill, không viết script primitive riêng.
- Hoàn tất model → material → render → export → WBS save/reload → DCC import trong ≤4 giờ làm việc.
- Multi-zoom QA đạt topology, surface, budget, provenance; required asset không vắng trong `dist/`.

**Test bổ sung:** `tests/test_hunger_skills.mjs`, `tests/test_hunger_contract.py`, fixtures `tests/fixtures/hunger-product/` và `tests/fixtures/hunger-landscape/`, cùng host-parity test Qoder/MCP.

**Kết luận thực thi:** ưu tiên Phase 1 trước mọi tính năng mới, đặc biệt P0 mất mesh GLB. Không tệp nào bị chỉnh sửa trong phiên này; SHA-256 của 15 tệp mục tiêu được giữ nguyên trước và sau audit.
