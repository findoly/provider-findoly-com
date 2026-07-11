const { presentProvider } = require("../../utils/provider");

async function get(provider) {
  return presentProvider(provider);
}

module.exports = { get };
