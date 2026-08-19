#import <OruSpecs/OruSpecs.h>
#import <React/RCTInvalidating.h>
// `Oru-Swift.h` declares every `@objc`-visible class in the app module, which
// includes `AppDelegate.swift`'s `ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate`.
// The generated header only `@import`s that superclass's module behind
// `__has_feature(objc_modules)`, which is off in this Objective-C++ translation
// unit, so the superclass has to be imported by hand before it.
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import "Oru-Swift.h"

/**
 * Spec section 6.1, on iOS. A Swift class cannot return a
 * `std::shared_ptr<facebook::react::TurboModule>`, so the module itself is
 * Objective-C++ and every line of logic lives in `ORURadioBridge`
 * (`ios/Oru/RadioBridge.swift`).
 *
 * `NativeRadioSpecBase` derives from NSObject and has no `invalidate` of its
 * own, so teardown is declared through `RCTInvalidating` and does not call
 * super.
 */
@interface NativeRadioModule : NativeRadioSpecBase <NativeRadioSpec, RCTInvalidating>
@end

@implementation NativeRadioModule {
  BOOL _attached;
}

RCT_EXPORT_MODULE(NativeRadio)

- (void)attachIfNeeded
{
  if (_attached) {
    return;
  }
  _attached = YES;

  ORURadioBridge *bridge = ORURadioBridge.shared;
  __weak NativeRadioModule *weakSelf = self;
  [bridge setHandlersWithOwner:self
                onStateChanged:^(NSDictionary *state) {
                  [weakSelf emitOnStateChanged:state];
                }
                       onError:^(NSDictionary *payload) {
                         [weakSelf emitOnError:payload];
                       }];
  [bridge attach];
}

- (void)invalidate
{
  if (!_attached) {
    return;
  }
  _attached = NO;
  // Only tear down if a newer module has not already taken ownership: a stale
  // invalidate must not mute the live module's event stream.
  if ([ORURadioBridge.shared clearHandlersWithOwner:self]) {
    [ORURadioBridge.shared detach];
  }
}

- (void)start:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared start];
  resolve(nil);
}

- (void)stop:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared stop];
  resolve(nil);
}

- (void)pressPtt:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared pressPtt];
  resolve(nil);
}

- (void)releasePtt:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared releasePtt];
  resolve(nil);
}

- (void)getState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  resolve([ORURadioBridge.shared snapshot]);
}

- (void)configurePtt:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared configurePtt:^(NSDictionary *configuration) {
    resolve(configuration);
  }
      reject:^(NSString *code, NSString *message) {
        reject(code, message, nil);
      }];
}

- (void)selectPttCandidate:(NSString *)deviceId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared selectPttCandidate:deviceId];
  resolve(nil);
}

- (void)forgetPtt:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared forgetPtt];
  resolve(nil);
}

- (void)setAudioMode:(NSString *)mode
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared setAudioMode:mode];
  resolve(nil);
}

- (void)getAppLocale:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  resolve([ORURadioBridge.shared appLocale]);
}

- (void)setAppLocale:(NSString *)locale
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared setAppLocale:locale];
  resolve(nil);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeRadioSpecJSI>(params);
}

@end
