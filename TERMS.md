# Terms of Service — Hunger

**Effective Date:** November 25, 2026

By accessing or using Hunger ("the Service"), you agree to the following Terms of Service.

---

## 1. Service Description & Beta Status
Hunger provides a browser-based 3D modeling, motion capture, animation, physics simulation, rendering, and AI-assisted staging environment. Certain features may run in **Beta / Free Mode** while Cloud storage, AI metering, or paid credit packs are optional and governed by the configuration shown in `/api/cloud/status`.

## 2. Accounts, Credits & Billing
- **Account Security:** You are responsible for safeguarding access tokens, passwords, and any personal API keys (BYOK) you enter.
- **Credits & Pricing:** Paid plans and credit packs (Starter, Pro, Studio) grant non-transferable usage credits for Cloud storage or metered AI operations according to the published cost schedule.
- **Refunds & Chargebacks:** If a payment is refunded via the payment provider (`order_refunded`), the Service reserves the right to reverse the corresponding unspent credit allocation. Disputed or fraudulent transactions will suspend credit issuance.
- **Free Mode:** While `freeMode` is active, listed actions consume `0` credits and starter bonus credits remain informational.

## 3. Content Ownership & Third-Party Licenses
- **Your Content:** You retain ownership and all rights to original 3D models, animations, motion-capture clips, scripts, and scenes you create or upload.
- **License to Operate:** By uploading projects or `.glb` files to Cloud Storage or Cloud Share, you grant the Service a limited license to host and serve those files solely to deliver the feature you requested (including public `/embed.html` links you explicitly generate).
- **Third-Party Assets:** Built-in CC0 and CC-BY assets are licensed by their respective creators under `THIRD_PARTY_LICENSES.md`. Where an asset carries a **CC-BY** license, you must retain appropriate author attribution when redistributing projects containing that asset.

## 4. Acceptable Use
You agree NOT to use the Service to:
- Upload malware, violate intellectual property rights, or distribute unlawful content.
- Bypass authentication, webhook signatures, rate limits, sandbox protections, or credit checks.
- Scrape, flood, or abuse upstream AI, TTS, or CDN endpoints.

## 5. Availability & Disclaimer of Warranties
The Service is provided **"AS IS"** and **"AS AVAILABLE"** without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, or uninterrupted uptime. Browser hardware limits (WebGL2/WebGPU/WebCodecs/WASM memory) apply to client-side processing.

## 6. Limitation of Liability
To the maximum extent permitted by applicable law, the Service operators and contributors shall not be liable for indirect, incidental, special, consequential, or punitive damages, or loss of data, profits, or project files. Always keep local backups (`.wbs` or `.glb`) of critical work.

## 7. Termination & Governing Terms
We may suspend or terminate access for material violations of these Terms. You may delete your account at any time via **File → Cloud / Tài khoản…** or `/api/cloud/me/delete`.

## 8. Contact
For support, billing, or legal inquiries, contact **hueotran80@gmail.com**.
