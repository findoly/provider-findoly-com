"use strict";

const crmSyncService = require("./crm-sync-service");

let timer = null;
let activeRun = null;

function intervalMs(env = process.env) {
  const value = Number(env.CRM_SYNC_RETRY_INTERVAL_MS || 30000);
  return Number.isInteger(value) && value >= 5000 && value <= 15 * 60 * 1000
    ? value
    : 30000;
}

async function runOnce() {
  if (activeRun) return { skipped: true, reason: "already_running" };
  activeRun = (async () => {
    try {
      const summary = await crmSyncService.retryDue();
      if (summary.processed > 0) {
        console.info(`CRM sync retry worker: ${JSON.stringify(summary)}`);
      }
      return summary;
    } catch (error) {
      console.error("CRM sync retry worker failed:", error?.message || error);
      return { processed: 0, synced: 0, failed: 1, error: error?.message || String(error) };
    }
  })();
  try {
    return await activeRun;
  } finally {
    activeRun = null;
  }
}

function startCrmSyncWorker(env = process.env) {
  if (String(env.CRM_SYNC_RETRY_WORKER_ENABLED || "true").trim().toLowerCase() === "false") return null;
  if (timer) return timer;
  timer = setInterval(() => { runOnce().catch(() => {}); }, intervalMs(env));
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

async function stopCrmSyncWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  if (activeRun) await activeRun.catch(() => {});
}

module.exports = { intervalMs, runOnce, startCrmSyncWorker, stopCrmSyncWorker };
