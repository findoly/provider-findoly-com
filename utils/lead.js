const SENSITIVE_KEY =
  /(name|mobile|phone|email|address|contact|whatsapp|customer|latitude|longitude|locationlink)/i;

function sanitizeDetails(value, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDetails(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    clean[key] = sanitizeDetails(child, depth + 1);
  }
  return clean;
}

function presentLead(row = {}) {
  const unlocked = row.contactUnlocked === true || row.status === "unlocked";
  const lead = {
    leadDistributionId: row.leadDistributionId || row.id || "",
    enquiryId: row.enquiryId || row.requirementId || "",
    categorySlug: row.categorySlug || "",
    status: row.status || "",
    leadPricePaise: Number(row.leadPricePaise || 0),
    currency: row.currency || "INR",
    contactUnlocked: unlocked,
    leadTitle: row.leadTitle || "",
    serviceType: row.serviceType || "",
    category: row.category || "",
    city: row.city || "",
    state: row.state || "",
    pincode: row.pincode || "",
    preferredDate: row.preferredDate || "",
    preferredSlot: row.preferredSlot || "",
    priority: row.priority || "normal",
    additionalDetails: unlocked
      ? row.additionalDetails || {}
      : sanitizeDetails(row.additionalDetails || {}),
    distributedAt: row.distributedAt || row.createdAt || null,
    unlockedAt: row.unlockedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };

  if (unlocked) {
    lead.customerName = row.customerName || "";
    lead.customerMobile = row.customerMobile || "";
    lead.customerEmail = row.customerEmail || "";
    lead.customerAddress = row.customerAddress || "";
  }

  return lead;
}

module.exports = { presentLead, sanitizeDetails };
