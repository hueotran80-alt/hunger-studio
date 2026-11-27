# Privacy Policy — Hunger

**Effective Date:** November 25, 2026  
**Last Reviewed:** November 26, 2026

Hunger ("the Service") is designed with a **local-first browser architecture**. Most 3D editing, video motion capture (MediaPipe WASM / WebCodecs), Rapier physics simulation, shader/texture baking, CPU/GPU path tracing, and MP4 rendering run directly on your device inside your web browser.

---

## 1. Data Processed Locally (On Your Device)
- **Viewport, Models & Animations:** Loaded 3D files (`.glb`, `.fbx`, `.usdz`, `.obj`, `.wbs`), textures, camera recordings, and timeline edits stay in browser memory, Origin Private File System (OPFS), or IndexedDB/localStorage unless you explicitly upload them to Cloud or click Share.
- **Self-Contained Share Links (`#z=`):** Compressed 3D previews encoded in URL fragments (`#z=...`) stay client-side and are not sent to the server.

## 2. Data Collected When Using Cloud Features
When you voluntarily sign in or connect Cloud features (`/api/cloud/*`), we process:
- **Account Information:** User ID, email address, display name, and authentication tokens (managed via Supabase Auth or configured self-hosted SQLite/Auth BFF).
- **Cloud Projects & Assets:** Scene JSON (`.blend.json`), thumbnails, and uploaded `.glb` files saved via Cloud Sync or Cloud Share.
- **Credit & Billing Records:** Credit balance ledger entries, payment order codes, amounts, payment provider (`SePay` / `LemonSqueezy`), and webhook timestamps. Card details and bank credentials are processed strictly by those external payment providers and never touch our servers.
- **AI Copilot & Image-to-3D Requests:** Text prompts, scene summaries, or images you submit to `/api/cloud/ai/chat`, `/api/ai/chat`, or `/api/image-to-3d` are forwarded to the configured AI provider solely to generate the requested response/3D output. If you supply your own API key (BYOK via `X-AI-Provider-Key`), it is used per-request in transit and never stored in logs or the database.

## 3. Data Retention & Your Rights (GDPR / Vietnam Decree 13/2023/ND-CP)
You have the right to access, export, and permanently delete your personal data at any time:
- **Export Your Data:** Use **File → Cloud / Tài khoản… → Export My Data** or send an authenticated `GET /api/cloud/me/export` request to download a JSON archive of your profile, projects, asset metadata, credit ledger, and payment history.
- **Delete Your Account:** Use **File → Cloud / Tài khoản… → Delete Account** or send an authenticated `POST /api/cloud/me/delete` request to permanently remove your account, saved Cloud projects, uploaded assets, and associated database records. (Legally required financial/tax transaction audit records may be anonymized or retained only as mandated by applicable law.)

## 4. Subprocessors & External Services
Depending on deployment configuration, the Service may interact with:
- **Supabase** (Authentication, Postgres database, Object Storage)
- **SePay / LemonSqueezy** (Payment processing & webhook verification)
- **Poly Haven CDN** (`cdn.polyhaven.com` / `api.polyhaven.com`) when browsing online CC0 materials/HDRIs
- **Configured AI / 3D Providers** (OpenAI-compatible / Gemini / Anthropic / Cloud Image-to-3D endpoints)

## 5. Security
- Service role keys and webhook secrets remain strictly on the backend (BFF) and are never exposed to client bundles.
- The application includes CSP headers, request limits, and CSRF protections; deployment operators must enforce HTTPS. On 26/11/2026, the reproduced Inspector stored-XSS path was remediated and verified in Chromium. AI-generated Copilot code and STEM demo code execute in a dedicated Worker with a mirrored Three.js scene, restricted capabilities, strict CSP, timeouts, and an allowlisted command bridge; `agent.exec` uses a separate restricted Worker. Local regression and production-bundle tests cover direct DOM, storage, network, and runtime-object escape paths. These controls reduce risk but do not replace dependency auditing, server-side authorization, provider-specific review, or deployment testing; the Service does not claim protection against every possible arbitrary-code exploit.

## 6. Contact
For privacy inquiries, data export assistance, or takedown requests, contact the Hunger operator at **hueotran80@gmail.com**.
