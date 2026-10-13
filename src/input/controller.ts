import type { SandSound } from '../audio/sound'
import type { SandCamera } from '../render/camera'
import { DIG, MATERIALS, MOLD, MOLDS, MOLD_PREVIEW_KIND, POUR, SAND, SYMMETRIES, TOOLS, TOOL_KEYS, TOOL_KIND, TOOL_SHAPE, idleStroke, isDepositTool, isEarthTool, type DepositTool, type MoldShape, type Point, type Stroke, type Tool } from '../config'
import { DaylightCycle } from '../render/daylight'
import type { ToolPreview } from '../render/renderer'
import type { InterfaceElements } from '../ui/interface'
import { AUTOPILOT_SPEED, GARDEN_PATTERNS, ZenAutopilot, gardenPaths, gardenReach, type Bounds } from './autopilot'
import { Earthworks } from './earthworks'
import { letteringPaths, normalizeMessage } from './lettering'
import { SandPourer } from './pour'
import { StrokeQueue } from './strokes'
import { WaterThrower } from './water'

const keyboardPointerId = -1
// Preview outline radii of the deposit tools relative to the size slider: the
// water pool, the pour stream, and a drip blob.
const depositReach: Record<DepositTool, number> = { water: 2.2, pour: POUR.streamRadius, drip: POUR.dripRadius * 1.6 }
// Writing pace, and the finger radius as a fraction of the letter cap height.
const writingSpeed = 0.22
const writingRadius = 0.085

/** Bed edits the runtime applies in order at the start of the next frame. */
export type InputAction = 'capture' | 'undo' | 'redo' | 'save'

export class InputController {
  readonly strokes = new StrokeQueue()
  readonly water = new WaterThrower()
  readonly pourer = new SandPourer()
  readonly earthworks = new Earthworks()
  readonly daylight = new DaylightCycle()
  /** The sand everything is made of: beach sand or a kinetic sand color. */
  material = MATERIALS[0]
  readonly autopilot = new ZenAutopilot(this.strokes)
  showPointer = false
  tool: Tool = 'finger'
  private readonly actions: InputAction[] = []
  /** Pointers whose gesture is a deposit tool, latched at pointer down. */
  private readonly depositPointers = new Map<number, DepositTool>()
  /** Pointers that are digging (a bucket tap places its mold at pointer down). */
  private readonly diggingPointers = new Set<number>()
  private readonly camera: SandCamera
  private hovering = false
  private heading = { x: 1, y: 0 }
  private symmetryIndex = 0
  private patternIndex = 0
  private readonly pointers = new Set<number>()
  private readonly pointerStartedAt = new Map<number, number>()
  private readonly suppressedPointers = new Set<number>()
  private readonly controller = new AbortController()
  private readonly canvas: HTMLCanvasElement
  private keyboardDrawing = false
  private interactive = true
  private interactiveSince = -Infinity

  constructor(ui: InterfaceElements, camera: SandCamera, sound: SandSound, reset: () => void) {
    const { signal } = this.controller
    const canvas = ui.canvas
    this.canvas = canvas
    this.camera = camera
    const touchFeedback = (event: PointerEvent, milliseconds: number) => { if (event.pointerType === 'touch') navigator.vibrate?.(milliseconds) }
    const position = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return camera.screenToBed(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height)
    }
    const pressure = (event: PointerEvent) => event.pointerType === 'pen' ? event.pressure : 0.75
    const eventTimelineTime = (event: Event) => event.timeStamp > performance.timeOrigin ? event.timeStamp - performance.timeOrigin : event.timeStamp
    const isOlderThanCurrentPointer = (event: PointerEvent) => {
      const startedAt = this.pointerStartedAt.get(event.pointerId)
      if (startedAt === undefined) return false
      const eventTime = eventTimelineTime(event)
      return Number.isFinite(eventTime) && eventTime > 0 && eventTime < startedAt
    }
    canvas.addEventListener('pointerdown', (event) => {
      const eventTime = eventTimelineTime(event)
      // A delayed event from an older WebKit pointer generation must never
      // suppress or replace an already accepted contact that reused the ID.
      if (this.pointers.has(event.pointerId)) return
      const staleLockedEvent = Number.isFinite(eventTime) && eventTime > 0 && eventTime < this.interactiveSince
      if (!this.interactive || staleLockedEvent) {
        this.suppressedPointers.add(event.pointerId)
        return
      }
      this.suppressedPointers.delete(event.pointerId)
      if (event.pointerType === 'mouse' && event.button !== 0) return
      const startedAt = Number.isFinite(eventTime) && eventTime > 0 ? eventTime : performance.now()
      // One undo step per gesture: several simultaneous fingers share it.
      if (!this.pointers.size && !this.keyboardDrawing) this.actions.push('capture')
      this.pointers.add(event.pointerId)
      this.pointerStartedAt.set(event.pointerId, startedAt)
      canvas.setPointerCapture(event.pointerId)
      canvas.focus({ preventScroll: true })
      if (isDepositTool(this.tool)) {
        this.depositPointers.set(event.pointerId, this.tool)
        this.strokes.position = position(event)
        this.beginDeposit(this.tool, this.strokes.position, startedAt, event.pointerId)
        touchFeedback(event, 12)
      } else if (this.tool === 'dig') {
        this.diggingPointers.add(event.pointerId)
        this.strokes.position = position(event)
        this.earthworks.beginDig(this.strokes.position, startedAt, event.pointerId)
        sound.beginPointer(event)
        touchFeedback(event, 10)
      } else if (this.tool === 'mold') {
        this.strokes.position = position(event)
        this.earthworks.placeMold(this.strokes.position)
        touchFeedback(event, 18)
      } else {
        this.strokes.begin(position(event), pressure(event), startedAt, event.pointerId)
        sound.beginPointer(event)
        if (this.tool === 'shell' || this.tool === 'feet') touchFeedback(event, 9)
      }
      this.showPointer = false
      this.hovering = false
    }, { signal })
    canvas.addEventListener('pointermove', (event) => {
      if (!this.interactive || this.suppressedPointers.has(event.pointerId) || isOlderThanCurrentPointer(event)) return
      if (event.pointerType === 'mouse' && !this.pointers.has(event.pointerId)) {
        const point = position(event)
        const delta = { x: point.x - this.strokes.position.x, y: point.y - this.strokes.position.y }
        const length = Math.hypot(delta.x, delta.y)
        if (length > 0.0005) {
          const blended = { x: this.heading.x * 0.65 + delta.x / length * 0.35, y: this.heading.y * 0.65 + delta.y / length * 0.35 }
          const norm = Math.hypot(blended.x, blended.y)
          if (norm > 1e-6) this.heading = { x: blended.x / norm, y: blended.y / norm }
        }
        this.hovering = true
      }
      const samples = event.getCoalescedEvents?.() ?? []
      for (const sample of samples.length ? samples : [event]) {
        if (isOlderThanCurrentPointer(sample)) continue
        const deposit = this.depositPointers.get(event.pointerId)
        if (deposit) {
          this.strokes.position = position(sample)
          this.moveDeposit(deposit, this.strokes.position, eventTimelineTime(sample), event.pointerId)
          continue
        }
        if (this.diggingPointers.has(event.pointerId)) {
          this.strokes.position = position(sample)
          this.earthworks.moveDig(this.strokes.position, event.pointerId, eventTimelineTime(sample))
          sound.movePointer(sample, event.pointerId)
          continue
        }
        // The queue retains the tool chosen when this contact began. A bucket
        // gesture has no track, so it only updates the cursor here.
        this.strokes.move(position(sample), pressure(sample), eventTimelineTime(sample), event.pointerId)
        sound.movePointer(sample, event.pointerId)
      }
    }, { signal })
    canvas.addEventListener('pointerup', (event) => {
      if (this.suppressedPointers.has(event.pointerId) && !this.pointers.has(event.pointerId)) {
        this.suppressedPointers.delete(event.pointerId)
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }
      if (isOlderThanCurrentPointer(event)) return
      if (!this.interactive && !this.pointers.has(event.pointerId)) return
      if (!this.pointers.has(event.pointerId)) return
      if (this.diggingPointers.delete(event.pointerId)) {
        this.earthworks.moveDig(position(event), event.pointerId, eventTimelineTime(event))
        this.earthworks.endDig(event.pointerId, eventTimelineTime(event))
      }
      const deposit = this.depositPointers.get(event.pointerId)
      if (deposit) {
        this.depositPointers.delete(event.pointerId)
        this.moveDeposit(deposit, position(event), eventTimelineTime(event), event.pointerId)
        this.endDeposit(deposit, event.pointerId, eventTimelineTime(event))
        this.pointers.delete(event.pointerId)
        this.pointerStartedAt.delete(event.pointerId)
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }
      this.strokes.move(position(event), pressure(event), eventTimelineTime(event), event.pointerId)
      sound.movePointer(event)
      this.strokes.end(event.pointerId)
      sound.endPointer(event.pointerId)
      this.pointers.delete(event.pointerId)
      this.pointerStartedAt.delete(event.pointerId)
      this.suppressedPointers.delete(event.pointerId)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }, { signal })
    const cancelPointer = (pointerId: number) => {
      this.suppressedPointers.delete(pointerId)
      this.pointers.delete(pointerId)
      this.pointerStartedAt.delete(pointerId)
      this.strokes.cancel(pointerId)
      this.depositPointers.delete(pointerId)
      this.diggingPointers.delete(pointerId)
      this.water.cancel(pointerId)
      this.pourer.cancel(pointerId)
      this.earthworks.cancel(pointerId)
      sound.endPointer(pointerId)
    }
    const cancelAll = (suppressActive = false) => {
      const activePointers = [...this.pointers]
      if (suppressActive) for (const pointerId of activePointers) this.suppressedPointers.add(pointerId)
      this.pointers.clear()
      this.pointerStartedAt.clear()
      for (const pointerId of activePointers) {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
      }
      this.keyboardDrawing = false
      this.depositPointers.clear()
      this.diggingPointers.clear()
      this.strokes.cancel()
      this.water.cancel()
      this.pourer.cancel()
      this.earthworks.cancel()
      sound.cancelAll()
    }
    canvas.addEventListener('pointercancel', (event) => { if (!isOlderThanCurrentPointer(event)) cancelPointer(event.pointerId) }, { signal })
    canvas.addEventListener('lostpointercapture', (event) => {
      if (this.pointers.has(event.pointerId) && !isOlderThanCurrentPointer(event)) cancelPointer(event.pointerId)
    }, { signal })
    canvas.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') this.hovering = false }, { signal })
    window.addEventListener('blur', () => cancelAll(), { signal })
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll() }, { signal })
    const selectTool = (tool: Tool) => {
      if (!this.interactive) return
      this.tool = tool
      if (!isDepositTool(tool) && !isEarthTool(tool)) this.strokes.tool = tool
      for (const button of ui.tools) button.setAttribute('aria-checked', String(button.dataset.tool === tool))
      this.showPointer = true
      ui.controls.syncTool(tool)
      if (!ui.controls.navigatingRadios) {
        if (tool === 'mold') ui.controls.openPanel('molds')
        else ui.controls.closePanels()
      }
    }
    for (const button of ui.moldButtons) {
      button.addEventListener('click', () => {
        if (!this.interactive) return
        this.earthworks.selectShape(button.dataset.mold as MoldShape)
        for (const other of ui.moldButtons) other.setAttribute('aria-checked', String(other === button))
        this.showPointer = true
        ui.controls.syncRadios()
        if (!ui.controls.navigatingRadios) { ui.controls.closePanels(); canvas.focus({ preventScroll: true }) }
      }, { signal })
    }
    const setSize = (millimetres: number) => {
      if (!this.interactive) return
      ui.radius.value = String(millimetres)
      this.strokes.radius = Number(ui.radius.value) / 1000
      this.water.size = this.strokes.radius
      this.pourer.size = this.strokes.radius
      this.earthworks.size = this.strokes.radius
      ui.controls.syncSize()
      this.showPointer = true
    }
    const cycleSymmetry = () => {
      if (!this.interactive) return
      this.symmetryIndex = (this.symmetryIndex + 1) % SYMMETRIES.length
      const symmetry = SYMMETRIES[this.symmetryIndex]
      this.strokes.symmetry = symmetry
      this.water.symmetry = symmetry
      this.pourer.symmetry = symmetry
      this.earthworks.symmetry = symmetry
      ui.symmetry.querySelector('b')!.textContent = symmetry.label
      ui.symmetry.setAttribute('aria-label', `Symmetry: ${symmetry.label}`)
      this.showPointer = true
    }
    const toggleZen = () => {
      if (!this.interactive) return
      ui.controls.closePanels()
      canvas.focus({ preventScroll: true })
      if (this.autopilot.active) { this.autopilot.stop(); return }
      const pattern = GARDEN_PATTERNS[this.patternIndex++ % GARDEN_PATTERNS.length]
      const view = this.gardenBounds()
      const reach = gardenReach(view, this.strokes.radius * TOOL_SHAPE.rake.reach)
      const bounds = { minX: view.minX + reach * 0.1, maxX: view.maxX - reach * 0.1, minY: view.minY + reach * 0.1, maxY: view.maxY - reach * 0.1 }
      closeWriter()
      this.actions.push('capture')
      this.autopilot.start(gardenPaths(pattern, bounds, reach), { tool: 'rake', radius: reach / TOOL_SHAPE.rake.reach, speed: AUTOPILOT_SPEED }, performance.now())
    }
    const closeWriter = () => ui.controls.closePanels()
    const openWriter = () => {
      if (this.interactive) ui.controls.openPanel('writer')
    }
    const write = () => {
      const message = normalizeMessage(ui.message.value)
      if (!this.interactive) return
      if (!message) { ui.controls.announce('Try a few letters, numbers, or <3 for a heart.'); return }
      closeWriter()
      canvas.focus({ preventScroll: true })
      const { paths, capHeight } = letteringPaths(message, this.gardenBounds())
      if (!paths.length) return
      this.actions.push('capture')
      const radius = Math.max(0.004, Math.min(0.012, capHeight * writingRadius))
      this.autopilot.start(paths, { tool: 'finger', radius, speed: writingSpeed }, performance.now())
    }
    ui.write.addEventListener('click', () => (ui.writer.hidden ? openWriter() : closeWriter()), { signal })
    ui.writer.addEventListener('submit', (event) => { event.preventDefault(); write() }, { signal })
    ui.message.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); ui.controls.closePanels(true) }
    }, { signal })
    const chooseMaterial = (id: string) => {
      if (!this.interactive) return
      this.material = MATERIALS.find((material) => material.id === id) ?? MATERIALS[0]
      for (const button of ui.materialButtons) button.setAttribute('aria-checked', String(button.dataset.material === this.material.id))
      ui.material.querySelector('b')!.textContent = this.material.label
      ui.material.setAttribute('aria-label', `Sand: ${this.material.label}`)
      ui.controls.syncRadios()
    }
    const cycleMaterial = () => {
      const index = MATERIALS.findIndex((material) => material.id === this.material.id)
      chooseMaterial(MATERIALS[(index + 1) % MATERIALS.length].id)
    }
    const toggleMaterials = () => {
      if (!this.interactive) return
      if (ui.materials.hidden) ui.controls.openPanel('materials')
      else ui.controls.closePanels()
    }
    for (const button of ui.materialButtons) {
      button.addEventListener('click', () => {
        if (!this.interactive) return
        chooseMaterial(button.dataset.material!)
        if (!ui.controls.navigatingRadios) { ui.controls.openPanel('scene') }
      }, { signal })
    }
    ui.material.addEventListener('click', toggleMaterials, { signal })
    const cycleDaylight = () => {
      if (!this.interactive) return
      const preset = this.daylight.next(performance.now())
      ui.light.querySelector('b')!.textContent = preset.label
      ui.light.setAttribute('aria-label', `Time of day: ${preset.label}`)
    }
    const history = (action: 'undo' | 'redo') => {
      if (!this.interactive) return
      cancelAll(true)
      this.autopilot.stop()
      this.actions.push(action)
    }
    const save = () => { if (this.interactive && !ui.save.disabled && !this.actions.includes('save')) this.actions.push('save') }
    for (const button of ui.tools) {
      button.addEventListener('click', () => {
        selectTool(button.dataset.tool as Tool)
        if (this.interactive && this.tool !== 'mold' && !ui.controls.navigatingRadios) canvas.focus({ preventScroll: true })
      }, { signal })
    }
    ui.radius.addEventListener('input', () => setSize(Number(ui.radius.value)), { signal })
    ui.symmetry.addEventListener('click', cycleSymmetry, { signal })
    ui.zen.addEventListener('click', toggleZen, { signal })
    ui.light.addEventListener('click', cycleDaylight, { signal })
    ui.undo.addEventListener('click', () => history('undo'), { signal })
    ui.redo.addEventListener('click', () => history('redo'), { signal })
    ui.save.addEventListener('click', save, { signal })
    ui.reset.addEventListener('click', () => { if (!this.interactive) return; cancelAll(true); reset() }, { signal })
    window.addEventListener('keydown', (event) => {
      // Typing a message keeps its own shortcuts, including Ctrl/⌘ Z.
      if (!this.interactive || event.defaultPrevented || event.altKey || (event.target instanceof HTMLInputElement && event.target.type !== 'range')) return
      const key = event.key.toLowerCase()
      const command = event.ctrlKey || event.metaKey
      if (command && key === 'z') { event.preventDefault(); history(event.shiftKey ? 'redo' : 'undo'); return }
      if (command && key === 'y') { event.preventDefault(); history('redo'); return }
      if (command && key === 's') { event.preventDefault(); save(); return }
      if (command || event.repeat) return
      const shortcutTool = TOOLS.find((tool) => TOOL_KEYS[tool] === key)
      if (shortcutTool) {
        selectTool(shortcutTool)
        if (shortcutTool !== 'mold') canvas.focus({ preventScroll: true })
      }
      else if (key === 't') cycleMaterial()
      else if (key === 'm') cycleSymmetry()
      else if (key === 'g') toggleZen()
      else if (key === 'l') cycleDaylight()
      else if (key === 's') save()
      else if (key === 'w') { event.preventDefault(); openWriter() }
    }, { signal })
    canvas.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key.toLowerCase() === 'r') { if (!this.interactive) return; cancelAll(true); reset() }
      if (!this.interactive) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (!this.keyboardDrawing) {
          if (!this.pointers.size) this.actions.push('capture')
          if (isDepositTool(this.tool)) {
            this.depositPointers.set(keyboardPointerId, this.tool)
            this.beginDeposit(this.tool, this.strokes.position, eventTimelineTime(event), keyboardPointerId)
          } else if (this.tool === 'dig') {
            this.diggingPointers.add(keyboardPointerId)
            this.earthworks.beginDig(this.strokes.position, eventTimelineTime(event), keyboardPointerId)
          } else if (this.tool === 'mold') this.earthworks.placeMold(this.strokes.position)
          else this.strokes.begin(this.strokes.position, 0.75, eventTimelineTime(event), keyboardPointerId)
          this.keyboardDrawing = true
        }
      }
      const movement: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      const direction = movement[event.key]
      if (direction) {
        event.preventDefault()
        this.showPointer = true
        const next = { x: this.strokes.position.x + direction[0] * 0.003, y: this.strokes.position.y + direction[1] * 0.003 }
        this.heading = { x: direction[0], y: direction[1] }
        const deposit = this.depositPointers.get(keyboardPointerId)
        if (deposit || this.diggingPointers.has(keyboardPointerId)) {
          this.strokes.position = next
          if (deposit) this.moveDeposit(deposit, next, eventTimelineTime(event), keyboardPointerId)
          if (this.diggingPointers.has(keyboardPointerId)) this.earthworks.moveDig(next, keyboardPointerId, eventTimelineTime(event))
        } else this.strokes.move(next, 0.75, eventTimelineTime(event), keyboardPointerId)
      }
      if (event.key === '[' || event.key === ']') setSize(Number(ui.radius.value) + (event.key === '[' ? -1 : 1))
    }, { signal })
    const endKeyboardDrawing = (time = performance.now()) => {
      if (!this.keyboardDrawing) return
      const deposit = this.depositPointers.get(keyboardPointerId)
      this.depositPointers.delete(keyboardPointerId)
      if (this.diggingPointers.delete(keyboardPointerId)) this.earthworks.endDig(keyboardPointerId, time)
      else if (deposit) this.endDeposit(deposit, keyboardPointerId, time)
      else this.strokes.end(keyboardPointerId)
      this.keyboardDrawing = false
    }
    canvas.addEventListener('keyup', (event) => { if (event.code === 'Space') endKeyboardDrawing(eventTimelineTime(event)) }, { signal })
    // Tab, a toolbar click, or the writer can move focus before Space is
    // released. Its keyup then belongs to another element, so release here.
    canvas.addEventListener('blur', () => endKeyboardDrawing(), { signal })
  }

  setInteractive(interactive: boolean) {
    if (this.interactive === interactive) return
    this.interactive = interactive
    if (!interactive) {
      const activePointers = [...this.pointers]
      for (const pointerId of activePointers) this.suppressedPointers.add(pointerId)
      this.pointers.clear()
      this.pointerStartedAt.clear()
      for (const pointerId of activePointers) {
        if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId)
      }
      this.keyboardDrawing = false
      this.showPointer = false
      this.depositPointers.clear()
      this.diggingPointers.clear()
      this.strokes.cancel()
      this.water.cancel()
      this.pourer.cancel()
      this.earthworks.cancel()
      this.autopilot.stop()
      return
    }

    // Start every post-reset interaction from a completely clean queue. Any
    // touch that physically began while locked remains quarantined until its
    // pointerup/cancel, and delayed WebKit events older than this boundary are
    // rejected by their event timestamp.
    this.strokes.cancel()
    this.interactiveSince = performance.now()
  }

  /** Actions requested since the last frame, in the order they were made. */
  takeActions() { return this.actions.splice(0) }

  private beginDeposit(tool: DepositTool, point: Point, time: number, pointerId: number) {
    if (tool === 'water') this.water.begin(point, time, pointerId)
    else this.pourer.begin(point, time, pointerId, tool)
  }

  private moveDeposit(tool: DepositTool, point: Point, time: number, pointerId: number) {
    if (tool === 'water') this.water.move(point, time, pointerId)
    else this.pourer.move(point, pointerId, time)
  }

  private endDeposit(tool: DepositTool, pointerId: number, time?: number) {
    if (tool === 'water') this.water.end(pointerId)
    else this.pourer.end(pointerId, time)
  }

  /** The cursor and footprint outline for the active tool, if it should be drawn. */
  preview(): { cursor: Stroke; visible: boolean; tool: ToolPreview } {
    const tool = this.tool
    const heading = Math.atan2(-this.heading.x, this.heading.y)
    const visible = this.showPointer || (this.hovering && !this.pointers.size)
    const symmetry = this.strokes.symmetry
    const at = (radius: number): Stroke => ({ ...idleStroke(), from: this.strokes.position, to: this.strokes.position, radius: this.strokes.radius * radius })
    if (isDepositTool(tool) || tool === 'dig') {
      return { cursor: at(tool === 'dig' ? DIG.radius : depositReach[tool]), visible, tool: { kind: TOOL_KIND.finger, angle: 0, direction: this.heading, symmetry, variant: 0 } }
    }
    if (tool === 'mold') {
      const shape = MOLDS.findIndex((mold) => mold.id === this.earthworks.shape)
      return { cursor: at(MOLD.radius), visible, tool: { kind: MOLD_PREVIEW_KIND, angle: this.earthworks.nextMoldAngle, direction: this.heading, symmetry, variant: shape } }
    }
    return {
      cursor: at(TOOL_SHAPE[tool].reach),
      visible,
      tool: {
        kind: TOOL_KIND[tool],
        angle: tool === 'feet' || tool === 'wind' ? heading : this.strokes.nextShellAngle,
        direction: this.heading, symmetry,
        variant: tool === 'feet' ? this.strokes.nextFoot : 0,
      },
    }
  }

  /** Visible bed rectangle clear of the masthead and toolbar. */
  private gardenBounds(): Bounds {
    const rect = this.canvas.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    const toolbar = document.querySelector('.toolbar')?.getBoundingClientRect()
    const top = height * 0.12
    const bottom = Math.min(height * 0.9, (toolbar?.top ?? height) - 12)
    const corner = (x: number, y: number) => this.camera.screenToBed(x, y, width, height)
    const [topLeft, topRight, bottomLeft, bottomRight] = [corner(width * 0.05, top), corner(width * 0.95, top), corner(width * 0.05, bottom), corner(width * 0.95, bottom)]
    const limit = SAND.extent / 2 - 0.03
    const minY = Math.max(-limit, Math.min(Math.max(topLeft.y, topRight.y), Math.max(bottomLeft.y, bottomRight.y)))
    const maxY = Math.min(limit, Math.max(Math.min(topLeft.y, topRight.y), Math.min(bottomLeft.y, bottomRight.y)))
    return { minX: Math.max(-limit, topLeft.x, bottomLeft.x), maxX: Math.min(limit, topRight.x, bottomRight.x), minY, maxY }
  }

  dispose() { this.controller.abort(); this.pointers.clear(); this.pointerStartedAt.clear(); this.suppressedPointers.clear(); this.strokes.cancel() }
}
