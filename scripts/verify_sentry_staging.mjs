#!/usr/bin/env node
/**
 * Verify Sentry error forwarding on Staging or Production Cloudflare Worker.
 * Usage:
 *   node scripts/verify_sentry_staging.mjs
 *   node scripts/verify_sentry_staging.mjs https://hunger-studio-staging.hunger-studio-vn.workers.dev
 */

import assert from 'node:assert/strict';

const baseUrl = (process.argv[2] || 'https://hunger-studio-staging.hunger-studio-vn.workers.dev').replace(/\/+$/, '');

const healthRes = await fetch(`${baseUrl}/healthz`);
assert.equal(healthRes.status, 200, `/healthz returned HTTP ${healthRes.status}`);
const health = await healthRes.json();
console.log('Health:', JSON.stringify(health));

if (!health.sentryConfigured) {
  console.error('FAIL: sentryConfigured is false. Configure SENTRY_DSN on this Worker first:');
  console.error('  npx cf workers secrets update SENTRY_DSN --worker hunger-studio-staging --type secret_text');
  process.exit(1);
}

const eventId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const payload = {
  release: health.release || 'hunger-motion@0.9.0-beta.2',
  environment: health.environment || 'staging',
  sessionId: 'sentry-smoke-check',
  events: [
    {
      kind: 'error',
      ts: new Date().toISOString(),
      sessionId: 'sentry-smoke-check',
      workspace: 'motion',
      sentry: {
        event_id: eventId,
        timestamp: Math.floor(Date.now() / 1000),
        platform: 'javascript',
        level: 'fatal',
        release: health.release || 'hunger-motion@0.9.0-beta.2',
        environment: health.environment || 'staging',
        tags: { subsystem: 'staging-smoke-check', workspace: 'motion', fatal: 'true' },
        exception: {
          values: [{ type: 'StagingSmokeError', value: 'Hunger Motion Staging Sentry verification event' }],
        },
        extra: { source: 'scripts/verify_sentry_staging.mjs' },
      },
    },
  ],
};

const res = await fetch(`${baseUrl}/api/telemetry/event`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
assert.equal(res.status, 202, `/api/telemetry/event returned HTTP ${res.status}`);
const data = await res.json();
console.log('Telemetry response:', JSON.stringify(data));
assert.ok(data.sentryForwarded >= 1, `Expected sentryForwarded >= 1, got ${data.sentryForwarded}`);
console.log(`PASS: Sentry accepted fatal smoke event ${eventId} on ${baseUrl}`);
