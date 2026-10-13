import type { Point } from '../config'
import type { Bounds } from './autopilot'

// A single-stroke rounded font for writing in the sand with a fingertip.
// Coordinates are in cap-height units with y up from the baseline; strokes are
// drawn in the order and direction a hand would draw them.
type Stroke = Point[]
type Glyph = { width: number; strokes: Stroke[] }

const point = (x: number, y: number): Point => ({ x, y })

/** Polyline through the given coordinate pairs. */
function line(...coordinates: number[]): Stroke {
  const points: Stroke = []
  for (let index = 0; index < coordinates.length; index += 2) points.push(point(coordinates[index], coordinates[index + 1]))
  return points
}

/** Elliptical arc from angle `from` to `to` in degrees (counterclockwise is positive). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Stroke {
  const steps = Math.max(6, Math.ceil(Math.abs(to - from) / 10))
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (from + (to - from) * index / steps) * Math.PI / 180
    return point(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle))
  })
}

/** Smooth Catmull-Rom curve through the given coordinate pairs. */
function curve(...coordinates: number[]): Stroke {
  const controls = line(...coordinates)
  const points: Stroke = []
  for (let index = 0; index < controls.length - 1; index++) {
    const p0 = controls[Math.max(0, index - 1)]
    const p1 = controls[index]
    const p2 = controls[index + 1]
    const p3 = controls[Math.min(controls.length - 1, index + 2)]
    for (let step = 0; step < 8; step++) {
      const t = step / 8
      const t2 = t * t
      const t3 = t2 * t
      const blend = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      points.push(point(blend(p0.x, p1.x, p2.x, p3.x), blend(p0.y, p1.y, p2.y, p3.y)))
    }
  }
  points.push(controls[controls.length - 1])
  return points
}

/** Joins strokes end to start into one continuous stroke. */
const join = (...strokes: Stroke[]): Stroke => strokes.flat()
/** A dot is a tiny circle, since a fingertip held still leaves no mark. */
const dot = (x: number, y: number) => arc(x, y, 0.035, 0.035, 0, 360)

const glyphs: Record<string, Glyph> = {
  A: { width: 0.8, strokes: [line(0, 0, 0.4, 1, 0.8, 0), line(0.16, 0.38, 0.64, 0.38)] },
  B: { width: 0.62, strokes: [line(0, 0, 0, 1), join(line(0, 1, 0.32, 1), arc(0.32, 0.77, 0.24, 0.23, 90, -90), line(0.32, 0.54, 0, 0.54)), join(line(0, 0.54, 0.34, 0.54), arc(0.34, 0.27, 0.28, 0.27, 90, -90), line(0.34, 0, 0, 0))] },
  C: { width: 0.78, strokes: [arc(0.42, 0.5, 0.42, 0.5, 45, 315)] },
  D: { width: 0.72, strokes: [join(line(0, 0, 0, 1, 0.25, 1), arc(0.25, 0.5, 0.47, 0.5, 90, -90), line(0.25, 0, 0, 0))] },
  E: { width: 0.6, strokes: [line(0.6, 1, 0, 1, 0, 0, 0.6, 0), line(0, 0.52, 0.48, 0.52)] },
  F: { width: 0.58, strokes: [line(0.58, 1, 0, 1, 0, 0), line(0, 0.52, 0.46, 0.52)] },
  G: { width: 0.84, strokes: [join(arc(0.42, 0.5, 0.42, 0.5, 40, 350), line(0.834, 0.413, 0.5, 0.413))] },
  H: { width: 0.72, strokes: [line(0, 1, 0, 0), line(0.72, 1, 0.72, 0), line(0, 0.52, 0.72, 0.52)] },
  I: { width: 0.1, strokes: [line(0.05, 1, 0.05, 0)] },
  J: { width: 0.5, strokes: [join(line(0.5, 1, 0.5, 0.3), arc(0.25, 0.3, 0.25, 0.3, 0, -180))] },
  K: { width: 0.66, strokes: [line(0, 1, 0, 0), line(0.66, 1, 0, 0.42), line(0.2, 0.6, 0.68, 0)] },
  L: { width: 0.56, strokes: [line(0, 1, 0, 0, 0.56, 0)] },
  M: { width: 0.9, strokes: [line(0, 0, 0, 1, 0.45, 0.35, 0.9, 1, 0.9, 0)] },
  N: { width: 0.74, strokes: [line(0, 0, 0, 1, 0.74, 0, 0.74, 1)] },
  O: { width: 0.9, strokes: [arc(0.45, 0.5, 0.45, 0.5, 90, 450)] },
  P: { width: 0.62, strokes: [join(line(0, 0, 0, 1, 0.3, 1), arc(0.3, 0.75, 0.26, 0.25, 90, -90), line(0.3, 0.5, 0, 0.5))] },
  Q: { width: 0.92, strokes: [arc(0.45, 0.5, 0.45, 0.5, 90, 450), line(0.55, 0.25, 0.92, -0.05)] },
  R: { width: 0.66, strokes: [join(line(0, 0, 0, 1, 0.3, 1), arc(0.3, 0.75, 0.26, 0.25, 90, -90), line(0.3, 0.5, 0, 0.5)), line(0.28, 0.5, 0.66, 0)] },
  S: { width: 0.62, strokes: [curve(0.58, 0.86, 0.42, 1, 0.18, 0.98, 0.04, 0.82, 0.1, 0.62, 0.31, 0.52, 0.52, 0.42, 0.6, 0.22, 0.48, 0.03, 0.24, 0, 0.02, 0.12)] },
  T: { width: 0.72, strokes: [line(0, 1, 0.72, 1), line(0.36, 1, 0.36, 0)] },
  U: { width: 0.72, strokes: [join(line(0, 1, 0, 0.35), arc(0.36, 0.35, 0.36, 0.35, 180, 360), line(0.72, 0.35, 0.72, 1))] },
  V: { width: 0.76, strokes: [line(0, 1, 0.38, 0, 0.76, 1)] },
  W: { width: 1, strokes: [line(0, 1, 0.22, 0, 0.5, 0.7, 0.78, 0, 1, 1)] },
  X: { width: 0.7, strokes: [line(0, 1, 0.7, 0), line(0.7, 1, 0, 0)] },
  Y: { width: 0.72, strokes: [line(0, 1, 0.36, 0.5, 0.72, 1), line(0.36, 0.5, 0.36, 0)] },
  Z: { width: 0.66, strokes: [line(0, 1, 0.66, 1, 0, 0, 0.66, 0)] },
  0: { width: 0.62, strokes: [arc(0.31, 0.5, 0.31, 0.5, 90, 450)] },
  1: { width: 0.3, strokes: [line(0, 0.8, 0.22, 1, 0.22, 0)] },
  2: { width: 0.62, strokes: [join(curve(0.02, 0.78, 0.12, 0.94, 0.32, 1, 0.52, 0.92, 0.58, 0.72, 0.45, 0.48, 0, 0), line(0, 0, 0.62, 0))] },
  3: { width: 0.58, strokes: [join(curve(0.04, 0.88, 0.25, 1, 0.5, 0.94, 0.55, 0.75, 0.4, 0.57, 0.2, 0.54), curve(0.2, 0.54, 0.45, 0.5, 0.6, 0.3, 0.52, 0.08, 0.3, 0, 0.02, 0.1))] },
  4: { width: 0.64, strokes: [line(0.48, 0, 0.48, 1, 0, 0.3, 0.64, 0.3)] },
  5: { width: 0.6, strokes: [join(line(0.56, 1, 0.08, 1, 0.03, 0.55), curve(0.03, 0.55, 0.3, 0.62, 0.55, 0.5, 0.6, 0.28, 0.48, 0.06, 0.25, 0, 0.02, 0.1))] },
  6: { width: 0.6, strokes: [curve(0.52, 0.94, 0.32, 1, 0.1, 0.85, 0.02, 0.5, 0.06, 0.2, 0.3, 0, 0.54, 0.1, 0.6, 0.32, 0.48, 0.52, 0.25, 0.55, 0.06, 0.4)] },
  7: { width: 0.6, strokes: [line(0, 1, 0.6, 1, 0.2, 0)] },
  8: { width: 0.6, strokes: [curve(0.3, 0.54, 0.52, 0.66, 0.54, 0.88, 0.3, 1, 0.08, 0.88, 0.1, 0.66, 0.3, 0.54, 0.56, 0.4, 0.6, 0.18, 0.3, 0, 0.02, 0.18, 0.06, 0.4, 0.3, 0.54)] },
  9: { width: 0.6, strokes: [curve(0.56, 0.6, 0.35, 0.46, 0.1, 0.52, 0.02, 0.75, 0.18, 0.98, 0.42, 0.98, 0.56, 0.78, 0.58, 0.5, 0.5, 0.2, 0.28, 0, 0.06, 0.06)] },
  '.': { width: 0.1, strokes: [dot(0.05, 0.04)] },
  ',': { width: 0.12, strokes: [line(0.09, 0.08, 0.02, -0.14)] },
  '!': { width: 0.1, strokes: [line(0.05, 1, 0.05, 0.3), dot(0.05, 0.04)] },
  '?': { width: 0.52, strokes: [curve(0.02, 0.8, 0.15, 0.97, 0.35, 1, 0.5, 0.85, 0.45, 0.62, 0.25, 0.48, 0.25, 0.3), dot(0.25, 0.04)] },
  "'": { width: 0.1, strokes: [line(0.05, 1, 0.05, 0.74)] },
  '-': { width: 0.4, strokes: [line(0.04, 0.45, 0.36, 0.45)] },
  '+': { width: 0.5, strokes: [line(0, 0.45, 0.5, 0.45), line(0.25, 0.2, 0.25, 0.7)] },
  ':': { width: 0.1, strokes: [dot(0.05, 0.6), dot(0.05, 0.06)] },
  '&': { width: 0.7, strokes: [curve(0.7, 0, 0.3, 0.42, 0.18, 0.62, 0.2, 0.86, 0.36, 0.98, 0.5, 0.86, 0.46, 0.68, 0.2, 0.48, 0.02, 0.28, 0.08, 0.06, 0.3, 0, 0.5, 0.1, 0.68, 0.36)] },
  '♥': { width: 0.82, strokes: [curve(0.41, 0.02, 0.12, 0.34, 0, 0.64, 0.08, 0.88, 0.25, 0.96, 0.41, 0.8, 0.57, 0.96, 0.74, 0.88, 0.82, 0.64, 0.7, 0.34, 0.41, 0.02)] },
}
const spaceWidth = 0.45
const tracking = 0.2
const lineHeight = 1.5

/** Characters the font can write; everything else is dropped (lowercase is uppercased). */
export function normalizeMessage(text: string) {
  return text.replace(/<3/g, '♥').toUpperCase().split('').filter((character) => character === ' ' || character in glyphs).join('').replace(/\s+/g, ' ').trim()
}

/** Width of a line of text; a space contributes `spaceWidth` between words. */
function textWidth(text: string) {
  let width = 0
  for (const character of text) width += character === ' ' ? spaceWidth - tracking : glyphs[character].width + tracking
  return Math.max(0, width - tracking)
}

function wrap(words: string[], lines: number) {
  const total = textWidth(words.join(' '))
  const target = total / lines
  const result: string[][] = [[]]
  let width = 0
  for (const word of words) {
    const extra = (result[result.length - 1].length ? spaceWidth : 0) + textWidth(word)
    if (result[result.length - 1].length && width + extra / 2 > target && result.length < lines) { result.push([]); width = 0 }
    result[result.length - 1].push(word)
    width += (result[result.length - 1].length > 1 ? spaceWidth : 0) + textWidth(word)
  }
  return result.map((words) => words.join(' '))
}

export type Lettering = { paths: Point[][]; capHeight: number }

/**
 * Lays a message out as finger paths centered in `bounds`, wrapping onto up to
 * four lines to make the letters as large as possible (capped at 9 cm).
 */
export function letteringPaths(text: string, bounds: Bounds): Lettering {
  const message = normalizeMessage(text)
  if (!message) return { paths: [], capHeight: 0 }
  const words = message.split(' ')
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  let best = { lines: [message], capHeight: 0 }
  for (let count = 1; count <= Math.min(4, words.length); count++) {
    const lines = wrap(words, count)
    const widest = Math.max(...lines.map(textWidth))
    const capHeight = Math.min(0.09, width / Math.max(widest, 0.5), height / (lines.length * lineHeight - (lineHeight - 1)))
    if (capHeight > best.capHeight) best = { lines, capHeight }
  }
  const { lines, capHeight } = best
  const blockHeight = (lines.length * lineHeight - (lineHeight - 1)) * capHeight
  const top = (bounds.minY + bounds.maxY) / 2 - blockHeight / 2
  const paths: Point[][] = []
  lines.forEach((text, row) => {
    // Screen up is bed -y, so glyph y (up) maps to decreasing bed y.
    const baseline = top + (row * lineHeight + 1) * capHeight
    let x = (bounds.minX + bounds.maxX) / 2 - textWidth(text) * capHeight / 2
    for (const character of text) {
      if (character === ' ') { x += (spaceWidth - tracking) * capHeight; continue }
      const glyph = glyphs[character]
      for (const stroke of glyph.strokes) paths.push(stroke.map((p) => ({ x: x + p.x * capHeight, y: baseline - p.y * capHeight })))
      x += (glyph.width + tracking) * capHeight
    }
  })
  return { paths, capHeight }
}
