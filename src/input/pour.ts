import { POUR, SAND, SYMMETRIES, type Deposit, type Point, type Symmetry } from '../config'
import { symmetryImages, transformVector } from './symmetry'

type Stream = { point: Point; mode: 'pour' | 'drip'; last: number; carry: number }
export type Drip = { time: number }

const limit = SAND.extent / 2 - 0.01
const referenceSize = SAND.radius

/**
 * Held-pointer sand sources. Pouring lays a continuous Gaussian stream of dry
 * sand under the pointer every frame, so a still pointer grows a cone that
 * avalanches at the angle of repose and a moving one draws a sand line.
 * Dripping releases blobs of saturated slurry at a steady cadence; as their
 * water drains they set into steep damp sand and stack into drip castles.
 * Both are scaled by the size slider and replicated by the drawing symmetry.
 */
export class SandPourer {
  size: number = SAND.radius
  symmetry: Symmetry = SYMMETRIES[0]
  private readonly streams = new Map<number, Stream>()
  private readonly drips: Drip[] = []
  private readonly random: () => number

  constructor(random: () => number = Math.random) { this.random = random }

  get pouring() { for (const stream of this.streams.values()) if (stream.mode === 'pour') return true; return false }

  begin(point: Point, time: number, pointerId: number, mode: 'pour' | 'drip') {
    // A drip lands as soon as the pointer goes down.
    this.streams.set(pointerId, { point: this.bound(point), mode, last: time, carry: mode === 'drip' ? 1 : 0 })
  }

  move(point: Point, pointerId: number) {
    const stream = this.streams.get(pointerId)
    if (stream) stream.point = this.bound(point)
  }

  end(pointerId: number) { this.streams.delete(pointerId) }

  cancel(pointerId?: number) {
    if (pointerId === undefined) { this.streams.clear(); this.drips.length = 0 }
    else this.streams.delete(pointerId)
  }

  /** Sand landed since the previous call, replicated by symmetry, at most `max` deposits. */
  take(now: number, max: number): Deposit[] {
    const images = symmetryImages(this.symmetry)
    const scale = this.size / referenceSize
    const deposits: Deposit[] = []
    const emit = (center: Point, deposit: Omit<Deposit, 'x' | 'y'>) => {
      if (deposits.length + images.length > max) return false
      for (const image of images) deposits.push({ ...deposit, ...this.bound(transformVector(image, center)) })
      return true
    }
    for (const stream of this.streams.values()) {
      const seconds = Math.max(0, Math.min(0.1, (now - stream.last) / 1000))
      stream.last = now
      if (stream.mode === 'pour') {
        const radius = this.size * POUR.streamRadius
        const volume = POUR.rate * scale * scale * seconds
        if (volume > 0) emit(stream.point, { radius, amount: 0, pit: 0, pitRadius: 0, sand: volume / (Math.PI * radius * radius / 4) })
        continue
      }
      stream.carry += seconds * POUR.dripRate
      while (stream.carry >= 1) {
        const radius = this.size * POUR.dripRadius
        const volume = POUR.dripVolume * scale ** 3
        // Drips never land exactly on one another, which is what makes a drip
        // castle's spires lumpy.
        const scatter = radius * POUR.dripScatter * Math.sqrt(this.random())
        const around = this.random() * Math.PI * 2
        const landing = { x: stream.point.x + Math.cos(around) * scatter, y: stream.point.y + Math.sin(around) * scatter }
        if (!emit(landing, { radius, amount: POUR.dripWetness, pit: 0, pitRadius: 0, sand: volume / (Math.PI * radius * radius / 4) })) break
        stream.carry -= 1
        this.drips.push({ time: now })
      }
    }
    return deposits
  }

  /** Pour stream emitter positions for the falling-grain visual, with symmetry. */
  emitters(): Point[] {
    const images = symmetryImages(this.symmetry)
    const points: Point[] = []
    for (const stream of this.streams.values()) {
      if (stream.mode !== 'pour') continue
      for (const image of images) points.push(this.bound(transformVector(image, stream.point)))
    }
    return points.slice(0, POUR.maxEmitters)
  }

  /** Drips that landed since the last call, for their sound. */
  takeDrips() { return this.drips.splice(0) }

  private bound(point: Point): Point {
    return { x: Math.max(-limit, Math.min(limit, point.x)), y: Math.max(-limit, Math.min(limit, point.y)) }
  }
}
