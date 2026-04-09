import Foundation
import React

@objc(PearGuardLink)
class LinkModule: RCTEventEmitter {
  static var pendingLink: String? = nil
  static var pendingChildPublicKey: String? = nil
  static var pendingTab: String? = nil
  private static weak var shared: LinkModule? = nil
  private var hasListeners = false

  override init() {
    super.init()
    LinkModule.shared = self
  }

  @objc override func supportedEvents() -> [String] {
    return ["notificationTapped"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  static func emitNotificationTapped(childPublicKey: String, tab: String?) {
    shared?.emitIfListening(childPublicKey: childPublicKey, tab: tab)
  }

  private func emitIfListening(childPublicKey: String, tab: String?) {
    guard hasListeners else { return }
    sendEvent(withName: "notificationTapped", body: [
      "childPublicKey": childPublicKey,
      "tab": tab ?? ""
    ])
  }

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

  @objc override static func requiresMainQueueSetup() -> Bool { return false }
}
