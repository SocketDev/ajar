import Foundation

/// One decoded status line from `ajar run --json`.
struct AjarStatus: Equatable {
    enum State: String {
        case awake, idle, blocked
    }

    var state: State
    var reason: String
    var agents: [String]

    static let unknown = AjarStatus(state: .idle, reason: "", agents: [])
}

/// Long-running bridge to the bundled `ajar` binary. Spawns `ajar run --json`
/// once, streams status NDJSON from its stdout, and forwards control commands
/// (`power …`, `mode …`, `quit`) to its stdin. Mirrors depsight's subprocess
/// bridge, adapted for a persistent process rather than a one-shot scan.
///
/// The binary lives in the app bundle at `Contents/Resources/ajar` (produced
/// by the `Build and bundle ajar binary` build phase).
final class AjarClient {
    static var binaryURL: URL? {
        Bundle.main.url(forResource: "ajar", withExtension: nil)
    }

    private var process: Process?
    private var stdin: FileHandle?
    private var buffer = Data()

    /// Spawn `ajar run --json`. `onStatus` fires on the main queue for each
    /// status line. Returns false if the binary is missing or the spawn fails.
    @discardableResult
    func start(onStatus: @escaping (AjarStatus) -> Void) -> Bool {
        guard process == nil, let url = Self.binaryURL else { return false }

        let proc = Process()
        proc.executableURL = url
        proc.arguments = ["run", "--json"]

        let outPipe = Pipe()
        let inPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = Pipe()   // discard
        proc.standardInput = inPipe

        // Minimal env — HOME so the ping-port file lands under ~/.ajar, PATH so
        // the runtime can shell out to caffeinate/pmset.
        var env: [String: String] = [:]
        if let home = ProcessInfo.processInfo.environment["HOME"] { env["HOME"] = home }
        if let path = ProcessInfo.processInfo.environment["PATH"] { env["PATH"] = path }
        env["LANG"] = "en_US.UTF-8"
        proc.environment = env

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let chunk = handle.availableData
            if chunk.isEmpty { return }
            self.buffer.append(chunk)
            while let nl = self.buffer.firstIndex(of: 0x0A) {
                let line = self.buffer.prefix(upTo: nl)
                self.buffer.removeSubrange(...nl)
                if let status = Self.decode(line) {
                    DispatchQueue.main.async { onStatus(status) }
                }
            }
        }

        do {
            try proc.run()
        } catch {
            return false
        }
        self.process = proc
        self.stdin = inPipe.fileHandleForWriting
        return true
    }

    /// Send one control command line (a trailing newline is added).
    func send(_ command: String) {
        guard let stdin else { return }
        try? stdin.write(contentsOf: Data((command + "\n").utf8))
    }

    /// Ask the runtime to quit + release the wake hold, then terminate.
    func stop() {
        send("quit")
        process?.terminate()
        process = nil
        stdin = nil
    }

    private static func decode(_ data: Data) -> AjarStatus? {
        guard !data.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let state = AjarStatus.State(rawValue: obj["status"] as? String ?? "") ?? .idle
        let reason = obj["reason"] as? String ?? ""
        let agentsRaw = obj["agents"] as? [[String: Any]] ?? []
        let agents = agentsRaw.compactMap { $0["label"] as? String }
        return AjarStatus(state: state, reason: reason, agents: agents)
    }
}
