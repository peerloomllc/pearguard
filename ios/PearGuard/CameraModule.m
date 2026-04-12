#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearGuardCamera, NSObject)
RCT_EXTERN_METHOD(capture:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
