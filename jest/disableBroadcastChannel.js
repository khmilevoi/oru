// @reatom/core eagerly opens a BroadcastChannel at module load and never
// closes it (node_modules/@reatom/core/dist/index.cjs, initWithBroadcastChannel).
// Node's global BroadcastChannel makes that a leaked handle under Jest's
// node-based test environment, which hangs the run; deleting it here makes
// reatom take its own documented in-memory persistence fallback instead.
// React Native's Hermes runtime never provides BroadcastChannel either, so
// this is also a more faithful stand-in for production than Node's real
// implementation.
delete globalThis.BroadcastChannel;
