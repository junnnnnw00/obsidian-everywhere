#!/usr/bin/env swift

import AppKit
import CoreText
import Foundation

guard (2...3).contains(CommandLine.arguments.count) else {
    fputs("Usage: render-social-preview.swift <output.png> [output.jpg]\n", stderr)
    exit(2)
}

let pngURL = URL(fileURLWithPath: CommandLine.arguments[1])
let jpgURL = CommandLine.arguments.count == 3
    ? URL(fileURLWithPath: CommandLine.arguments[2])
    : nil

let logicalWidth: CGFloat = 1280
let logicalHeight: CGFloat = 640
let renderScale = 2
let safeArea = NSRect(x: 56, y: 48, width: 1168, height: 544)

let background = NSColor(srgbRed: 0.035, green: 0.041, blue: 0.052, alpha: 1)
let surface = NSColor(srgbRed: 0.073, green: 0.081, blue: 0.098, alpha: 1)
let surfaceRaised = NSColor(srgbRed: 0.097, green: 0.106, blue: 0.126, alpha: 1)
let titlebar = NSColor(srgbRed: 0.115, green: 0.125, blue: 0.145, alpha: 1)
let sidebar = NSColor(srgbRed: 0.057, green: 0.063, blue: 0.079, alpha: 1)
let white = NSColor(srgbRed: 0.965, green: 0.958, blue: 0.943, alpha: 1)
let text = NSColor(srgbRed: 0.810, green: 0.820, blue: 0.845, alpha: 1)
let muted = NSColor(srgbRed: 0.510, green: 0.530, blue: 0.575, alpha: 1)
let purple = NSColor(srgbRed: 0.655, green: 0.545, blue: 0.980, alpha: 1)
let cyan = NSColor(srgbRed: 0.408, green: 0.776, blue: 0.847, alpha: 1)
let green = NSColor(srgbRed: 0.365, green: 0.808, blue: 0.596, alpha: 1)

struct AuditItem {
    let name: String
    let rect: NSRect
}

var auditItems: [AuditItem] = []

func font(size: CGFloat, weight: NSFont.Weight = .regular, mono: Bool = false) -> NSFont {
    mono
        ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
        : NSFont.systemFont(ofSize: size, weight: weight)
}

func textWidth(
    _ value: String,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    mono: Bool = false
) -> CGFloat {
    let attributed = NSAttributedString(
        string: value,
        attributes: [.font: font(size: size, weight: weight, mono: mono)]
    )
    return CGFloat(
        CTLineGetTypographicBounds(
            CTLineCreateWithAttributedString(attributed),
            nil,
            nil,
            nil
        )
    )
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
            .font: font(size: size, weight: weight, mono: mono),
            .foregroundColor: color,
        ]
    )
    let line = CTLineCreateWithAttributedString(attributed)
    context.saveGState()
    context.textMatrix = .identity
    context.textPosition = CGPoint(x: x, y: baseline)
    CTLineDraw(line, context)
    context.restoreGState()
}

func drawCenteredText(
    _ value: String,
    in rect: NSRect,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = text,
    mono: Bool = false,
    auditName: String? = nil
) {
    let valueFont = font(size: size, weight: weight, mono: mono)
    let width = textWidth(value, size: size, weight: weight, mono: mono)
    precondition(width <= rect.width, "\(auditName ?? value) is \(width - rect.width) px too wide")
    let baseline = rect.midY - (valueFont.ascender + valueFont.descender) / 2
    drawText(
        value,
        x: rect.midX - width / 2,
        baseline: baseline,
        size: size,
        weight: weight,
        color: color,
        mono: mono
    )
    if let auditName {
        auditItems.append(AuditItem(name: auditName, rect: rect))
    }
}

func drawFittedText(
    _ value: String,
    x: CGFloat,
    baseline: CGFloat,
    maxWidth: CGFloat,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = text,
    mono: Bool = false,
    auditName: String
) {
    let width = textWidth(value, size: size, weight: weight, mono: mono)
    precondition(width <= maxWidth, "\(auditName) is \(width - maxWidth) px too wide")
    drawText(
        value,
        x: x,
        baseline: baseline,
        size: size,
        weight: weight,
        color: color,
        mono: mono
    )
    let valueFont = font(size: size, weight: weight, mono: mono)
    auditItems.append(
        AuditItem(
            name: auditName,
            rect: NSRect(
                x: x,
                y: baseline + valueFont.descender,
                width: width,
                height: valueFont.ascender - valueFont.descender
            )
        )
    )
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

func line(
    from start: NSPoint,
    to end: NSPoint,
    color: NSColor,
    width: CGFloat = 1,
    dashed: Bool = false
) {
    let path = NSBezierPath()
    path.move(to: start)
    path.line(to: end)
    path.lineWidth = width
    path.lineCapStyle = .round
    if dashed {
        var pattern: [CGFloat] = [5, 6]
        path.setLineDash(&pattern, count: pattern.count, phase: 0)
    }
    color.setStroke()
    path.stroke()
}

func circle(
    center: NSPoint,
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

func drawDiamondLogo(center: NSPoint, size: CGFloat) {
    let outer = NSBezierPath()
    outer.move(to: NSPoint(x: center.x, y: center.y + size / 2))
    outer.line(to: NSPoint(x: center.x + size * 0.37, y: center.y))
    outer.line(to: NSPoint(x: center.x, y: center.y - size / 2))
    outer.line(to: NSPoint(x: center.x - size * 0.37, y: center.y))
    outer.close()
    NSColor(srgbRed: 0.155, green: 0.125, blue: 0.245, alpha: 1).setFill()
    outer.fill()
    outer.lineWidth = 1.4
    purple.setStroke()
    outer.stroke()

    let inner = NSBezierPath()
    inner.move(to: NSPoint(x: center.x, y: center.y + size * 0.32))
    inner.line(to: NSPoint(x: center.x + size * 0.19, y: center.y))
    inner.line(to: NSPoint(x: center.x, y: center.y - size * 0.32))
    inner.line(to: NSPoint(x: center.x - size * 0.19, y: center.y))
    inner.close()
    inner.lineWidth = 1
    cyan.withAlphaComponent(0.85).setStroke()
    inner.stroke()
}

func drawPill(
    _ value: String,
    rect: NSRect,
    fill: NSColor,
    stroke: NSColor,
    textColor: NSColor,
    size: CGFloat,
    auditName: String
) {
    rounded(rect, radius: rect.height / 2, fill: fill, stroke: stroke)
    drawCenteredText(
        value,
        in: rect.insetBy(dx: 10, dy: 0),
        size: size,
        weight: .semibold,
        color: textColor,
        mono: true,
        auditName: auditName
    )
}

func drawWindowChrome(_ rect: NSRect, title: String, online: Bool) {
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.58)
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.shadowBlurRadius = 28

    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    rounded(
        rect,
        radius: 10,
        fill: surface,
        stroke: NSColor.white.withAlphaComponent(0.105),
        lineWidth: 1
    )
    NSGraphicsContext.restoreGraphicsState()

    let chrome = NSRect(x: rect.minX, y: rect.maxY - 38, width: rect.width, height: 38)
    let chromePath = NSBezierPath(
        roundedRect: chrome,
        xRadius: 10,
        yRadius: 10
    )
    titlebar.setFill()
    chromePath.fill()
    titlebar.setFill()
    NSRect(x: chrome.minX, y: chrome.minY, width: chrome.width, height: 11).fill()

    circle(center: NSPoint(x: rect.minX + 16, y: rect.maxY - 19), radius: 3.2, fill: .systemRed)
    circle(center: NSPoint(x: rect.minX + 27, y: rect.maxY - 19), radius: 3.2, fill: .systemYellow)
    circle(center: NSPoint(x: rect.minX + 38, y: rect.maxY - 19), radius: 3.2, fill: .systemGreen)
    drawFittedText(
        title,
        x: rect.minX + 55,
        baseline: rect.maxY - 23,
        maxWidth: online ? rect.width - 170 : rect.width - 75,
        size: 9.5,
        weight: .semibold,
        color: muted,
        mono: true,
        auditName: "\(title) title"
    )

    if online {
        let badge = NSRect(x: rect.maxX - 91, y: rect.maxY - 29, width: 73, height: 20)
        drawPill(
            "MCP ONLINE",
            rect: badge,
            fill: green.withAlphaComponent(0.13),
            stroke: green.withAlphaComponent(0.48),
            textColor: green,
            size: 8,
            auditName: "MCP ONLINE"
        )
    }
}

func drawLocalVaultWindow(_ rect: NSRect) {
    drawWindowChrome(rect, title: "LOCAL  ·  PROJECT LUMEN", online: false)

    let contentTop = rect.maxY - 38
    let sidebarRect = NSRect(x: rect.minX, y: rect.minY, width: 132, height: rect.height - 38)
    sidebar.setFill()
    sidebarRect.fill()
    NSColor.white.withAlphaComponent(0.065).setFill()
    NSRect(x: sidebarRect.maxX, y: sidebarRect.minY, width: 1, height: sidebarRect.height).fill()

    drawDiamondLogo(center: NSPoint(x: rect.minX + 20, y: contentTop - 24), size: 18)
    drawFittedText(
        "FILES",
        x: rect.minX + 38,
        baseline: contentTop - 27,
        maxWidth: 70,
        size: 8.5,
        weight: .bold,
        color: muted,
        mono: true,
        auditName: "FILES"
    )

    let rowX = rect.minX + 16
    drawFittedText(
        "▾  Projects",
        x: rowX,
        baseline: contentTop - 59,
        maxWidth: 105,
        size: 9,
        weight: .semibold,
        color: text,
        auditName: "Projects row"
    )
    drawFittedText(
        "   ▾  Lumen",
        x: rowX,
        baseline: contentTop - 83,
        maxWidth: 105,
        size: 9,
        weight: .semibold,
        color: text,
        auditName: "Lumen row"
    )

    let selection = NSRect(x: rect.minX + 34, y: contentTop - 119, width: 88, height: 22)
    rounded(
        selection,
        radius: 4,
        fill: purple.withAlphaComponent(0.18),
        stroke: purple.withAlphaComponent(0.28)
    )
    drawCenteredText(
        "Research",
        in: selection,
        size: 9,
        weight: .semibold,
        color: white,
        auditName: "Research selection"
    )
    for (name, offset) in [("Interview synthesis", 145), ("Import friction", 169), ("Roadmap", 193)] {
        drawFittedText(
            name,
            x: rect.minX + 43,
            baseline: contentTop - CGFloat(offset),
            maxWidth: 82,
            size: 8.5,
            color: muted,
            auditName: "\(name) row"
        )
    }

    let editorX = sidebarRect.maxX + 26
    drawFittedText(
        "KNOWLEDGE GRAPH",
        x: editorX,
        baseline: contentTop - 30,
        maxWidth: rect.maxX - editorX - 24,
        size: 8.5,
        weight: .bold,
        color: purple,
        mono: true,
        auditName: "KNOWLEDGE GRAPH"
    )
    drawFittedText(
        "Onboarding research",
        x: editorX,
        baseline: contentTop - 65,
        maxWidth: rect.maxX - editorX - 24,
        size: 19,
        weight: .bold,
        color: white,
        auditName: "Onboarding research"
    )
    drawFittedText(
        "7 linked notes · local graph",
        x: editorX,
        baseline: contentTop - 87,
        maxWidth: rect.maxX - editorX - 24,
        size: 9,
        color: muted,
        mono: true,
        auditName: "Local graph metadata"
    )

    let n1 = NSPoint(x: editorX + 74, y: rect.minY + 122)
    let n2 = NSPoint(x: editorX + 165, y: rect.minY + 184)
    let n3 = NSPoint(x: editorX + 258, y: rect.minY + 145)
    let n4 = NSPoint(x: editorX + 221, y: rect.minY + 84)
    let n5 = NSPoint(x: editorX + 122, y: rect.minY + 72)
    for (a, b) in [(n1, n2), (n2, n3), (n3, n4), (n4, n5), (n5, n1), (n2, n4)] {
        line(from: a, to: b, color: cyan.withAlphaComponent(0.52), width: 1.4)
    }
    for (point, radius, color) in [
        (n1, 7.0, purple),
        (n2, 9.5, purple),
        (n3, 6.0, cyan),
        (n4, 6.5, cyan),
        (n5, 4.5, muted),
    ] {
        circle(center: point, radius: radius + 3, fill: color.withAlphaComponent(0.10))
        circle(center: point, radius: radius, fill: color)
    }
    drawFittedText(
        "Interview synthesis",
        x: n2.x - 48,
        baseline: n2.y - 19,
        maxWidth: 98,
        size: 8,
        weight: .semibold,
        color: text,
        auditName: "Graph node label"
    )
}

func drawRemoteAgentWindow(_ rect: NSRect) {
    drawWindowChrome(rect, title: "REMOTE  ·  CLAUDE CODE", online: true)
    let top = rect.maxY - 38
    let contentX = rect.minX + 24

    drawFittedText(
        "obsidian-everywhere  ›  semantic_search",
        x: contentX,
        baseline: top - 30,
        maxWidth: rect.width - 48,
        size: 9,
        weight: .semibold,
        color: purple,
        mono: true,
        auditName: "Semantic search command"
    )
    drawFittedText(
        "\"why did activation stall?\"",
        x: contentX,
        baseline: top - 60,
        maxWidth: rect.width - 48,
        size: 15,
        weight: .semibold,
        color: white,
        auditName: "Search query"
    )

    let cards = [
        ("Projects/Lumen/Interview Synthesis.md", "0.942"),
        ("Projects/Lumen/Import Friction.md", "0.915"),
    ]
    for (index, item) in cards.enumerated() {
        let y = top - 109 - CGFloat(index * 47)
        let card = NSRect(x: contentX, y: y, width: rect.width - 48, height: 36)
        rounded(
            card,
            radius: 5,
            fill: index == 0 ? purple.withAlphaComponent(0.13) : surfaceRaised,
            stroke: index == 0
                ? purple.withAlphaComponent(0.32)
                : NSColor.white.withAlphaComponent(0.07)
        )
        drawFittedText(
            item.0,
            x: card.minX + 11,
            baseline: card.midY - 3,
            maxWidth: card.width - 70,
            size: 8.5,
            weight: .medium,
            color: index == 0 ? white : text,
            mono: true,
            auditName: "Search result \(index + 1)"
        )
        drawFittedText(
            item.1,
            x: card.maxX - 42,
            baseline: card.midY - 3,
            maxWidth: 32,
            size: 8.5,
            weight: .bold,
            color: index == 0 ? purple : cyan,
            mono: true,
            auditName: "Search score \(index + 1)"
        )
    }

    let status = NSRect(x: contentX, y: rect.minY + 18, width: rect.width - 48, height: 28)
    rounded(
        status,
        radius: 5,
        fill: green.withAlphaComponent(0.10),
        stroke: green.withAlphaComponent(0.30)
    )
    circle(center: NSPoint(x: status.minX + 14, y: status.midY), radius: 3.5, fill: green)
    drawFittedText(
        "Local embeddings · source paths returned",
        x: status.minX + 26,
        baseline: status.midY - 3.2,
        maxWidth: status.width - 38,
        size: 8.5,
        weight: .semibold,
        color: green,
        mono: true,
        auditName: "Local embeddings status"
    )
}

func renderCard() {
    let canvas = NSRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight)

    let base = NSGradient(
        starting: NSColor(srgbRed: 0.030, green: 0.035, blue: 0.045, alpha: 1),
        ending: NSColor(srgbRed: 0.056, green: 0.045, blue: 0.081, alpha: 1)
    )
    base?.draw(in: canvas, angle: 12)

    let purpleGlow = NSGradient(
        colorsAndLocations:
            (purple.withAlphaComponent(0.20), 0.0),
            (purple.withAlphaComponent(0), 1.0)
    )
    purpleGlow?.draw(
        in: NSRect(x: 690, y: 255, width: 670, height: 530),
        relativeCenterPosition: NSPoint(x: 0.15, y: -0.1)
    )
    let cyanGlow = NSGradient(
        colorsAndLocations:
            (cyan.withAlphaComponent(0.10), 0.0),
            (cyan.withAlphaComponent(0), 1.0)
    )
    cyanGlow?.draw(
        in: NSRect(x: 540, y: -210, width: 760, height: 520),
        relativeCenterPosition: NSPoint(x: 0.2, y: 0.25)
    )

    for x in stride(from: CGFloat(640), through: logicalWidth, by: 48) {
        line(
            from: NSPoint(x: x, y: 48),
            to: NSPoint(x: x, y: 592),
            color: NSColor.white.withAlphaComponent(0.020)
        )
    }
    for y in stride(from: CGFloat(64), through: logicalHeight - 48, by: 48) {
        line(
            from: NSPoint(x: 620, y: y),
            to: NSPoint(x: 1224, y: y),
            color: NSColor.white.withAlphaComponent(0.020)
        )
    }

    drawDiamondLogo(center: NSPoint(x: 72, y: 566), size: 25)
    drawFittedText(
        "OBSIDIAN EVERYWHERE",
        x: 94,
        baseline: 561,
        maxWidth: 250,
        size: 12,
        weight: .bold,
        color: white,
        mono: true,
        auditName: "Brand"
    )
    drawFittedText(
        "OPEN-SOURCE MCP SERVER",
        x: 72,
        baseline: 508,
        maxWidth: 470,
        size: 13,
        weight: .bold,
        color: purple,
        mono: true,
        auditName: "Eyebrow"
    )
    drawFittedText(
        "Local vault context.",
        x: 68,
        baseline: 433,
        maxWidth: 540,
        size: 52,
        weight: .heavy,
        color: white,
        auditName: "Headline line 1"
    )
    drawFittedText(
        "For agents anywhere.",
        x: 68,
        baseline: 366,
        maxWidth: 540,
        size: 52,
        weight: .heavy,
        color: white,
        auditName: "Headline line 2"
    )
    drawFittedText(
        "Graph context, semantic search, and guarded writes—",
        x: 72,
        baseline: 303,
        maxWidth: 520,
        size: 18,
        weight: .medium,
        color: text,
        auditName: "Subtitle line 1"
    )
    drawFittedText(
        "without moving your notes off your machine.",
        x: 72,
        baseline: 275,
        maxWidth: 520,
        size: 18,
        weight: .medium,
        color: text,
        auditName: "Subtitle line 2"
    )

    drawPill(
        "GRAPH-AWARE",
        rect: NSRect(x: 72, y: 203, width: 126, height: 34),
        fill: purple.withAlphaComponent(0.13),
        stroke: purple.withAlphaComponent(0.36),
        textColor: purple,
        size: 10.5,
        auditName: "GRAPH-AWARE"
    )
    drawPill(
        "SEMANTIC SEARCH",
        rect: NSRect(x: 210, y: 203, width: 158, height: 34),
        fill: cyan.withAlphaComponent(0.10),
        stroke: cyan.withAlphaComponent(0.32),
        textColor: cyan,
        size: 10.5,
        auditName: "SEMANTIC SEARCH"
    )
    drawPill(
        "REMOTE WRITES",
        rect: NSRect(x: 380, y: 203, width: 139, height: 34),
        fill: green.withAlphaComponent(0.10),
        stroke: green.withAlphaComponent(0.30),
        textColor: green,
        size: 10.5,
        auditName: "REMOTE WRITES"
    )

    let trustBar = NSRect(x: 72, y: 86, width: 447, height: 66)
    rounded(
        trustBar,
        radius: 9,
        fill: NSColor.black.withAlphaComponent(0.19),
        stroke: NSColor.white.withAlphaComponent(0.09)
    )
    circle(center: NSPoint(x: 94, y: trustBar.midY), radius: 7, fill: green.withAlphaComponent(0.15))
    circle(center: NSPoint(x: 94, y: trustBar.midY), radius: 3.4, fill: green)
    drawFittedText(
        "Your files stay on your machine",
        x: 113,
        baseline: 116,
        maxWidth: 265,
        size: 14,
        weight: .semibold,
        color: white,
        auditName: "Local file promise"
    )
    drawFittedText(
        "Mount Guard blocks unsafe writes",
        x: 113,
        baseline: 97,
        maxWidth: 265,
        size: 9.5,
        color: muted,
        mono: true,
        auditName: "Mount Guard promise"
    )
    drawPill(
        "LOCAL-FIRST",
        rect: NSRect(x: 395, y: 104, width: 105, height: 30),
        fill: green.withAlphaComponent(0.09),
        stroke: green.withAlphaComponent(0.28),
        textColor: green,
        size: 9,
        auditName: "LOCAL-FIRST"
    )

    let localRect = NSRect(x: 626, y: 190, width: 528, height: 354)
    let remoteRect = NSRect(x: 777, y: 56, width: 439, height: 286)

    line(
        from: NSPoint(x: 652, y: 156),
        to: NSPoint(x: 1178, y: 156),
        color: cyan.withAlphaComponent(0.12),
        width: 9
    )
    line(
        from: NSPoint(x: 652, y: 156),
        to: NSPoint(x: 1178, y: 156),
        color: cyan.withAlphaComponent(0.72),
        width: 1.5,
        dashed: true
    )
    let bridgeBadge = NSRect(x: 648, y: 140, width: 120, height: 32)
    drawPill(
        "HTTPS  ·  MCP",
        rect: bridgeBadge,
        fill: background.withAlphaComponent(0.96),
        stroke: cyan.withAlphaComponent(0.34),
        textColor: cyan,
        size: 9,
        auditName: "HTTPS MCP bridge"
    )

    drawLocalVaultWindow(localRect)
    drawRemoteAgentWindow(remoteRect)

    auditItems.append(AuditItem(name: "Local vault window", rect: localRect))
    auditItems.append(AuditItem(name: "Remote agent window", rect: remoteRect))
}

func makeBitmap(width: Int, height: Int) -> NSBitmapImageRep {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fatalError("Could not allocate bitmap")
    }
    bitmap.size = NSSize(width: width, height: height)
    return bitmap
}

let highResolution = makeBitmap(
    width: Int(logicalWidth) * renderScale,
    height: Int(logicalHeight) * renderScale
)
highResolution.size = NSSize(width: logicalWidth, height: logicalHeight)

NSGraphicsContext.saveGraphicsState()
guard let highContext = NSGraphicsContext(bitmapImageRep: highResolution) else {
    fatalError("Could not create high-resolution graphics context")
}
NSGraphicsContext.current = highContext
highContext.imageInterpolation = .high
renderCard()
NSGraphicsContext.restoreGraphicsState()

for item in auditItems {
    precondition(
        safeArea.contains(item.rect),
        "\(item.name) escapes the 56×48 px safe area: \(item.rect)"
    )
}

let finalBitmap = makeBitmap(width: Int(logicalWidth), height: Int(logicalHeight))
NSGraphicsContext.saveGraphicsState()
guard let finalContext = NSGraphicsContext(bitmapImageRep: finalBitmap) else {
    fatalError("Could not create final graphics context")
}
NSGraphicsContext.current = finalContext
finalContext.imageInterpolation = .high
let highImage = NSImage(size: NSSize(width: logicalWidth, height: logicalHeight))
highImage.addRepresentation(highResolution)
highImage.draw(
    in: NSRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight),
    from: .zero,
    operation: .copy,
    fraction: 1
)
NSGraphicsContext.restoreGraphicsState()

guard let png = finalBitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not encode PNG")
}
try png.write(to: pngURL, options: .atomic)

if let jpgURL {
    guard let jpg = finalBitmap.representation(
        using: .jpeg,
        properties: [.compressionFactor: 0.91]
    ) else {
        fatalError("Could not encode JPEG")
    }
    try jpg.write(to: jpgURL, options: .atomic)
}

print("Rendered 1280×640 social preview")
print("Geometry audit: \(auditItems.count) text and component bounds passed")
