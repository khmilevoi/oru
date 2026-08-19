// The real ru catalog, keyed by the macro's hashed ids — see poCatalog.en.js
// for why the statically imported catalogs must be faithful under Jest.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {loadPoCatalog} = require('../jest/loadPoCatalog');

module.exports = {messages: loadPoCatalog('ru')};
