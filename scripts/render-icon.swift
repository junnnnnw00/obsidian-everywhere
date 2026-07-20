#!/usr/bin/env swift

import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: render-icon.swift <background.png> <output.png>\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = NSImage(contentsOf: inputURL),
      let bitmap = NSBitmapImageRep(
          bitmapDataPlanes: nil,
          pixelsWide: 512,
          pixelsHigh: 512,
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
let canvas = NSRect(x: 0, y: 0, width: 512, height: 512)
NSColor(calibratedRed: 0.035, green: 0.035, blue: 0.065, alpha: 1).setFill()
canvas.fill()

// Crop the source's left square, which contains the crystal and densest graph.
let sourceCrop = NSRect(x: 0, y: 0, width: source.size.height, height: source.size.height)
source.draw(in: canvas, from: sourceCrop, operation: .sourceOver, fraction: 1)

let vignette = NSGradient(colorsAndLocations:
    (NSColor(calibratedWhite: 0, alpha: 0.0), 0.55),
    (NSColor(calibratedWhite: 0, alpha: 0.28), 1.0)
)
vignette?.draw(in: canvas, relativeCenterPosition: .zero)
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    exit(1)
}
try png.write(to: outputURL)
