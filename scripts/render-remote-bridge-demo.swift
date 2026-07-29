#!/usr/bin/env swift

import AppKit
import CoreText
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: render-remote-bridge-demo.swift <output-directory>\n", stderr)
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

let fps = 30
let totalFrames = 1_320
let duration = 44.0

let env = ProcessInfo.processInfo.environment
let renderScale = max(1, min(2, Int(env["OE_RENDER_SCALE"] ?? "") ?? 2))
let showGuides = env["OE_RENDER_GUIDES"] == "1"
let canvasWidth = 1280 * renderScale
let canvasHeight = 720 * renderScale
let requestedFrames = env["OE_RENDER_FRAMES"]?
    .split(separator: ",")
    .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
    .filter { $0 >= 0 && $0 < totalFrames }
let firstFrame = max(0, Int(env["OE_RENDER_START_FRAME"] ?? "") ?? 0)
let endFrame = min(totalFrames, Int(env["OE_RENDER_END_FRAME"] ?? "") ?? totalFrames)
let framesToRender = requestedFrames ?? Array(firstFrame..<endFrame)

guard !framesToRender.isEmpty else {
    fputs("No valid frames requested\n", stderr)
    exit(2)
}

let white = NSColor(calibratedRed: 0.945, green: 0.937, blue: 0.914, alpha: 1)
let text = NSColor(calibratedRed: 0.82, green: 0.82, blue: 0.84, alpha: 1)
let muted = NSColor(calibratedRed: 0.60, green: 0.61, blue: 0.65, alpha: 1)
let dim = NSColor(calibratedRed: 0.36, green: 0.37, blue: 0.41, alpha: 1)
let background = NSColor(calibratedRed: 0.055, green: 0.059, blue: 0.071, alpha: 1)
let windowSurface = NSColor(calibratedRed: 0.090, green: 0.094, blue: 0.110, alpha: 1)
let titlebar = NSColor(calibratedRed: 0.114, green: 0.122, blue: 0.141, alpha: 1)
let sidebar = NSColor(calibratedRed: 0.071, green: 0.075, blue: 0.094, alpha: 1)
let editor = NSColor(calibratedRed: 0.090, green: 0.094, blue: 0.110, alpha: 1)
let elevated = NSColor(calibratedRed: 0.135, green: 0.141, blue: 0.165, alpha: 1)
let purple = NSColor(calibratedRed: 0.655, green: 0.545, blue: 0.980, alpha: 1)
let cyan = NSColor(calibratedRed: 0.408, green: 0.776, blue: 0.847, alpha: 1)
let green = NSColor(calibratedRed: 0.365, green: 0.808, blue: 0.596, alpha: 1)
let amber = NSColor(calibratedRed: 0.871, green: 0.682, blue: 0.349, alpha: 1)
let red = NSColor(calibratedRed: 0.929, green: 0.420, blue: 0.451, alpha: 1)

let logicalWidth: CGFloat = 760
let logicalHeight: CGFloat = 460
let logicalTitlebar: CGFloat = 42

func clamp(_ value: Double) -> CGFloat {
    CGFloat(max(0, min(1, value)))
}

func progress(_ time: Double, _ start: Double, _ duration: Double) -> CGFloat {
    guard duration > 0 else { return time >= start ? 1 : 0 }
    return clamp((time - start) / duration)
}

func easeOutCubic(_ value: CGFloat) -> CGFloat {
    let x = max(0, min(1, value))
    return 1 - pow(1 - x, 3)
}

func easeInOutCubic(_ value: CGFloat) -> CGFloat {
    let x = max(0, min(1, value))
    return x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2
}

func lerp(_ a: CGFloat, _ b: CGFloat, _ amount: CGFloat) -> CGFloat {
    a + (b - a) * amount
}

func mixRect(_ a: NSRect, _ b: NSRect, _ amount: CGFloat) -> NSRect {
    NSRect(
        x: lerp(a.origin.x, b.origin.x, amount),
        y: lerp(a.origin.y, b.origin.y, amount),
        width: lerp(a.width, b.width, amount),
        height: lerp(a.height, b.height, amount)
    )
}

func pointBetween(_ a: NSPoint, _ b: NSPoint, _ amount: CGFloat) -> NSPoint {
    NSPoint(x: lerp(a.x, b.x, amount), y: lerp(a.y, b.y, amount))
}

func withAlpha(_ alpha: CGFloat, draw: () -> Void) {
    guard alpha > 0.001, let context = NSGraphicsContext.current?.cgContext else { return }
    context.saveGState()
    context.setAlpha(max(0, min(1, alpha)))
    draw()
    context.restoreGState()
}

func sequentialFade(
    time: Double,
    start: Double,
    duration: Double,
    outgoing: () -> Void,
    incoming: () -> Void
) {
    let amount = progress(time, start, duration)
    // Keep a tiny visual floor at the hand-off frame. This prevents a one-frame
    // blink to an entirely empty surface without making old and new text overlap.
    let handoffFloor: CGFloat = 0.035
    if amount < 0.5 {
        let alpha = max(handoffFloor, 1 - easeInOutCubic(amount * 2))
        withAlpha(alpha, draw: outgoing)
    } else {
        let alpha = max(handoffFloor, easeInOutCubic((amount - 0.5) * 2))
        withAlpha(alpha, draw: incoming)
    }
}

func rounded(
    _ rect: NSRect,
    radius: CGFloat,
    fill: NSColor,
    stroke: NSColor? = nil,
    lineWidth: CGFloat = 1
) {
    let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    fill.setFill()
    path.fill()
    if let stroke {
        path.lineWidth = lineWidth
        stroke.setStroke()
        path.stroke()
    }
}

func circle(
    _ center: NSPoint,
    radius: CGFloat,
    fill: NSColor,
    stroke: NSColor? = nil,
    lineWidth: CGFloat = 1
) {
    let path = NSBezierPath(
        ovalIn: NSRect(
            x: center.x - radius,
            y: center.y - radius,
            width: radius * 2,
            height: radius * 2
        )
    )
    fill.setFill()
    path.fill()
    if let stroke {
        path.lineWidth = lineWidth
        stroke.setStroke()
        path.stroke()
    }
}

func line(
    _ start: NSPoint,
    _ end: NSPoint,
    color: NSColor,
    lineWidth: CGFloat = 2,
    amount: CGFloat = 1,
    dashed: Bool = false,
    dashPhase: CGFloat = 0
) {
    let path = NSBezierPath()
    path.move(to: start)
    path.line(to: pointBetween(start, end, amount))
    path.lineWidth = lineWidth
    path.lineCapStyle = .round
    if dashed {
        var pattern: [CGFloat] = [8, 8]
        path.setLineDash(&pattern, count: pattern.count, phase: dashPhase)
    }
    color.setStroke()
    path.stroke()
}

func systemFont(size: CGFloat, weight: NSFont.Weight, mono: Bool) -> NSFont {
    mono
        ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
        : NSFont.systemFont(ofSize: size, weight: weight)
}

func drawText(
    _ value: String,
    x: CGFloat,
    baseline: CGFloat,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = text,
    mono: Bool = false
) {
    guard let context = NSGraphicsContext.current?.cgContext else { return }
    let attributed = NSAttributedString(
        string: value,
        attributes: [
            .font: systemFont(size: size, weight: weight, mono: mono),
            .foregroundColor: color,
        ]
    )
    let ctLine = CTLineCreateWithAttributedString(attributed)
    context.saveGState()
    context.textMatrix = .identity
    context.textPosition = CGPoint(x: x, y: baseline)
    CTLineDraw(ctLine, context)
    context.restoreGState()
}

func textWidth(
    _ value: String,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    mono: Bool = false
) -> CGFloat {
    let attributed = NSAttributedString(
        string: value,
        attributes: [.font: systemFont(size: size, weight: weight, mono: mono)]
    )
    return CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(attributed), nil, nil, nil))
}

func drawCentered(
    _ value: String,
    center: NSPoint,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = text,
    mono: Bool = false
) {
    let font = systemFont(size: size, weight: weight, mono: mono)
    let width = textWidth(value, size: size, weight: weight, mono: mono)
    let baseline = center.y - (font.ascender + font.descender) / 2
    drawText(
        value,
        x: center.x - width / 2,
        baseline: baseline,
        size: size,
        weight: weight,
        color: color,
        mono: mono
    )
}

func drawTextVerticallyCentered(
    _ value: String,
    x: CGFloat,
    rect: NSRect,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = text,
    mono: Bool = false
) {
    let font = systemFont(size: size, weight: weight, mono: mono)
    let baseline = rect.midY - (font.ascender + font.descender) / 2
    drawText(
        value,
        x: x,
        baseline: baseline,
        size: size,
        weight: weight,
        color: color,
        mono: mono
    )
}

func drawParagraph(
    _ value: String,
    rect: NSRect,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = text,
    lineHeight: CGFloat? = nil,
    mono: Bool = false
) {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    if let lineHeight {
        style.minimumLineHeight = lineHeight
        style.maximumLineHeight = lineHeight
    }
    value.draw(
        in: rect,
        withAttributes: [
            .font: systemFont(size: size, weight: weight, mono: mono),
            .foregroundColor: color,
            .paragraphStyle: style,
        ]
    )
}

func pill(
    _ value: String,
    rect: NSRect,
    color: NSColor,
    fillAlpha: CGFloat = 0.12,
    mono: Bool = true
) {
    rounded(
        rect,
        radius: rect.height / 2,
        fill: color.withAlphaComponent(fillAlpha),
        stroke: color.withAlphaComponent(0.45),
        lineWidth: 1.2
    )
    drawCentered(
        value,
        center: NSPoint(x: rect.midX, y: rect.midY),
        size: 12,
        weight: .bold,
        color: color,
        mono: mono
    )
}

func check(center: NSPoint, radius: CGFloat, color: NSColor, amount: CGFloat) {
    circle(
        center,
        radius: radius,
        fill: color.withAlphaComponent(0.12),
        stroke: color.withAlphaComponent(0.85),
        lineWidth: 1.5
    )
    let path = NSBezierPath()
    let a = NSPoint(x: center.x - radius * 0.43, y: center.y)
    let b = NSPoint(x: center.x - radius * 0.10, y: center.y - radius * 0.34)
    let c = NSPoint(x: center.x + radius * 0.48, y: center.y + radius * 0.38)
    path.move(to: a)
    if amount < 0.42 {
        path.line(to: pointBetween(a, b, amount / 0.42))
    } else {
        path.line(to: b)
        path.line(to: pointBetween(b, c, (amount - 0.42) / 0.58))
    }
    path.lineWidth = 2
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    color.setStroke()
    path.stroke()
}

func drawCrystal(center: NSPoint, size: CGFloat, color: NSColor) {
    let top = NSPoint(x: center.x, y: center.y + size * 0.56)
    let left = NSPoint(x: center.x - size * 0.40, y: center.y + size * 0.10)
    let bottom = NSPoint(x: center.x, y: center.y - size * 0.58)
    let right = NSPoint(x: center.x + size * 0.40, y: center.y + size * 0.10)
    let path = NSBezierPath()
    path.move(to: top)
    path.line(to: left)
    path.line(to: bottom)
    path.line(to: right)
    path.close()
    color.withAlphaComponent(0.16).setFill()
    path.fill()
    path.lineWidth = 1.7
    color.setStroke()
    path.stroke()
    line(top, bottom, color: color.withAlphaComponent(0.48), lineWidth: 1.2)
    line(left, right, color: color.withAlphaComponent(0.48), lineWidth: 1.2)
    line(left, NSPoint(x: center.x, y: center.y + size * 0.10), color: color.withAlphaComponent(0.42), lineWidth: 1)
    line(right, NSPoint(x: center.x, y: center.y + size * 0.10), color: color.withAlphaComponent(0.42), lineWidth: 1)
}

func drawBackground(time: Double) {
    rounded(NSRect(x: 0, y: 0, width: 1280, height: 720), radius: 0, fill: background)
    rounded(NSRect(x: 0, y: 0, width: 1280, height: 54), radius: 0, fill: NSColor.black.withAlphaComponent(0.10))
    rounded(NSRect(x: 0, y: 676, width: 1280, height: 44), radius: 0, fill: NSColor.white.withAlphaComponent(0.008))
}

func drawWindowFrame(
    rect: NSRect,
    title: String,
    accent: NSColor,
    opacity: CGFloat,
    body: () -> Void
) {
    guard opacity > 0.001, let context = NSGraphicsContext.current?.cgContext else { return }
    context.saveGState()
    context.setAlpha(opacity)
    context.setShadow(
        offset: CGSize(width: 0, height: -12),
        blur: 28,
        color: NSColor.black.withAlphaComponent(0.42).cgColor
    )
    rounded(rect, radius: 17, fill: windowSurface)
    context.restoreGState()

    context.saveGState()
    context.setAlpha(opacity)
    context.beginTransparencyLayer(auxiliaryInfo: nil)
    context.saveGState()
    context.translateBy(x: rect.minX, y: rect.minY)
    context.scaleBy(x: rect.width / logicalWidth, y: rect.height / logicalHeight)
    let logicalRect = NSRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight)
    rounded(
        logicalRect,
        radius: 10,
        fill: windowSurface,
        stroke: white.withAlphaComponent(0.14),
        lineWidth: 1.2
    )
    rounded(
        NSRect(x: 0, y: logicalHeight - logicalTitlebar, width: logicalWidth, height: logicalTitlebar),
        radius: 17,
        fill: titlebar
    )
    rounded(
        NSRect(x: 0, y: logicalHeight - logicalTitlebar, width: logicalWidth, height: 18),
        radius: 0,
        fill: titlebar
    )
    circle(NSPoint(x: 23, y: 439), radius: 5, fill: red)
    circle(NSPoint(x: 42, y: 439), radius: 5, fill: amber)
    circle(NSPoint(x: 61, y: 439), radius: 5, fill: green)
    drawText(title, x: 86, baseline: 435, size: 11, weight: .semibold, color: muted, mono: true)
    rounded(NSRect(x: 728, y: 427, width: 12, height: 2), radius: 1, fill: accent.withAlphaComponent(0.82))
    rounded(
        NSRect(x: 0, y: logicalHeight - logicalTitlebar, width: logicalWidth, height: 1),
        radius: 0,
        fill: white.withAlphaComponent(0.07)
    )
    context.saveGState()
    context.clip(to: CGRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight - logicalTitlebar))
    body()
    context.restoreGState()
    context.restoreGState()
    context.endTransparencyLayer()
    context.restoreGState()
}

func drawObsidianSidebar(time: Double) {
    rounded(NSRect(x: 0, y: 0, width: 202, height: 418), radius: 0, fill: sidebar)
    rounded(NSRect(x: 0, y: 0, width: 46, height: 418), radius: 0, fill: background.withAlphaComponent(0.82))
    drawCrystal(center: NSPoint(x: 23, y: 380), size: 19, color: purple)
    for index in 0..<4 {
        circle(
            NSPoint(x: 23, y: 326 - CGFloat(index) * 46),
            radius: 8,
            fill: index == 0 ? purple.withAlphaComponent(0.20) : white.withAlphaComponent(0.05),
            stroke: index == 0 ? purple.withAlphaComponent(0.66) : muted.withAlphaComponent(0.28)
        )
    }
    drawText("FILES", x: 66, baseline: 388, size: 10, weight: .bold, color: muted, mono: true)
    let rows: [(String, CGFloat, CGFloat, Bool)] = [
        ("▾  Projects", 352, 0, true),
        ("▾  Lumen", 318, 16, true),
        ("Research", 284, 30, false),
        ("Interview Synthesis", 250, 30, false),
        ("Import Friction", 216, 30, false),
        ("▾  Experiments", 170, 0, true),
        ("Guided Import", 136, 16, false),
        ("Daily", 90, 0, false),
    ]
    for row in rows {
        let semanticPhase = time >= 6.5 && time < 12.62
        let graphPhase = time >= 12.62 && time < 23.12
        let selected: Bool
        if semanticPhase {
            if time < 9.4 {
                selected = row.0 == "Interview Synthesis"
            } else if time < 10.9 {
                selected = row.0 == "Import Friction"
            } else {
                selected = row.0 == "Guided Import"
            }
        } else if graphPhase {
            selected = row.0 == "Interview Synthesis"
        } else {
            selected = row.0 == "Research"
        }
        let rowTextX = 62 + row.2
        let rowRect = NSRect(x: rowTextX - 8, y: row.1 - 9, width: 208 - rowTextX, height: 24)
        if selected {
            rounded(
                rowRect,
                radius: 5,
                fill: purple.withAlphaComponent(0.13)
            )
            rounded(NSRect(x: rowRect.minX, y: rowRect.minY, width: 2, height: rowRect.height), radius: 1, fill: purple)
        }
        drawTextVerticallyCentered(
            row.0,
            x: rowTextX,
            rect: rowRect,
            size: row.3 ? 12 : 11,
            weight: row.3 || selected ? .semibold : .regular,
            color: selected ? white : row.3 ? text : muted
        )
    }
}

func drawEditorBase(newFindingAlpha: CGFloat = 0, highlight: CGFloat = 0) {
    rounded(NSRect(x: 202, y: 0, width: 558, height: 418), radius: 0, fill: editor)
    drawText("PROJECT LUMEN", x: 242, baseline: 373, size: 10, weight: .bold, color: purple, mono: true)
    drawText("Onboarding research", x: 242, baseline: 328, size: 28, weight: .bold, color: white)
    pill("research", rect: NSRect(x: 242, y: 279, width: 104, height: 30), color: cyan, mono: false)
    pill("onboarding", rect: NSRect(x: 358, y: 279, width: 120, height: 30), color: purple, mono: false)
    rounded(NSRect(x: 242, y: 256, width: 466, height: 1), radius: 0.5, fill: white.withAlphaComponent(0.08))
    drawText("Current evidence", x: 242, baseline: 221, size: 15, weight: .bold, color: text)
    let bodyRows = [
        "• Setup friction appears before first success.",
        "• Guided import improves activation.",
        "• Users often treat import as optional.",
    ]
    for (index, row) in bodyRows.enumerated() {
        drawText(row, x: 242, baseline: 185 - CGFloat(index) * 34, size: 13, color: muted)
    }
    if newFindingAlpha > 0.001 {
        withAlpha(newFindingAlpha) {
        rounded(
            NSRect(x: 230, y: 28, width: 490, height: 72),
            radius: 10,
            fill: green.withAlphaComponent(0.04 + 0.08 * highlight),
            stroke: green.withAlphaComponent(0.18 + 0.32 * highlight),
            lineWidth: 1.5
        )
        drawTextVerticallyCentered(
            "+  Findings",
            x: 250,
            rect: NSRect(x: 250, y: 64, width: 450, height: 26),
            size: 12,
            weight: .bold,
            color: green,
            mono: true
        )
        drawTextVerticallyCentered(
            "Interview 18 — Import looked optional, so participants postponed setup.",
            x: 250,
            rect: NSRect(x: 250, y: 38, width: 450, height: 26),
            size: 11,
            weight: .medium,
            color: text
        )
        }
    }
}

func drawEvidenceNote(time: Double) {
    rounded(NSRect(x: 202, y: 0, width: 558, height: 418), radius: 0, fill: editor)
    let sourceIndex = time < 9.4 ? 0 : time < 10.9 ? 1 : 2
    let sources = [
        ("INTERVIEW SYNTHESIS", "Activation interviews", "Participants were confused before their first success.", "Import looked optional, so setup was postponed."),
        ("IMPORT FRICTION", "Import setup friction", "Setup asked for too many decisions at once.", "Users left before reaching a meaningful outcome."),
        ("GUIDED IMPORT", "Experiment readout", "Activation improved after guided setup.", "Fewer choices helped users reach first value."),
    ]
    let source = sources[sourceIndex]
    drawText(source.0, x: 242, baseline: 373, size: 10, weight: .bold, color: purple, mono: true)
    drawText(source.1, x: 242, baseline: 328, size: 27, weight: .bold, color: white)
    rounded(NSRect(x: 242, y: 290, width: 450, height: 1), radius: 0.5, fill: white.withAlphaComponent(0.09))
    drawText(source.2, x: 242, baseline: 244, size: 14, weight: .medium, color: text)
    let highlightIn = easeOutCubic(progress(time, 6.78, 0.28))
    rounded(
        NSRect(x: 230, y: 146, width: 486, height: 62),
        radius: 6,
        fill: purple.withAlphaComponent(0.04 + 0.06 * highlightIn)
    )
    rounded(NSRect(x: 230, y: 146, width: 3, height: 62), radius: 1.5, fill: purple)
    drawTextVerticallyCentered(
        source.3,
        x: 250,
        rect: NSRect(x: 250, y: 156, width: 446, height: 42),
        size: 14,
        weight: .semibold,
        color: white
    )
    drawText("Local file · source remains on this machine", x: 242, baseline: 92, size: 11, color: muted, mono: true)
}

func drawGraphMode(time: Double) {
    rounded(NSRect(x: 0, y: 0, width: 760, height: 418), radius: 0, fill: editor)
    drawText("OBSIDIAN EVERYWHERE MCP · get_neighborhood · Interview Synthesis.md", x: 32, baseline: 383, size: 11, weight: .bold, color: purple, mono: true)
    drawText("7 linked notes · local graph", x: 584, baseline: 383, size: 10, weight: .semibold, color: muted)

    let nodes: [(NSPoint, String, Bool)] = [
        (NSPoint(x: 350, y: 220), "Interview Synthesis", true),
        (NSPoint(x: 132, y: 306), "Research Plan", false),
        (NSPoint(x: 156, y: 126), "Persona Notes", false),
        (NSPoint(x: 360, y: 338), "Lumen", true),
        (NSPoint(x: 548, y: 300), "Import Friction", true),
        (NSPoint(x: 584, y: 142), "Guided Import", true),
        (NSPoint(x: 362, y: 82), "Interview 18", false),
        (NSPoint(x: 694, y: 224), "Roadmap", true),
    ]
    let edges = [(0,1),(0,2),(0,3),(0,4),(0,6),(4,5),(4,7),(5,6),(5,7),(2,6)]
    let graphIn = easeOutCubic(progress(time, 12.68, 0.32))
    for (index, edge) in edges.enumerated() {
        let edgeIn = easeOutCubic(progress(time, 12.78 + Double(index) * 0.030, 0.28))
        let active = nodes[edge.0].2 && nodes[edge.1].2
        line(
            nodes[edge.0].0,
            nodes[edge.1].0,
            color: (active ? cyan : white).withAlphaComponent(active ? 0.72 : 0.12),
            lineWidth: active ? 2.2 : 1.2,
            amount: edgeIn * graphIn
        )
    }
    for (index, node) in nodes.enumerated() {
        let nodeIn = easeOutCubic(progress(time, 12.72 + Double(index) * 0.038, 0.24))
        withAlpha(min(1, nodeIn)) {
            circle(
                node.0,
                radius: (index == 0 ? 14 : node.2 ? 8 : 6) * (0.92 + 0.08 * nodeIn),
                fill: node.2 ? (index == 0 ? purple : cyan) : elevated,
                stroke: node.2 ? (index == 0 ? purple : cyan) : dim,
                lineWidth: node.2 ? 1.8 : 1.2
            )
            if node.2 {
                drawCentered(
                    node.1,
                    center: NSPoint(x: node.0.x, y: node.0.y - 24),
                    size: index == 0 ? 11 : 10,
                    weight: .semibold,
                    color: index == 0 ? white : muted
                )
            }
        }
    }
}

func drawFileBody(time: Double) {
    drawObsidianSidebar(time: time)
    if time >= 6.5 && time < 12.62 {
        drawEvidenceNote(time: time)
    } else {
        let findingIn = easeOutCubic(progress(time, 37.28, 0.28))
        let highlight = findingIn * (1 - easeInOutCubic(progress(time, 38.48, 1.2)))
        drawEditorBase(newFindingAlpha: findingIn, highlight: highlight)
    }
}

func drawObsidianWindow(rect: NSRect, time: Double, opacity: CGFloat) {
    drawWindowFrame(
        rect: rect,
        title: "LOCAL · PROJECT LUMEN",
        accent: purple,
        opacity: opacity
    ) {
        if time >= 12.74 && time < 13.0 {
            sequentialFade(
                time: time,
                start: 12.74,
                duration: 0.26,
                outgoing: { drawFileBody(time: 12.61) },
                incoming: { drawGraphMode(time: time) }
            )
        } else if time >= 13.0 && time < 23.24 {
            drawGraphMode(time: time)
        } else if time >= 23.24 && time < 23.50 {
            sequentialFade(
                time: time,
                start: 23.24,
                duration: 0.26,
                outgoing: { drawGraphMode(time: time) },
                incoming: { drawFileBody(time: time) }
            )
        } else if time >= 12.62 && time < 12.74 {
            drawFileBody(time: 12.61)
        } else {
            drawFileBody(time: time)
        }
    }
}

func terminalPrompt(time: Double) {
    drawText("›", x: 42, baseline: 348, size: 22, weight: .bold, color: cyan, mono: true)
    let question = "Why are trial users dropping before activation in Project Lumen?"
    let typing = progress(time, 3.15, 1.20)
    let visible = min(question.count, Int(CGFloat(question.count) * typing))
    drawText(String(question.prefix(visible)), x: 72, baseline: 349, size: 14, weight: .medium, color: white, mono: true)
    let callIn = easeOutCubic(progress(time, 4.65, 0.28))
    withAlpha(callIn) {
        rounded(
            NSRect(x: 42, y: 242, width: 330, height: 46),
            radius: 6,
            fill: purple.withAlphaComponent(0.12),
            stroke: purple.withAlphaComponent(0.42),
            lineWidth: 1.2
        )
        circle(NSPoint(x: 64, y: 265), radius: 4, fill: purple)
        drawTextVerticallyCentered(
            "obsidian-everywhere.semantic_search",
            x: 80,
            rect: NSRect(x: 80, y: 242, width: 274, height: 46),
            size: 12,
            weight: .bold,
            color: purple,
            mono: true
        )
    }
    let statusIn = easeOutCubic(progress(time, 4.98, 0.26))
    withAlpha(statusIn) {
        drawText("Searching the local index…", x: 42, baseline: 204, size: 12, color: muted, mono: true)
        drawText("request → HTTPS/MCP → local vault", x: 42, baseline: 168, size: 11, color: dim, mono: true)
    }
}

func terminalSearchStatus(time: Double) {
    drawText("obsidian-everywhere · semantic_search", x: 42, baseline: 371, size: 11, weight: .bold, color: purple, mono: true)
    let results: [(String, String, String, CGFloat)] = [
        ("Projects/Lumen/Interview Synthesis.md", "Activation interviews", "0.942", 292),
        ("Projects/Lumen/Import Friction.md", "Import setup friction", "0.891", 204),
        ("Experiments/Guided Import.md", "Guided import experiment", "0.844", 116),
    ]
    for (index, item) in results.enumerated() {
        let reveal = easeOutCubic(progress(time, 8.0 + Double(index) * 0.16, 0.28))
        withAlpha(reveal) {
            rounded(
                NSRect(x: 42 + 8 * (1 - reveal), y: item.3, width: 676, height: 72),
                radius: 6,
                fill: index == 0 ? purple.withAlphaComponent(0.10) : elevated.withAlphaComponent(0.48),
                stroke: index == 0 ? purple.withAlphaComponent(0.34) : white.withAlphaComponent(0.06),
                lineWidth: 1
            )
            circle(NSPoint(x: 64, y: item.3 + 40), radius: 4, fill: purple)
            drawTextVerticallyCentered(
                item.0,
                x: 80,
                rect: NSRect(x: 80, y: item.3 + 34, width: 575, height: 28),
                size: 11,
                weight: .semibold,
                color: white,
                mono: true
            )
            drawTextVerticallyCentered(
                item.1,
                x: 80,
                rect: NSRect(x: 80, y: item.3 + 10, width: 575, height: 24),
                size: 11,
                color: muted
            )
            drawTextVerticallyCentered(
                item.2,
                x: 675,
                rect: NSRect(x: 675, y: item.3, width: 35, height: 72),
                size: 11,
                weight: .bold,
                color: purple,
                mono: true
            )
        }
    }
    drawText("3 results · local embeddings · paths and titles returned", x: 42, baseline: 76, size: 11, color: muted, mono: true)
}

func terminalContext(time: Double) {
    drawText("obsidian-everywhere · get_context_bundle", x: 42, baseline: 371, size: 11, weight: .bold, color: cyan, mono: true)
    let paths = [
        "Projects/Lumen/Interview Synthesis.md",
        "Projects/Lumen/Import Friction.md",
        "Experiments/Guided Import.md",
    ]
    for (index, path) in paths.enumerated() {
        let reveal = easeOutCubic(progress(time, 12.96 + Double(index) * 0.14, 0.28))
        withAlpha(reveal) {
            let y = 300 - CGFloat(index) * 62
            rounded(
                NSRect(x: 42 + 16 * (1 - reveal), y: y, width: 676, height: 48),
                radius: 6,
                fill: cyan.withAlphaComponent(index == 0 ? 0.10 : 0.05),
                stroke: cyan.withAlphaComponent(index == 0 ? 0.32 : 0.16)
            )
            drawTextVerticallyCentered(
                "↳",
                x: 62,
                rect: NSRect(x: 62, y: y, width: 18, height: 48),
                size: 13,
                weight: .bold,
                color: cyan,
                mono: true
            )
            drawTextVerticallyCentered(
                path,
                x: 88,
                rect: NSRect(x: 88, y: y, width: 610, height: 48),
                size: 12,
                weight: .medium,
                color: text,
                mono: true
            )
        }
    }
    drawText("3 notes · 7 graph links · 3,742 tokens", x: 42, baseline: 102, size: 11, weight: .semibold, color: muted, mono: true)
    drawText("selected context returned over authenticated MCP", x: 42, baseline: 74, size: 10, color: dim, mono: true)
}

func terminalAnswer(time: Double) {
    drawText("ANSWER", x: 42, baseline: 371, size: 12, weight: .bold, color: cyan, mono: true)
    let answerIn = easeOutCubic(progress(time, 18.24, 0.30))
    withAlpha(answerIn) {
        drawParagraph(
            "They stall before first value. Import looks optional, and setup asks for too many decisions.",
            rect: NSRect(x: 42, y: 230, width: 664, height: 104),
            size: 20,
            weight: .semibold,
            color: white,
            lineHeight: 29
        )
    }
    let sourcesIn = easeOutCubic(progress(time, 18.82, 0.28))
    withAlpha(sourcesIn) {
        drawText("Sources", x: 42, baseline: 190, size: 10, weight: .bold, color: muted, mono: true)
        drawText("Projects/Lumen/Interview Synthesis.md", x: 42, baseline: 160, size: 11, weight: .semibold, color: purple, mono: true)
        drawText("“Confusion before first success”", x: 42, baseline: 136, size: 11, color: muted)
    }
    let toolIn = easeOutCubic(progress(time, 19.76, 0.28))
    withAlpha(toolIn) {
        drawText("Projects/Lumen/Import Friction.md", x: 42, baseline: 100, size: 11, weight: .semibold, color: purple, mono: true)
        drawText("“Setup required too many decisions”", x: 42, baseline: 76, size: 11, color: muted)
    }
}

func terminalWrite(time: Double) {
    let requestIn = easeOutCubic(progress(time, 23.18, 0.26))
    withAlpha(requestIn) {
        drawText("WRITE REQUEST · PERMISSION: ASK", x: 42, baseline: 371, size: 12, weight: .bold, color: purple, mono: true)
        drawText("›", x: 42, baseline: 338, size: 20, weight: .bold, color: cyan, mono: true)
        drawText("Append today’s interview finding under Research → Findings.", x: 72, baseline: 338, size: 13, weight: .medium, color: white, mono: true)
    }
    let previewIn = easeOutCubic(progress(time, 23.46, 0.28))
    withAlpha(previewIn) {
        rounded(
            NSRect(x: 42, y: 228, width: 676, height: 76),
            radius: 6,
            fill: purple.withAlphaComponent(0.09),
            stroke: purple.withAlphaComponent(0.30),
            lineWidth: 1.2
        )
        drawTextVerticallyCentered(
            "append_to_note",
            x: 62,
            rect: NSRect(x: 62, y: 266, width: 148, height: 28),
            size: 12,
            weight: .bold,
            color: purple,
            mono: true
        )
        drawTextVerticallyCentered(
            "Projects/Lumen/Research.md  ·  heading: Findings",
            x: 230,
            rect: NSRect(x: 230, y: 266, width: 468, height: 28),
            size: 11,
            color: muted,
            mono: true
        )
        drawTextVerticallyCentered(
            "+ Interview 18 — Import looked optional, so participants postponed setup.",
            x: 62,
            rect: NSRect(x: 62, y: 238, width: 636, height: 28),
            size: 12,
            weight: .medium,
            color: text,
            mono: true
        )
    }
    let permissionIn = easeOutCubic(progress(time, 23.76, 0.28))
    withAlpha(permissionIn) {
        drawText("Claude Code needs permission to use append_to_note.", x: 42, baseline: 184, size: 12, color: muted, mono: true)
        rounded(NSRect(x: 42, y: 108, width: 196, height: 42), radius: 6, fill: purple.withAlphaComponent(0.16), stroke: purple.withAlphaComponent(0.48))
        drawTextVerticallyCentered(
            "❯  Allow once",
            x: 62,
            rect: NSRect(x: 62, y: 108, width: 156, height: 42),
            size: 12,
            weight: .bold,
            color: white,
            mono: true
        )
        drawText("2  Always allow", x: 266, baseline: 124, size: 12, color: muted, mono: true)
        drawText("3  Deny", x: 430, baseline: 124, size: 12, color: muted, mono: true)
    }
}

func terminalBlocked(time: Double) {
    drawText("REMOTE WRITE", x: 42, baseline: 371, size: 12, weight: .bold, color: red, mono: true)
    rounded(
        NSRect(x: 42, y: 300, width: 676, height: 54),
        radius: 10,
        fill: purple.withAlphaComponent(0.10),
        stroke: purple.withAlphaComponent(0.34),
        lineWidth: 1.5
    )
    drawTextVerticallyCentered(
        "append_to_note",
        x: 66,
        rect: NSRect(x: 66, y: 300, width: 632, height: 54),
        size: 13,
        weight: .bold,
        color: purple,
        mono: true
    )
    let blockedIn = easeOutCubic(progress(time, 28.18, 0.26))
    withAlpha(min(1, blockedIn)) {
        rounded(
            NSRect(x: 42, y: 190, width: 676, height: 78),
            radius: 12,
            fill: red.withAlphaComponent(0.10),
            stroke: red.withAlphaComponent(0.44),
            lineWidth: 1.7
        )
        circle(NSPoint(x: 72, y: 229), radius: 11, fill: red.withAlphaComponent(0.16), stroke: red)
        drawCentered("!", center: NSPoint(x: 72, y: 229), size: 14, weight: .bold, color: red)
        drawTextVerticallyCentered(
            "Write blocked",
            x: 100,
            rect: NSRect(x: 100, y: 224, width: 598, height: 30),
            size: 15,
            weight: .bold,
            color: red
        )
        drawTextVerticallyCentered(
            "Vault mount unavailable. No changes were made.",
            x: 100,
            rect: NSRect(x: 100, y: 198, width: 598, height: 26),
            size: 12,
            color: muted,
            mono: true
        )
    }
    drawText("Index preserved · reads stale · writes disabled", x: 42, baseline: 130, size: 12, weight: .semibold, color: amber, mono: true)
}

func terminalRecovery(time: Double) {
    drawText("VAULT STATUS", x: 42, baseline: 371, size: 12, weight: .bold, color: amber, mono: true)
    let steps: [(String, Double)] = [
        ("sentinel verified", 31.70),
        ("117 notes reconciled", 32.80),
        ("index fresh · writes enabled", 34.15),
    ]
    for (index, step) in steps.enumerated() {
        let reveal = easeOutCubic(progress(time, step.1, 0.28))
        withAlpha(reveal) {
            let y = 300 - CGFloat(index) * 80
            check(center: NSPoint(x: 64, y: y + 8), radius: 12, color: index == 2 ? green : amber, amount: reveal)
            drawText(step.0, x: 92, baseline: y + 2, size: 14, weight: .semibold, color: text, mono: true)
        }
        if time >= step.1 - 0.25 && time < step.1 {
            let spin = CGFloat((time * 2.5).truncatingRemainder(dividingBy: 1))
            circle(NSPoint(x: 64, y: 308 - CGFloat(index) * 80), radius: 12 + 3 * spin, fill: NSColor.clear, stroke: amber.withAlphaComponent(1 - spin), lineWidth: 2)
        }
    }
}

func terminalRetry(time: Double) {
    let retryIn = easeOutCubic(progress(time, 35.34, 0.26))
    withAlpha(retryIn) {
        drawText("RETRY", x: 42, baseline: 371, size: 12, weight: .bold, color: green, mono: true)
        drawText("›", x: 42, baseline: 334, size: 20, weight: .bold, color: cyan, mono: true)
        drawText("Retry.", x: 72, baseline: 334, size: 14, weight: .medium, color: white, mono: true)
        drawText("User approved this retry", x: 42, baseline: 292, size: 13, weight: .semibold, color: green, mono: true)
    }
    let toolIn = easeOutCubic(progress(time, 35.66, 0.28))
    withAlpha(toolIn) {
        rounded(
            NSRect(x: 42, y: 220, width: 676, height: 54),
            radius: 6,
            fill: purple.withAlphaComponent(0.09),
            stroke: purple.withAlphaComponent(0.30)
        )
        drawTextVerticallyCentered(
            "append_to_note",
            x: 62,
            rect: NSRect(x: 62, y: 220, width: 260, height: 54),
            size: 12,
            weight: .bold,
            color: purple,
            mono: true
        )
        drawTextVerticallyCentered(
            "Projects/Lumen/Research.md · permission: approved",
            x: 342,
            rect: NSRect(x: 342, y: 220, width: 356, height: 54),
            size: 11,
            color: muted,
            mono: true
        )
    }
    let successIn = easeOutCubic(progress(time, 37.0, 0.28))
    withAlpha(successIn) {
        check(center: NSPoint(x: 62, y: 184), radius: 11, color: green, amount: successIn)
        drawText("Updated Projects/Lumen/Research.md · reindexed", x: 90, baseline: 178, size: 15, weight: .semibold, color: green, mono: true)
        drawText("The local editor now shows the committed line.", x: 90, baseline: 146, size: 13, color: muted, mono: true)
    }
}

func terminalReady() {
    drawText("›", x: 42, baseline: 328, size: 22, weight: .bold, color: cyan, mono: true)
    drawText("Ready for a remote vault request.", x: 72, baseline: 329, size: 15, color: muted, mono: true)
    drawText("MCP endpoint authenticated", x: 42, baseline: 250, size: 12, weight: .semibold, color: green, mono: true)
    drawText("Waiting for context…", x: 42, baseline: 214, size: 12, color: dim, mono: true)
}

func drawTerminalPhase(_ phase: Int, time: Double) {
    switch phase {
    case 0: terminalReady()
    case 1: terminalPrompt(time: time)
    case 2: terminalSearchStatus(time: time)
    case 3: terminalContext(time: time)
    case 4: terminalAnswer(time: time)
    case 5: terminalWrite(time: time)
    case 6: terminalBlocked(time: time)
    case 7: terminalRecovery(time: time)
    default: terminalRetry(time: time)
    }
}

func drawTerminalContent(time: Double) {
    let boundaries: [Double] = [3.12, 6.5, 12.62, 18.12, 23.12, 27.34, 31.34, 35.32]
    let phase = boundaries.filter { time >= $0 }.count
    if phase > 0 {
        let boundary = boundaries[phase - 1]
        if time < boundary + 0.24 {
            sequentialFade(
                time: time,
                start: boundary,
                duration: 0.24,
                outgoing: { drawTerminalPhase(phase - 1, time: time) },
                incoming: { drawTerminalPhase(phase, time: time) }
            )
            return
        }
    }
    drawTerminalPhase(phase, time: time)
}

func drawTerminalStatus(time: Double) {
    let onlineRect = NSRect(x: 608, y: 374, width: 124, height: 28)
    let reconcilingRect = NSRect(x: 590, y: 374, width: 142, height: 28)
    let readyRect = NSRect(x: 548, y: 374, width: 184, height: 28)
    let online = { pill("MCP ONLINE", rect: onlineRect, color: green) }
    let reconciling = { pill("RECONCILING", rect: reconcilingRect, color: amber) }
    let ready = { pill("MCP + VAULT READY", rect: readyRect, color: green) }
    let transition = {
        (
            fromValue: String,
            fromRect: NSRect,
            fromColor: NSColor,
            toValue: String,
            toRect: NSRect,
            toColor: NSColor,
            start: Double
        ) in
        let amount = easeInOutCubic(progress(time, start, 0.24))
        let rect = mixRect(fromRect, toRect, amount)
        let color = fromColor.blended(withFraction: amount, of: toColor) ?? toColor
        rounded(
            rect,
            radius: rect.height / 2,
            fill: color.withAlphaComponent(0.12),
            stroke: color.withAlphaComponent(0.45),
            lineWidth: 1.2
        )
        let labelProgress = progress(time, start, 0.24)
        let labelAlpha = 0.28 + 0.72 * abs(2 * labelProgress - 1)
        let labelValue = labelProgress < 0.5 ? fromValue : toValue
        let labelColor = labelProgress < 0.5 ? fromColor : toColor
        withAlpha(labelAlpha) {
            drawCentered(
                labelValue,
                center: NSPoint(x: rect.midX, y: rect.midY),
                size: 12,
                weight: .bold,
                color: labelColor,
                mono: true
            )
        }
    }

    if time >= 31.34 && time < 31.58 {
        transition("MCP ONLINE", onlineRect, green, "RECONCILING", reconcilingRect, amber, 31.34)
    } else if time >= 34.15 && time < 34.39 {
        transition("RECONCILING", reconcilingRect, amber, "MCP + VAULT READY", readyRect, green, 34.15)
    } else if time >= 34.15 {
        ready()
    } else if time >= 31.34 {
        reconciling()
    } else {
        online()
    }
}

func drawTerminalWindow(rect: NSRect, time: Double, opacity: CGFloat) {
    drawWindowFrame(
        rect: rect,
        title: "REMOTE · CLAUDE CODE",
        accent: cyan,
        opacity: opacity
    ) {
        rounded(NSRect(x: 0, y: 0, width: 760, height: 418), radius: 0, fill: windowSurface)
        drawTerminalStatus(time: time)
        drawTerminalContent(time: time)
    }
}

struct Layout {
    let obsidian: NSRect
    let terminal: NSRect
    let obsidianOpacity: CGFloat
    let terminalOpacity: CGFloat
}

let wideObs = NSRect(x: 24, y: 142, width: 720, height: 436)
let wideTerm = NSRect(x: 764, y: 170, width: 492, height: 298)
let terminalFocusObs = NSRect(x: 24, y: 238, width: 480, height: 291)
let terminalFocusTerm = NSRect(x: 526, y: 172, width: 730, height: 442)
let graphFocusObs = NSRect(x: 24, y: 166, width: 760, height: 460)
let graphFocusTerm = NSRect(x: 806, y: 244, width: 450, height: 272)
let answerSplitObs = NSRect(x: 24, y: 210, width: 520, height: 315)
let answerSplitTerm = NSRect(x: 566, y: 172, width: 690, height: 418)
let writeSplitObs = NSRect(x: 24, y: 226, width: 580, height: 351)
let writeSplitTerm = NSRect(x: 626, y: 208, width: 630, height: 382)
let successObs = NSRect(x: 24, y: 190, width: 660, height: 399)
let successTerm = NSRect(x: 706, y: 235, width: 550, height: 333)
let finalObs = NSRect(x: 82, y: 150, width: 500, height: 303)
let finalTerm = NSRect(x: 698, y: 170, width: 500, height: 303)

func validateGeometry() {
    let namedLayouts: [(String, NSRect, NSRect)] = [
        ("wide", wideObs, wideTerm),
        ("terminal focus", terminalFocusObs, terminalFocusTerm),
        ("graph focus", graphFocusObs, graphFocusTerm),
        ("answer split", answerSplitObs, answerSplitTerm),
        ("write split", writeSplitObs, writeSplitTerm),
        ("success", successObs, successTerm),
        ("final", finalObs, finalTerm),
    ]
    let targetAspect = logicalWidth / logicalHeight
    for (name, local, remote) in namedLayouts {
        for (side, rect) in [("local", local), ("remote", remote)] {
            precondition(rect.minX >= 16 && rect.maxX <= 1264, "\(name) \(side) exceeds horizontal safe area")
            precondition(rect.minY >= 54 && rect.maxY <= 640, "\(name) \(side) exceeds vertical safe area")
            precondition(abs(rect.width / rect.height - targetAspect) < 0.008, "\(name) \(side) distorts the window aspect")
        }
        precondition(!local.intersects(remote), "\(name) windows overlap")
    }

    let textFits: [(String, CGFloat, NSFont.Weight, CGFloat, Bool)] = [
        ("Interview Synthesis", 11, .semibold, 108, false),
        ("Import Friction", 11, .regular, 108, false),
        ("research", 12, .bold, 84, false),
        ("onboarding", 12, .bold, 100, false),
        ("+  Findings", 12, .bold, 450, true),
        ("Why are trial users dropping before activation in Project Lumen?", 14, .medium, 646, true),
        ("obsidian-everywhere.semantic_search", 12, .bold, 274, true),
        ("Projects/Lumen/Interview Synthesis.md", 11, .semibold, 560, true),
        ("Projects/Lumen/Import Friction.md", 11, .semibold, 560, true),
        ("Experiments/Guided Import.md", 11, .semibold, 560, true),
        ("Activation interviews", 11, .regular, 618, false),
        ("Guided import experiment", 11, .regular, 618, false),
        ("0.942", 11, .bold, 35, true),
        ("OBSIDIAN EVERYWHERE MCP · get_neighborhood · Interview Synthesis.md", 11, .bold, 520, true),
        ("3 results · local embeddings · paths and titles returned", 11, .regular, 650, true),
        ("Append today’s interview finding under Research → Findings.", 13, .medium, 646, true),
        ("append_to_note", 12, .bold, 148, true),
        ("Projects/Lumen/Research.md  ·  heading: Findings", 11, .regular, 468, true),
        ("+ Interview 18 — Import looked optional, so participants postponed setup.", 12, .medium, 636, true),
        ("❯  Allow once", 12, .bold, 156, true),
        ("Vault mount unavailable. No changes were made.", 12, .regular, 598, true),
        ("Interview 18 — Import looked optional, so participants postponed setup.", 11, .medium, 450, false),
        ("Projects/Lumen/Research.md · permission: approved", 11, .regular, 356, true),
        ("Updated Projects/Lumen/Research.md · reindexed", 15, .semibold, 628, true),
        ("The local editor now shows the committed line.", 13, .regular, 628, true),
        ("obsidian-everywhere · vault mount unavailable · writes disabled", 11, .semibold, 505, true),
        ("obsidian-everywhere · mount returned · reconciling 117 notes", 11, .semibold, 505, true),
        ("MCP + VAULT READY", 12, .bold, 160, true),
        ("RECONCILING", 12, .bold, 118, true),
        ("MCP ONLINE", 12, .bold, 100, true),
        ("npx -y obsidian-everywhere demo", 14, .semibold, 460, true),
        ("Local vault context for agents running anywhere.", 34, .bold, 900, false),
    ]
    for (value, size, weight, width, mono) in textFits {
        precondition(textWidth(value, size: size, weight: weight, mono: mono) <= width, "Text overflows: \(value)")
    }

    let logicalBody = NSRect(x: 0, y: 0, width: 760, height: 418)
    let sceneBoxes: [(String, [NSRect])] = [
        ("semantic results", [
            NSRect(x: 42, y: 292, width: 676, height: 72),
            NSRect(x: 42, y: 204, width: 676, height: 72),
            NSRect(x: 42, y: 116, width: 676, height: 72),
            NSRect(x: 608, y: 374, width: 124, height: 28),
        ]),
        ("context rows", [
            NSRect(x: 42, y: 300, width: 676, height: 48),
            NSRect(x: 42, y: 238, width: 676, height: 48),
            NSRect(x: 42, y: 176, width: 676, height: 48),
            NSRect(x: 608, y: 374, width: 124, height: 28),
        ]),
        ("write approval", [
            NSRect(x: 42, y: 228, width: 676, height: 76),
            NSRect(x: 42, y: 108, width: 196, height: 42),
            NSRect(x: 608, y: 374, width: 124, height: 28),
        ]),
        ("blocked write", [
            NSRect(x: 42, y: 300, width: 676, height: 54),
            NSRect(x: 42, y: 190, width: 676, height: 78),
            NSRect(x: 608, y: 374, width: 124, height: 28),
        ]),
        ("retry", [
            NSRect(x: 42, y: 220, width: 676, height: 54),
            NSRect(x: 548, y: 374, width: 184, height: 28),
        ]),
    ]
    for (scene, boxes) in sceneBoxes {
        for box in boxes {
            precondition(logicalBody.contains(box), "\(scene) box exceeds the window body: \(box)")
        }
        for leftIndex in boxes.indices {
            for rightIndex in boxes.indices where rightIndex > leftIndex {
                precondition(!boxes[leftIndex].intersects(boxes[rightIndex]), "\(scene) boxes overlap")
            }
        }
    }

    let mountStrip = mountStatusRect(
        layout: Layout(
            obsidian: writeSplitObs,
            terminal: writeSplitTerm,
            obsidianOpacity: 1,
            terminalOpacity: 1
        )
    )
    precondition(mountStrip.minX >= 16 && mountStrip.maxX <= 1264 && mountStrip.minY >= 54, "Mount status strip exceeds safe area")
    precondition(!mountStrip.intersects(writeSplitObs), "Mount status strip overlaps the local window")
    let finalCommand = NSRect(x: 390, y: 286, width: 500, height: 54)
    precondition(finalCommand.minX >= 64 && finalCommand.maxX <= 1216, "Final command box exceeds CTA safe area")
}

func layoutTransition(
    from: Layout,
    to: Layout,
    time: Double,
    start: Double,
    duration: Double = 0.52
) -> Layout {
    let amount = easeInOutCubic(progress(time, start, duration))
    return Layout(
        obsidian: mixRect(from.obsidian, to.obsidian, amount),
        terminal: mixRect(from.terminal, to.terminal, amount),
        obsidianOpacity: lerp(from.obsidianOpacity, to.obsidianOpacity, amount),
        terminalOpacity: lerp(from.terminalOpacity, to.terminalOpacity, amount)
    )
}

func layout(at time: Double) -> Layout {
    let wide = Layout(obsidian: wideObs, terminal: wideTerm, obsidianOpacity: 1, terminalOpacity: 1)
    let terminalFocus = Layout(obsidian: terminalFocusObs, terminal: terminalFocusTerm, obsidianOpacity: 0.64, terminalOpacity: 1)
    let graphFocus = Layout(obsidian: graphFocusObs, terminal: graphFocusTerm, obsidianOpacity: 1, terminalOpacity: 0.68)
    let answerSplit = Layout(obsidian: answerSplitObs, terminal: answerSplitTerm, obsidianOpacity: 0.78, terminalOpacity: 1)
    let writeSplit = Layout(obsidian: writeSplitObs, terminal: writeSplitTerm, obsidianOpacity: 1, terminalOpacity: 1)
    let success = Layout(obsidian: successObs, terminal: successTerm, obsidianOpacity: 1, terminalOpacity: 1)
    let final = Layout(obsidian: finalObs, terminal: finalTerm, obsidianOpacity: 0, terminalOpacity: 0)

    if time < 0.9 {
        let appear = easeOutCubic(progress(time, 0.18, 0.48))
        let obsStart = NSRect(x: wideObs.minX, y: wideObs.minY - 14, width: wideObs.width, height: wideObs.height)
        let termStart = NSRect(x: wideTerm.minX, y: wideTerm.minY - 14, width: wideTerm.width, height: wideTerm.height)
        return Layout(
            obsidian: mixRect(obsStart, wideObs, appear),
            terminal: mixRect(termStart, wideTerm, appear),
            obsidianOpacity: appear,
            terminalOpacity: appear
        )
    }
    if time < 2.6 { return wide }
    if time < 3.12 { return layoutTransition(from: wide, to: terminalFocus, time: time, start: 2.6) }
    if time < 12.1 { return terminalFocus }
    if time < 12.62 { return layoutTransition(from: terminalFocus, to: graphFocus, time: time, start: 12.1) }
    if time < 17.6 { return graphFocus }
    if time < 18.12 { return layoutTransition(from: graphFocus, to: answerSplit, time: time, start: 17.6) }
    if time < 22.6 { return answerSplit }
    if time < 23.12 { return layoutTransition(from: answerSplit, to: writeSplit, time: time, start: 22.6) }
    if time < 34.8 { return writeSplit }
    if time < 35.32 { return layoutTransition(from: writeSplit, to: success, time: time, start: 34.8) }
    if time < 40.8 { return success }
    return layoutTransition(from: success, to: final, time: time, start: 40.8, duration: 0.52)
}

func drawIntro(time: Double) {
    let titleIn = easeOutCubic(progress(time, 0.12, 0.42))
    let titleOut = 1 - easeInOutCubic(progress(time, 2.22, 0.30))
    withAlpha(min(titleIn, titleOut)) {
        drawText("A remote agent. A local vault.", x: 24, baseline: 636, size: 30, weight: .bold, color: white)
        drawText("Connected through authenticated MCP over HTTPS.", x: 24, baseline: 604, size: 13, weight: .medium, color: muted)
    }
}

func drawBrand(time: Double) {
    let chromeOpacity = 1 - easeInOutCubic(progress(time, 40.8, 0.26))
    withAlpha(chromeOpacity) {
        drawCrystal(center: NSPoint(x: 32, y: 692), size: 16, color: purple)
        drawText("OBSIDIAN EVERYWHERE", x: 48, baseline: 687, size: 10, weight: .bold, color: text, mono: true)
        drawText("REMOTE AGENT  ⇄  LOCAL VAULT", x: 1060, baseline: 687, size: 9, weight: .bold, color: muted, mono: true)
    }
}

func drawGuides() {
    guard showGuides else { return }
    for x in stride(from: 0, through: 1280, by: 8) {
        let major = x % 64 == 0
        line(
            NSPoint(x: CGFloat(x), y: 0),
            NSPoint(x: CGFloat(x), y: 720),
            color: (major ? cyan : white).withAlphaComponent(major ? 0.16 : 0.035),
            lineWidth: major ? 1 : 0.5
        )
    }
    for y in stride(from: 0, through: 720, by: 8) {
        let major = y % 64 == 0
        line(
            NSPoint(x: 0, y: CGFloat(y)),
            NSPoint(x: 1280, y: CGFloat(y)),
            color: (major ? cyan : white).withAlphaComponent(major ? 0.16 : 0.035),
            lineWidth: major ? 1 : 0.5
        )
    }
    let safe = NSBezierPath(rect: NSRect(x: 16, y: 54, width: 1248, height: 586))
    safe.lineWidth = 1.5
    red.withAlphaComponent(0.62).setStroke()
    safe.stroke()
}

func mountStatusRect(layout: Layout) -> NSRect {
    NSRect(
        x: layout.obsidian.minX + 16,
        y: layout.obsidian.minY - 54,
        width: min(548, layout.obsidian.width - 32),
        height: 40
    )
}

func mountStatusOpacity(time: Double) -> CGFloat {
    guard time >= 27.34 && time < 34.15 else { return 0 }
    let appear = easeOutCubic(progress(time, 27.34, 0.24))
    let disappear = 1 - easeInOutCubic(progress(time, 33.88, 0.27))
    return min(appear, disappear)
}

func drawMountStatus(time: Double, layout: Layout) {
    let alpha = mountStatusOpacity(time: time)
    guard alpha > 0.001 else { return }
    let returned = easeInOutCubic(progress(time, 31.0, 0.24))
    let color = red.blended(withFraction: returned, of: amber) ?? amber
    let rect = mountStatusRect(layout: layout)
    withAlpha(alpha) {
        rounded(
            rect,
            radius: 6,
            fill: background,
            stroke: color.withAlphaComponent(0.52),
            lineWidth: 1.2
        )
        rounded(
            rect.insetBy(dx: 1, dy: 1),
            radius: 5,
            fill: color.withAlphaComponent(0.10)
        )
        let contentRect = NSRect(
            x: rect.minX + 31,
            y: rect.minY + 10,
            width: rect.width - 43,
            height: 25
        )
        circle(NSPoint(x: rect.minX + 17, y: contentRect.midY), radius: 4, fill: color)
        let lostText = "obsidian-everywhere · vault mount unavailable · writes disabled"
        let returnedText = "obsidian-everywhere · mount returned · reconciling 117 notes"
        let drawLost = {
            drawTextVerticallyCentered(
                lostText,
                x: contentRect.minX,
                rect: contentRect,
                size: 11,
                weight: .semibold,
                color: red,
                mono: true
            )
        }
        let drawReturned = {
            drawTextVerticallyCentered(
                returnedText,
                x: contentRect.minX,
                rect: contentRect,
                size: 11,
                weight: .semibold,
                color: amber,
                mono: true
            )
        }
        if time >= 31 && time < 31.24 {
            sequentialFade(time: time, start: 31, duration: 0.24, outgoing: drawLost, incoming: drawReturned)
        } else if time >= 31.24 {
            drawReturned()
        } else {
            drawLost()
        }
        if time >= 31 {
            let reindex = easeInOutCubic(progress(time, 31.45, 2.43))
            let track = NSRect(x: rect.minX + 10, y: rect.minY + 5, width: rect.width - 20, height: 3)
            rounded(track, radius: 1.5, fill: white.withAlphaComponent(0.10))
            rounded(
                NSRect(x: track.minX, y: track.minY, width: track.width * reindex, height: track.height),
                radius: 1.5,
                fill: amber
            )
        }
    }
}

func drawDrive(time: Double, layout: Layout) {
    guard time >= 26.7 && time < 35.56 else { return }
    let disconnect = easeInOutCubic(progress(time, 27.0, 0.32))
    let reconnect = easeInOutCubic(progress(time, 31.0, 0.32))
    let unavailable = max(disconnect - reconnect, 0)
    let fadeIn = easeOutCubic(progress(time, 26.72, 0.22))
    let fadeOut = 1 - easeInOutCubic(progress(time, 35.32, 0.24))
    let hudAlpha = min(fadeIn, fadeOut)
    let center = NSPoint(x: 84, y: 92 - 10 * unavailable)
    let stateColor = green.blended(withFraction: unavailable, of: red) ?? green
    let cableColor = cyan.blended(withFraction: unavailable, of: red) ?? cyan
    withAlpha(hudAlpha) {
        rounded(
            NSRect(x: center.x - 28, y: center.y - 18, width: 56, height: 36),
            radius: 6,
            fill: elevated,
            stroke: stateColor.withAlphaComponent(0.68),
            lineWidth: 1.2
        )
        rounded(NSRect(x: center.x - 16, y: center.y + 5, width: 32, height: 3), radius: 1.5, fill: white.withAlphaComponent(0.18))
        circle(NSPoint(x: center.x + 17, y: center.y - 9), radius: 3, fill: stateColor)
        let cableStart = NSPoint(x: center.x, y: center.y + 18)
        let cableEnd = NSPoint(x: layout.obsidian.minX + 84, y: layout.obsidian.minY)
        if mountStatusOpacity(time: time) > 0.001 {
            let mountRect = mountStatusRect(layout: layout)
            let connectorX = center.x
            line(
                cableStart,
                NSPoint(x: connectorX, y: mountRect.minY),
                color: cableColor.withAlphaComponent(0.52),
                lineWidth: 1.5,
                amount: 1 - 0.58 * unavailable
            )
            line(
                NSPoint(x: connectorX, y: mountRect.maxY),
                cableEnd,
                color: cableColor.withAlphaComponent(0.52),
                lineWidth: 1.5,
                amount: 1 - 0.58 * unavailable
            )
        } else {
            line(
                cableStart,
                cableEnd,
                color: cableColor.withAlphaComponent(0.52),
                lineWidth: 1.5,
                amount: 1 - 0.58 * unavailable
            )
        }
        let labelCenter = NSPoint(x: center.x, y: center.y - 31)
        let drawLocal = {
            drawCentered("LOCAL VAULT", center: labelCenter, size: 8, weight: .bold, color: green, mono: true)
        }
        let drawLost = {
            drawCentered("VAULT MOUNT LOST", center: labelCenter, size: 8, weight: .bold, color: red, mono: true)
        }
        let drawReturned = {
            drawCentered("MOUNT RETURNED", center: labelCenter, size: 8, weight: .bold, color: green, mono: true)
        }
        if time >= 27 && time < 27.32 {
            sequentialFade(time: time, start: 27, duration: 0.32, outgoing: drawLocal, incoming: drawLost)
        } else if time >= 31 && time < 31.32 {
            sequentialFade(time: time, start: 31, duration: 0.32, outgoing: drawLost, incoming: drawReturned)
        } else if time >= 31.32 {
            drawReturned()
        } else if time >= 27.32 {
            drawLost()
        } else {
            drawLocal()
        }
    }
}

func drawTransportRail(time: Double, layout: Layout) {
    guard time < 41.06 else { return }
    let y: CGFloat = 46
    let left = NSPoint(x: max(260, layout.obsidian.midX), y: y)
    let right = NSPoint(x: min(1020, layout.terminal.midX), y: y)
    let introAlpha: CGFloat = time < 0.8 ? easeOutCubic(progress(time, 0.24, 0.34)) : 1
    let chromeOpacity = 1 - easeInOutCubic(progress(time, 40.8, 0.26))
    let railAlpha = introAlpha * chromeOpacity
    withAlpha(railAlpha) {
        let localConnectorTop = NSPoint(x: layout.obsidian.midX, y: layout.obsidian.minY)
        if mountStatusOpacity(time: time) > 0.001 {
            let mountRect = mountStatusRect(layout: layout)
            line(
                localConnectorTop,
                NSPoint(x: localConnectorTop.x, y: mountRect.maxY),
                color: cyan.withAlphaComponent(0.28),
                lineWidth: 1.5
            )
            line(
                NSPoint(x: localConnectorTop.x, y: mountRect.minY),
                left,
                color: cyan.withAlphaComponent(0.28),
                lineWidth: 1.5
            )
        } else {
            line(
                localConnectorTop,
                left,
                color: cyan.withAlphaComponent(0.28),
                lineWidth: 1.5
            )
        }
        line(left, right, color: white.withAlphaComponent(0.16), lineWidth: 1.5)
        line(
            right,
            NSPoint(x: layout.terminal.midX, y: layout.terminal.minY),
            color: cyan.withAlphaComponent(0.28),
            lineWidth: 1.5
        )
        drawText("LOCAL · obsidian-everywhere", x: 24, baseline: 18, size: 9, weight: .semibold, color: muted, mono: true)
        drawCentered("ngrok · HTTPS · bearer token · MCP", center: NSPoint(x: 640, y: 19), size: 9, weight: .semibold, color: muted, mono: true)
        drawText("REMOTE · Claude Code", x: 1086, baseline: 18, size: 9, weight: .semibold, color: muted, mono: true)
    }

    let events: [(Double, Bool)] = [
        (4.65, false),
        (6.72, false),
        (8.05, true),
        (12.72, false),
        (13.32, true),
        (23.36, false),
        (27.70, false),
        (35.74, false),
        (37.0, true),
    ]
    for event in events where time >= event.0 && time < event.0 + 0.46 {
        let amount = progress(time, event.0, 0.46)
        let blocked = event.0 == 27.70
        let travel = blocked ? min(amount, 0.76) : amount
        let start = event.1 ? left : right
        let end = event.1 ? right : left
        let packet = pointBetween(start, end, travel)
        circle(packet, radius: 5, fill: blocked ? red : event.1 ? cyan : purple)
        if blocked && amount > 0.76 {
            line(
                NSPoint(x: packet.x - 5, y: packet.y - 5),
                NSPoint(x: packet.x + 5, y: packet.y + 5),
                color: red,
                lineWidth: 2
            )
        }
    }
}

func drawFinal(time: Double) {
    guard time >= 40.8 else { return }
    let reveal = easeInOutCubic(progress(time, 41.24, 0.24))
    rounded(NSRect(x: 0, y: 0, width: 1280, height: 720), radius: 0, fill: NSColor.black.withAlphaComponent(0.36 * reveal))
    withAlpha(reveal) {
        drawCrystal(center: NSPoint(x: 640, y: 578), size: 30, color: purple)
        drawCentered(
            "OBSIDIAN EVERYWHERE",
            center: NSPoint(x: 640, y: 540),
            size: 11,
            weight: .bold,
            color: white,
            mono: true
        )
        drawCentered(
            "Local vault context for agents running anywhere.",
            center: NSPoint(x: 640, y: 454),
            size: 34,
            weight: .bold,
            color: white
        )
        drawCentered(
            "Graph context · local semantic search · guarded remote writes",
            center: NSPoint(x: 640, y: 404),
            size: 14,
            weight: .medium,
            color: muted
        )
        rounded(
            NSRect(x: 390, y: 286, width: 500, height: 54),
            radius: 8,
            fill: elevated.withAlphaComponent(0.88),
            stroke: white.withAlphaComponent(0.16),
            lineWidth: 1.2
        )
        drawCentered(
            "npx -y obsidian-everywhere demo",
            center: NSPoint(x: 640, y: 313),
            size: 14,
            weight: .semibold,
            color: white,
            mono: true
        )
        drawCentered(
            "Remote setup  →  docs/ngrok-remote.md",
            center: NSPoint(x: 640, y: 246),
            size: 12,
            weight: .medium,
            color: purple,
            mono: true
        )
        drawCentered(
            "github.com/junnnnnw00/obsidian-everywhere",
            center: NSPoint(x: 640, y: 202),
            size: 11,
            weight: .medium,
            color: muted,
            mono: true
        )
        drawCentered(
            "Mount Guard · beta",
            center: NSPoint(x: 640, y: 154),
            size: 10,
            weight: .semibold,
            color: green,
            mono: true
        )
    }
}

validateGeometry()

for frame in framesToRender {
    autoreleasepool {
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: canvasWidth,
            pixelsHigh: canvasHeight,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .calibratedRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            fputs("Could not create bitmap\n", stderr)
            exit(1)
        }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        if let context = NSGraphicsContext.current?.cgContext {
            context.setShouldAntialias(true)
            context.setAllowsAntialiasing(true)
            context.interpolationQuality = .high
            context.scaleBy(x: CGFloat(renderScale), y: CGFloat(renderScale))
        }

        let time = Double(frame) / Double(fps)
        drawBackground(time: time)
        let currentLayout = layout(at: time)
        drawObsidianWindow(
            rect: currentLayout.obsidian,
            time: time,
            opacity: currentLayout.obsidianOpacity
        )
        drawTerminalWindow(
            rect: currentLayout.terminal,
            time: time,
            opacity: currentLayout.terminalOpacity
        )

        drawDrive(time: time, layout: currentLayout)
        drawTransportRail(time: time, layout: currentLayout)
        drawMountStatus(time: time, layout: currentLayout)
        drawIntro(time: time)
        drawBrand(time: time)
        drawFinal(time: time)
        drawGuides()

        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            fputs("Could not encode frame\n", stderr)
            exit(1)
        }
        do {
            try png.write(
                to: outputDirectory.appendingPathComponent(String(format: "frame-%04d.png", frame))
            )
        } catch {
            fputs("Could not write frame: \(error)\n", stderr)
            exit(1)
        }
    }
}

print("Rendered \(framesToRender.count) requested frame(s) from a 44s / 30fps timeline at \(renderScale)x")
