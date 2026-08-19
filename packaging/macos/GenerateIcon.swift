import AppKit
import Darwin
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: GenerateIcon.swift <output.png>\n", stderr)
    exit(2)
}

let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()

let background = NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 210, yRadius: 210)
NSColor(calibratedRed: 0.10, green: 0.42, blue: 0.96, alpha: 1).setFill()
background.fill()

NSColor.white.setStroke()
let links = NSBezierPath()
links.lineWidth = 34
links.lineCapStyle = .round
links.move(to: NSPoint(x: 300, y: 520))
links.line(to: NSPoint(x: 512, y: 700))
links.line(to: NSPoint(x: 724, y: 520))
links.line(to: NSPoint(x: 512, y: 320))
links.close()
links.stroke()

for point in [NSPoint(x: 300, y: 520), NSPoint(x: 512, y: 700), NSPoint(x: 724, y: 520), NSPoint(x: 512, y: 320)] {
    let node = NSBezierPath(ovalIn: NSRect(x: point.x - 62, y: point.y - 62, width: 124, height: 124))
    NSColor.white.setFill()
    node.fill()
    NSColor(calibratedRed: 0.10, green: 0.42, blue: 0.96, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: point.x - 24, y: point.y - 24, width: 48, height: 48)).fill()
}

image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("failed to render icon\n", stderr)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
