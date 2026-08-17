#ifndef MallocCompatShim_h
#define MallocCompatShim_h

#include <stddef.h>

/// A weak `sdallocx` in the vendored BoringSSL build loses dyld's weak-symbol
/// coalescing to a strong (but inert on Apple platforms) `sdallocx` exported
/// by React Native's prebuilt ReactNativeDependencies.framework (folly's
/// jemalloc-detection shim, which is never actually called there because
/// `folly::usingJEMalloc()` is false on Apple). Every BoringSSL call to
/// `sdallocx` then jumps into that framework's non-executable `__DATA` page
/// instead of running code, which the kernel kills outright
/// (CODESIGNING/"Invalid Page"). Providing our own strong, real definition
/// wins that coalescing -- this image loads ahead of
/// ReactNativeDependencies.framework -- and gives every caller a working
/// `free`-backed implementation instead.
void sdallocx(void *ptr, size_t size, int flags);

#endif /* MallocCompatShim_h */
