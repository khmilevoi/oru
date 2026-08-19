package com.oru.radio

import android.content.Context

/**
 * Spec section 8's persisted setting, stored natively exactly as [PttBindingStore] is: no JS
 * storage dependency exists, and the pin must survive a radio restart.
 */
interface AudioModeStore {
    fun load(): ModePolicy.AudioMode
    fun save(mode: ModePolicy.AudioMode)
}

class SharedPreferencesAudioModeStore(context: Context) : AudioModeStore {

    private companion object {
        const val FILE = "oru.audio"
        const val KEY = "mode"
    }

    private val preferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** An absent or unrecognised value is section 8's `auto` default. */
    override fun load(): ModePolicy.AudioMode = audioModeFromWire(preferences.getString(KEY, null))

    override fun save(mode: ModePolicy.AudioMode) {
        preferences.edit().putString(KEY, mode.wire()).apply()
    }
}
