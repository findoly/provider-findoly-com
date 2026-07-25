function activeReservationKey(providerId, enquiryId) {
  return `lead-unlock:${String(providerId || "").trim()}:${String(enquiryId || "").trim()}`;
}

module.exports = { activeReservationKey };
