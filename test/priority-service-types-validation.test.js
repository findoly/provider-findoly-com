const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { assertPlainBody } = require("../middleware/plain-text");
const { presentLead } = require("../utils/lead");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("provider-facing lead flow uses priority and no longer uses lead intent", () => {
  const files = [
    "views/lead/index.ejs",
    "views/lead/show.ejs",
    "services/lead/lead-service.js",
    "services/marketplace/marketplace-service.js",
    "utils/lead.js",
  ];
  for (const file of files) {
    const text = source(file);
    assert.doesNotMatch(text, /leadIntent|Lead intent|normalizeIntent/);
  }
  assert.match(source("views/lead/index.ejs"), /Urgent priority/);
  assert.match(source("views/lead/show.ejs"), />Priority</);
});

test("provider presentation retains up to five CRM service types", () => {
  const lead = presentLead({
    enquiryId: "lead-1",
    priority: "urgent",
    serviceType: "Interior Painting",
    serviceTypes: [
      { serviceTypeId: "st-1", name: "Interior Painting", slug: "interior-painting" },
      { serviceTypeId: "st-2", name: "Exterior Painting", slug: "exterior-painting" },
    ],
  });
  assert.equal(lead.priority, "urgent");
  assert.equal(lead.serviceTypes.length, 2);
  assert.equal(lead.serviceTypes[1].name, "Exterior Painting");
});

test("provider API form bodies reject emoji and HTML", () => {
  assert.throws(() => assertPlainBody({ note: "Call tomorrow 😀" }), /must not contain emoji/);
  assert.throws(() => assertPlainBody({ note: "<script>alert(1)<\/script>" }), /must not contain HTML/);
  assert.throws(() => assertPlainBody({ note: "&lt;b&gt;unsafe&lt;\/b&gt;" }), /must not contain HTML/);
  assert.doesNotThrow(() => assertPlainBody({ note: "Customer asked for a callback tomorrow." }));
});
