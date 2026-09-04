import SwiftUI

/// App entry point. Marked `LSUIElement` in Info.plist so there is no Dock icon
/// and no main window — the status item is the entire UI surface.
///
/// The status item + popover are AppKit-driven (NSStatusItem + NSPopover) for
/// programmatic open, a right-click menu, and transient-popover control that
/// SwiftUI's MenuBarExtra doesn't expose.
@main
struct AjarMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // SwiftUI requires one Scene. Settings has no window in an LSUIElement
        // app, so the whole UI stays AppKit-driven.
        Settings { EmptyView() }
    }
}
