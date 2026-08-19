// The real en catalog, keyed by the macro's hashed ids (see
// jest/loadPoCatalog.js). `src/i18n.ts` imports both catalogs statically, and
// an empty stand-in there would make `activateLocale()` activate nothing under
// Jest — the in-place language switch the Settings screen performs would
// silently render English fallbacks and no test could catch a broken catalog.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {loadPoCatalog} = require('../jest/loadPoCatalog');

module.exports = {messages: loadPoCatalog('en')};
