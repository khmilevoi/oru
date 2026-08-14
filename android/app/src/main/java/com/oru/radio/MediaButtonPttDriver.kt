package com.oru.radio

import android.content.Context
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.view.KeyEvent

/**
 * The background-capable fallback on Android (spec section 9.1): a media-key button on a
 * Bluetooth headset profile reaches an active MediaSession even with the screen locked.
 * The session claims a "playing" state because the system only routes media buttons to a
 * session that looks like it is playing.
 *
 * Threading: [start]/[stop] run on the engine's single scheduler thread. The
 * `MediaSession.Callback` registered with no explicit `Handler` dispatches on whatever
 * thread's `Looper` was current when [session] was constructed, which in practice is this
 * same scheduler thread — but that is a platform default, not a documented guarantee, so
 * [pressed] is `@Volatile` rather than relying on it.
 */
class MediaButtonPttDriver(
    context: Context,
    private val keyCode: Int,
    private val listener: PttDriverListener,
) : PttDriver {

    private val session = MediaSession(context.applicationContext, "OruPtt")

    @Volatile
    private var pressed = false

    override fun start() {
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY)
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build(),
        )
        session.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                @Suppress("DEPRECATION")
                val event = mediaButtonIntent
                    .getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
                if (event.keyCode != keyCode) return false
                when (event.action) {
                    KeyEvent.ACTION_DOWN -> if (!pressed) {
                        pressed = true
                        listener.onPressed()
                    }
                    KeyEvent.ACTION_UP -> if (pressed) {
                        pressed = false
                        listener.onReleased()
                    }
                }
                return true
            }
        })
        session.isActive = true
        listener.onConnectionChanged(true)
    }

    override fun stop() {
        pressed = false
        session.isActive = false
        session.release()
        listener.onConnectionChanged(false)
    }
}
