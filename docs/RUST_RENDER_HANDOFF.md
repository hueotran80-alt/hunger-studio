# Rust Render Kernel — Handoff hiện hành

Tài liệu này dành cho người tiếp tục `crates/render_kernel/`. Trạng thái sản phẩm và gate xem [README.md](../README.md); ngữ cảnh kiến trúc xem [AGENTS.md](../AGENTS.md#3-lộ-trình-thực-hiện).

## 1. Phạm vi đã hoàn thành

- BVH2/BVH4, traversal 4-wide SIMD, `rk_refit`.
- Tách `TriGeom`/`TriAttr`, texture atlas RGBA8, bilinear + sRGB LUT + TBN normal map.
- Principled BSDF: GGX/VNDF anisotropic, clearcoat, sheen, subsurface wrap, transmission + Beer–Lambert, AOV.
- NEE + MIS cho point/sphere/sun/spot/rect-area light; emissive mesh + HDRI.
- Volume fog đồng nhất, Sobol/QMC, adaptive sampling, variance-guided à-trous denoiser.
- Temporal reprojection theo motion vector, neighborhood clamp.
- AgX/ACES/Neutral/Linear tone mapping.
- Native CLI `rk_cli` đa luồng và WASM bridge/pool Worker cho ảnh + video.

## 2. File chính

| Thành phần | File |
|---|---|
| Kernel, scene, BSDF, light, ABI | `crates/render_kernel/src/lib.rs` |
| BVH/refit/SIMD | `crates/render_kernel/src/bvh.rs` |
| Environment/HDRI | `crates/render_kernel/src/env.rs` |
| Denoise/tone map | `crates/render_kernel/src/post.rs` |
| Native CLI | `crates/render_kernel/src/bin/rk_cli.rs` |
| WASM bridge + Worker pool | `js/render/rust-render-bridge.js`, `js/render/rust-render-worker.js` |
| Three.js → buffer packer | `js/render/rust-scene-pack.js` |
| UI ảnh/video | `js/render/pathtrace-render.js`, `js/render/video-export.js` |
| Test | `crates/render_kernel/`, `tests/test_rust_render.mjs` |

ABI hiện tại gồm `rk_alloc/free`, `rk_scene_load`, `rk_set_env`, `rk_set_camera`, `rk_render_rows`, `rk_denoise`, `rk_mean`, `rk_tonemap`, `rk_version` và `rk_refit`. Khi đổi ABI phải cập nhật đồng bộ Rust, bridge, packer và test.

## 3. Build & test chuẩn

```bash
cargo test --release
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --lib
cp target/wasm32-unknown-unknown/release/render_kernel.wasm vendor/wasm/render_kernel.wasm
node --import ./tests/three-resolve-hooks.mjs tests/test_rust_render.mjs
bash tests/run_all.sh --fast
npm run test:browser
npm run test:dist
```

Mỗi lần đổi Rust phải build lại WASM và copy artifact trước khi chạy test JS. Không chạy song song lệnh build WASM và test đọc artifact.

## 4. Việc tiếp theo

1. Đối chiếu chất lượng với Blender Cycles/Unity trên cùng cảnh, camera, light và sample count; ghi ảnh + số đo, không tuyên bố “ngang Cycles” nếu chưa so sánh.
2. Benchmark thiết bị thật (GPU fallback, RAM 8 GB, Chromium/Safari) cho ảnh và video; xác định bottleneck trước khi tối ưu.
3. Kiểm tra bộ nhớ WASM/Worker pool khi render nhiều frame và dispose; giữ AbortSignal/cancel sạch.
4. Mở rộng test hồi quy cho material/texture/light mới; giữ deterministic test và round-trip scene.
5. Cập nhật artifact, tài liệu và release note cùng lúc; không để test JS chạy với WASM cũ.

## 5. Ràng buộc

- Chạy CLI/headless; không mở GUI trừ khi người dùng yêu cầu.
- Giữ màu linear, quy ước equirect và cường độ đèn hiện có; thay đổi phải có test parity.
- `rk_render_rows` ghi buffer tile-relative; test native phải truyền `base` đúng.
- Mỗi Worker một instance WASM; không dùng thread WASM khi môi trường không có COOP/COEP.
- Sau mỗi lời gọi kernel, đọc lại `memory.buffer` vì memory có thể grow.
- Không ghi task đã hoàn thành thành TODO; cập nhật mục này theo trạng thái thực tế.
