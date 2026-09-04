//! Guardrails — the pure policy that decides whether ajar is ALLOWED to hold
//! the wake lock right now, independent of whether an agent wants it.
//!
//! The OS-reading (battery %, AC state, thermal pressure, Low Power Mode) lives
//! in the platform/UI layer; this module is the deterministic decision so it is
//! trivially testable and identical on every OS.

/// Live power/thermal inputs sampled by the platform layer.
#[derive(Clone, Copy, Debug)]
pub struct Power {
    /// Battery charge, 0.0–1.0.
    pub battery: f32,
    /// On external (AC) power.
    pub on_ac: bool,
    /// macOS/OS "Low Power Mode" is on.
    pub low_power_mode: bool,
    /// Thermal pressure has reached a level ajar should back off at.
    pub thermal_hot: bool,
}

/// User-configured guardrails (the Power & Display tab).
#[derive(Clone, Copy, Debug)]
pub struct Guards {
    /// Release the hold once battery drops below this fraction (0.0–1.0).
    pub battery_cutoff: f32,
    /// Only ever hold while plugged into AC.
    pub plugged_in_only: bool,
    /// Release the hold when the OS is in Low Power Mode.
    pub respect_low_power_mode: bool,
    /// Release the hold when the machine runs hot (re-engages once it cools).
    pub release_when_hot: bool,
}

impl Default for Guards {
    fn default() -> Self {
        Self {
            battery_cutoff: 0.25,
            plugged_in_only: false,
            respect_low_power_mode: true,
            release_when_hot: true,
        }
    }
}

/// Why the wake lock is being held back — surfaced in the UI + notifications.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Blocked {
    BatteryLow,
    OnBattery,
    LowPowerMode,
    Thermal,
}

impl Blocked {
    pub fn reason(self) -> &'static str {
        match self {
            Blocked::BatteryLow => "battery below cutoff",
            Blocked::OnBattery => "on battery (plugged-in-only mode)",
            Blocked::LowPowerMode => "Low Power Mode",
            Blocked::Thermal => "running hot — cooling down",
        }
    }
}

impl Guards {
    /// The first guard that forbids holding, or `None` when holding is allowed.
    /// Order matters only for which reason we report; all are hard blocks.
    pub fn block(&self, power: Power) -> Option<Blocked> {
        if self.plugged_in_only && !power.on_ac {
            return Some(Blocked::OnBattery);
        }
        // The battery cutoff only applies on battery — AC power can't drain past it.
        if !power.on_ac && power.battery < self.battery_cutoff {
            return Some(Blocked::BatteryLow);
        }
        if self.respect_low_power_mode && power.low_power_mode {
            return Some(Blocked::LowPowerMode);
        }
        if self.release_when_hot && power.thermal_hot {
            return Some(Blocked::Thermal);
        }
        None
    }

    /// Whether holding is allowed under the current power/thermal state.
    pub fn allows(&self, power: Power) -> bool {
        self.block(power).is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ac() -> Power {
        Power {
            battery: 1.0,
            on_ac: true,
            low_power_mode: false,
            thermal_hot: false,
        }
    }

    #[test]
    fn ac_power_ignores_battery_cutoff() {
        let g = Guards::default();
        let mut p = ac();
        p.battery = 0.05; // well below cutoff, but on AC — allowed.
        assert!(g.allows(p));
    }

    #[test]
    fn low_battery_on_battery_blocks() {
        let g = Guards::default();
        let p = Power {
            battery: 0.10,
            on_ac: false,
            ..ac()
        };
        assert_eq!(g.block(p), Some(Blocked::BatteryLow));
    }

    #[test]
    fn plugged_in_only_blocks_on_battery() {
        let g = Guards {
            plugged_in_only: true,
            ..Guards::default()
        };
        let p = Power {
            on_ac: false,
            ..ac()
        };
        assert_eq!(g.block(p), Some(Blocked::OnBattery));
    }

    #[test]
    fn thermal_hot_blocks_even_on_ac() {
        let g = Guards::default();
        let p = Power {
            thermal_hot: true,
            ..ac()
        };
        assert_eq!(g.block(p), Some(Blocked::Thermal));
    }
}
