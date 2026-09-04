import Foundation
import UserNotifications

/// Thin wrapper over UNUserNotificationCenter for "agent finished" banners. A
/// menu-bar LSUIElement app can post user notifications once authorized;
/// authorization is requested once at launch (best-effort — a denial just means
/// no banners, never an error surfaced to the user).
enum Notifier {
    static func requestAuthorization() {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound]) { _, error in
                if let error {
                    NSLog("ajar: notification authorization failed: %@", error.localizedDescription)
                }
            }
    }

    /// Post "<label> finished". When no agents remain working the body says the
    /// Mac can sleep again; otherwise it reports how many are still going.
    static func notifyFinished(_ label: String, remaining: Int) {
        let content = UNMutableNotificationContent()
        content.title = "\(label) finished"
        content.body =
            remaining == 0
            ? "All agents idle — your Mac can sleep again."
            : "\(remaining) agent\(remaining == 1 ? "" : "s") still working."
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}
