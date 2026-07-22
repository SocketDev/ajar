import AppKit
import SwiftUI

/// Owns the NSStatusItem and NSPopover. Created by SwiftUI's
/// `@NSApplicationDelegateAdaptor`.
///
/// Left-click on the status item toggles the popover; right-click (or
/// option-click) shows a small NSMenu with the mode toggle + Quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private let model = StatusViewModel()

    /// Global mouse-event monitor that closes the popover on outside clicks.
    private var clickMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureStatusItem()
        configurePopover()
        model.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let m = clickMonitor { NSEvent.removeMonitor(m) }
        model.stop()
    }

    // MARK: - Status item

    private func configureStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }

        button.image = LidGlyph.statusImage(awake: false)
        button.image?.isTemplate = true
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])

        // The icon has two states (awake filled / idle outlined). Poll the
        // model on a short interval to keep it in sync — fine-grained
        // observation isn't needed for a two-state glyph.
        Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.refreshIconState()
                try? await Task.sleep(for: .seconds(2))
                if self == nil { return }
            }
        }
    }

    private func refreshIconState() {
        guard let button = statusItem?.button else { return }
        let awake = model.status.state == .awake
        button.image = LidGlyph.statusImage(awake: awake)
        button.image?.isTemplate = true
        button.toolTip = "Ajar — \(model.status.state.rawValue)"
    }

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        let isRightClick = event?.type == .rightMouseUp
            || (event?.modifierFlags.contains(.option) ?? false)

        if isRightClick {
            showContextMenu(from: sender)
        } else {
            togglePopover(from: sender)
        }
    }

    // MARK: - Popover

    private func configurePopover() {
        popover = NSPopover()
        popover.behavior = .transient
        // NSPopover's built-in animation is slow and not tunable via public
        // API; disabling it gives the snappy show/hide of native menu-bar
        // widgets.
        popover.animates = false
        popover.contentSize = NSSize(width: 320, height: 380)
        popover.contentViewController = NSHostingController(rootView: PopoverView(model: model))
    }

    private func togglePopover(from sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(nil)
            tearDownClickMonitor()
        } else {
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)

            // The popover opens without becoming key, so SwiftUI hover events
            // don't fire until the first click. Activating + making it key
            // fixes hover affordances on the very first open.
            NSApp.activate(ignoringOtherApps: true)
            if let window = popover.contentViewController?.view.window {
                window.makeKey()
                window.acceptsMouseMovedEvents = true
            }
            installClickMonitor()
        }
    }

    private func installClickMonitor() {
        tearDownClickMonitor()
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self else { return }
            if self.popover.isShown { self.popover.performClose(nil) }
            self.tearDownClickMonitor()
        }
    }

    private func tearDownClickMonitor() {
        if let m = clickMonitor {
            NSEvent.removeMonitor(m)
            clickMonitor = nil
        }
    }

    // MARK: - Context menu

    private func showContextMenu(from sender: NSStatusBarButton) {
        let menu = NSMenu()

        let modeItem = NSMenuItem(
            title: model.mode == .always
                ? "Keep awake only while agents work"
                : "Always keep awake",
            action: #selector(toggleMode),
            keyEquivalent: ""
        )
        modeItem.target = self
        menu.addItem(modeItem)

        let loginItem = NSMenuItem(
            title: "Launch at Login",
            action: #selector(toggleLaunchAtLogin),
            keyEquivalent: ""
        )
        loginItem.target = self
        loginItem.state = LaunchAtLogin.isEnabled ? .on : .off
        menu.addItem(loginItem)

        let notifyItem = NSMenuItem(
            title: "Notify when agents finish",
            action: #selector(toggleNotifyOnFinish),
            keyEquivalent: ""
        )
        notifyItem.target = self
        notifyItem.state = model.notifyOnFinish ? .on : .off
        menu.addItem(notifyItem)

        menu.addItem(.separator())
        let quit = NSMenuItem(
            title: "Quit Ajar",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quit)

        for item in menu.items where item.target == nil {
            item.target = self
        }

        statusItem.menu = menu
        sender.performClick(nil)   // pops the menu
        statusItem.menu = nil      // restore button-click behavior
    }

    @objc private func toggleMode() {
        model.setMode(model.mode == .always ? .whileAgentsWork : .always)
    }

    @objc private func toggleLaunchAtLogin() {
        LaunchAtLogin.toggle()
    }

    @objc private func toggleNotifyOnFinish() {
        model.notifyOnFinish.toggle()
    }
}
