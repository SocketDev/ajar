//! The runtime — assembles the ping server, the process scan, and the wake
//! engine into one background-running system that a UI drives (the native tray
//! shells in M3, or the headless runner today). The shell feeds power samples +
//! config; the runtime does the rest on a timer.

use crate::agent::Agent;
use crate::guard::{Guards, Power};
use crate::ping::PingServer;
use crate::registry::Registry;
use crate::scan::scan_running;
use crate::state::{Engine, KeepAwake, Status};
use crate::wake::{controller, WakeController};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// How often the runtime rescans processes + re-evaluates the wake decision.
const TICK: Duration = Duration::from_secs(2);

/// A running ajar. Cloneable handles into the shared state let the UI query +
/// reconfigure it while the background loop runs.
pub struct Runtime {
    engine: Arc<Mutex<Engine>>,
    registry: Arc<Mutex<Registry>>,
    power: Arc<Mutex<Power>>,
    running: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Runtime {
    /// Start with the current platform's real wake controller.
    pub fn start(mode: KeepAwake, guards: Guards) -> io::Result<Self> {
        Self::start_with(mode, guards, controller())
    }

    /// Start with an injected controller (tests use a fake so no real
    /// `caffeinate`/helper is spawned).
    pub fn start_with(
        mode: KeepAwake,
        guards: Guards,
        wake: Box<dyn WakeController>,
    ) -> io::Result<Self> {
        let engine = Arc::new(Mutex::new(Engine::new(wake, mode, guards)));
        let registry = Arc::new(Mutex::new(Registry::new()));
        // Assume plugged-in until the shell reports otherwise, so the guardrails
        // don't spuriously block before the first power sample arrives.
        let power = Arc::new(Mutex::new(Power {
            battery: 1.0,
            on_ac: true,
            low_power_mode: false,
            thermal_hot: false,
        }));
        let running = Arc::new(AtomicBool::new(true));

        // Ping server: fold lifecycle-hook reports into the registry.
        let server = PingServer::bind()?;
        {
            let registry = Arc::clone(&registry);
            thread::spawn(move || server.serve(registry));
        }

        // Evaluate once synchronously so status is meaningful the instant
        // start() returns (no first-tick race), then keep ticking on a timer.
        tick_once(&engine, &registry, &power);
        let worker = {
            let engine = Arc::clone(&engine);
            let registry = Arc::clone(&registry);
            let power = Arc::clone(&power);
            let running = Arc::clone(&running);
            thread::spawn(move || {
                // Poll in small steps so stop() is responsive (≤POLL) while
                // re-evaluating every TICK.
                const POLL: Duration = Duration::from_millis(200);
                let mut since = Duration::ZERO;
                while running.load(Ordering::SeqCst) {
                    thread::sleep(POLL);
                    since += POLL;
                    if since >= TICK {
                        since = Duration::ZERO;
                        tick_once(&engine, &registry, &power);
                    }
                }
                // On stop, force a release so the machine can sleep again
                // (mode-independent — `Always` would keep holding on tick(0)).
                engine.lock().unwrap().shutdown();
            })
        };

        Ok(Self {
            engine,
            registry,
            power,
            running,
            worker: Some(worker),
        })
    }

    /// Report the latest battery/thermal/power state (the shell's platform job).
    pub fn set_power(&self, power: Power) {
        *self.power.lock().unwrap() = power;
    }

    pub fn set_mode(&self, mode: KeepAwake) {
        self.engine.lock().unwrap().set_mode(mode);
    }

    pub fn set_guards(&self, guards: Guards) {
        self.engine.lock().unwrap().set_guards(guards);
    }

    /// Restrict watched agents (empty = watch all).
    pub fn set_enabled_agents(&self, agents: impl IntoIterator<Item = Agent>) {
        self.registry.lock().unwrap().set_enabled(agents);
    }

    pub fn status(&self) -> Status {
        self.engine.lock().unwrap().status()
    }

    pub fn working_agents(&self) -> Vec<Agent> {
        self.registry.lock().unwrap().working_agents()
    }

    /// Stop the loop + release the wake hold. Idempotent.
    pub fn stop(&mut self) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One evaluation: rescan processes, then drive the engine off the current
/// working count + power sample.
fn tick_once(
    engine: &Arc<Mutex<Engine>>,
    registry: &Arc<Mutex<Registry>>,
    power: &Arc<Mutex<Power>>,
) {
    let alive = scan_running();
    let (working, sample) = {
        let mut reg = registry.lock().unwrap();
        reg.observe_processes(alive);
        (reg.working(), *power.lock().unwrap())
    };
    engine.lock().unwrap().tick(working, sample);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wake::LidCapability;

    #[derive(Default)]
    struct FakeCtl {
        engaged: bool,
    }
    impl WakeController for FakeCtl {
        fn engage(&mut self, _r: &str) -> io::Result<()> {
            self.engaged = true;
            Ok(())
        }
        fn release(&mut self) {
            self.engaged = false;
        }
        fn is_engaged(&self) -> bool {
            self.engaged
        }
        fn lid_capability(&self) -> LidCapability {
            LidCapability::IdleOnly
        }
    }

    #[test]
    fn starts_and_stops_cleanly() {
        let mut rt = Runtime::start_with(
            KeepAwake::WhileAgentsWork,
            Guards::default(),
            Box::<FakeCtl>::default(),
        )
        .unwrap();
        // No process-tracked agent working (Claude is hook-tracked, not counted
        // by the scan) → the initial synchronous tick leaves the engine idle.
        assert_eq!(rt.status(), Status::Idle);
        rt.stop();
    }

    #[test]
    fn always_mode_holds_then_releases_on_stop() {
        let mut rt = Runtime::start_with(
            KeepAwake::Always,
            Guards::default(),
            Box::<FakeCtl>::default(),
        )
        .unwrap();
        // The initial synchronous tick holds immediately in Always mode.
        assert_eq!(rt.status(), Status::Awake);
        rt.stop();
        assert_eq!(rt.status(), Status::Idle); // released on stop
    }
}
