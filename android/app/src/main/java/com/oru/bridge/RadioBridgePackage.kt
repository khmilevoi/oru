package com.oru.bridge

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * How `TurboModuleManager` finds [NativeRadioModule]. `NativeRadioSpec.NAME` is
 * the generated constant carrying the section 6.1 module name; it is read from
 * the spec rather than repeated so the two can never drift.
 */
class RadioBridgePackage : BaseReactPackage() {

    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext,
    ): NativeModule? =
        if (name == NativeRadioSpec.NAME) NativeRadioModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            NativeRadioSpec.NAME to ReactModuleInfo(
                NativeRadioSpec.NAME,
                NativeRadioModule::class.java.name,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            ),
        )
    }
}
