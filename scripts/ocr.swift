// Poster OCR verifier.
//
// Why this exists: DallyReport renders posters to pixels, and a poster's only
// real acceptance test is whether the glyphs in those pixels are the glyphs we
// asked for. Reading the PNG back with an OCR pass is the one check that is
// independent of the thing being checked — it does not share a code path with
// the renderer, so a corrupted 字形 shows up as corrupted text here.
//
// Reads a PNG and prints one `text<TAB>confidence<TAB>y` line per recognized
// block, top-to-bottom, so callers can diff the output against the intended
// strings. Double/triple scale the input before recognition: Vision's
// confidence on small CJK type is scale-sensitive, and a glyph that OCRs
// differently at two scales is genuinely ambiguous rather than merely small.
//
// Build:  swiftc -O scripts/ocr.swift -o /tmp/dallyocr
// Usage:  /tmp/dallyocr <image.png> [scale]      (scale defaults to 2)

import Foundation
import Vision
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("ocr: \(message)\n".data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: ocr <image.png> [scale]") }
let path = args[1]
let scale = args.count >= 3 ? (Double(args[2]) ?? 2.0) : 2.0
guard scale >= 1, scale <= 8 else { fail("scale must be between 1 and 8") }

guard let image = NSImage(contentsOfFile: path) else { fail("cannot read image: \(path)") }
let base = NSImage(size: image.size)
base.lockFocus()
image.draw(in: NSRect(origin: .zero, size: image.size))
base.unlockFocus()
guard let baseCg = base.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fail("cannot rasterize image: \(path)")
}

let pixelW = Int(Double(baseCg.width) * scale)
let pixelH = Int(Double(baseCg.height) * scale)
guard let ctx = CGContext(
  data: nil, width: pixelW, height: pixelH, bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else { fail("cannot allocate \(pixelW)x\(pixelH) bitmap") }
ctx.interpolationQuality = .high
ctx.draw(baseCg, in: CGRect(x: 0, y: 0, width: pixelW, height: pixelH))
guard let scaled = ctx.makeImage() else { fail("cannot scale image") }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// CJK is the point of this tool: without the language hint Vision guesses Latin
// and shreds Chinese into per-character boxes with low confidence.
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: scaled, options: [:])
do {
  try handler.perform([request])
} catch {
  fail("recognition failed: \(error)")
}

guard let observations = request.results else { exit(0) }
let blocks: [(Double, String, Float)] = observations.compactMap { observation in
  guard let candidate = observation.topCandidates(1).first else { return nil }
  return (Double(observation.boundingBox.midY), candidate.string, candidate.confidence)
}
for (_, text, confidence) in blocks.sorted(by: { $0.0 > $1.0 }) {
  let clean = text.replacingOccurrences(of: "\t", with: " ")
  print(String(format: "%@\t%.2f", clean, confidence))
}
