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

test("credit and direct-payment unlock flows sync compact unlock IDs after successful commits", () => {
  const leadSource = read("services/lead/lead-service.js");
  const directSource = read("services/wallet/lead-payment-service.js");
  assert.match(leadSource, /syncUnlockCommunication\(transactionResult\.unlock/);
  assert.match(leadSource, /providerLeadUnlockId: unlock\.providerLeadUnlockId/);
  assert.match(directSource, /syncUnlock\(result\.unlock/);
  assert.match(directSource, /unlockMethod: "direct_payment"/);
  assert.match(directSource, /crmSyncStatus: "failed"/);
});

test("provider outcome update remains saved when CRM synchronization fails", () => {
  const source = read("services/lead/lead-service.js");
  const saveIndex = source.indexOf("await unlock.save({ session })");
  const syncIndex = source.indexOf("sendProviderFeedback(");
  assert.ok(saveIndex >= 0 && syncIndex > saveIndex);
  assert.match(source, /crmSyncStatus: "failed"/);
  assert.match(source, /crmSyncError:/);
});
