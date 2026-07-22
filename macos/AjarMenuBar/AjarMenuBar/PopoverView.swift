import SwiftUI

/// The menu-bar dropdown. A header with the lid mark + a live status pill, the
/// keep-awake mode picker, a power card, and the list of agents keeping the
/// machine awake right now. Reads flow from the @Observable model; writes go
/// through the model's command methods.
struct PopoverView: View {
    let model: StatusViewModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.border)
            content
            Spacer(minLength: 0)
            footer
        }
        .frame(width: 320, height: 380)
        .background(Theme.background)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            LidGlyph(awake: model.status.state == .awake)
                .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text("Ajar")
                    .font(.brandHeadline)
                    .foregroundStyle(Theme.text)
                Text("keeps AI working, lid closed")
                    .font(.brandCaption)
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer()
            statusPill
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.surface)
    }

    private var statusPill: some View {
        let (label, color) = pillStyle
        return Text(label)
            .font(.brandCaption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
    }

    private var pillStyle: (String, Color) {
        switch model.status.state {
        case .awake:   return ("Awake", Theme.green)
        case .idle:    return ("Idle", Theme.textMuted)
        case .blocked: return ("Blocked", Theme.yellow)
        }
    }

    // MARK: Content

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            modePicker
            powerCard
            agentsCard
        }
        .padding(14)
    }

    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("KEEP AWAKE")
            Picker(
                "",
                selection: Binding(get: { model.mode }, set: { model.setMode($0) })
            ) {
                Text("While agents work").tag(StatusViewModel.Mode.whileAgentsWork)
                Text("Always").tag(StatusViewModel.Mode.always)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private var powerCard: some View {
        HStack(spacing: 10) {
            Image(systemName: model.onAC ? "powerplug.fill" : "battery.75")
                .foregroundStyle(Theme.purple)
            VStack(alignment: .leading, spacing: 2) {
                Text(powerLine)
                    .font(.brandBody)
                    .foregroundStyle(Theme.text)
                if model.status.state == .blocked, !model.status.reason.isEmpty {
                    Text(model.status.reason)
                        .font(.brandCaption)
                        .foregroundStyle(Theme.yellow)
                }
            }
            Spacer()
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
    }

    private var powerLine: String {
        let pct = Int((model.battery * 100).rounded())
        return model.onAC ? "Plugged in · \(pct)%" : "On battery · \(pct)%"
    }

    private var agentsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("WORKING NOW")
            if model.status.agents.isEmpty {
                Text("No agents working — the Mac may sleep.")
                    .font(.brandCaption)
                    .foregroundStyle(Theme.textMuted)
            } else {
                ForEach(model.status.agents, id: \.self) { label in
                    HStack(spacing: 8) {
                        Circle().fill(Theme.green).frame(width: 6, height: 6)
                        Text(label)
                            .font(.brandBody)
                            .foregroundStyle(Theme.text)
                        Spacer()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 10))
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.brandCaption.weight(.semibold))
            .foregroundStyle(Theme.textDim)
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            Text("v0.1.0")
                .font(.brandCaption)
                .foregroundStyle(Theme.textDim)
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain)
                .font(.brandCaption)
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Theme.surface)
    }
}
