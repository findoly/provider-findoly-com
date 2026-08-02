"use strict";

const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const crmSyncService = require("../services/integration/crm-sync-service");

function maximumBatches(env = process.env) {
  const configured = Number(env.CRM_SYNC_RETRY_MAX_BATCHES || 20);
  return Number.isInteger(configured) && configured >= 1 && configured <= 100 ? configured : 20;
}

function maximumEvents(args = process.argv.slice(2), env = process.env) {
  const argument = args.find((value) => String(value).startsWith("--max="));
  const raw = argument ? String(argument).slice("--max=".length) : env.CRM_SYNC_RETRY_MAX_EVENTS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return maximumBatches(env) * crmSyncService.DEFAULT_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000) {
    throw new Error("CRM sync retry --max must be a whole number between 1 and 10000");
  }
  return parsed;
}

async function main(options = {}) {
  await connectDatabase();
  const maxEvents = maximumEvents(options.args, options.env);
  const includeDeadLetter = (options.args || process.argv.slice(2)).includes("--include-dead-letter");
  const summary = { processed: 0, synced: 0, failed: 0, deadLetter: 0, leaseLost: 0 };
  while (summary.processed < maxEvents) {
    const limit = Math.min(crmSyncService.DEFAULT_BATCH_SIZE, maxEvents - summary.processed);
    const result = await crmSyncService.retryDue({ limit, includeDeadLetter });
    summary.processed += result.processed;
    summary.synced += result.synced;
    summary.failed += result.failed;
    summary.deadLetter += Number(result.deadLetter || 0);
    summary.leaseLost += Number(result.leaseLost || 0);
    if (result.processed < limit) break;
  }
  console.log(`CRM sync retry: ${JSON.stringify(summary)}`);
  return summary;
}

if (require.main === module) {
  main()
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await mongoose.disconnect().catch(() => {}); });
}

module.exports = { main, maximumBatches, maximumEvents };
