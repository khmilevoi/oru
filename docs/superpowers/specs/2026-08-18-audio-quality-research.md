# Audio quality research: voice isolation and bitrate optimization (2026-08-18)

Research synthesis from three parallel investigations: a codebase audit of the current audio
pipeline, a survey of on-device voice isolation / noise suppression options, and a survey of
Opus codec tuning for this app's transport. No code was changed. Companion to the design spec
(`2026-08-13-offline-nearby-ptt-design.md`, section 8).

## 1. Current pipeline (facts from the code)

- **Capture, Android:** `AudioRecord` with `MediaRecorder.AudioSource.VOICE_COMMUNICATION`
  (system AEC/NS, OEM-dependent quality), 16 kHz mono PCM16 (`AudioEngine.kt:130-138`).
- **Capture, iOS:** `AVAudioEngine` input tap at the hardware rate → `AVAudioConverter` to
  16 kHz Int16 → software makeup gain ×2.0 (`RadioConfig.swift:30`, hardware finding
  2026-08-17: iPhone capture is quiet) → Opus. The session runs `.playAndRecord` /
  `.voiceChat` (`AlwaysHotBackgroundManager.swift:160-162`) but
  `setVoiceProcessingEnabled(true)` is **never called** — the input node's AGC/NS are not
  active, recorded as an open investigation (`AudioEngine.swift:300-309`).
- **Encoder:** libopus on both platforms, `OPUS_APPLICATION_VOIP`, 16 kHz mono, 20 ms frames,
  `OPUS_SET_BITRATE(24000)` — and *nothing else*: complexity, VBR mode, DTX, FEC, signal,
  LSB depth are all at libopus defaults (`OpusCodec.kt:23`, `OpusCodec.swift:62-81`,
  Android JNI `opus_jni.c`).
- **Transport:** one Nearby Connections **STREAM payload per transmission** — reliable and
  ordered (confirmed by `JitterBuffer.swift:3-5` and Google's Connections docs). Each Opus
  packet is length-prefixed with 2 big-endian bytes (`AudioFraming.kt`), one
  `writeFrame`+flush per 20 ms frame. Loss therefore manifests as *delay*, never as
  decoder-visible drops.
- **Receive:** per-peer jitter buffer (target 3 frames = 60 ms, cap 25); on underrun it
  re-primes and `pop()` returns null — the peer is simply skipped for that mix cycle. The
  Android decoder *supports* PLC (`decode(null, …)`, `OpusCodec.kt:77-85`) but the playback
  loop never uses it; the iOS `Opus.Decoder` wrapper exposes no PLC path at all. Android
  mixes peers itself with saturating summation (`AudioMixer.kt`); iOS mixes via
  `AVAudioEngine` player nodes.
- **Mismatch found:** `MAX_ENCODED_FRAME_BYTES` is 400 on Android (and `AudioFraming.readFrame`
  *rejects* longer frames, killing the stream) vs 1275 on iOS. Harmless at 24 kbps CVBR
  (~60-byte packets), but a hard constraint on any packing/bitrate change.
- **Integration seam for a suppressor:** between the assembled 16 kHz PCM frame and
  `encoder.encode(...)` — `AudioEngine.kt:179` and `AudioEngine.swift:384-390`. All tunables
  live in the two mirrored `RadioConfig` files and must be changed in lockstep.

## 2. Voice isolation / noise suppression findings

Full comparison in the research pass; the shortlist tailored to this app:

1. **WebRTC APM (NS + AGC2), first.** BSD, no model file, natively 16 kHz / 10 ms (two hops
   per 20 ms frame), negligible CPU. AGC2 (adaptive digital gain to a speech target +
   limiter) is the *proper* fix for the iOS quiet-transmit problem that `captureGain = 2.0`
   currently patches with a fixed +6 dB. One C++ lib shared by both platforms
   (`webrtc-audio-processing` packaging exists). Weakness: mediocre on non-stationary noise.
2. **RNNoise as the quality upgrade.** BSD, 85 KB model, ~7× realtime on a Raspberry Pi 3 —
   trivial on any target phone. Caveat: fixed 48 kHz / 10 ms frames, so it either needs
   16→48→16 resampling (cheap, upper bands stay empty) or pairs naturally with a 48 kHz
   capture migration (see §3.1). Keep AGC2 after it.
3. **DeepFilterNet 3 only if 1+2 prove insufficient outdoors.** Best open quality
   (MIT/Apache, ready-made Android JNI wrapper exists), but ~40 ms algorithmic latency eats
   half the latency budget, ~8 MB model, iOS integration is DIY Rust/ONNX, and phone CPU
   numbers are extrapolated, not measured.

Ruled out: Picovoice Koala (license server needs internet — incompatible with an offline
app), Silero (non-commercial license), Krisp (enterprise pricing, offline-license terms
unknown). Honorable mention: DTLN (MIT, natively 16 kHz, TFLite) as an alternative to
RNNoise if TFLite is preferred over C, at worse latency (32 ms blocks vs 10 ms).

Key practice points, sourced:

- The suppressor sits **sender-side, immediately before the Opus encoder**. Receiver-side
  enhancement pays CPU on every listener and decodes noise that already consumed bits — skip.
- Denoising before a low-bitrate codec measurably helps: low-rate codecs "degrade noisy
  speech more than clean speech" (J-M Valin, RNNoise author / Opus co-author). At 24 kbps the
  win is perceptual (clean voice, no noise-pumping) rather than rescuing a starving codec.
- **Disable platform NS when shipping our own** (double-suppression gates and cuts words):
  Android switches capture to `VOICE_RECOGNITION` (or `UNPROCESSED` where supported); iOS
  bypasses VPIO or at minimum sets `isVoiceProcessingAGCEnabled = false`. Half-duplex PTT
  makes losing the platform AEC nearly free — the transmitter isn't playing far-end audio.
- **Battery:** run the suppressor only while the PTT button is held (bursts ≤120 s), never in
  the always-on keep-alive path; then even the heaviest option is a rounding error.
- **iOS Voice Isolation mic mode** (Apple's own DNN, zero CPU cost to us) cannot be enabled
  programmatically — through iOS 18/26 the app can only read `activeMicrophoneMode` and pop
  the system picker (`AVCaptureDevice.showSystemUserInterface(.microphoneModes)`). Worth a
  one-time nudge UI, not a dependency.
- **Wind** (ski slopes, street): none of the general suppressors target it and saturated-mic
  wind is unrecoverable by DSP. A steep ~100-150 Hz high-pass + DNN suppressor catches
  moderate rumble; heavy buffeting only yields to OEM multi-mic processing — which is an
  argument for keeping the platform path as a fallback toggle.

## 3. Opus / bitrate findings

The transport being a *reliable ordered stream* reframes everything: the levers are bitrate,
bandwidth, packing and PLC — not loss-recovery knobs.

### 3.1 The big one: 16 kHz capture caps quality below what 24 kbps pays for

libopus's own auto-bandwidth table picks **fullband from ~14 kbps** for mono voice; published
listening tests (Rämö & Toukomaa, Interspeech 2011; Xiph recommended settings) put WB speech
saturation at ~20 kbps and SWB/FB@24 kbps clearly above WB@24 kbps. Today's 16 kHz PCM API
rate is the artificial cap: the encoder *cannot* code above WB. Two coherent options:

- **Migrate capture/encode (and eventually decode/playback) to 48 kHz, keep 24 kbps.** Opus
  packets are self-describing (RFC 6716 TOC), so FB packets from a new sender still decode
  fine on an unchanged 16 kHz receiver (downsampled to WB) — no protocol bump, but receivers
  only *hear* the gain once their decode path runs ≥24 kHz. Synergy: RNNoise wants 48 kHz
  anyway; iOS already captures at the hardware rate and resamples, so there the change is
  mostly "resample to 48 instead of 16".
- **Or stay WB and drop to 18-20 kbps** at no perceptible cost — pocket ~20 % bandwidth.

### 3.2 Recommended parameter set

| Knob | Current | Recommendation | Compat |
|---|---|---|---|
| PCM rate | 16 kHz | 48 kHz (phase 2, both platforms) | app rollout, no wire bump |
| `OPUS_SET_BITRATE` | 24000 | keep 24000 with 48 kHz; 18000-20000 if staying WB | sender-side, any time |
| `OPUS_SET_SIGNAL` | AUTO | `OPUS_SIGNAL_VOICE` (stops speech/music mode flapping on noisy input) | sender-side, free |
| `OPUS_SET_LSB_DEPTH` | 24 | 16 (matches PCM16 capture, fixes silence detection) | sender-side, free |
| VBR | default CVBR | keep (optionally unconstrained) | already variable on the wire |
| `OPUS_SET_COMPLEXITY` | 9 | keep 9 — codec CPU is noise next to the radios | — |
| `OPUS_SET_INBAND_FEC` / `PACKET_LOSS_PERC` | off | **never enable**: on an ordered stream the FEC copy in packet N queues *behind* the delayed packet N−1 — logically useless, costs up to ~25 % of bitrate | — |
| `OPUS_SET_DTX` | off | leave off (PTT bursts are mostly speech; the frame-counting jitter buffer can't tell a DTX gap from a stall — cf. WebRTC NetEq M66 bug) | — |
| PLC | unused | on jitter underrun mid-transmission, decode `NULL` for concealment instead of skipping; discard the late frame when it arrives. Android decoder already supports it; iOS needs a shim past the `Opus.Decoder` wrapper | receiver-only |
| Flush batching | flush per 20 ms frame | batch 2-3 frames per stream flush: same wire format (2-byte length prefixes in the same STREAM), fewer Nearby transfer chunks and radio wakeups, +20-40 ms latency — fine for half-duplex | **wire-compatible** (unlike the BYTES-payload packing a naive reading suggests) |
| `MAX_ENCODED_FRAME_BYTES` | 400 (Android) / 1275 (iOS) | unify at 1275 (Opus hard max); Android's 400 currently kills the stream on any oversized frame | receiver hardening first |
| Adaptive bitrate | fixed | keep fixed; at most 2 static presets keyed off `BandwidthInfo.Quality` at connect time (LOW → 16 kbps WB). Continuous adaptation can't converge within a PTT burst and has no iOS signal | sender-side |
| libopus version | vendored | ensure ≥1.3; 1.5+ optionally unlocks decoder-side OSCE enhancement later | safe, bitstream frozen |

### 3.3 Do-not-bother list

Inband FEC, CBR (privacy rationale out of threat model), complexity-for-battery tuning,
continuous adaptive bitrate, frame sizes <20 ms, DRED, `EXPERT_FRAME_DURATION`, application
mode changes (VOIP is correct).

## 4. Suggested phasing (for a future planning pass — nothing started)

1. **Free wins, sender-side, no wire impact:** `OPUS_SIGNAL_VOICE`, `LSB_DEPTH(16)`; unify
   `MAX_ENCODED_FRAME_BYTES`; receiver PLC on underrun (Android trivially, iOS via shim).
   Requires extending the JNI/OpusShim ctl surface — today only bitrate is settable.
2. **AGC done right:** WebRTC AGC2 (or an RMS-target gain + limiter) replacing the fixed
   iOS `captureGain = 2.0`; resolves the quiet-transmit investigation properly on both
   platforms.
3. **Noise suppression v1:** WebRTC NS at 16 kHz behind a RadioConfig flag, platform NS
   disabled when active; A/B in the field (the heartbeat level meters already exist).
4. **Quality jump:** 48 kHz capture/encode migration + RNNoise (one resample budget serves
   both), receivers move decode/playback to 48 kHz in the same release; coordinate via app
   version.
5. **Only if field tests demand it:** DeepFilterNet3 prototype, bandwidth presets off
   `BandwidthInfo`, flush batching.

## 5. Explicitly unverified items

- Magnitudes: RNNoise→Opus@24kbps MOS gain, `SIGNAL_VOICE` benefit size, complexity-vs-quality
  curves, unconstrained-VBR delta — direction sourced, numbers not published; A/B locally.
- DeepFilterNet3 CPU on actual phones (extrapolated from Raspberry Pi 4 RTF 0.42).
- Current Nearby per-chunk framing overhead in bytes (NDSS 2019 documents structure only).
- Wind robustness of all DNS-trained suppressors (training sets are wind-light).
- The 2011 listening-test MOS values are read off a printed chart and predate Opus 1.2's
  low-rate SWB/FB improvements (which should widen, not shrink, the advantage).

Key sources: libopus `opus_encoder.c` defaults; RFC 6716/6562; Rämö & Toukomaa (Interspeech
2011); Xiph Opus Recommended Settings / FAQ; Opus 1.2/1.3/1.5 release notes; Google Nearby
Connections reference (reliability/ordering, `BandwidthInfo`); Antonioli et al. (NDSS 2019)
Nearby reverse engineering; WebRTC APM design doc; RNNoise demo & paper (Valin 2017);
DeepFilterNet 2/3 papers; Apple VPIO / microphone-mode documentation and developer-forum
threads on VPIO input level (721535, 739160).
