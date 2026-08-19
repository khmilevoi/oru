package com.oru.bridge

import android.content.Context

/**
 * Amended spec §12.2 (2026-08-19): the in-app language override, stored natively exactly as
 * [com.oru.radio.SharedPreferencesAudioModeStore] stores the §8 pin — no JS persistence layer
 * exists. It lives in the bridge package, not `com.oru.radio`: the locale is an app concern
 * with no engine counterpart, so nothing under the radio package should know it exists.
 */
class SharedPreferencesAppLocaleStore(context: Context) {

    private companion object {
        const val FILE = "oru.appLocale"
        const val KEY = "locale"
    }

    private val preferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** Null means no override was ever chosen: the app follows the system locale. */
    fun load(): String? = preferences.getString(KEY, null)

    fun save(locale: String) {
        preferences.edit().putString(KEY, locale).apply()
    }
}
