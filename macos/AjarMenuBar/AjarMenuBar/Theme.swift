import AppKit
import SwiftUI

/// Socket brand tokens. Each color is defined with both a light and dark
/// variant; macOS picks the right one automatically based on the user's
/// appearance setting. Single source of truth — mirrors depsight's Theme and
/// socket-wheelhouse/docs/design/themes.md.
enum Theme {
    // MARK: Surfaces
    /// Outermost background of the popover.
    static let background = dual(light: 0xF7F8FA, dark: 0x0B0F1A)
    /// Header / footer bar; cards.
    static let surface    = dual(light: 0xFFFFFF, dark: 0x1A1F2E)
    /// Nested cards, chip backgrounds.
    static let surfaceAlt = dual(light: 0xF1F3F7, dark: 0x141927)
    /// 1px dividers and faint borders.
    static let border     = dual(light: 0xE2E8F0, dark: 0x2A3142)

    // MARK: Brand
    // socketeer neo-purple accent (never the AI-default indigo); the soft violet
    // is the secondary affordance.
    static let purple     = dual(light: 0x8B34E6, dark: 0xB24BFF)
    static let purpleSoft = dual(light: 0x7C5CFF, dark: 0xA98BFF)
    static let purpleDim  = dual(light: 0xC7B8F2, dark: 0x4C2D9C)

    // MARK: Text
    static let text       = dual(light: 0x0F172A, dark: 0xF5F7FA)
    static let textMuted  = dual(light: 0x475569, dark: 0x9AA3B5)
    static let textDim    = dual(light: 0x94A3B8, dark: 0x5A6377)

    // MARK: Status
    static let red    = dual(light: 0xDC2626, dark: 0xE55858)
    static let yellow = dual(light: 0xCA8A04, dark: 0xE0B040)
    static let green  = dual(light: 0x16A34A, dark: 0x3FB360)

    // MARK: Dual builders

    private static func dual(light: UInt32, dark: UInt32) -> Color {
        dualColor(light: NSColor(hex: light), dark: NSColor(hex: dark))
    }

    /// Wraps an NSColor that resolves per-appearance into a SwiftUI Color.
    private static func dualColor(light: NSColor, dark: NSColor) -> Color {
        let dynamic = NSColor(name: nil) { appearance in
            switch appearance.bestMatch(from: [.aqua, .darkAqua]) {
            case .darkAqua: return dark
            default:        return light
            }
        }
        return Color(nsColor: dynamic)
    }
}

private extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1.0) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green:   CGFloat((hex >>  8) & 0xFF) / 255.0,
            blue:    CGFloat( hex        & 0xFF) / 255.0,
            alpha:   alpha
        )
    }
}

// MARK: - Typography

extension Font {
    /// SF Pro is visually near-identical to Inter at popover sizes and ships
    /// with the OS, so nothing is bundled.
    static func brand(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static var brandHeadline: Font { brand(13, weight: .semibold) }
    static var brandBody:     Font { brand(12, weight: .regular) }
    static var brandCaption:  Font { brand(11, weight: .regular) }
}
