# Git, PR, Protected `main` & Release Workflow — Hunger Motion

## 1. Trạng thái hiện hành

- Repository: `https://github.com/hueotran80-alt/hunger-studio`.
- `main` đang protected: `strict=true`, `enforce_admins=true`, yêu cầu PR và 3 required checks:
  - `Python, Node, P1 Hardening & CDN Build Gate`
  - `Rust WASM Kernels`
  - `Headless Chromium Browser & Production Gate`
- Cấu hình hiện tại yêu cầu PR nhưng **chưa bắt buộc approving review**. Nếu muốn bật code-owner review/1 approval, phải cập nhật branch protection và ghi lại thay đổi; không được tuyên bố đang bật khi API trả `required_approving_review_count: 0`.
- Tag hiện tại: `v0.9.0-beta.2` trỏ đúng HEAD `662e5bb`; package manifest và release constants trong source đã đồng bộ beta.2.
- Staging đang chạy beta.1 cho tới khi deploy beta.2. Auto-deploy hiện bị skip nếu thiếu `CLOUDFLARE_API_TOKEN`.

## 2. Branching, commit và hook

- Không commit trực tiếp vào `main`; dùng `feat/*`, `fix/*`, `chore/*`, `docs/*`, `release/*`.
- Commit theo Conventional Commits.
- Hook local:
  - `.githooks/pre-commit`: chặn secret/config nhạy cảm.
  - `.githooks/pre-push`: chặn push trực tiếp `main`; override `ALLOW_MAIN_PUSH=1` chỉ dùng khi bootstrap/khôi phục có chủ ý.
- Không dùng `--no-verify`, force-push hay xoá nhánh protected khi chưa được phê duyệt.

## 3. PR bắt buộc

Trước khi merge:

```bash
bash tests/run_all.sh --fast
npm run test:browser
npm run test:dist
STUDIO_R2_CDN=1 npm run build
```

PR phải ghi lệnh đã chạy, kết quả, CI link, rủi ro/rollback và trạng thái tài liệu. Không đưa chat transcript, session log, báo cáo tạm hoặc file chứa secret vào commit.

## 4. Deploy Cloudflare

```bash
npm run r2:upload
npm run deploy:staging
npm run deploy:prod
```

- Staging Worker: `hunger-studio-staging`.
- Production Worker: `hunger-studio`.
- `SENTRY_DSN` là Worker secret; browser không nhận SDK/secret Sentry.
- Nếu workflow báo `CLOUDFLARE_API_TOKEN secret not configured`, job vẫn có thể xanh nhưng **không có deploy thật**. Phải kiểm health sau deploy, không suy ra đã live từ màu xanh của workflow.

## 5. Release checklist

1. Chọn tag mới và cập nhật đồng bộ:
   - `package.json` + `package-lock.json`
   - `server.py`, `motion.html`, `js/core/telemetry.js`, `cloudflare/cloud-bff.js`
   - `README.md`, `AGENTS.md`, `AUDIT.md`
2. Chạy đủ gate ở §3 và ghi evidence.
3. Tạo annotated tag và push:

```bash
git tag -a v0.9.0-beta.3 -m "Hunger Motion Beta 3"
git push origin v0.9.0-beta.3
```

4. Theo dõi `.github/workflows/release.yml`; xác nhận bước deploy không bị skip.
5. Kiểm sau deploy:

```bash
curl -fsS https://hunger-studio-staging.hunger-studio-vn.workers.dev/healthz
curl -fsS https://hunger-studio-staging.hunger-studio-vn.workers.dev/motion >/dev/null
node scripts/verify_sentry_staging.mjs
```

`/healthz` phải báo đúng release/tag; Sentry và telemetry phải nhận event. Kiểm Motion workspace và một luồng mocap/export ngắn.

## 6. Rollback

- Ưu tiên redeploy tag/commit tốt trước đó bằng đúng workflow hoặc lệnh deploy đã biết.
- Không sửa tag cũ bằng force-push để “rollback”.
- Sau rollback, kiểm `/healthz`, `/motion`, Sentry và ghi rõ release đang chạy trong README/AUDIT.

## 7. Vệ sinh tài liệu

- Root chỉ giữ tài liệu chuẩn: `README.md`, `AGENTS.md`, `AUDIT.md`, `roadmap_web_saas.md`, tài liệu pháp lý.
- Báo cáo/kế hoạch lịch sử đưa vào `audit/reports/`.
- Không commit `.cloud-attachments/`, `.log`, `.qoder/`, `.freebuff/`, `.DS_Store`, cache hoặc output tạm.
- Không xoá `audit/`, `recordings/`, `assets/`, `models/`, `docs-box-steps/`, `full_preview.html` hoặc notebook/backend được UI tham chiếu.
