const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    categoryId: { type: String, default: "", index: true },
    id: { type: String, default: "", index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, trim: true, index: true, maxlength: 80 },
    active: { type: Boolean, default: true, index: true },
  },
  {
    collection: "categories",
    strict: false,
  },
);

module.exports = mongoose.models.Category || mongoose.model("Category", categorySchema, "categories");
