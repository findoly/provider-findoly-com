const mongoose = require("mongoose");
const uuid = require("../utils/uuid");

const providerSchema = new mongoose.Schema(
  {
    providerId: { type: String, default: uuid, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    businessName: { type: String, default: "", trim: true },
    mobile: { type: String, default: "", trim: true },
    normalizedMobile: { type: String, default: "", trim: true, index: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    status: { type: String, default: "active", index: true },
    onboardingStage: { type: String, default: "new" },
    categorySlugs: { type: [String], default: [], index: true },
    skills: { type: [String], default: [] },
    city: { type: String, default: "", index: true },
    state: { type: String, default: "" },
    servicePincode: {
      type: String,
      default: "",
      trim: true,
      index: true,
      validate: {
        validator: (value) => !value || /^[1-9]\d{5}$/.test(value),
        message: "Service PIN code must contain exactly 6 digits",
      },
    },
    serviceAddress: { type: String, default: "", trim: true, maxlength: 500 },
    serviceLatitude: { type: Number, default: null },
    serviceLongitude: { type: Number, default: null },
    serviceLocality: { type: String, default: "" },
    serviceDistrict: { type: String, default: "" },
    serviceState: { type: String, default: "" },
    serviceCountry: { type: String, default: "India" },
    serviceLocationVerifiedAt: { type: Date, default: null },
    serviceLocationSource: { type: String, default: "" },
    serviceAreas: { type: [String], default: [] },
    availability: { type: String, default: "available_today" },
    rating: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    documentsVerified: { type: Boolean, default: false },
    portalAccessEnabled: { type: Boolean, default: true, index: true },

    // Kept for shared-CRM compatibility. Internally this stores credit minor units:
    // 100 minor units = 1 provider credit.
    walletBalancePaise: { type: Number, default: 0, min: 0 },
    walletCurrency: { type: String, default: "INR" },
    walletUpdatedAt: { type: Date, default: null },

    currentPlanCode: { type: String, default: "", index: true },
    currentPlanName: { type: String, default: "" },
    currentBillingCycle: { type: String, default: "" },
    currentPlanStartedAt: { type: Date, default: null },
    currentPlanExpiresAt: { type: Date, default: null, index: true },
    currentSubscriptionId: { type: String, default: "", index: true },

    lastLoginAt: { type: Date, default: null },
  },
  {
    collection: "providers",
    timestamps: true,
    strict: false,
  },
);

providerSchema.index({ status: 1, portalAccessEnabled: 1, categorySlugs: 1 });

module.exports = mongoose.model("Provider", providerSchema, "providers");
