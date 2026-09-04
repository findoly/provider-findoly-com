"use strict";

const outboxService = require("./provider-communication-outbox-service");

let timer = null;
let running = false;
let stopping = false;
let inFlight = Promise.resolve();

function intervalMs(env = process.env) {
  const value = Number(env.PROVIDER_COMMUNICATION_RETRY_INTERVAL_MS || 30000);
  return Number.isInteger(value) && value >= 5000 && value <= 600000 ? value : 30000;
}

function runOnce() {
  if (running || stopping) return inFlight;
  running = true;
  inFlight = outboxService.retryDue()
    .then((summary) => {
      if (summary.processed) console.info({ event: "provider_communication_event_retry_batch_completed", ...summary });
      return summary;
    })
    .catch((error) => {
      console.error({
        event: "provider_communication_event_retry_batch_failed",
        code: String(error?.code || "PROVIDER_COMMUNICATION_RETRY_FAILED"),
        message: String(error?.message || error).slice(0, 1000),
      });
      return { processed: 0, synced: 0, failed: 0 };
    })
    .finally(() => { running = false; });
  return inFlight;
}

function start() {
  if (timer) return;
  stopping = false;
  timer = setInterval(runOnce, intervalMs());
  timer.unref?.();
  setImmediate(runOnce);
}

async function stop() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}

module.exports = { intervalMs, runOnce, start, stop };
