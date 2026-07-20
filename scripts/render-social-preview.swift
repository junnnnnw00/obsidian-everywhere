#!/usr/bin/env swift

import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: render-social-preview.swift <background.png> <output.png>\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = NSImage(contentsOf: inputURL) else {
    fputs("Could not open background image.\n", stderr)
    exit(1)
}

let width = 1280
let height = 640
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
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

let canvas = NSRect(x: 0, y: 0, width: width, height: height)
NSColor(calibratedRed: 0.035, green: 0.035, blue: 0.065, alpha: 1).setFill()
canvas.fill()
source.draw(in: canvas, from: .zero, operation: .sourceOver, fraction: 1)

let veil = NSGradient(colorsAndLocations:
    (NSColor(calibratedWhite: 0, alpha: 0.0), 0.0),
    (NSColor(calibratedRed: 0.025, green: 0.025, blue: 0.055, alpha: 0.72), 0.35),
    (NSColor(calibratedRed: 0.025, green: 0.025, blue: 0.055, alpha: 0.96), 1.0)
)
veil?.draw(in: NSRect(x: 600, y: 0, width: 680, height: 640), angle: 0)

func draw(_ text: String, rect: NSRect, font: NSFont, color: NSColor, spacing: CGFloat = 0) {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
        .kern: spacing,
        .paragraphStyle: style,
    ]
    text.draw(in: rect, withAttributes: attributes)
}

draw(
    "OPEN-SOURCE MCP FOR OBSIDIAN",
    rect: NSRect(x: 748, y: 478, width: 460, height: 30),
    font: NSFont.systemFont(ofSize: 17, weight: .semibold),
    color: NSColor(calibratedRed: 0.60, green: 0.50, blue: 1.0, alpha: 1),
    spacing: 1.8
)
draw(
    "OBSIDIAN\nEVERYWHERE",
    rect: NSRect(x: 744, y: 290, width: 470, height: 180),
    font: NSFont.systemFont(ofSize: 66, weight: .black),
    color: .white,
    spacing: -1.2
)
draw(
    "Your vault. Every AI. Everywhere.",
    rect: NSRect(x: 748, y: 228, width: 460, height: 42),
    font: NSFont.systemFont(ofSize: 25, weight: .medium),
    color: NSColor(calibratedWhite: 0.84, alpha: 1)
)
draw(
    "31 GRAPH-NATIVE TOOLS  •  LOCAL + REMOTE",
    rect: NSRect(x: 748, y: 154, width: 470, height: 30),
    font: NSFont.monospacedSystemFont(ofSize: 14, weight: .semibold),
    color: NSColor(calibratedRed: 0.55, green: 0.76, blue: 1.0, alpha: 1),
    spacing: 0.5
)

NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    exit(1)
}
try png.write(to: outputURL)
