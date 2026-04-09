#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearGuardNotifications, NSObject)
RCT_EXTERN_METHOD(postNow:(NSDictionary *)opts
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
