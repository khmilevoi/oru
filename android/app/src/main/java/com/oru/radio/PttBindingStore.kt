package com.oru.radio

import android.content.Context

/** Spec section 9.2: the binding is stored natively and survives radio restarts. */
interface PttBindingStore {
    fun load(): PttConfiguration?
    fun save(configuration: PttConfiguration)
    fun clear()
}

class SharedPreferencesPttBindingStore(context: Context) : PttBindingStore {

    private companion object {
        const val FILE = "oru.ptt"
        const val KEY = "configuration"
    }

    private val preferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    override fun load(): PttConfiguration? =
        PttBindingCodec.decode(preferences.getString(KEY, null))

    override fun save(configuration: PttConfiguration) {
        preferences.edit().putString(KEY, PttBindingCodec.encode(configuration)).apply()
    }

    override fun clear() {
        preferences.edit().remove(KEY).apply()
    }
}
