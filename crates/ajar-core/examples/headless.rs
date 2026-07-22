//! Headless ajar — start the runtime and print status on a timer. Proves the
//! whole system works end-to-end (process/hook agent-detection → wake hold →
//! status) without any GUI. The native tray shells (M3) drive the same
//! `Runtime`; this is the reference driver + a real, usable no-UI mode.
//!
//! Run: `cargo run -p ajar-core --example headless`

use ajar_core::{Guards, KeepAwake, Runtime};
use std::time::Duration;

fn main() {
    let rt = Runtime::start(KeepAwake::WhileAgentsWork, Guards::default())
        .expect("failed to start ajar runtime");
    println!(
        "ajar (headless) — holding the wake lock only while a watched agent works. Ctrl-C to quit.\n"
    );
    loop {
        let working: Vec<&str> = rt.working_agents().iter().map(|a| a.label()).collect();
        println!("  {:?} · working: {working:?}", rt.status());
        std::thread::sleep(Duration::from_secs(5));
    }
}
