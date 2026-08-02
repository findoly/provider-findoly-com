const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("provider CRM client supports generic, unlock and feedback communication events", () => {
  const source = read("services/integration/crm-service.js");
  assert.match(source, /async function sendEvent\(eventName/);
  assert.match(source, /sendEvent\("provider_lead_unlocked"/);
  assert.match(source, /sendEvent\("provider_feedback_updated"/);
  assert.match(source, /x-communication-token/);
});

test("unlock and feedback commits enqueue durable CRM sync records", () => {
  const leadSource = read("services/lead/lead-service.js");
  const directSource = read("services/wallet/lead-payment-service.js");
  const syncSource = read("services/integration/crm-sync-service.js");
  const workerSource = read("services/integration/crm-sync-worker.js");
  const pkg = JSON.parse(read("package.json"));

  assert.match(leadSource, /pendingSyncFields\("provider_lead_unlocked"/);
  assert.match(leadSource, /pendingSyncFields\("provider_feedback_updated"/);
  assert.match(leadSource, /crmSyncService\.enqueue\(\s*"provider_lead_unlocked"/);
  assert.match(leadSource, /crmSyncService\.enqueue\(\s*"provider_feedback_updated"/);
  assert.match(directSource, /crmSyncService\.enqueue\(\s*"provider_lead_unlocked"/);
  assert.match(leadSource, /syncUnlockCommunication\(transactionResult\.unlock/);
  assert.match(leadSource, /syncById\(unlock\.providerLeadUnlockId/);
  assert.match(directSource, /syncById\(unlock\.providerLeadUnlockId/);
  assert.match(syncSource, /ProviderCrmSyncEvent/);
  assert.match(syncSource, /backfillLegacyPending/);
  assert.match(syncSource, /dead_letter/);
  assert.match(syncSource, /crmSyncAttemptCount/);
  assert.match(syncSource, /crmSyncNextAttemptAt/);
  assert.match(syncSource, /crmSyncLockToken/);
  assert.match(syncSource, /retryDelayMs/);
  assert.match(workerSource, /setInterval/);
  assert.equal(pkg.scripts["retry:crm-sync"], "node scripts/run-with-runtime.js scripts/retry-crm-sync.js");
});

test("provider outcome update remains saved before CRM synchronization is attempted", () => {
  const source = read("services/lead/lead-service.js");
  const saveIndex = source.indexOf("await unlock.save({ session })");
  const syncIndex = source.indexOf(".syncById(result.unlock.providerLeadUnlockId");
  assert.ok(saveIndex >= 0 && syncIndex > saveIndex);
  assert.match(source, /\.catch\(\(\) => \(\{ processed: false \}\)\)/);
});
