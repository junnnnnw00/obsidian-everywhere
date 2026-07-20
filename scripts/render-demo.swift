#!/usr/bin/env swift

import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: render-demo.swift <output-directory>\n", stderr)
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

let width = 1000
let height = 800
let fps = 25
let framesPerStage = 90
let totalFrames = framesPerStage * 6

let background = NSColor(calibratedRed: 0.050, green: 0.050, blue: 0.062, alpha: 1)
let surface = NSColor(calibratedRed: 0.085, green: 0.085, blue: 0.105, alpha: 1)
let surfaceRaised = NSColor(calibratedRed: 0.105, green: 0.105, blue: 0.130, alpha: 1)
let text = NSColor(calibratedWhite: 0.96, alpha: 1)
let secondary = NSColor(calibratedWhite: 0.65, alpha: 1)
let faint = NSColor(calibratedWhite: 0.75, alpha: 0.15)
let purple = NSColor(calibratedRed: 0.64, green: 0.49, blue: 0.95, alpha: 1)
let cyan = NSColor(calibratedRed: 0.27, green: 0.79, blue: 0.95, alpha: 1)
let amber = NSColor(calibratedRed: 1.00, green: 0.65, blue: 0.25, alpha: 1)
let green = NSColor(calibratedRed: 0.33, green: 0.86, blue: 0.58, alpha: 1)

func unit(_ value: Double) -> CGFloat { CGFloat(max(0, min(1, value))) }
func smooth(_ value: Double) -> CGFloat {
    let x = max(0, min(1, value))
    return CGFloat(x * x * (3 - 2 * x))
}
func interval(_ phase: Double, _ start: Double, _ end: Double) -> CGFloat {
    guard end > start else { return phase >= end ? 1 : 0 }
    return unit((phase - start) / (end - start))
}
func easeOutBack(_ value: Double) -> CGFloat {
    let x = max(0, min(1, value))
    let c1 = 1.70158
    let c3 = c1 + 1
    return CGFloat(1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2))
}
func spring(_ value: Double) -> CGFloat {
    let x = max(0, min(1, value))
    return CGFloat(1 - exp(-7 * x) * cos(11 * x))
}
func mix(_ a: NSPoint, _ b: NSPoint, _ progress: CGFloat) -> NSPoint {
    NSPoint(x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress)
}

func roundedRect(_ rect: NSRect, radius: CGFloat, fill: NSColor, stroke: NSColor? = nil, width: CGFloat = 1) {
    let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    fill.setFill()
    path.fill()
    if let stroke {
        path.lineWidth = width
        stroke.setStroke()
        path.stroke()
    }
}

func circle(_ center: NSPoint, radius: CGFloat, fill: NSColor, stroke: NSColor? = nil, width: CGFloat = 1) {
    let path = NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
    fill.setFill()
    path.fill()
    if let stroke {
        path.lineWidth = width
        stroke.setStroke()
        path.stroke()
    }
}

func line(_ from: NSPoint, _ to: NSPoint, color: NSColor, width: CGFloat = 1, progress: CGFloat = 1, dashed: Bool = false) {
    let path = NSBezierPath()
    path.move(to: from)
    path.line(to: mix(from, to, progress))
    path.lineWidth = width
    path.lineCapStyle = .round
    if dashed {
        var pattern: [CGFloat] = [7, 7]
        path.setLineDash(&pattern, count: pattern.count, phase: 0)
    }
    color.setStroke()
    path.stroke()
}

func label(_ value: String, at point: NSPoint, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = text, mono: Bool = false) {
    let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
    value.draw(at: point, withAttributes: [.font: font, .foregroundColor: color])
}

func centeredLabel(_ value: String, center: NSPoint, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = text, mono: Bool = false) {
    let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    let measured = value.size(withAttributes: attributes)
    value.draw(at: NSPoint(x: center.x - measured.width / 2, y: center.y - measured.height / 2), withAttributes: attributes)
}

func arrowHead(at point: NSPoint, angle: CGFloat, color: NSColor, size: CGFloat = 10) {
    let path = NSBezierPath()
    path.move(to: point)
    path.line(to: NSPoint(x: point.x - size * cos(angle - 0.55), y: point.y - size * sin(angle - 0.55)))
    path.line(to: NSPoint(x: point.x - size * cos(angle + 0.55), y: point.y - size * sin(angle + 0.55)))
    path.close()
    color.setFill()
    path.fill()
}

func drawHeader(tool: String, purpose: String, accent: NSColor) {
    label(tool, at: NSPoint(x: 70, y: 718), size: 28, weight: .bold, color: text, mono: true)
    label(purpose, at: NSPoint(x: 72, y: 685), size: 16, weight: .medium, color: secondary)
    roundedRect(NSRect(x: 70, y: 662, width: 64, height: 4), radius: 2, fill: accent)
}

func drawDocument(_ rect: NSRect, color: NSColor, scale: CGFloat = 1) {
    let adjusted = NSRect(x: rect.midX - rect.width * scale / 2, y: rect.midY - rect.height * scale / 2, width: rect.width * scale, height: rect.height * scale)
    roundedRect(adjusted, radius: 9, fill: surfaceRaised, stroke: color.withAlphaComponent(0.45), width: 1.5)
    let inset = adjusted.width * 0.18
    for row in 0..<3 {
        let y = adjusted.maxY - adjusted.height * 0.28 - CGFloat(row) * adjusted.height * 0.19
        line(NSPoint(x: adjusted.minX + inset, y: y), NSPoint(x: adjusted.maxX - inset - (row == 2 ? adjusted.width * 0.16 : 0), y: y), color: color.withAlphaComponent(row == 0 ? 0.8 : 0.28), width: 2)
    }
}

func drawShield(center: NSPoint, color: NSColor, scale: CGFloat) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: center.x, y: center.y + 25 * scale))
    path.line(to: NSPoint(x: center.x + 22 * scale, y: center.y + 15 * scale))
    path.line(to: NSPoint(x: center.x + 18 * scale, y: center.y - 12 * scale))
    path.curve(to: NSPoint(x: center.x, y: center.y - 27 * scale), controlPoint1: NSPoint(x: center.x + 14 * scale, y: center.y - 21 * scale), controlPoint2: NSPoint(x: center.x + 6 * scale, y: center.y - 25 * scale))
    path.curve(to: NSPoint(x: center.x - 18 * scale, y: center.y - 12 * scale), controlPoint1: NSPoint(x: center.x - 6 * scale, y: center.y - 25 * scale), controlPoint2: NSPoint(x: center.x - 14 * scale, y: center.y - 21 * scale))
    path.line(to: NSPoint(x: center.x - 22 * scale, y: center.y + 15 * scale))
    path.close()
    color.withAlphaComponent(0.14).setFill()
    path.fill()
    path.lineWidth = 2.5
    color.setStroke()
    path.stroke()
    let check = NSBezierPath()
    check.move(to: NSPoint(x: center.x - 9 * scale, y: center.y))
    check.line(to: NSPoint(x: center.x - 2 * scale, y: center.y - 8 * scale))
    check.line(to: NSPoint(x: center.x + 11 * scale, y: center.y + 8 * scale))
    check.lineWidth = 3
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    color.setStroke()
    check.stroke()
}

func drawContextBundle(_ phase: Double) {
    drawHeader(tool: "get_context_bundle", purpose: "Graph → answer-ready context", accent: purple)
    let graphCenter = NSPoint(x: 278, y: 390)
    let neighbors = [
        NSPoint(x: 152, y: 520), NSPoint(x: 270, y: 555), NSPoint(x: 390, y: 505),
        NSPoint(x: 432, y: 375), NSPoint(x: 368, y: 250), NSPoint(x: 225, y: 225),
        NSPoint(x: 118, y: 320), NSPoint(x: 205, y: 415), NSPoint(x: 342, y: 420),
    ]
    let selected = Set([0, 2, 4, 7, 8])
    let appear = spring(Double(interval(phase, 0.02, 0.22)))
    for (index, point) in neighbors.enumerated() {
        let destination = mix(graphCenter, point, appear)
        let active = selected.contains(index)
        line(graphCenter, destination, color: (active ? purple : faint).withAlphaComponent(active ? 0.52 : 0.12), width: active ? 2 : 1, progress: appear)
        circle(destination, radius: active ? 7 : 5, fill: active ? purple : secondary.withAlphaComponent(0.28))
    }
    circle(graphCenter, radius: 18 + 3 * CGFloat(sin(phase * .pi * 5)), fill: purple.withAlphaComponent(0.16), stroke: purple, width: 2)
    circle(graphCenter, radius: 7, fill: text)

    let card = NSRect(x: 570, y: 225, width: 350, height: 340)
    let cardScale = easeOutBack(Double(interval(phase, 0.14, 0.36)))
    let scaledCard = NSRect(x: card.midX - card.width * cardScale / 2, y: card.midY - card.height * cardScale / 2, width: card.width * cardScale, height: card.height * cardScale)
    if cardScale > 0.02 {
        roundedRect(scaledCard, radius: 18, fill: surface, stroke: purple.withAlphaComponent(0.35), width: 1.5)
    }
    if cardScale > 0.82 {
        label("LLM CONTEXT", at: NSPoint(x: 600, y: 520), size: 12, weight: .bold, color: purple, mono: true)
        let rowWidths: [CGFloat] = [250, 212, 268, 188, 232]
        for index in 0..<5 {
            let rowProgress = smooth(Double(interval(phase, 0.30 + Double(index) * 0.055, 0.48 + Double(index) * 0.055)))
            let y = CGFloat(474 - index * 43)
            roundedRect(NSRect(x: 600, y: y, width: rowWidths[index] * rowProgress, height: 11), radius: 5.5, fill: index == 0 ? purple.withAlphaComponent(0.78) : text.withAlphaComponent(0.20))
            roundedRect(NSRect(x: 600, y: y - 16, width: (rowWidths[index] - 38) * rowProgress, height: 5), radius: 2.5, fill: text.withAlphaComponent(0.09))
        }
        label("1,842 / 2,000 tokens", at: NSPoint(x: 600, y: 251), size: 12, weight: .medium, color: secondary, mono: true)
        roundedRect(NSRect(x: 600, y: 238, width: 278, height: 5), radius: 2.5, fill: text.withAlphaComponent(0.08))
        roundedRect(NSRect(x: 600, y: 238, width: 256 * smooth(Double(interval(phase, 0.56, 0.82))), height: 5), radius: 2.5, fill: purple)
    }

    let flow = interval(phase, 0.34, 0.82)
    let arrowStart = NSPoint(x: 458, y: 390)
    let arrowEnd = NSPoint(x: 548, y: 390)
    if flow > 0 {
        line(arrowStart, arrowEnd, color: purple.withAlphaComponent(0.75), width: 2.5, progress: smooth(Double(flow)))
        if flow > 0.7 { arrowHead(at: arrowEnd, angle: 0, color: purple, size: 11) }
        for index in 0..<3 {
            let travel = CGFloat((Double(flow) * 1.45 + Double(index) * 0.23).truncatingRemainder(dividingBy: 1))
            circle(mix(arrowStart, arrowEnd, travel), radius: 3.5, fill: text)
        }
    }
}

func drawRelated(_ phase: Double) {
    drawHeader(tool: "get_related", purpose: "Find the notes your links missed", accent: purple)
    let topic = NSPoint(x: 315, y: 390)
    let linked = [
        NSPoint(x: 142, y: 510), NSPoint(x: 132, y: 320),
        NSPoint(x: 298, y: 570), NSPoint(x: 305, y: 220),
        NSPoint(x: 455, y: 495), NSPoint(x: 458, y: 292),
    ]
    let candidates = [NSPoint(x: 735, y: 505), NSPoint(x: 785, y: 340), NSPoint(x: 660, y: 225)]
    let scores = ["92%", "87%", "81%"]
    let appear = spring(Double(interval(phase, 0.02, 0.22)))
    for (index, point) in linked.enumerated() {
        let current = mix(topic, point, appear)
        line(topic, current, color: purple.withAlphaComponent(0.35), width: 1.5, progress: appear)
        circle(current, radius: index % 2 == 0 ? 7 : 5.5, fill: purple.withAlphaComponent(index % 2 == 0 ? 0.86 : 0.52))
    }
    circle(topic, radius: 24, fill: purple.withAlphaComponent(0.13), stroke: purple, width: 2.5)
    circle(topic, radius: 8, fill: text)
    centeredLabel("TOPIC", center: NSPoint(x: topic.x, y: topic.y - 48), size: 11, weight: .bold, color: secondary, mono: true)

    let scan = interval(phase, 0.18, 0.56)
    if scan > 0 {
        circle(topic, radius: 38 + 340 * scan, fill: NSColor.clear, stroke: purple.withAlphaComponent((1 - scan) * 0.38), width: 2)
    }
    for (index, candidate) in candidates.enumerated() {
        let found = easeOutBack(Double(interval(phase, 0.38 + Double(index) * 0.08, 0.60 + Double(index) * 0.08)))
        if found > 0 {
            let card = NSRect(x: candidate.x - 70 * found, y: candidate.y - 34 * found, width: 140 * found, height: 68 * found)
            roundedRect(card, radius: 13, fill: surface, stroke: cyan.withAlphaComponent(0.48), width: 1.5)
            if found > 0.72 {
                circle(NSPoint(x: candidate.x - 43, y: candidate.y), radius: 7, fill: cyan)
                label(scores[index], at: NSPoint(x: candidate.x - 23, y: candidate.y - 8), size: 17, weight: .bold, color: text, mono: true)
            }
            let route = smooth(Double(interval(phase, 0.48 + Double(index) * 0.07, 0.72 + Double(index) * 0.07)))
            line(topic, NSPoint(x: candidate.x - 70, y: candidate.y), color: cyan.withAlphaComponent(0.72), width: 2.5, progress: route, dashed: true)
        }
    }
    let resultPop = easeOutBack(Double(interval(phase, 0.68, 0.86)))
    if resultPop > 0 {
        roundedRect(NSRect(x: 402, y: 105, width: 196, height: 54 * resultPop), radius: 27, fill: surface, stroke: cyan.withAlphaComponent(0.4))
        centeredLabel("3 suggestions", center: NSPoint(x: 500, y: 132), size: 16, weight: .bold, color: cyan, mono: true)
    }
}

func drawFindPath(_ phase: Double) {
    drawHeader(tool: "find_path", purpose: "The shortest route between any two notes", accent: cyan)
    let points = [
        NSPoint(x: 112, y: 390), NSPoint(x: 245, y: 540), NSPoint(x: 250, y: 390),
        NSPoint(x: 230, y: 245), NSPoint(x: 390, y: 575), NSPoint(x: 410, y: 435),
        NSPoint(x: 390, y: 270), NSPoint(x: 560, y: 545), NSPoint(x: 565, y: 385),
        NSPoint(x: 555, y: 230), NSPoint(x: 720, y: 520), NSPoint(x: 735, y: 360),
        NSPoint(x: 730, y: 210), NSPoint(x: 888, y: 390),
    ]
    let baseEdges = [(0,1),(0,2),(0,3),(1,2),(1,4),(2,3),(2,5),(3,6),(4,5),(4,7),(5,6),(5,7),(5,8),(6,8),(6,9),(7,8),(7,10),(8,9),(8,10),(8,11),(9,11),(9,12),(10,11),(10,13),(11,12),(11,13),(12,13)]
    let route = [0,2,5,8,11,13]
    let appear = spring(Double(interval(phase, 0.02, 0.18)))
    for pair in baseEdges {
        line(points[pair.0], points[pair.1], color: faint, width: 1.2, progress: appear)
    }
    for (index, point) in points.enumerated() {
        circle(point, radius: (index == 0 || index == 13) ? 10 : 5, fill: (index == 0 || index == 13) ? surface : secondary.withAlphaComponent(0.38), stroke: (index == 0 || index == 13) ? cyan : nil, width: 2)
    }
    let build = smooth(Double(interval(phase, 0.20, 0.66))) * CGFloat(route.count - 1)
    for segment in 0..<(route.count - 1) {
        let local = max(0, min(1, build - CGFloat(segment)))
        if local > 0 {
            line(points[route[segment]], points[route[segment + 1]], color: cyan, width: 5, progress: local)
        }
    }
    let signalProgress = interval(phase, 0.40, 0.92) * CGFloat(route.count - 1)
    let signalSegment = min(Int(signalProgress), route.count - 2)
    let signalLocal = signalProgress - CGFloat(signalSegment)
    let signal = mix(points[route[signalSegment]], points[route[signalSegment + 1]], signalLocal)
    circle(signal, radius: 14, fill: cyan.withAlphaComponent(0.13))
    circle(signal, radius: 5.5, fill: text)

    let endpointPop = spring(Double(interval(phase, 0.58, 0.78)))
    if endpointPop > 0 {
        roundedRect(NSRect(x: 78, y: 318, width: 68 * endpointPop, height: 32), radius: 16, fill: surfaceRaised, stroke: cyan.withAlphaComponent(0.4))
        centeredLabel("START", center: NSPoint(x: 112, y: 334), size: 10, weight: .bold, color: cyan, mono: true)
        roundedRect(NSRect(x: 854, y: 318, width: 68 * endpointPop, height: 32), radius: 16, fill: surfaceRaised, stroke: cyan.withAlphaComponent(0.4))
        centeredLabel("FOUND", center: NSPoint(x: 888, y: 334), size: 10, weight: .bold, color: cyan, mono: true)
    }
    let resultPop = easeOutBack(Double(interval(phase, 0.66, 0.84)))
    if resultPop > 0 {
        let rect = NSRect(x: 421, y: 154, width: 158, height: 52 * resultPop)
        roundedRect(rect, radius: 26, fill: surface, stroke: cyan.withAlphaComponent(0.42))
        centeredLabel("5 hops", center: NSPoint(x: 500, y: 180), size: 17, weight: .bold, color: text, mono: true)
    }
}

func drawUnresolved(_ phase: Double) {
    drawHeader(tool: "find_unresolved", purpose: "Expose every broken link — with its source", accent: amber)
    let rows: [(String, String, CGFloat)] = [
        ("Project Atlas", "Missing spec", 520),
        ("Reading list", "Author notes", 380),
        ("Meeting", "Decision log", 240),
    ]
    let sweep = 112 + 776 * smooth(Double(interval(phase, 0.14, 0.70)))
    for (index, row) in rows.enumerated() {
        let pop = easeOutBack(Double(interval(phase, 0.02 + Double(index) * 0.06, 0.22 + Double(index) * 0.06)))
        let source = NSRect(x: 105, y: row.2 - 42, width: 250 * pop, height: 84)
        if pop > 0 {
            roundedRect(source, radius: 13, fill: surface, stroke: text.withAlphaComponent(0.10))
            drawDocument(NSRect(x: 125, y: row.2 - 24, width: 42, height: 52), color: secondary, scale: min(1, pop))
            label(row.0, at: NSPoint(x: 184, y: row.2 - 7), size: 15, weight: .semibold)
        }
        let targetX: CGFloat = 660
        line(NSPoint(x: 365, y: row.2), NSPoint(x: targetX - 28, y: row.2), color: amber.withAlphaComponent(0.55), width: 2, progress: smooth(Double(interval(phase, 0.18 + Double(index) * 0.07, 0.48 + Double(index) * 0.07))), dashed: true)
        let found = unit(Double((sweep - targetX + 55) / 80))
        let targetPop = easeOutBack(Double(found))
        circle(NSPoint(x: targetX, y: row.2), radius: 25 * targetPop, fill: amber.withAlphaComponent(0.12), stroke: amber.withAlphaComponent(targetPop), width: 2.5)
        if targetPop > 0.5 { centeredLabel("?", center: NSPoint(x: targetX, y: row.2), size: 18, weight: .bold, color: amber, mono: true) }
        let resultWidth = 190 * targetPop
        if resultWidth > 8 {
            roundedRect(NSRect(x: 702, y: row.2 - 22, width: resultWidth, height: 44), radius: 10, fill: amber.withAlphaComponent(0.08), stroke: amber.withAlphaComponent(0.28))
            if targetPop > 0.72 { label(row.1, at: NSPoint(x: 720, y: row.2 - 6), size: 14, weight: .medium, color: text) }
        }
    }
    let scanAlpha = sin(Double(interval(phase, 0.12, 0.76)) * .pi)
    line(NSPoint(x: sweep, y: 174), NSPoint(x: sweep, y: 594), color: amber.withAlphaComponent(CGFloat(scanAlpha) * 0.72), width: 2)
    let countPop = easeOutBack(Double(interval(phase, 0.68, 0.86)))
    if countPop > 0 {
        roundedRect(NSRect(x: 394, y: 130, width: 212, height: 54 * countPop), radius: 27, fill: surface, stroke: amber.withAlphaComponent(0.45))
        centeredLabel("7 unresolved", center: NSPoint(x: 500, y: 157), size: 17, weight: .bold, color: amber, mono: true)
    }
}

func drawMoveNote(_ phase: Double) {
    drawHeader(tool: "move_note", purpose: "Move once. Rewrite every inbound link.", accent: cyan)
    let leftFolder = NSRect(x: 75, y: 340, width: 320, height: 250)
    let rightFolder = NSRect(x: 605, y: 340, width: 320, height: 250)
    roundedRect(leftFolder, radius: 18, fill: surface, stroke: text.withAlphaComponent(0.10))
    roundedRect(rightFolder, radius: 18, fill: surface, stroke: cyan.withAlphaComponent(0.25))
    label("Projects/", at: NSPoint(x: 105, y: 540), size: 15, weight: .bold, color: secondary, mono: true)
    label("Archive/", at: NSPoint(x: 635, y: 540), size: 15, weight: .bold, color: cyan, mono: true)

    let start = NSPoint(x: 235, y: 445)
    let end = NSPoint(x: 765, y: 445)
    let travel = spring(Double(interval(phase, 0.20, 0.62)))
    let note = mix(start, end, travel)
    let compress = CGFloat(1 - 0.10 * sin(Double(interval(phase, 0.20, 0.62)) * .pi))
    drawDocument(NSRect(x: note.x - 55, y: note.y - 72, width: 110, height: 144), color: cyan, scale: compress)
    centeredLabel("Atlas", center: NSPoint(x: note.x, y: note.y - 56), size: 13, weight: .bold, color: text, mono: true)

    let panelPop = easeOutBack(Double(interval(phase, 0.05, 0.24)))
    if panelPop > 0 {
        let panel = NSRect(x: 150, y: 120, width: 700, height: 160)
        let adjusted = NSRect(x: panel.midX - panel.width * panelPop / 2, y: panel.midY - panel.height * panelPop / 2, width: panel.width * panelPop, height: panel.height * panelPop)
        roundedRect(adjusted, radius: 16, fill: surface, stroke: text.withAlphaComponent(0.10))
        if panelPop > 0.78 {
            label("INBOUND LINKS", at: NSPoint(x: 180, y: 242), size: 11, weight: .bold, color: secondary, mono: true)
            label("Roadmap.md", at: NSPoint(x: 180, y: 201), size: 13, weight: .medium, color: secondary, mono: true)
            label("Meeting.md", at: NSPoint(x: 180, y: 159), size: 13, weight: .medium, color: secondary, mono: true)
            let update = smooth(Double(interval(phase, 0.56, 0.78)))
            let oldAlpha = 1 - smooth(Double(update) / 0.45)
            let newAlpha = smooth((Double(update) - 0.55) / 0.45)
            if oldAlpha > 0 {
                label("[[Projects/Atlas]]", at: NSPoint(x: 350, y: 201), size: 14, weight: .semibold, color: amber.withAlphaComponent(oldAlpha), mono: true)
                label("(Projects/Atlas.md)", at: NSPoint(x: 350, y: 159), size: 14, weight: .semibold, color: amber.withAlphaComponent(oldAlpha), mono: true)
            }
            if newAlpha > 0 {
                label("[[Archive/Atlas]]", at: NSPoint(x: 350, y: 201), size: 14, weight: .semibold, color: green.withAlphaComponent(newAlpha), mono: true)
                label("(Archive/Atlas.md)", at: NSPoint(x: 350, y: 159), size: 14, weight: .semibold, color: green.withAlphaComponent(newAlpha), mono: true)
                roundedRect(NSRect(x: 698, y: 183, width: 122 * newAlpha, height: 36), radius: 18, fill: green.withAlphaComponent(0.12), stroke: green.withAlphaComponent(0.42))
                if newAlpha > 0.72 {
                    centeredLabel("12 UPDATED", center: NSPoint(x: 759, y: 201), size: 11, weight: .bold, color: green, mono: true)
                }
            }
        }
    }
}

func drawBulkReplace(_ phase: Double) {
    drawHeader(tool: "bulk_replace", purpose: "Dry-run, snapshots, and one-call rollback", accent: green)
    let cardRects = (0..<12).map { index in
        NSRect(x: 88 + CGFloat(index % 4) * 218, y: 238 + CGFloat(index / 4) * 142, width: 170, height: 106)
    }
    let cardsAppear = spring(Double(interval(phase, 0.02, 0.22)))
    for (index, rect) in cardRects.enumerated() {
        let delayed = spring(Double(interval(phase, 0.03 + Double(index) * 0.012, 0.20 + Double(index) * 0.012)))
        let scale = min(cardsAppear, delayed)
        let adjusted = NSRect(x: rect.midX - rect.width * scale / 2, y: rect.midY - rect.height * scale / 2, width: rect.width * scale, height: rect.height * scale)
        if scale > 0.02 {
            roundedRect(adjusted, radius: 11, fill: surface, stroke: text.withAlphaComponent(0.09))
            for row in 0..<3 {
                let y = adjusted.maxY - 27 - CGFloat(row) * 23
                let matched = row == 1
                roundedRect(NSRect(x: adjusted.minX + 20, y: y, width: (matched ? 112 : 92) * scale, height: matched ? 7 : 5), radius: 3, fill: matched ? amber.withAlphaComponent(0.78) : text.withAlphaComponent(0.13))
            }
        }
    }

    let scan = smooth(Double(interval(phase, 0.20, 0.52)))
    let scanY = 630 - 392 * scan
    line(NSPoint(x: 70, y: scanY), NSPoint(x: 930, y: scanY), color: green.withAlphaComponent(CGFloat(sin(Double(scan) * .pi)) * 0.8), width: 3)

    let panelPop = easeOutBack(Double(interval(phase, 0.48, 0.68)))
    if panelPop > 0 {
        let panel = NSRect(x: 275, y: 282, width: 450, height: 230)
        let adjusted = NSRect(x: panel.midX - panel.width * panelPop / 2, y: panel.midY - panel.height * panelPop / 2, width: panel.width * panelPop, height: panel.height * panelPop)
        roundedRect(adjusted, radius: 18, fill: surfaceRaised, stroke: green.withAlphaComponent(0.42), width: 1.5)
        if panelPop > 0.82 {
            let shieldScale = spring(Double(interval(phase, 0.58, 0.76)))
            drawShield(center: NSPoint(x: 336, y: 447), color: green, scale: shieldScale)
            label("DRY RUN", at: NSPoint(x: 382, y: 439), size: 20, weight: .bold, color: text, mono: true)
            roundedRect(NSRect(x: 620, y: 426, width: 70, height: 38), radius: 19, fill: green.withAlphaComponent(0.20), stroke: green.withAlphaComponent(0.55))
            circle(NSPoint(x: 671, y: 445), radius: 14, fill: green)
            line(NSPoint(x: 310, y: 408), NSPoint(x: 690, y: 408), color: text.withAlphaComponent(0.09))
            label("48", at: NSPoint(x: 332, y: 342), size: 38, weight: .bold, color: amber, mono: true)
            label("changes", at: NSPoint(x: 392, y: 353), size: 14, weight: .medium, color: secondary)
            label("0", at: NSPoint(x: 560, y: 342), size: 38, weight: .bold, color: green, mono: true)
            label("writes", at: NSPoint(x: 594, y: 353), size: 14, weight: .medium, color: secondary)
            roundedRect(NSRect(x: 310, y: 312, width: 380, height: 5), radius: 2.5, fill: text.withAlphaComponent(0.08))
            roundedRect(NSRect(x: 310, y: 312, width: 380 * smooth(Double(interval(phase, 0.62, 0.90))), height: 5), radius: 2.5, fill: green)
        }
    }
}

for frame in 0..<totalFrames {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    background.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    let stage = min(frame / framesPerStage, 5)
    let phase = Double(frame % framesPerStage) / Double(framesPerStage - 1)
    let fadeIn: CGFloat = stage == 0 ? 1 : smooth(phase / 0.04)
    let fadeOut = smooth((1 - phase) / 0.04)
    let alpha = min(fadeIn, fadeOut)
    NSGraphicsContext.current?.cgContext.saveGState()
    NSGraphicsContext.current?.cgContext.setAlpha(alpha)
    switch stage {
    case 0: drawContextBundle(phase)
    case 1: drawRelated(phase)
    case 2: drawFindPath(phase)
    case 3: drawUnresolved(phase)
    case 4: drawMoveNote(phase)
    default: drawBulkReplace(phase)
    }
    NSGraphicsContext.current?.cgContext.restoreGState()

    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
    try png.write(to: outputDirectory.appendingPathComponent(String(format: "frame-%03d.png", frame)))
}
