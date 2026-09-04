//! The engine: given who's working + what the guardrails allow, decide whether
//! to hold the wake lock, and drive the platform [`WakeController`] accordingly.
//!
//! This is the whole "agent-aware auto-sleep" behavior in one testable place —
//! it owns no OS calls itself; the UI layer feeds it agent + power samples and
//! it flips the controller.

use crate::guard::{Blocked, Guards, Power};
use crate::wake::WakeController;

/// When ajar should keep the machine awake.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeepAwake {
    /// Hold only while a watched agent is actively working (auto-sleeps on idle).
    WhileAgentsWork,
    /// Hold unconditionally (still subject to the guardrails).
    Always,
}

/// What the engine resolved to on the last tick — drives the UI + notifications.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    /// Holding the wake lock.
    Awake,
    /// Idle by design — no agent working (in `WhileAgentsWork`).
    Idle,
    /// Wanted to hold, but a guardrail forbids it.
    Blocked(Blocked),
}

/// The wake engine. Feed it `tick(...)` on each sample.
pub struct Engine {
    controller: Box<dyn WakeController>,
    mode: KeepAwake,
    guards: Guards,
    status: Status,
}

impl Engine {
    pub fn new(controller: Box<dyn WakeController>, mode: KeepAwake, guards: Guards) -> Self {
        Self {
            controller,
            mode,
            guards,
            status: Status::Idle,
        }
    }

    pub fn set_mode(&mut self, mode: KeepAwake) {
        self.mode = mode;
    }

    pub fn set_guards(&mut self, guards: Guards) {
        self.guards = guards;
    }

    pub fn status(&self) -> Status {
        self.status
    }

    pub fn is_awake(&self) -> bool {
        matches!(self.status, Status::Awake)
    }

    /// Re-evaluate and drive the controller.
    ///
    /// `agents_working` — count of watched agents currently WORKING (0 in
    /// `WhileAgentsWork` means "let it sleep"). `power` — the latest sample.
    ///
    /// Returns the resolved [`Status`] (also stored). The controller is only
    /// touched on an actual transition, so `tick` is cheap to call on a timer.
    pub fn tick(&mut self, agents_working: usize, power: Power) -> Status {
        let wants_hold = match self.mode {
            KeepAwake::Always => true,
            KeepAwake::WhileAgentsWork => agents_working > 0,
        };

        let next = if !wants_hold {
            Status::Idle
        } else if let Some(blocked) = self.guards.block(power) {
            // A guardrail overrides the desire to hold — always, on top of the
            // engage conditions (matches the Hold My Lid safety model).
            Status::Blocked(blocked)
        } else {
            Status::Awake
        };

        // Drive the controller only across the awake boundary.
        let was_awake = matches!(self.status, Status::Awake);
        let now_awake = matches!(next, Status::Awake);
        if now_awake && !was_awake {
            let _ = self.controller.engage("ajar: agent working");
        } else if !now_awake && was_awake {
            self.controller.release();
        }

        self.status = next;
        next
    }

    /// Force-release the wake hold and go idle, regardless of mode — used on
    /// shutdown so stopping ajar always lets the machine sleep again (in
    /// `Always` mode a `tick(0)` would keep holding).
    pub fn shutdown(&mut self) {
        if matches!(self.status, Status::Awake) {
            self.controller.release();
        }
        self.status = Status::Idle;
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Never strand the machine awake if ajar goes away.
        self.controller.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wake::{LidCapability, WakeController};
    use std::io;

    #[derive(Default)]
    struct FakeCtl {
        engaged: bool,
        engage_calls: u32,
        release_calls: u32,
    }
    impl WakeController for FakeCtl {
        fn engage(&mut self, _r: &str) -> io::Result<()> {
            if !self.engaged {
                self.engage_calls += 1;
            }
            self.engaged = true;
            Ok(())
        }
        fn release(&mut self) {
            if self.engaged {
                self.release_calls += 1;
            }
            self.engaged = false;
        }
        fn is_engaged(&self) -> bool {
            self.engaged
        }
        fn lid_capability(&self) -> LidCapability {
            LidCapability::IdleOnly
        }
    }

    fn ac() -> Power {
        Power {
            battery: 1.0,
            on_ac: true,
            low_power_mode: false,
            thermal_hot: false,
        }
    }

    #[test]
    fn holds_only_while_an_agent_works() {
        let mut e = Engine::new(
            Box::<FakeCtl>::default(),
            KeepAwake::WhileAgentsWork,
            Guards::default(),
        );
        assert_eq!(e.tick(0, ac()), Status::Idle);
        assert_eq!(e.tick(1, ac()), Status::Awake);
        assert_eq!(e.tick(3, ac()), Status::Awake); // still one hold, no re-engage
        assert_eq!(e.tick(0, ac()), Status::Idle); // auto-sleep when agents finish
    }

    #[test]
    fn guardrail_overrides_the_hold() {
        let mut e = Engine::new(
            Box::<FakeCtl>::default(),
            KeepAwake::WhileAgentsWork,
            Guards::default(),
        );
        let hot = Power {
            thermal_hot: true,
            ..ac()
        };
        assert_eq!(e.tick(1, hot), Status::Blocked(Blocked::Thermal));
        assert!(!e.is_awake());
        // Cools down → re-engages.
        assert_eq!(e.tick(1, ac()), Status::Awake);
    }

    #[test]
    fn always_mode_still_respects_guards() {
        let mut e = Engine::new(
            Box::<FakeCtl>::default(),
            KeepAwake::Always,
            Guards::default(),
        );
        assert_eq!(e.tick(0, ac()), Status::Awake); // holds with zero agents
        let on_batt_low = Power {
            battery: 0.05,
            on_ac: false,
            ..ac()
        };
        assert_eq!(e.tick(0, on_batt_low), Status::Blocked(Blocked::BatteryLow));
    }
}
