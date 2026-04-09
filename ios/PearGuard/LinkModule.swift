import Foundation

@objc(PearGuardLink)
class LinkModule: NSObject {
  static var pendingLink: String? = nil
  static var pendingChildPublicKey: String? = nil
  static var pendingTab: String? = nil

  @objc func getPendingLink(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let link = LinkModule.pendingLink
    LinkModule.pendingLink = nil
    resolve(link)
  }

  @objc func getPendingNav(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let key = LinkModule.pendingChildPublicKey
    let tab = LinkModule.pendingTab
    LinkModule.pendingChildPublicKey = nil
    LinkModule.pendingTab = nil
    if let key = key {
      resolve(["childPublicKey": key, "tab": tab ?? ""])
    } else {
      resolve(nil)
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}
