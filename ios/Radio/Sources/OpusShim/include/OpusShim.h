#ifndef OpusShim_h
#define OpusShim_h

#include <opus.h>

/// Swift cannot call `opus_encoder_ctl` directly: it is a C variadic function,
/// and the Clang importer marks every C variadic function unavailable. This is
/// a fixed-arity, non-variadic wrapper around the one ctl request RadioKit needs.
int oru_opus_encoder_set_bitrate(OpusEncoder *st, opus_int32 bitrate);

#endif /* OpusShim_h */
