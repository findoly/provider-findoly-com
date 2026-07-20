const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("provider CRM client supports generic, unlock and feedback communication events", function () {
  const source = read("services/integration/crm-service.js");
  assert.match(source, /async function sendEvent\(eventName/);
  assert.match(source, /sendEvent\("provider_lead_unlocked"/);
  assert.match(source, /sendEvent\("provider_feedback_updated"/);
  assert.match(source, /x-communication-token/);
});

test("credit and direct-payment unlock flows call the CRM communication API after success", function () {
  const leadSource = read("services/lead/lead-service.js");
  const walletSource = read("services/wallet/wallet-service.js");
  assert.match(leadSource, /sendProviderUnlock\(result\.eventPayload\)/);
  assert.match(leadSource, /The lead was unlocked, but its email and Slack notifications are pending retry/);
  assert.match(walletSource, /sendProviderUnlock\(result\._communicationEvent\)/);
  assert.match(walletSource, /unlockMethod: "direct_payment"/);
});

test("provider status update continues to call CRM without rolling back a saved update", function () {
  const source = read("services/lead/lead-service.js");
  assert.match(source, /sendProviderFeedback\(/);
  assert.match(source, /crmSyncStatus: "failed"/);
  assert.match(source, /Your update was saved, but CRM notification is pending/);
});
