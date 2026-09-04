import Foundation
import ServiceManagement

/// Register/unregister ajar as a macOS login item via SMAppService (the modern
/// replacement for the deprecated SMLoginItemSetEnabled / login-items API). A
/// menu-bar utility that keeps the machine awake for agents is only useful if it
/// comes back after a reboot, so this is offered as a toggle in the status-item
/// context menu.
enum LaunchAtLogin {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    /// Best-effort register/unregister. Failures are logged (visible in
    /// Console.app) rather than surfaced — the toggle simply reflects the real
    /// status on the next menu open.
    static func set(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog(
                "ajar: launch-at-login %@ failed: %@",
                enabled ? "register" : "unregister",
                error.localizedDescription
            )
        }
    }

    static func toggle() {
        set(!isEnabled)
    }
}
