import AppKit
import Foundation
import IOKit.ps
import Observation

/// Drives the menu-bar UI. Owns the [`AjarClient`] bridge, mirrors its status
/// stream into observable state, and samples the platform power state on a
/// timer — forwarding battery/AC/low-power/thermal to the runtime so the wake
/// guardrails (which live in the shared Rust engine) apply here too.
///
/// Lifecycle: created once by AppDelegate at launch, kept alive for the
/// lifetime of the process. The view is recreated on each popover open, so all
/// persistent state lives here.
@Observable
@MainActor
final class StatusViewModel {
    /// UI mirror of `ajar-core`'s `KeepAwake`.
    enum Mode: String {
        case whileAgentsWork, always
    }

    /// Latest status line from the runtime. `.unknown` until the first arrives.
    var status: AjarStatus = .unknown
    var mode: Mode = .whileAgentsWork
    var battery: Double = 1.0
    var onAC: Bool = true
    var notifyOnFinish: Bool = StatusViewModel.loadNotifyOnFinish() {
        didSet { UserDefaults.standard.set(notifyOnFinish, forKey: StatusViewModel.notifyKey) }
    }

    private static let notifyKey = "ajar.notifyOnFinish"
    private let client = AjarClient()
    private var powerTask: Task<Void, Never>?
    private var started = false
    /// Working-agent labels from the previous status, to detect finishes.
    private var previousWorking: Set<String> = []

    /// How often to re-sample battery/thermal and forward it to the runtime.
    private let powerInterval: TimeInterval = 15

    /// Spawn the bridge + begin power sampling. Call once after construction.
    func start() {
        guard !started else { return }
        started = true
        Notifier.requestAuthorization()
        client.start { [weak self] status in
            self?.handleStatusUpdate(status)
        }
        sendPower()   // prime the runtime before the first timer tick
        startPowerSampling()
    }

    /// Fold a status line into observable state and fire a finish notification
    /// for any agent that dropped out of the working set since the last update.
    private func handleStatusUpdate(_ next: AjarStatus) {
        let current = Set(next.agents)
        if notifyOnFinish {
            for label in previousWorking.subtracting(current).sorted() {
                Notifier.notifyFinished(label, remaining: current.count)
            }
        }
        previousWorking = current
        status = next
    }

    private static func loadNotifyOnFinish() -> Bool {
        UserDefaults.standard.object(forKey: notifyKey) == nil
            ? true
            : UserDefaults.standard.bool(forKey: notifyKey)
    }

    func setMode(_ mode: Mode) {
        self.mode = mode
        client.send(mode == .always ? "mode always" : "mode agents")
    }

    /// Stop sampling + tell the runtime to release. Call from a main-actor
    /// context (AppDelegate.applicationWillTerminate).
    func stop() {
        powerTask?.cancel()
        powerTask = nil
        client.stop()
    }

    // MARK: - Power sampling

    private func startPowerSampling() {
        powerTask?.cancel()
        powerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self?.powerInterval ?? 15))
                guard let self else { return }
                self.sendPower()
            }
        }
    }

    private func sendPower() {
        let (batt, ac) = Self.readPower()
        battery = batt
        onAC = ac
        var cmd = "power \(String(format: "%.2f", batt)) \(ac ? "ac" : "batt")"
        if ProcessInfo.processInfo.isLowPowerModeEnabled {
            cmd += " lowpower"
        }
        switch ProcessInfo.processInfo.thermalState {
        case .serious, .critical:
            cmd += " hot"
        default:
            break
        }
        client.send(cmd)
    }

    /// Read the internal battery fraction + AC state via IOKit. A machine with
    /// no battery (desktop) reports as plugged in at full charge.
    private static func readPower() -> (Double, Bool) {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [CFTypeRef],
              let source = sources.first,
              let desc = IOPSGetPowerSourceDescription(snapshot, source)?.takeUnretainedValue() as? [String: Any]
        else {
            return (1.0, true)
        }
        let current = desc[kIOPSCurrentCapacityKey] as? Int ?? 100
        let maximum = desc[kIOPSMaxCapacityKey] as? Int ?? 100
        let state = desc[kIOPSPowerSourceStateKey] as? String ?? kIOPSACPowerValue
        let onAC = state == kIOPSACPowerValue
        let fraction = maximum > 0 ? Double(current) / Double(maximum) : 1.0
        return (fraction, onAC)
    }
}
