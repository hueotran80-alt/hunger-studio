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
      // Optional `SENTRY_DSN` can be added anytime via `cf workers secrets update` and is read from `env.SENTRY_DSN`.
      SUPABASE_SERVICE_KEY: bindings.secret(),
      STUDIO_BRIDGE_TOKEN: bindings.secret(),
      MOTAPIS_API_KEYS: bindings.secret(),
      GEMINI_API_KEY: bindings.secret(),
      OPENAI_API_KEY: bindings.secret(),
      // Public non-secret AI defaults, environment tag & credit pricing
      STUDIO_ENV: bindings.text(isStaging ? 'staging' : 'production'),
      AI_RATE_LIMIT_PER_MIN: bindings.text(isStaging ? '60' : '30'),
      AI_PROVIDER: bindings.text('motapis'),
      MOTAPIS_ENDPOINT: bindings.text('https://motapis.com/v1'),
      MOTAPIS_MODEL: bindings.text('gpt-6-astra'),
      GEMINI_MODEL: bindings.text('gemini-3.5-flash-lite'),
      OPENAI_MODEL: bindings.text('gpt-4o-mini'),
      COST_SAVE_PROJECT: bindings.text('0'),
      COST_UPLOAD_ASSET: bindings.text('0'),
      COST_AI_CHAT: bindings.text('0'),
    },
  },
};
});
