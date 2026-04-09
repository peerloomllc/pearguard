import UserNotifications

@objc(PearGuardNotifications)
class NotificationsModule: NSObject {

  private static var permissionRequested = false

  private static func ensurePermission() {
    guard !permissionRequested else { return }
    permissionRequested = true
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { _, _ in }
  }

  @objc func postNow(
    _ opts: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    NotificationsModule.ensurePermission()
    let id = opts["id"] as? Int ?? Int.random(in: 1_000_000...9_999_999)
    let title = opts["title"] as? String ?? "PearGuard"
    let body = opts["body"] as? String ?? ""
    let childPublicKey = opts["childPublicKey"] as? String ?? ""
    let tab = opts["tab"] as? String ?? ""

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.userInfo = ["childPublicKey": childPublicKey, "tab": tab]

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
    let request = UNNotificationRequest(
      identifier: "now-\(id)",
      content: content,
      trigger: trigger
    )
    UNUserNotificationCenter.current().add(request) { _ in resolve(nil) }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}
