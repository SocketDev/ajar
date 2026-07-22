import AppKit
import SwiftUI

/// The ajar mark: a side-view laptop with the lid held open ("ajar"). Drawn
/// once as straight-line coordinates in a 24×24 viewBox, rendered two ways —
/// a purple SwiftUI view for the popover header, and a template NSImage for
/// the menu-bar status item (filled when awake, outlined when idle).
enum LidShape {
    /// Keyboard deck — a shallow trapezoid, wider along the top edge.
    static let deck: [(CGFloat, CGFloat)] = [(3, 16.5), (21, 16.5), (18.5, 20), (5.5, 20)]
    /// Screen — a parallelogram rising from the deck's hinge, leaning open.
    static let lid: [(CGFloat, CGFloat)] = [(6, 16.5), (11, 16.5), (15.5, 4), (10.5, 4)]
}

struct LidGlyph: View {
    var awake: Bool = true

    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height) / 24
            let shading = GraphicsContext.Shading.linearGradient(
                Gradient(colors: [Theme.purpleSoft, Theme.purple]),
                startPoint: .zero,
                endPoint: CGPoint(x: size.width, y: size.height)
            )
            let deck = Self.path(LidShape.deck, scale: s)
            let lid = Self.path(LidShape.lid, scale: s)
            if awake {
                ctx.fill(deck, with: shading)
                ctx.fill(lid, with: shading)
            } else {
                ctx.stroke(deck, with: shading, lineWidth: 1.6)
                ctx.stroke(lid, with: shading, lineWidth: 1.6)
            }
        }
    }

    private static func path(_ points: [(CGFloat, CGFloat)], scale s: CGFloat) -> Path {
        var p = Path()
        for (i, c) in points.enumerated() {
            let q = CGPoint(x: c.0 * s, y: c.1 * s)
            if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
        }
        p.closeSubpath()
        return p
    }

    /// Template NSImage for the menu-bar status item. Pure black + alpha so the
    /// menu bar handles dark/light tinting; the caller sets `isTemplate = true`.
    static func statusImage(awake: Bool) -> NSImage {
        let size = NSSize(width: 20, height: 20)
        let image = NSImage(size: size)
        image.lockFocus()
        defer { image.unlockFocus() }

        NSColor.black.set()
        let deck = bezier(LidShape.deck, in: size)
        let lid = bezier(LidShape.lid, in: size)
        if awake {
            deck.fill()
            lid.fill()
        } else {
            deck.lineWidth = 1.4
            lid.lineWidth = 1.4
            deck.stroke()
            lid.stroke()
        }
        return image
    }

    private static func bezier(_ points: [(CGFloat, CGFloat)], in size: NSSize) -> NSBezierPath {
        let s = min(size.width, size.height) / 24.0
        let xOff = (size.width - 24 * s) / 2
        let yOff = (size.height - 24 * s) / 2
        // The shape is authored top-left (SVG); NSBezierPath is bottom-left —
        // flip y around the icon height.
        func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: xOff + x * s, y: size.height - (yOff + y * s))
        }
        let p = NSBezierPath()
        for (i, c) in points.enumerated() {
            let q = pt(c.0, c.1)
            if i == 0 { p.move(to: q) } else { p.line(to: q) }
        }
        p.close()
        return p
    }
}
