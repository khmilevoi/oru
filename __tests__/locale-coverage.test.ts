// eslint-disable-next-line @typescript-eslint/no-var-requires
const {loadPoCatalog} = require('../jest/loadPoCatalog');

/**
 * Spec section 12.2: two locales, both filled. A rendering test can only prove
 * the strings it happens to touch; this proves the catalogs themselves.
 */
describe('locale catalogs — spec section 12.2', () => {
  it('translates every source message into Russian', () => {
    const en = loadPoCatalog('en') as Record<string, string>;
    const ru = loadPoCatalog('ru') as Record<string, string>;

    const missing = Object.keys(en).filter(id => !ru[id]);

    expect(missing).toEqual([]);
  });

  it('carries a non-trivial number of messages', () => {
    expect(Object.keys(loadPoCatalog('en')).length).toBeGreaterThan(30);
  });

  it('keeps every placeholder intact across the translation', () => {
    const en = loadPoCatalog('en') as Record<string, string>;
    const ru = loadPoCatalog('ru') as Record<string, string>;
    const placeholders = (value: string) =>
      (value.match(/\{[^}]*\}/g) ?? []).sort();

    Object.entries(en).forEach(([id, source]) => {
      expect({id, of: placeholders(ru[id] ?? '')}).toEqual({
        id,
        of: placeholders(source),
      });
    });
  });
});
