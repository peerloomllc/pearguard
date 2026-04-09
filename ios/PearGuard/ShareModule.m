#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearGuardShare, NSObject)
RCT_EXTERN_METHOD(share:(NSString *)title text:(NSString *)text)
@end
