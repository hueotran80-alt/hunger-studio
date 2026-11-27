# Hướng dẫn bàn giao: nâng cấp Rust Render Kernel (dành cho Gemini)

Mục tiêu: render ảnh/video **nhanh và chi tiết gần Blender (Cycles)**, chạy 100% trong trình duyệt bằng Rust WASM. Đọc `AGENTS.md` (mục 2.10) trước. Quy tắc người dùng: luôn chạy CLI/headless, không mở GUI; trả lời tiếng Việt.

## 1. Hiện trạng (đã xong, test pass)
| Thành phần | File |
|---|---|
| Toán, RNG PCG | `crates/render_kernel/src/math.rs` |
| BVH binned-SAH, intersect/occluded | `.../bvh.rs` (Node có `axis`, duyệt near-first) |
| Env: gradient sky hoặc equirect + CDF importance sampling | `.../env.rs` |
| Denoise à-trous (albedo/normal), AgX/ACES/linear | `.../post.rs` |
| Scene, BSDF (GGX VNDF, diffuse, transmission), NEE đèn + HDRI MIS, Russian roulette, ABI C | `.../lib.rs` |
| Bridge WASM + pool Web Worker + `renderRust()` | `js/render/rust-render-bridge.js`, `rust-render-worker.js` |
| Đóng gói three.js → buffer | `js/render/rust-scene-pack.js` |
| Tích hợp UI ảnh / video | `pathtrace-render.js` (`renderRust`, select `#pt-engine`), `video-export.js` (`engine:'rust'`, `_renderRustFrame`) |
| Test | `cargo test` (4), `tests/test_rust_render.mjs` (7), nhóm 31 `tests/run_all.sh` |

ABI hiện tại (`lib.rs`, cuối file): `rk_alloc/free`, `rk_scene_load(pos,nrm,matIds,ntri,mats,nmat,lights,nlight)`, `rk_set_env(params16,rgb,w,h)`, `rk_set_camera(params16)`, `rk_render_rows(accum,aov,w,h,y0,y1,spp,seed,maxBounces,clamp)` (buffer **tile-relative**, tổng chứ không phải trung bình), `rk_denoise`, `rk_mean`, `rk_tonemap`, `rk_version`.
Layout: vật liệu `MAT_STRIDE=16` f32 `[base rgb, metal, rough, emit rgb, trans, ior, opacity, …]`; đèn `LIGHT_STRIDE=12` `[type(0 điểm/cầu,1 hướng), pos3, color3, dir3, radius, _]`.
Quy ước: màu linear; equirect `u=atan2(z,x)/2π+0.5`, hàng 0 = thiên đỉnh (packer tự lật khi `!flipY`); cường độ đèn như three.js (không nhân π).

## 2. Build & test (lệnh chuẩn)
```bash
cd crates/render_kernel
cargo test --release
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/render_kernel.wasm ../../vendor/wasm/
cd ../.. && node --import ./tests/three-resolve-hooks.mjs tests/test_rust_render.mjs
RUST_RENDER_PNG=/tmp/rk.png node --import ./tests/three-resolve-hooks.mjs tests/test_rust_render.mjs  # xuất ảnh ~90s, tự xem PNG
bash tests/run_all.sh
```
Mỗi lần đổi Rust **phải build lại WASM và copy** rồi mới chạy test JS. Không chạy test JS khi đang build.

## 3. Việc cần làm (theo thứ tự ưu tiên)

### P1. Texture map (khác biệt lớn nhất với Blender)
1. Kernel: thêm UV vào `Tri` (`uv0,uv1,uv2: [f32;2]`); `rk_scene_load` nhận thêm `uvs: f32[ntri*6]`.
2. Atlas texture: thêm `rk_set_textures(rgba8_or_f32_ptr, layout_ptr, n)`; mỗi texture có `offset,w,h`. Material thêm index: `baseColorTex, normalTex, roughMetalTex (G=rough,B=metal chuẩn glTF), emissiveTex` (dùng ô trống trong stride 16: vị trí 11–15). Bilinear sampling, repeat wrap; chuyển sRGB→linear cho base/emissive khi nạp.
3. Normal map: dựng TBN từ UV (tangent theo tam giác nếu không có thuộc tính tangent).
4. `rust-scene-pack.js`: đọc `geometry.attributes.uv`, `material.map/normalMap/roughnessMap/metalnessMap/emissiveMap` (qua canvas `getImageData` hoặc `texture.image.data`), giảm kích thước ≤2048², tạo atlas.
5. Test: Rust unit (lấy mẫu bilinear đúng, wrap), Node: quad có checker 2×2 → pixel đúng màu; Cornell scene giữ nguyên kết quả khi không có texture.

### P2. Hiệu năng
- Đo bằng benchmark native (`cargo bench` hoặc test `--nocapture`) rồi tối ưu: nén `Tri` (hiện ~100 B) — tách vertex/normal ra mảng riêng chỉ đọc khi trúng; BVH node 32 B; traversal 4-wide hoặc SIMD `wasm32 simd128` (`core::arch::wasm32`); gom tia (packet) cho camera ray.
- Sampling: Sobol/blue-noise thay PCG thuần; adaptive sampling theo variance mỗi tile.
- Mục tiêu: ≥ 3× hiện tại (hiện ~180k path/s/luồng ở cảnh 4,7k tri, 5 bounce).
- Giữ **tất định** và test `deterministic_and_row_tiling_equal`.

### P3. Chất lượng giống Blender
- Spot light có hình nón + `spot_blend` (dùng ô `LIGHT_STRIDE` còn trống: cos_outer, cos_inner, và dir); area light chữ nhật; sun có `angle` (cone nhỏ).
- Emissive mesh làm nguồn sáng NEE (lập bảng tam giác phát sáng theo diện tích×độ sáng, sample cùng MIS).
- Principled đầy đủ: clearcoat, sheen, subsurface xấp xỉ (random-walk đơn giản hoặc diffusion), anisotropy, thickness/absorption (Beer–Lambert theo `attenuationColor/Distance` của `MeshPhysicalMaterial`), volumetric fog đồng nhất.
- Camera: orthographic (hiện `packSceneForRust` đặt `orthographic:true` nhưng kernel chưa xử lý), DOF dùng `aperture/focus` (kernel có, packer đang đặt 0 — nối `camera.userData` hoặc thuộc tính DOF của studio).
- Khúc xạ: hiện thủy tinh trong ảnh thử hơi đục → rà lại `transmissive` (thêm trọng số G, nhân `1/eta²` khi radiance đi vào/ra, kiểm tra furnace test cho cầu thủy tinh: mong đợi ≈ 1 khi sky trắng).
- Denoise: thêm bộ lọc dựa variance (SVGF-lite) hoặc OIDN-style nhẹ; hiện `sigma` thủ công trong `post.rs`.
- Tone mapping: thêm exposure/Filmic "Khronos Neutral" nếu viewport dùng.

### P4. Video
- `renderVideo({engine:'rust'})` đang dựng BVH **từng frame**. Tối ưu: khi chỉ xương/transform đổi, refit BVH (`rk_refit(pos)`), hoặc giữ pool worker sống qua frame (hiện `renderRust` tạo/huỷ pool mỗi lần — cache pool trong `VideoExportManager`).
- Tái dùng denoise theo thời gian (temporal accumulation với motion vector) để giảm flicker; thêm option `seed = frameIndex` hoặc cố định seed (blue-noise ổn định) để chống nhấp nháy.
- Ngân sách: tôn trọng `VIDEO_BUDGET` (≤1080p, ≤1800 frame).

### P5. Hoàn thiện
- Dialog UI: thêm ô số luồng, nút chọn tonemap, hiển thị thời gian/ước lượng còn lại.
- Preview progressive: gửi ảnh trung gian mỗi N pass cho dialog (đã có `onProgress`, chưa có ảnh).
- Native CLI `crates/render_kernel/src/bin/rk_cli.rs` đọc scene JSON → PNG (dùng `rayon` chỉ cho bản native, đặt sau `cfg(not(target_arch="wasm32"))`).
- Cập nhật `AGENTS.md` mục 2.10 và `roadmap_web_saas.md` sau mỗi bước, nêu rõ phần chưa làm.

## 4. Cạm bẫy đã gặp
- Camera đặt ngoài hộp kín sẽ bị tường chắn (kernel bỏ qua `side`, mọi mặt đều đặc). Cảnh test cần camera bên trong room.
- `rk_render_rows` ghi buffer tile-relative; `Scene::render_rows` có tham số `base` — khi gọi từ test native với buffer toàn khung dùng `base=0`.
- Struct `Node` có `axis`; sửa BVH nhớ cập nhật test brute-force (`Node { …, axis: 0 }`).
- Không dùng thread WASM (cần COOP/COEP); song song hoá bằng nhiều Worker, mỗi Worker một instance WASM.
- Bộ nhớ WASM có thể grow → luôn đọc `memory.buffer` mới sau khi gọi kernel (bridge đã `.slice()`).
- `static mut SCENE`: một cảnh mỗi instance; đừng gọi đồng thời.

## 5. Tiêu chí hoàn thành mỗi bước
- `cargo test --release` và `tests/test_rust_render.mjs` pass; thêm test mới cho tính năng.
- `bash tests/run_all.sh` không hỏng nhóm nào (đặc biệt 29 video, 30 path-trace env).
- Xuất `RUST_RENDER_PNG` và tự xem ảnh để xác nhận trực quan.
- Báo cáo số đo thật (ms, spp, độ phân giải); không khẳng định "ngang Blender" nếu chưa so sánh cùng cảnh.
