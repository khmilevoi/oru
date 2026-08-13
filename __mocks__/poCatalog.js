// Stand-in for a Metro-compiled .po catalog. Jest does not run the Metro
// transformer, so `.po` imports are mapped here by jest.config.js.
module.exports = {messages: {}};
