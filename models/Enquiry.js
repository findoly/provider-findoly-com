const mongoose = require("mongoose");
const uuid = require("../utils/uuid");

const enquirySchema = new mongoose.Schema(
  {
    enquiryId: { type: String, default: uuid, unique: true, index: true, immutable: true },
    recordType: { type: String, default: "requirement" },
    name: { type: String, default: "", trim: true },
    mobile: { type: String, default: "", trim: true, index: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    addressLine: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true, index: true },
    cityKey: { type: String, default: "", trim: true, maxlength: 100, index: true },
    state: { type: String, default: "", trim: true },
    pincode: { type: String, default: "", trim: true },
    locationLatitude: { type: Number, default: null },
    locationLongitude: { type: Number, default: null },
    locationPincode: { type: String, default: "", trim: true },
    locationLocality: { type: String, default: "" },
    locationDistrict: { type: String, default: "" },
    locationState: { type: String, default: "" },
    locationCountry: { type: String, default: "India" },
    locationVerifiedAt: { type: Date, default: null },
    locationSource: { type: String, default: "" },
    marketplaceStatus: { type: String, enum: ["draft", "published", "paused", "closed", "expired"], default: "draft", index: true },
    marketplaceAvailable: { type: Boolean, default: false, index: true },
    marketplaceClosureReason: { type: String, enum: ["", "unlock_limit", "status_change", "invalid", "deactivated", "expired"], default: "" },
    marketplacePublishedAt: { type: Date, default: null, index: true },
    marketplaceExpiresAt: { type: Date, default: null, index: true },
    category: { type: String, default: "", trim: true },
    categorySlug: { type: String, required: true, trim: true, index: true },
    serviceType: { type: String, default: "", trim: true },
    serviceTypes: {
      type: [
        new mongoose.Schema(
          {
            serviceTypeId: { type: String, required: true },
            name: { type: String, required: true, trim: true, maxlength: 120 },
            slug: { type: String, required: true, trim: true, maxlength: 80 },
          },
          { _id: false },
        ),
      ],
      default: undefined,
      validate: {
        validator(value) { return value === undefined || (Array.isArray(value) && value.length <= 5); },
        message: "A lead may contain no more than 5 Service Types",
      },
    },
    requirementTitle: { type: String, default: "", trim: true },
    requirementTitleKey: { type: String, default: "", trim: true, maxlength: 200, index: true },
    priority: { type: String, default: "normal", index: true, enum: ["low", "normal", "high", "urgent"] },
    status: { type: String, default: "new", index: true },
    preferredDate: { type: String, default: "" },
    preferredSlot: { type: String, default: "" },
    leadPricePaise: { type: Number, default: 10000, min: 0 },
    leadCostCredits: { type: Number, min: 0, default: undefined },
    currency: { type: String, default: "INR" },
    sourceWebsite: { type: String, default: "manual-admin", index: true },
    sourceChannel: { type: String, default: "admin" },
    sourceType: { type: String, default: "manual" },
    sourceName: { type: String, default: "" },
    campaign: { type: String, default: "" },
    externalEnquiryId: { type: String, default: "", index: true },
    notes: { type: String, default: "" },
    additionalDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    timeline: { type: [mongoose.Schema.Types.Mixed], default: [] },
    unlockedCount: { type: Number, default: 0, min: 0 },
    reservedUnlockCount: { type: Number, default: 0, min: 0 },
    remainingUnlocks: { type: Number, default: 5, min: 0 },
    maxProviderUnlocks: { type: Number, default: 5, min: 1, max: 1000 },
    providerConfirmedCount: { type: Number, default: 0, min: 0 },
    providerSaleConversionStatus: {
      type: String,
      enum: ["pending", "converted", "not_converted"],
      default: "pending",
      index: true,
    },
    providerSaleConversionUpdatedAt: { type: Date, default: null },
    providerSaleConvertedAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    collection: "enquiries",
    timestamps: true,
    strict: false,
  },
);

enquirySchema.index({ status: 1, categorySlug: 1, createdAt: -1 });
enquirySchema.index({ marketplaceAvailable: 1, categorySlug: 1, marketplacePublishedAt: -1, _id: -1 });
enquirySchema.index({ marketplaceAvailable: 1, categorySlug: 1, priority: 1, marketplacePublishedAt: -1, _id: -1 });
enquirySchema.index({ marketplaceStatus: 1, marketplaceExpiresAt: 1, _id: 1 });

module.exports = mongoose.model("Enquiry", enquirySchema, "enquiries");
