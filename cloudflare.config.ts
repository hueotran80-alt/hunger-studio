import { defineConfig, bindings, exports as cfExports } from 'cf/config';

/**
 * Cloudflare CLI (`cf`) 100% Serverless config for Hunger 3D Studio.
 * Runs Frontend Static Assets + R2 Asset/Upload Storage + Cloud BFF + AI Proxy
 * directly on Cloudflare Edge + Supabase (zero separate VPS required).
 *
 * Deployment:
 *   1. npx cf auth login
 *   2. npx cf r2 buckets create --name hunger-assets --location-hint apac
 *   3. node scripts/upload_assets_to_r2.mjs --bucket hunger-assets
 *   4. STUDIO_R2_CDN=1 npx cf deploy --secrets-file <path-to-secrets.json>
 */
export default defineConfig(({ mode } = {} as { mode?: string }) => {
  const activeMode = String(mode || process.env.HUNGER_ENV || 'production').toLowerCase();
  const isStaging = activeMode === 'staging';
  const workerName = isStaging ? 'hunger-studio-staging' : 'hunger-studio';
  return {
  accountId: '63f4b9694f48059900ba909bd958e1ef',
  worker: {
    name: workerName,
    compatibilityDate: '2026-11-26',
    entrypoint: './cloudflare/worker.js',
    assets: {
      runWorkerFirst: [
        '/api/*',
        '/mcp',
        '/healthz',
        '/models/*',
        '/vendor/mediapipe/*',
        '/assets/characters/*',
        '/assets/environments/*',
        '/assets/*-exec-worker-*.js',
        '/',
        '/index.html',
        '/motion',
        '/motion/',
        '/motion.html',
        '/landing',
        '/landing/',
        '/embed',
        '/embed/',
        '/embed.html',
      ],
    },
    exports: {
      StudioBridgeHub: cfExports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      ASSETS: bindings.assets(),
      BRIDGE_HUB: bindings.durableObject({ worker: workerName, exportName: 'StudioBridgeHub' }),
      // Bind Cloudflare R2 (`hunger-assets`) by default for zero-egress runtime assets
      // and user GLB/thumbnail uploads (pass STUDIO_R2_CDN=0 to disable).
      HUNGER_ASSETS: process.env.STUDIO_R2_CDN === '0'
        ? undefined
        : bindings.r2({ name: 'hunger-assets' }),
      // Public Supabase URL & publishable anon key (safe for client/config).
      SUPABASE_URL: bindings.text('https://fpkhjitqzieqofcviyqi.supabase.co'),
      SUPABASE_ANON_KEY: bindings.text('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwa2hqaXRxemllcW9mY3ZpeXFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5ODA0NjcsImV4cCI6MjExMDU1NjQ2N30.FqKcfGc2bYw4flrp7JV7As6bNwc0lxRYNchaxZSb27U'),
      // Server-only secrets — injected exclusively via `--secrets-file` or Cloudflare Secrets.
      // Staging binds `SENTRY_DSN` directly so future deploys preserve Sentry Envelope v7 forwarding.
      SUPABASE_SERVICE_KEY: bindings.secret(),
      STUDIO_BRIDGE_TOKEN: bindings.secret(),
      MOTAPIS_API_KEYS: bindings.secret(),
      GEMINI_API_KEY: bindings.secret(),
      OPENAI_API_KEY: bindings.secret(),
      ...(isStaging ? {
        SENTRY_DSN: bindings.secret(),
        TELEMETRY_ADMIN_TOKEN: bindings.secret(),
      } : {}),
      ...(!isStaging && process.env.TELEMETRY_ADMIN_BIND_SECRET === '1' ? {
        TELEMETRY_ADMIN_TOKEN: bindings.secret(),
      } : {}),
      // Public non-secret AI defaults, environment tag & credit pricing
      STUDIO_ENV: bindings.text(isStaging ? 'staging' : 'production'),
      AI_RATE_LIMIT_PER_MIN: bindings.text(isStaging ? '60' : '30'),
      AI_PROVIDER: bindings.text('motapis'),
      MOTAPIS_ENDPOINT: bindings.text('https://motapis.com/v1'),
      MOTAPIS_MODEL: bindings.text('gpt-6-astra'),
      GEMINI_MODEL: bindings.text('gemini-3.5-flash-lite'),
      OPENAI_MODEL: bindings.text('gpt-4o-mini'),
      // Credit pricing defaults to free-beta ("0") until live billing secrets & pricing are activated
      COST_SAVE_PROJECT: bindings.text(process.env.COST_SAVE_PROJECT || '0'),
      COST_UPLOAD_ASSET: bindings.text(process.env.COST_UPLOAD_ASSET || '0'),
      COST_AI_CHAT: bindings.text(process.env.COST_AI_CHAT || '0'),
      // Default "auto" syncs Google/GitHub OAuth visibility directly from Supabase /auth/v1/settings
      OAUTH_GOOGLE_ENABLED: bindings.text(process.env.OAUTH_GOOGLE_ENABLED || 'auto'),
      OAUTH_GITHUB_ENABLED: bindings.text(process.env.OAUTH_GITHUB_ENABLED || 'auto'),
      ...(process.env.ALLOW_TEST_BILLING ? { ALLOW_TEST_BILLING: bindings.text(process.env.ALLOW_TEST_BILLING) } : {}),
      ...(process.env.SEPAY_BANK ? { SEPAY_BANK: bindings.text(process.env.SEPAY_BANK) } : {}),
      ...(process.env.SEPAY_ACCOUNT ? { SEPAY_ACCOUNT: bindings.text(process.env.SEPAY_ACCOUNT) } : {}),
      ...(process.env.SEPAY_HOLDER ? { SEPAY_HOLDER: bindings.text(process.env.SEPAY_HOLDER) } : {}),
      ...(process.env.SEPAY_QR_TEMPLATE ? { SEPAY_QR_TEMPLATE: bindings.text(process.env.SEPAY_QR_TEMPLATE) } : {}),
      ...(process.env.SEPAY_BIND_SECRETS === '1' ? {
        SEPAY_WEBHOOK_SECRET: bindings.secret(),
        SEPAY_API_KEY: bindings.secret(),
      } : {}),
      ...(process.env.LEMONSQUEEZY_STORE_ID ? { LEMONSQUEEZY_STORE_ID: bindings.text(process.env.LEMONSQUEEZY_STORE_ID) } : {}),
      ...(process.env.LEMONSQUEEZY_VARIANT_STARTER ? { LEMONSQUEEZY_VARIANT_STARTER: bindings.text(process.env.LEMONSQUEEZY_VARIANT_STARTER) } : {}),
      ...(process.env.LEMONSQUEEZY_VARIANT_PRO ? { LEMONSQUEEZY_VARIANT_PRO: bindings.text(process.env.LEMONSQUEEZY_VARIANT_PRO) } : {}),
      ...(process.env.LEMONSQUEEZY_VARIANT_STUDIO ? { LEMONSQUEEZY_VARIANT_STUDIO: bindings.text(process.env.LEMONSQUEEZY_VARIANT_STUDIO) } : {}),
      ...(process.env.LEMONSQUEEZY_BIND_SECRETS === '1' ? {
        LEMONSQUEEZY_API_KEY: bindings.secret(),
        LEMONSQUEEZY_SIGNING_SECRET: bindings.secret(),
      } : {}),
    },
  },
};
});
