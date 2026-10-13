import { POUR, SAND, SYMMETRIES, type Deposit, type Point, type Symmetry } from '../config'
import { symmetryImages, transformVector } from './symmetry'
import { HeldPath } from './held-path'

type Stream = { path: HeldPath; mode: 'pour' | 'drip'; last: number; carry: number }
type PendingDeposit = { pointerId: number; point: Point; deposit: Omit<Deposit, 'x' | 'y'>; symmetry: Symmetry; drip: boolean }
export type Drip = { time: number }

const limit = SAND.extent / 2 - 0.01
const referenceSize = SAND.radius
// Bound retained input during blocked frames; prefer recent gestures on overflow.
const maxPending = 64
const maxSeconds = 0.1

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
  private readonly pending: PendingDeposit[] = []
  private nextStream = 0
  private readonly random: () => number

  constructor(random: () => number = Math.random) { this.random = random }

  get pouring() { for (const stream of this.streams.values()) if (stream.mode === 'pour') return true; return false }

  begin(point: Point, time: number, pointerId: number, mode: 'pour' | 'drip') {
    // A drip lands as soon as the pointer goes down.
    this.streams.set(pointerId, { path: new HeldPath(this.bound(point), time), mode, last: time, carry: mode === 'drip' ? 1 : 0 })
  }

  move(point: Point, pointerId: number, time?: number) {
    const stream = this.streams.get(pointerId)
    if (stream) stream.path.move(this.bound(point), time)
  }

  end(pointerId: number, time?: number) {
    const stream = this.streams.get(pointerId)
    if (!stream) return
    this.streams.delete(pointerId)
    this.advance(stream, time ?? stream.last)
    while (this.ready(stream)) {
      if (this.pending.length === maxPending) this.pending.shift()
      this.pending.push({ ...this.deposit(stream), pointerId, symmetry: this.symmetry, drip: stream.mode === 'drip' })
    }
  }

  cancel(pointerId?: number) {
    if (pointerId === undefined) {
      this.streams.clear()
      this.pending.length = 0
      this.drips.length = 0
      this.nextStream = 0
      return
    }
    this.streams.delete(pointerId)
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (this.pending[index].pointerId === pointerId) this.pending.splice(index, 1)
    }
  }

  /** Sand landed since the previous call, replicated by symmetry, at most `max` deposits. */
  take(now: number, max: number): Deposit[] {
    const budget = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0
    const deposits: Deposit[] = []
    const emit = (point: Point, deposit: Omit<Deposit, 'x' | 'y'>, symmetry: Symmetry, drip: boolean) => {
      const images = symmetryImages(symmetry)
      if (deposits.length + images.length > budget) return false
      for (const image of images) deposits.push({ ...deposit, ...this.bound(transformVector(image, point)),
        ...(deposit.from ? { from: this.bound(transformVector(image, deposit.from)) } : {}),
      })
      if (drip) {
        if (this.drips.length === maxPending) this.drips.shift()
        this.drips.push({ time: now })
      }
      return true
    }
    let kept = 0
    for (const pending of this.pending) {
      if (!emit(pending.point, pending.deposit, pending.symmetry, pending.drip)) this.pending[kept++] = pending
    }
    this.pending.length = kept
    const streams = Array.from(this.streams.values())
    const start = this.nextStream % Math.max(1, streams.length)
    const copies = symmetryImages(this.symmetry).length
    for (let offset = 0; offset < streams.length; offset++) {
      const index = (start + offset) % streams.length
      const stream = streams[index]
      this.advance(stream, now)
      while (this.ready(stream) && deposits.length + copies <= budget) {
        const { point, deposit } = this.deposit(stream)
        emit(point, deposit, this.symmetry, stream.mode === 'drip')
        this.nextStream = index + 1
      }
    }
    return deposits
  }

  private advance(stream: Stream, now: number) {
    const time = Number.isFinite(now) ? Math.max(stream.last, now) : stream.last
    const seconds = Math.min(maxSeconds, (time - stream.last) / 1000)
    stream.last = time
    if (stream.mode === 'pour') stream.path.advance(time)
    else stream.carry = Math.min(2, stream.carry + seconds * POUR.dripRate)
  }

  private ready(stream: Stream) { return stream.mode === 'pour' ? stream.path.ready : stream.carry >= 1 }

  private deposit(stream: Stream): Pick<PendingDeposit, 'point' | 'deposit'> {
    const scale = this.size / referenceSize
    const drip = stream.mode === 'drip'
    const segment = drip ? undefined : stream.path.take()
    const radius = this.size * (drip ? POUR.dripRadius : POUR.streamRadius)
    const volume = drip ? POUR.dripVolume * scale ** 3 : POUR.rate * scale * scale * (segment?.seconds ?? 0)
    let point = segment?.to ?? stream.path.point
    if (drip) {
      stream.carry--
      // Small landing scatter gives drip castles their lumpy spires.
      const scatter = radius * POUR.dripScatter * Math.sqrt(this.random())
      const around = this.random() * Math.PI * 2
      point = { x: point.x + Math.cos(around) * scatter, y: point.y + Math.sin(around) * scatter }
    }
    return { point, deposit: { radius, amount: drip ? POUR.dripWetness : 0, pit: 0, pitRadius: 0, sand: volume / (Math.PI * radius * radius / 4),
      ...(segment ? { from: segment.from } : {}),
    } }
  }

  /** Pour stream emitter positions for the falling-grain visual, with symmetry. */
  emitters(): Point[] {
    const images = symmetryImages(this.symmetry)
    const points: Point[] = []
    for (const stream of this.streams.values()) {
      if (stream.mode !== 'pour') continue
      for (const image of images) points.push(this.bound(transformVector(image, stream.path.point)))
    }
    return points.slice(0, POUR.maxEmitters)
  }

  /** Drips that landed since the last call, for their sound. */
  takeDrips() { return this.drips.splice(0) }

  private bound(point: Point): Point {
    return { x: Math.max(-limit, Math.min(limit, point.x)), y: Math.max(-limit, Math.min(limit, point.y)) }
  }
}
