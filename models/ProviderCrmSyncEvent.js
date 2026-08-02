"use strict";

const mongoose = require("mongoose");
const uuid = require("../utils/uuid");

const providerCrmSyncEventSchema = new mongoose.Schema(
  {
    crmSyncEventId: { type: String, default: uuid, unique: true, index: true, immutable: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true, maxlength: 300, immutable: true },
    providerLeadUnlockId: { type: String, required: true, index: true, maxlength: 120, immutable: true },
    enquiryId: { type: String, default: "", index: true, maxlength: 120, immutable: true },
    providerId: { type: String, default: "", index: true, maxlength: 120, immutable: true },
    eventName: {
      type: String,
      required: true,
      enum: ["provider_lead_unlocked", "provider_feedback_updated"],
      index: true,
      immutable: true,
    },
    sequence: { type: Number, required: true, min: 1, index: true, immutable: true },
    eventAt: { type: Date, required: true, index: true, immutable: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
    status: { type: String, enum: ["pending", "synced", "failed", "dead_letter"], default: "pending", index: true },
    attemptCount: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: "", maxlength: 1000 },
    lastAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    lockToken: { type: String, default: "", maxlength: 120 },
    syncedAt: { type: Date, default: null },
    purgeAfterAt: { type: Date, default: null },
  },
  {
    collection: "providercrmsyncevents",
    timestamps: true,
  },
);

providerCrmSyncEventSchema.index({ status: 1, nextAttemptAt: 1, lockedAt: 1, _id: 1 });
providerCrmSyncEventSchema.index({ providerLeadUnlockId: 1, sequence: 1 }, { unique: true });
providerCrmSyncEventSchema.index({ providerLeadUnlockId: 1, createdAt: 1, _id: 1 });
providerCrmSyncEventSchema.index({ purgeAfterAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
  "ProviderCrmSyncEvent",
  providerCrmSyncEventSchema,
  "providercrmsyncevents",
);
