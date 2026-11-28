## Summary
<!-- Mô tả thay đổi, lý do và milestone/issue liên quan -->

## Type of Change
- [ ] P0 / P1 bug fix
- [ ] Hunger Motion feature / template / UX
- [ ] Render / Geometry / Rust WASM
- [ ] Cloud / Billing / Auth / Security
- [ ] Infrastructure / CI / Release
- [ ] Docs / Guidance only

## Evidence
<!-- Dán lệnh + kết quả thật, CI link, ảnh/benchmark nếu có -->
- [ ] `bash tests/run_all.sh --fast` — exit 0
- [ ] `npm run test:browser` — 14/14 suites, 0 blocked, 0 uncaught
- [ ] `npm run test:dist` — build + runtime gate, 0 files >25 MB
- [ ] `STUDIO_R2_CDN=1 npm run build` — no non-commercial assets leaked
- [ ] Affected flow verified in a real browser when UI/runtime changed

## Risk & Rollback
- Risk level: <!-- low / medium / high -->
- Rollback: <!-- previous tag/commit, config switch, or not applicable -->

## Security / Privacy / License
- [ ] No secret, token, private key, Supabase key or local path committed
- [ ] No new P0/P1 regression in transaction, rollback, Worker CSP, lease or Export Cancel
- [ ] Telemetry contains no PII/secret and respects DNT/consent
- [ ] New assets have commercial-safe license/provenance or are excluded from `dist/`

## Docs & Artifacts
- [ ] `README.md` / `AGENTS.md` / `AUDIT.md` synced when status, metrics or architecture changed
- [ ] Release/package/health version synced when releasing
- [ ] No chat transcript, session log, temporary report or cache committed
- [ ] Historical reports moved to `audit/reports/`; audit evidence, recordings and assets preserved
