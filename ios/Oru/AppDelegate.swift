import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import RadioKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Phase 0: the radio runs without React Native. Debug builds only; wave 4
    // replaces this with the real app-entry wiring.
#if DEBUG
    RadioSpike.bootstrap()
#endif

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "Oru",
      in: window,
      launchOptions: launchOptions
    )

#if DEBUG
    // Phase 0 spike UI: covers the stock RN template screen entirely. The RN
    // root stays rootViewController; the panel is a full-screen child on top.
    if let window {
      SpikeControlPanelPresenter.attach(over: window)
    }
#endif

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
