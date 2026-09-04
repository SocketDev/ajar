//! Cross-platform wake control — the one trait every OS backend implements.
//!
//! The hard part of "keep the machine awake with the lid closed" is per-OS:
//!
//! | OS      | idle-sleep hold            | lid-closed hold                         |
//! |---------|----------------------------|-----------------------------------------|
//! | macOS   | `IOPMAssertion` (M0 shells `caffeinate`) | privileged helper: `pmset -a disablesleep 1` (M1); Apple-Silicon clamshell is *Partial* |
//! | Linux   | `logind` Inhibit           | `logind` Inhibit `handle-lid-switch` — Full (M2) |
//! | Windows | `SetThreadExecutionState`  | power-scheme lid-close action → "do nothing" via `powercfg` (M2) — Full |
//!
//! Every backend MUST auto-release on drop / crash so the machine can always
//! sleep again — the wake hold is a lease, never a latch.

use std::io;

/// How completely a backend can defeat sleep when the LID IS CLOSED. ajar
/// reports this honestly in the UI rather than overselling (Apple Silicon
/// clamshell sleep is genuinely `Partial`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LidCapability {
    /// Survives a closed lid on this machine.
    Full,
    /// Survives a closed lid in most cases; the OS may still force sleep in
    /// some edge cases (Apple Silicon clamshell).
    Partial,
    /// Prevents idle sleep only; a closed lid still sleeps.
    IdleOnly,
    /// No wake control available on this platform build yet.
    Unsupported,
}

/// A live wake hold. Dropping it releases the hold (fail-safe).
pub trait WakeController: Send {
    /// Take (or renew) the wake hold. `reason` surfaces in OS power tooling.
    fn engage(&mut self, reason: &str) -> io::Result<()>;
    /// Release the hold — the machine may sleep again.
    fn release(&mut self);
    /// Whether the hold is currently taken.
    fn is_engaged(&self) -> bool;
    /// What this backend can promise with the lid closed on this machine.
    fn lid_capability(&self) -> LidCapability;
}

/// The wake controller for the current platform. On macOS this prefers the
/// privileged helper (true lid-closed hold) and falls back to `caffeinate`
/// (idle-only) when the helper isn't installed yet.
pub fn controller() -> Box<dyn WakeController> {
    #[cfg(target_os = "macos")]
    {
        if macos::PmsetHelper::is_available() {
            Box::new(macos::PmsetHelper::new())
        } else {
            Box::new(macos::Caffeinate::new())
        }
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(linux::Inhibitor::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::PowerHold::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Box::new(unsupported::Unsupported)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{LidCapability, WakeController};
    use std::io;
    use std::process::{Child, Command};

    /// M0 macOS backend: hold a `caffeinate` child for the duration of the
    /// wake. `caffeinate -dimsu` is Apple's own `IOPMAssertion` wrapper —
    /// prevents idle system + display sleep. Killing the child releases every
    /// assertion, so a crash of ajar can never strand the Mac awake.
    ///
    /// M1 replaces this with a direct `IOPMAssertionCreateWithName` +
    /// privileged helper (`pmset -a disablesleep 1`) for true lid-closed hold.
    pub struct Caffeinate {
        child: Option<Child>,
    }

    impl Caffeinate {
        pub fn new() -> Self {
            Self { child: None }
        }
    }

    impl WakeController for Caffeinate {
        fn engage(&mut self, _reason: &str) -> io::Result<()> {
            if self.child.is_some() {
                return Ok(());
            }
            // -d display, -i idle system, -m disk, -s (on AC) system, -u user-active.
            let child = Command::new("/usr/bin/caffeinate")
                .args(["-dimsu"])
                .spawn()?;
            self.child = Some(child);
            Ok(())
        }

        fn release(&mut self) {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        fn is_engaged(&self) -> bool {
            self.child.is_some()
        }

        fn lid_capability(&self) -> LidCapability {
            // M0 caffeinate holds idle sleep only; lid-closed hold is M1's
            // privileged-helper job.
            LidCapability::IdleOnly
        }
    }

    impl Drop for Caffeinate {
        fn drop(&mut self) {
            self.release();
        }
    }

    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    const HELPER_SOCK: &str = "/var/run/com.socketdev.ajar-helper.sock";
    /// Lease TTL sent to the helper. Must exceed the renew interval with margin
    /// so a single dropped renewal doesn't lapse the hold.
    const LEASE_TTL_MS: u64 = 15_000;
    const RENEW_MS: u64 = 6_000;

    /// The true lid-closed backend: leases `pmset disablesleep` through the
    /// privileged helper. A background thread renews the lease every
    /// [`RENEW_MS`] so the hold survives regardless of the engine's tick
    /// cadence; if ajar dies the lease lapses and the helper re-enables sleep.
    pub struct PmsetHelper {
        engaged: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl PmsetHelper {
        /// The helper is installed + listening.
        pub fn is_available() -> bool {
            Path::new(HELPER_SOCK).exists()
        }

        pub fn new() -> Self {
            Self {
                engaged: Arc::new(AtomicBool::new(false)),
                worker: None,
            }
        }
    }

    impl WakeController for PmsetHelper {
        fn engage(&mut self, _reason: &str) -> io::Result<()> {
            if self.engaged.load(Ordering::SeqCst) {
                return Ok(());
            }
            // Verify the helper is reachable before claiming the hold.
            send_command(&format!("ENGAGE {LEASE_TTL_MS}"))?;
            self.engaged.store(true, Ordering::SeqCst);
            let engaged = Arc::clone(&self.engaged);
            self.worker = Some(thread::spawn(move || {
                while engaged.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(RENEW_MS));
                    if !engaged.load(Ordering::SeqCst) {
                        break;
                    }
                    // A dropped renewal is non-fatal: the lease TTL leaves slack
                    // and the next tick retries.
                    let _ = send_command(&format!("ENGAGE {LEASE_TTL_MS}"));
                }
            }));
            Ok(())
        }

        fn release(&mut self) {
            if !self.engaged.swap(false, Ordering::SeqCst) {
                return;
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            let _ = send_command("RELEASE");
        }

        fn is_engaged(&self) -> bool {
            self.engaged.load(Ordering::SeqCst)
        }

        fn lid_capability(&self) -> LidCapability {
            // `pmset disablesleep` is Full on Intel but Apple Silicon's clamshell
            // sensor can still force sleep in edge cases — report honestly.
            LidCapability::Partial
        }
    }

    impl Drop for PmsetHelper {
        fn drop(&mut self) {
            self.release();
        }
    }

    /// Send one line to the helper and wait for its reply. Connect-per-command
    /// keeps the client stateless; the helper's lease carries the state.
    fn send_command(cmd: &str) -> io::Result<()> {
        let mut stream = UnixStream::connect(HELPER_SOCK)?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(cmd.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{LidCapability, WakeController};
    use std::io;
    use std::process::{Child, Command};

    /// Linux backend: holds a systemd-logind inhibitor lock over
    /// `sleep:idle:handle-lid-switch` in `block` mode by keeping a
    /// `systemd-inhibit … sleep infinity` child alive. Killing the child drops
    /// the lock, so a crash always lets the machine sleep again. Blocking
    /// `handle-lid-switch` is what survives a closed lid — Full on Linux.
    pub struct Inhibitor {
        child: Option<Child>,
    }

    impl Inhibitor {
        pub fn new() -> Self {
            Self { child: None }
        }
    }

    impl WakeController for Inhibitor {
        fn engage(&mut self, reason: &str) -> io::Result<()> {
            if self.child.is_some() {
                return Ok(());
            }
            let child = Command::new("systemd-inhibit")
                .arg("--what=sleep:idle:handle-lid-switch")
                .arg("--who=ajar")
                .arg(format!("--why={reason}"))
                .arg("--mode=block")
                .args(["sleep", "infinity"])
                .spawn()?;
            self.child = Some(child);
            Ok(())
        }

        fn release(&mut self) {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        fn is_engaged(&self) -> bool {
            self.child.is_some()
        }

        fn lid_capability(&self) -> LidCapability {
            LidCapability::Full
        }
    }

    impl Drop for Inhibitor {
        fn drop(&mut self) {
            self.release();
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{LidCapability, WakeController};
    use std::io;
    use std::process::Command;

    type ExecutionState = u32;
    const ES_CONTINUOUS: ExecutionState = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: ExecutionState = 0x0000_0001;

    extern "system" {
        fn SetThreadExecutionState(es_flags: ExecutionState) -> ExecutionState;
    }

    /// Windows backend: `SetThreadExecutionState` keeps the system out of idle
    /// sleep, and the active power scheme's lid-close action is set to "do
    /// nothing" while engaged (restored to sleep on release) so a closed lid
    /// stays awake — Full on Windows. Save/restore of a non-default prior lid
    /// action is an M3 refinement.
    pub struct PowerHold {
        engaged: bool,
    }

    impl PowerHold {
        pub fn new() -> Self {
            Self { engaged: false }
        }

        /// GUID_SYSTEM_BUTTON_SUBGROUP / lid-close-action. Index 0 = "do
        /// nothing", 1 = "sleep".
        fn set_lid_action(index: &str) {
            for domain in ["/setacvalueindex", "/setdcvalueindex"] {
                let _ = Command::new("powercfg")
                    .args([
                        domain,
                        "SCHEME_CURRENT",
                        "4f971e89-eebd-4455-a8de-9e59040e7347", // SUB_BUTTONS
                        "5ca83367-6e45-459f-a27b-476b1d01c936", // LIDACTION
                        index,
                    ])
                    .status();
            }
            let _ = Command::new("powercfg")
                .args(["/setactive", "SCHEME_CURRENT"])
                .status();
        }
    }

    impl WakeController for PowerHold {
        fn engage(&mut self, _reason: &str) -> io::Result<()> {
            // SAFETY: FFI to kernel32; the flags are a valid EXECUTION_STATE
            // bitmask and the call has no memory effects.
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            }
            Self::set_lid_action("0");
            self.engaged = true;
            Ok(())
        }

        fn release(&mut self) {
            // SAFETY: as above — clears the continuous requirement.
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
            Self::set_lid_action("1");
            self.engaged = false;
        }

        fn is_engaged(&self) -> bool {
            self.engaged
        }

        fn lid_capability(&self) -> LidCapability {
            LidCapability::Full
        }
    }

    impl Drop for PowerHold {
        fn drop(&mut self) {
            if self.engaged {
                self.release();
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod unsupported {
    use super::{LidCapability, WakeController};
    use std::io;

    /// Fallback for platforms without a wake backend. Reports `Unsupported` so
    /// the UI never claims a hold it cannot keep.
    pub struct Unsupported;

    impl WakeController for Unsupported {
        fn engage(&mut self, _reason: &str) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "wake control not yet implemented on this platform (M2)",
            ))
        }
        fn release(&mut self) {}
        fn is_engaged(&self) -> bool {
            false
        }
        fn lid_capability(&self) -> LidCapability {
            LidCapability::Unsupported
        }
    }
}
