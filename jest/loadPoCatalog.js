/**
 * Jest never runs Metro's Lingui transformer, so jest.config.js maps every
 * `.po` import to __mocks__/poCatalog.js -- an empty catalog. That is right for
 * modules that merely import a catalog, and useless for the locale acceptance
 * of spec section 12.2, which has to prove that Russian copy actually renders.
 *
 * This reads a catalog off disk instead. The messages are handed to
 * `i18n.loadAndActivate` as plain strings; @lingui/core installs
 * `compileMessage` as its runtime compiler, so an uncompiled catalog behaves
 * exactly like a Metro-compiled one.
 *
 * A `.po` file's own `msgid` is the human-readable source text (see
 * `@lingui/format-po`'s `isGeneratedId`), but `Trans`/`t` compile to a lookup
 * by `generateMessageId(message, context)` -- a short hash -- whenever no
 * explicit id was written in the source, which is every message in this repo.
 * A catalog keyed by raw `msgid` text therefore never matches what the
 * compiled screen looks up, and every locale but the one whose source text
 * happens to equal its own translation would silently render the English
 * fallback. Keying by the same hash the macro embeds is what makes this a
 * faithful stand-in for a Metro-compiled catalog.
 */
const {readFileSync} = require('fs');
const {join} = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {generateMessageId} = require('@lingui/message-utils/generateMessageId');

const unquote = line => line.replace(/^"|"$/g, '').replace(/\\"/g, '"');

function loadPoCatalog(locale) {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'locales', locale, 'messages.po'),
    'utf8',
  );

  const messages = {};
  let id = null;
  let value = null;
  let field = null;

  const flush = () => {
    if (id && value) messages[generateMessageId(id)] = value;
    id = null;
    value = null;
    field = null;
  };

  for (const raw of source.split('\n')) {
    const line = raw.trim();

    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('#')) continue;

    if (line.startsWith('msgid ')) {
      flush();
      field = 'id';
      id = unquote(line.slice('msgid '.length));
      continue;
    }
    if (line.startsWith('msgstr ')) {
      field = 'str';
      value = unquote(line.slice('msgstr '.length));
      continue;
    }
    if (line.startsWith('"')) {
      if (field === 'id') id += unquote(line);
      if (field === 'str') value += unquote(line);
    }
  }
  flush();

  return messages;
}

module.exports = {loadPoCatalog};
