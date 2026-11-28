# Lộ trình Thương mại hoá — Hunger Motion / Web Blender Studio

> Tài liệu này chỉ theo dõi **việc chưa làm và tiêu chí nghiệm thu**. Trạng thái mã nguồn, CI, build và staging xem [README.md](README.md); bằng chứng lịch sử xem [AUDIT.md](AUDIT.md). Không lặp lại toàn bộ lịch sử tính năng trong file này.

## Baseline hiện tại

- Phase 1 đã đạt **GO Phase 2** trên `main` tại HEAD `662e5bb`, tag `v0.9.0-beta.2`.
- CI required: Python/Node/P1/CDN, Rust WASM, Headless Chromium + Production gate đều xanh; browser 14/14 suite / 208 checks, production `dist/` 9/9.
- Staging đang chạy `v0.9.0-beta.1`, khỏe và có Sentry; auto-deploy beta.2 chưa chạy vì thiếu `CLOUDFLARE_API_TOKEN`. Chưa tuyên bố beta.2 đã live.

## Phase 2 — Ưu tiên đề xuất

| Ưu tiên | Hạng mục | Kết quả cần đạt | Tệp/điểm chỉnh chính | Nghiệm thu |
|---|---|---|---|---|
| P0 | Đồng bộ release beta.2 | Deploy đúng commit/tag, health báo beta.2, tài liệu không lệch version | `.github/workflows/*`, `cloudflare/cloud-bff.js`, `server.py`, `js/core/telemetry.js`, `motion.html`, `package*.json` | CI xanh; `/healthz` đúng release; `/motion`, Motion workspace, Sentry và telemetry smoke PASS |
| P1 | Billing & Auth GA | SePay/LemonSqueezy live, xử lý webhook external-ID-only, Google/GitHub OAuth, Reset Password; chỉ chuyển `freeMode:false` sau nghiệm thu | `cloud/`, `js/cloud/`, `js/ui/cloud-panel.js`, Supabase schema | Test unit + webhook sandbox/live; không cộng credit trùng; refund/paid race có regression; auth/session/RLS PASS |
| P1 | Image-to-3D live | Chọn provider thật (Tripo/Meshy/fal.ai hoặc API_ORIGIN), tắt maintenance khi sẵn sàng | `hunyuan3d_engine.py`, `server.py`, `js/ui/hunyuan3d-ui.js`, Edge config | Upload có containment; lỗi trả mã rõ; GLB kiểm provenance/size; import lại trong Studio PASS |
| P1 | Nén GLB & decoder | Meshopt/Draco/KTX2 export + import tương ứng, giữ data map lossless | `js/exporters/`, `js/core/mesh-kernel-bridge.js`, `vite.config.js` | Round-trip geometry/material/animation; byte budget đo trước/sau; file >25 MB bị chặn; visual regression PASS |
| P1 | Copilot thực chiến | SSE streaming và/hoặc native tool-calling; đo pass-rate trên bộ tác vụ thật | `js/ai/`, `js/agent/`, `server.py`, provider adapter | Transaction/rollback/CSP vẫn PASS; đo tool success, latency, cancellation; không PII/secret vào telemetry |
| P1 | Telemetry người dùng thật | Có session thật để đánh giá 5 KPI thay vì `sessions:0` | `js/core/telemetry.js`, `cloudflare/cloud-bff.js`, dashboard/query | Crash-free, video→GLB, TTFA, TTI, funnel có dữ liệu; sanitization và DNT PASS |
| P2 | STEM B2B | Teacher Dashboard, lớp/học sinh, bài nộp/chấm điểm cloud; LTI/Google Classroom nếu cần | `js/education/`, `js/ui/stem-tutor-ui.js`, Cloud BFF/Supabase | Phân quyền teacher/student; export CSV; không lộ bài làm của học sinh khác |
| P2 | Engine & DCC parity | Soft body/cloth/weather; đối chiếu chất lượng với Blender Cycles/Unity; tối ưu thiết bị thật | `js/simulation/`, `js/render/`, `crates/` | Có benchmark và ảnh đối chiếu cùng cảnh; deterministic physics; budget/draw-call không vượt tier |
| P2 | Community & growth | Seed nội dung CC0, template gallery, sharing analytics có consent | Asset catalog, Community UI, telemetry | Không asset thiếu license; URL/embed round-trip; consent/DNT PASS |

## Sau Phase 2

- WebXR/Android Scene Viewer và annotation hotspots cho Embed/AR.
- Whisper WASM offline cho STEM khi phù hợp ngân sách thiết bị.
- Giảm dần phụ thuộc `window.*` ở lớp tương thích dev.
- Tauri không thuộc lộ trình thương mại trừ khi có yêu cầu riêng.

## Gate trước mỗi release

1. `bash tests/run_all.sh --fast` — exit 0.
2. `npm run test:browser` — 14/14 suite, 0 blocked, 0 uncaught.
3. `npm run test:dist` — build + runtime gate, 0 file >25 MB.
4. `STUDIO_R2_CDN=1 npm run build` — không lọt asset không thương mại.
5. Deploy staging/production đúng tag; kiểm `/healthz`, `/motion`, Sentry và telemetry.
6. Có rollback đã biết và không force-push `main`.

## Quy tắc tài liệu

- `README.md`: trạng thái hiện tại và cách dùng.
- `AGENTS.md`: ưu tiên, ràng buộc và quy tắc làm việc cho agent.
- `AUDIT.md`: bằng chứng audit lịch sử; không ghi đè snapshot cũ.
- `docs/RELEASE_AND_GIT_WORKFLOW.md`: runbook Git/deploy/release.
- `docs/RUST_RENDER_HANDOFF.md`: handoff kỹ thuật Rust render hiện hành.
- `audit/reports/`: báo cáo/kế hoạch lịch sử đã archive; không đặt chat transcript, session log hoặc báo cáo tạm ở root.
