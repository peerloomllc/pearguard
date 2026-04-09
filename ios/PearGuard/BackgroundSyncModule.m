#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearGuardBGSync, NSObject)
RCT_EXTERN_METHOD(checkPendingBGSync:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(completeBGSync:(NSNumber *)success)
@end
