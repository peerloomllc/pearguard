import BackgroundTasks

@objc(PearGuardBGSync)
class BackgroundSyncModule: NSObject {
  static let taskIdentifier = "com.pearguard.bgsync"
  private static let lock = NSLock()
  private static var pendingTask: BGAppRefreshTask?
  private static var expirationTimer: Timer?

  static func handleBGTask(_ task: BGAppRefreshTask) {
    lock.lock()
    pendingTask = task
    lock.unlock()
    DispatchQueue.main.async {
      let timer = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { _ in
        lock.lock()
        pendingTask?.setTaskCompleted(success: false)
        pendingTask = nil
        expirationTimer = nil
        lock.unlock()
      }
      lock.lock()
      expirationTimer = timer
      lock.unlock()
    }
    task.expirationHandler = {
      lock.lock()
      expirationTimer?.invalidate()
      expirationTimer = nil
      pendingTask?.setTaskCompleted(success: false)
      pendingTask = nil
      lock.unlock()
    }
    scheduleNext()
  }

  static func scheduleNext() {
    let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }

  @objc func checkPendingBGSync(
    _ resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    BackgroundSyncModule.lock.lock()
    let hasPending = BackgroundSyncModule.pendingTask != nil
    BackgroundSyncModule.lock.unlock()
    resolve(hasPending)
  }

  @objc func completeBGSync(_ success: NSNumber) {
    BackgroundSyncModule.lock.lock()
    BackgroundSyncModule.expirationTimer?.invalidate()
    BackgroundSyncModule.expirationTimer = nil
    BackgroundSyncModule.pendingTask?.setTaskCompleted(success: success.boolValue)
    BackgroundSyncModule.pendingTask = nil
    BackgroundSyncModule.lock.unlock()
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}
