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

/// The wake controller for the current platform.
pub fn controller() -> Box<dyn WakeController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::Caffeinate::new())
    }
    #[cfg(not(target_os = "macos"))]
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
}

#[cfg(not(target_os = "macos"))]
mod unsupported {
    use super::{LidCapability, WakeController};
    use std::io;

    /// Placeholder until the Linux (`logind` Inhibit) and Windows (`powercfg`
    /// lid-action) backends land in M2. Reports `Unsupported` so the UI never
    /// claims a hold it cannot keep.
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
