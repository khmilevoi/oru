import {atom, computed} from '@reatom/core';
import * as errore from 'errore';

describe('runtime dependencies are importable under Jest', () => {
  it('exposes the Reatom v1001 primitives the spec names', () => {
    expect(typeof atom).toBe('function');
    expect(typeof computed).toBe('function');
  });

  it('supports atom.extend, which the section 6.2 model relies on', () => {
    const counter = atom(0).extend(target => ({
      increment() {
        target.set(target() + 1);
      },
    }));

    counter.increment();

    expect(counter()).toBe(1);
  });

  it('computes derived state', () => {
    const source = atom(2);
    const doubled = computed(() => source() * 2);

    expect(doubled()).toBe(4);
  });

  it('exposes the errore helpers the TypeScript layer uses', () => {
    expect(typeof errore.createTaggedError).toBe('function');
  });
});
