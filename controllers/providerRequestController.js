const service = require("../services/provider-request/provider-request-service");

async function page(req, res, next) {
  try {
    const categories = await service.listActiveCategories();
    return res.render("auth/join-as-provider", {
      title: "Join Findoly as a Provider",
      categories,
      googleMapsApiKey: String(process.env.GOOGLE_MAPS_API_KEY || "").trim(),
    });
  } catch (error) {
    return next(error);
  }
}

async function create(req, res, next) {
  try {
    const data = await service.submit(req.body || {});
    return res.status(data.duplicate || data.ignored ? 200 : 201).json({
      success: true,
      message: data.duplicate
        ? "A joining request already exists for this mobile number. Our team will contact you after reviewing it."
        : "Your joining request has been submitted successfully. Our team will contact you shortly.",
      data,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { page, create };
