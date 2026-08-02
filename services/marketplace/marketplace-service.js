const Enquiry = require("../../models/Enquiry");
const ProviderLeadUnlock = require("../../models/ProviderLeadUnlock");
const {
  providerCategories,
  providerIdentity,
} = require("../../utils/provider");
const {
  haversineDistanceKm,
  marketplaceVisibleAt,
} = require("../../utils/marketplace-radius");
const {
  getPagination,
  normalizeSort,
  decodeCursor,
  buildCursorCondition,
  mergeQuery,
  encodeCursor,
} = require("../../utils/pagination");
const { normalizeSearchText, prefixRegex } = require("../../utils/normalization");

const MARKETPLACE_COUNT_MAX_TIME_MS = Math.min(60000, Math.max(1000, Number(process.env.PROVIDER_QUERY_MAX_TIME_MS || 10000)));

const MARKETPLACE_SELECT = Object.freeze({
  _id: 1,
  enquiryId: 1,
  category: 1,
  categorySlug: 1,
  serviceType: 1,
  serviceTypes: 1,
  requirementTitle: 1,
  requirementTitleKey: 1,
  priority: 1,
  city: 1,
  cityKey: 1,
  state: 1,
  pincode: 1,
  preferredDate: 1,
  preferredSlot: 1,
  leadPricePaise: 1,
  leadCostCredits: 1,
  currency: 1,
  additionalDetails: 1,
  locationLatitude: 1,
  locationLongitude: 1,
  marketplaceStatus: 1,
  marketplaceAvailable: 1,
  marketplacePublishedAt: 1,
  marketplaceExpiresAt: 1,
  maxProviderUnlocks: 1,
  unlockedCount: 1,
  reservedUnlockCount: 1,
  remainingUnlocks: 1,
  providerConfirmedCount: 1,
  createdAt: 1,
  updatedAt: 1,
});

function publicId(value, label = "Lead reference") {
  const id = String(value || "").trim();
  if (!id || id.length > 120 || /[\0\r\n]/.test(id)) {
    throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  }
  return id;
}

function providerHasCoordinates(provider = {}) {
  return [provider.serviceLatitude, provider.serviceLongitude]
    .every((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
}

function leadHasCoordinates(lead = {}) {
  return [lead.locationLatitude, lead.locationLongitude]
    .every((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
}

function visibilityFor(provider = {}, lead = {}) {
  const distanceKm = providerHasCoordinates(provider) && leadHasCoordinates(lead)
    ? haversineDistanceKm(
        provider.serviceLatitude,
        provider.serviceLongitude,
        lead.locationLatitude,
        lead.locationLongitude,
      )
    : null;
  return {
    providerDistanceKm: distanceKm,
    marketplaceVisibleAt: marketplaceVisibleAt(lead.marketplacePublishedAt, distanceKm),
  };
}

function isVisibleNow(provider, lead, now = new Date()) {
  if (!lead.marketplaceAvailable || lead.marketplaceStatus !== "published") return false;
  if (!lead.marketplacePublishedAt || new Date(lead.marketplacePublishedAt) > now) return false;
  if (!lead.marketplaceExpiresAt || new Date(lead.marketplaceExpiresAt) <= now) return false;
  if (Number(lead.remainingUnlocks || 0) <= 0) return false;
  const visibleAt = visibilityFor(provider, lead).marketplaceVisibleAt;
  return Boolean(visibleAt && visibleAt <= now);
}

function assertCategoryMatch(provider, lead) {
  const categories = providerCategories(provider);
  if (!categories.length || !categories.includes(String(lead.categorySlug || ""))) {
    throw Object.assign(new Error("This lead does not match your provider categories"), {
      status: 404,
      code: "LEAD_NOT_FOUND",
    });
  }
}

async function loadMarketplaceEnquiry(provider, enquiryId, options = {}) {
  const providerId = providerIdentity(provider);
  const id = publicId(enquiryId);
  let query = Enquiry.findOne({ enquiryId: id });
  if (options.session) query = query.session(options.session);
  const lead = options.includeContact
    ? await query
    : await query.select(MARKETPLACE_SELECT);
  if (!lead) {
    throw Object.assign(new Error("Lead not found"), { status: 404, code: "LEAD_NOT_FOUND" });
  }
  assertCategoryMatch(provider, lead);

  if (!isVisibleNow(provider, lead, options.now || new Date())) {
    const existingQuery = ProviderLeadUnlock.findOne({ providerId, enquiryId: id });
    if (options.session) existingQuery.session(options.session);
    const existing = await existingQuery.select({ providerLeadUnlockId: 1 }).lean();
    if (!existing) {
      throw Object.assign(new Error("This lead is no longer available in the marketplace"), {
        status: 410,
        code: "LEAD_NOT_AVAILABLE",
      });
    }
  }
  return lead;
}


async function closeIfFull(enquiry, session = null) {
  if (!enquiry || Number(enquiry.remainingUnlocks || 0) > 0) return false;
  const options = session ? { session } : {};
  const result = await Enquiry.updateOne(
    { enquiryId: enquiry.enquiryId, remainingUnlocks: 0 },
    {
      $set: {
        marketplaceAvailable: false,
        marketplaceStatus: "closed",
        marketplaceClosureReason: "unlock_limit",
        updatedAt: new Date(),
      },
    },
    options,
  );
  return Boolean(result.matchedCount);
}

function listSort(filters = {}) {
  return String(filters.sort || "newest") === "oldest"
    ? { marketplacePublishedAt: 1, _id: 1 }
    : { marketplacePublishedAt: -1, _id: -1 };
}

function parseDateFilter(value, endOfDay = false) {
  if (!value) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw Object.assign(new Error("Date filter is invalid"), { status: 400 });
  }
  const date = new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new Error("Date filter is invalid"), { status: 400 });
  }
  return date;
}

function parseNonNegativeNumber(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  }
  return number;
}

function maximumDistance(filters = {}) {
  if (filters.maxDistanceKm === undefined || filters.maxDistanceKm === null || filters.maxDistanceKm === "") {
    return null;
  }
  const value = Number(filters.maxDistanceKm);
  if (!Number.isFinite(value) || value <= 0 || value > 1000) {
    throw Object.assign(new Error("Distance filter is invalid"), { status: 400 });
  }
  return value;
}

function buildMarketplaceQuery(provider, filters = {}, now = new Date()) {
  const categories = providerCategories(provider);
  if (!categories.length) return { _id: { $exists: false } };
  const requestedCategory = String(filters.categorySlug || "").trim().toLowerCase();
  if (requestedCategory && !categories.includes(requestedCategory)) {
    return { _id: { $exists: false } };
  }
  const startDate = parseDateFilter(filters.startDate);
  const endDate = parseDateFilter(filters.endDate, true);
  const publishedAt = { $lte: now };
  if (startDate) publishedAt.$gte = startDate;
  if (endDate && endDate < now) publishedAt.$lte = endDate;

  const query = {
    marketplaceAvailable: true,
    marketplaceStatus: "published",
    categorySlug: requestedCategory || { $in: categories.slice(0, 50) },
    marketplacePublishedAt: publishedAt,
    marketplaceExpiresAt: { $gt: now },
    remainingUnlocks: { $gt: 0 },
  };

  const minimumCredits = parseNonNegativeNumber(filters.minCredits, "Minimum credits filter");
  const maximumCredits = parseNonNegativeNumber(filters.maxCredits, "Maximum credits filter");
  if (minimumCredits !== null || maximumCredits !== null) {
    query.leadCostCredits = {};
    if (minimumCredits !== null) query.leadCostCredits.$gte = minimumCredits;
    if (maximumCredits !== null) query.leadCostCredits.$lte = maximumCredits;
  }

  const confirmation = String(filters.confirmation || "").trim().toLowerCase();
  if (confirmation === "confirmed") query.providerConfirmedCount = { $gt: 0 };
  else if (confirmation === "not_confirmed") query.providerConfirmedCount = 0;
  else if (confirmation) {
    throw Object.assign(new Error("Confirmation filter is invalid"), { status: 400 });
  }

  const unlockCount = String(filters.unlockCount || "").trim().toLowerCase();
  if (unlockCount === "none") query.unlockedCount = 0;
  else if (unlockCount === "one_two") query.unlockedCount = { $gte: 1, $lte: 2 };
  else if (unlockCount === "three_plus") query.unlockedCount = { $gte: 3 };
  else if (unlockCount) {
    throw Object.assign(new Error("Provider unlock filter is invalid"), { status: 400 });
  }

  const age = String(filters.age || "").trim().toLowerCase();
  const ageDays = { today: 1, "3d": 3, "7d": 7, "30d": 30 }[age];
  if (age && !ageDays) {
    throw Object.assign(new Error("Lead age filter is invalid"), { status: 400 });
  }
  if (ageDays) {
    const threshold = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
    query.marketplacePublishedAt.$gte = query.marketplacePublishedAt.$gte
      && query.marketplacePublishedAt.$gte > threshold
      ? query.marketplacePublishedAt.$gte
      : threshold;
  }

  const pincode = String(filters.pincode || "").trim();
  if (pincode) {
    if (!/^[1-9]\d{0,5}$/.test(pincode)) {
      throw Object.assign(new Error("PIN code filter is invalid"), { status: 400 });
    }
    query.pincode = prefixRegex(pincode);
  }

  const city = normalizeSearchText(filters.city);
  if (city) query.cityKey = prefixRegex(city);

  const priority = String(filters.priority || "").trim().toLowerCase();
  if (priority) {
    if (!["low", "normal", "high", "urgent"].includes(priority)) {
      throw Object.assign(new Error("Priority filter is invalid"), { status: 400 });
    }
    query.priority = priority;
  }

  const search = String(filters.q || filters.search || "").trim();
  if (search) {
    if (search.length > 120) {
      throw Object.assign(new Error("Search is too long"), { status: 400 });
    }
    if (/^[a-zA-Z0-9_-]{8,120}$/.test(search)) {
      query.$or = [
        { enquiryId: search },
        { requirementTitleKey: prefixRegex(search) },
        { cityKey: prefixRegex(search) },
        { pincode: prefixRegex(search) },
      ];
    } else {
      const normalized = normalizeSearchText(search);
      if (normalized.length < 2) {
        throw Object.assign(new Error("Enter at least 2 characters to search"), { status: 400 });
      }
      query.$or = [
        { requirementTitleKey: prefixRegex(normalized) },
        { cityKey: prefixRegex(normalized) },
        { pincode: prefixRegex(normalized) },
      ];
    }
  }
  return query;
}

async function listMarketplace(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const { limit, cursor } = getPagination(filters);
  const now = new Date();
  const sort = normalizeSort(listSort(filters));
  const baseQuery = buildMarketplaceQuery(provider, filters, now);
  const maxDistanceKm = maximumDistance(filters);
  let cursorValues = decodeCursor(cursor, sort);
  const selected = [];
  let lastScanned = null;
  let sourceHasMore = false;
  const scanLimit = Math.min(500, Math.max(limit * 4, 40));
  const maxBatches = 4;

  for (let batch = 0; batch < maxBatches && selected.length < limit + 1; batch += 1) {
    const condition = buildCursorCondition(sort, cursorValues);
    const rows = await Enquiry.find(mergeQuery(baseQuery, condition))
      .select(MARKETPLACE_SELECT)
      .sort(sort)
      .limit(scanLimit + 1)
      .lean();
    sourceHasMore = rows.length > scanLimit;
    const candidates = sourceHasMore ? rows.slice(0, scanLimit) : rows;
    if (!candidates.length) break;
    lastScanned = candidates[candidates.length - 1];

    const visible = candidates
      .map((lead) => ({ ...lead, ...visibilityFor(provider, lead) }))
      .filter((lead) => lead.marketplaceVisibleAt && lead.marketplaceVisibleAt <= now)
      .filter((lead) => maxDistanceKm === null
        || (lead.providerDistanceKm !== null && lead.providerDistanceKm <= maxDistanceKm));

    if (visible.length) {
      const unlocked = await ProviderLeadUnlock.find({
        providerId,
        enquiryId: { $in: visible.map((lead) => lead.enquiryId) },
      }).select({ enquiryId: 1 }).lean();
      const unlockedIds = new Set(unlocked.map((row) => row.enquiryId));
      for (const lead of visible) {
        if (!unlockedIds.has(lead.enquiryId)) selected.push(lead);
        if (selected.length >= limit + 1) break;
      }
    }

    if (!sourceHasMore) break;
    cursorValues = decodeCursor(encodeCursor(lastScanned, sort), sort);
  }

  const hasNext = selected.length > limit || sourceHasMore;
  const data = selected.slice(0, limit);
  const cursorRow = selected.length > limit
    ? data[data.length - 1]
    : (sourceHasMore ? lastScanned : data[data.length - 1]);
  const nextCursor = hasNext && cursorRow ? encodeCursor(cursorRow, sort) : "";
  return {
    data,
    pagination: { limit, returned: data.length, hasNext, nextCursor },
  };
}

async function countMarketplace(provider, options = {}) {
  const providerId = providerIdentity(provider);
  const cap = Math.min(5000, Math.max(1, Number(options.cap || 1000)));
  const now = options.now instanceof Date ? options.now : new Date();
  const baseQuery = buildMarketplaceQuery(provider, options.filters || {}, now);
  const unlockCollection = ProviderLeadUnlock.collection.name;
  const cursor = Enquiry.aggregate([
    { $match: baseQuery },
    {
      $lookup: {
        from: unlockCollection,
        let: { enquiryId: "$enquiryId" },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ["$providerId", providerId] },
            { $eq: ["$enquiryId", "$$enquiryId"] },
          ] } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "providerUnlock",
      },
    },
    { $match: { "providerUnlock.0": { $exists: false } } },
    { $sort: { marketplacePublishedAt: -1, _id: -1 } },
    { $project: MARKETPLACE_SELECT },
  ])
    .option({ maxTimeMS: MARKETPLACE_COUNT_MAX_TIME_MS })
    .cursor({ batchSize: 250 });

  let visible = 0;
  for await (const lead of cursor) {
    const visibleAt = visibilityFor(provider, lead).marketplaceVisibleAt;
    if (visibleAt && visibleAt <= now) visible += 1;
    if (visible > cap) {
      await cursor.close();
      return { value: cap, capped: true };
    }
  }
  return { value: visible, capped: false };
}

module.exports = {
  MARKETPLACE_SELECT,
  publicId,
  visibilityFor,
  isVisibleNow,
  assertCategoryMatch,
  loadMarketplaceEnquiry,
  closeIfFull,
  buildMarketplaceQuery,
  maximumDistance,
  listMarketplace,
  countMarketplace,
};
