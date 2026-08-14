cmake_minimum_required(VERSION 3.22)
project(OruOpus LANGUAGES C)

include(FetchContent)

# Pinned libopus release. The hash was taken from the canonical HTTPS download on
# 2026-08-14. For an offline build, point ORU_OPUS_URL at a local copy:
#   -DORU_OPUS_URL=file:///C:/somewhere/opus-1.5.2.tar.gz
# The same file is mirrored at
#   https://github.com/xiph/opus/releases/download/v1.5.2/opus-1.5.2.tar.gz
set(ORU_OPUS_URL
    "https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz"
    CACHE STRING "libopus release tarball")
set(ORU_OPUS_SHA256
    "65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1"
    CACHE STRING "SHA-256 of ORU_OPUS_URL")

# Static libopus, no programs, no tests, no install rules: this build produces exactly
# one artifact, liboru_opus.so, with libopus linked into it. Fixed point is the right
# choice for phones and is what mobile Opus builds use.
set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_FIXED_POINT ON CACHE BOOL "" FORCE)

# The NDK's prebuilt clang does not resolve celt_pitch_xcorr_neon at link time (the ARM
# NEON intrinsics translation unit fails to link against the fixed-point SILK objects
# that call it), so intrinsics are disabled and libopus falls back to its portable C.
set(OPUS_DISABLE_INTRINSICS ON CACHE BOOL "" FORCE)

FetchContent_Declare(
    opus
    URL ${ORU_OPUS_URL}
    URL_HASH SHA256=${ORU_OPUS_SHA256}
)
FetchContent_MakeAvailable(opus)

add_library(oru_opus SHARED opus_jni.c)
target_link_libraries(oru_opus PRIVATE opus log)
