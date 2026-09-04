"use strict";

const mongoose = require("mongoose");

const providerCommunicationEventOutboxSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true, immutable: true, maxlength: 220 },
    idempotencyKey: { type: String, required: true, unique: true, index: true, immutable: true, maxlength: 260 },
    eventName: {
      type: String,
      required: true,
      enum: ["provider_join_request_submitted", "provider_plan_purchased"],
      index: true,
      immutable: true,
    },
    // Kept required for compatibility with the existing unique database index.
    // Plan events use a unique synthetic value derived from paymentOrderId.
    providerJoinRequestId: { type: String, required: true, index: true, immutable: true, maxlength: 160 },
    providerId: { type: String, default: "", index: true, immutable: true, maxlength: 120 },
    paymentOrderId: { type: String, default: "", index: true, immutable: true, maxlength: 120 },
    providerSubscriptionId: { type: String, default: "", index: true, immutable: true, maxlength: 120 },
    payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
    status: {
      type: String,
      enum: ["pending", "synced", "failed", "dead_letter"],
      default: "pending",
      index: true,
    },
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
    collection: "providercommunicationeventoutbox",
    timestamps: true,
  },
);

providerCommunicationEventOutboxSchema.index({ status: 1, nextAttemptAt: 1, lockedAt: 1, _id: 1 });
providerCommunicationEventOutboxSchema.index({ providerJoinRequestId: 1, eventName: 1 }, { unique: true });
providerCommunicationEventOutboxSchema.index({ paymentOrderId: 1, eventName: 1 });
providerCommunicationEventOutboxSchema.index({ providerId: 1, eventName: 1, createdAt: -1 });
providerCommunicationEventOutboxSchema.index({ purgeAfterAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
  "ProviderCommunicationEventOutbox",
  providerCommunicationEventOutboxSchema,
  "providercommunicationeventoutbox",
);
