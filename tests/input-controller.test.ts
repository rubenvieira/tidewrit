import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SandSound } from '../src/audio/sound'
import { MATERIALS, MOLDS, SYMMETRIES, TOOLS, TOOL_KIND, type Tool } from '../src/config'
import { InputController } from '../src/input/controller'
import type { SandCamera } from '../src/render/camera'
import type { InterfaceElements } from '../src/ui/interface'

// Exercise the actual DOM event handlers without requiring a GPU or browser.
class Element extends EventTarget {
  hidden = false
  value = ''
  type = ''
  textContent = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  private readonly attributes = new Map<string, string>()
  private readonly captures = new Set<number>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  querySelector() { return this }
  getBoundingClientRect() { return { left: 0, top: 600, width: 800, height: 700 } }
  setPointerCapture(id: number) { this.captures.add(id) }
  hasPointerCapture(id: number) { return this.captures.has(id) }
  releasePointerCapture(id: number) { this.captures.delete(id) }
  focus() {}
  select() {}
}

class Input extends Element {}

function dispatch(target: EventTarget, type: string, values: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true })
  for (const [name, value] of Object.entries(values)) Object.defineProperty(event, name, { value })
  target.dispatchEvent(event)
  return event
}

const controllers: InputController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.unstubAllGlobals()
})

function fixture() {
  const windowTarget = new Element()
  const documentTarget = new Element()
  vi.stubGlobal('window', windowTarget)
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('HTMLInputElement', Input)
  const button = (dataset: Record<string, string> = {}) => Object.assign(new Element(), { dataset })
  const ui = {
    root: new Element(),
    canvas: new Element(), radius: Object.assign(new Input(), { value: '12', type: 'range' }),
    tools: TOOLS.map((tool) => button({ tool })),
    reset: button(), symmetry: button(), zen: button(), light: button(),
    write: button(), writer: Object.assign(new Element(), { hidden: true }), message: new Input(),
    molds: Object.assign(new Element(), { hidden: true }), moldButtons: MOLDS.map((mold) => button({ mold: mold.id })),
    material: button(), materials: Object.assign(new Element(), { hidden: true }), materialButtons: MATERIALS.map((material) => button({ material: material.id })),
    undo: button(), redo: button(), save: button(), sound: button(),
    controls: {
      syncTool: vi.fn(), openPanel: vi.fn(), closePanels: vi.fn(), syncRadios: vi.fn(),
      syncSize: vi.fn(), announce: vi.fn(), navigatingRadios: false,
    },
  }
  const sound = { beginPointer: vi.fn(), movePointer: vi.fn(), endPointer: vi.fn(), cancelAll: vi.fn(), muted: false, setMuted: vi.fn() }
  const reset = vi.fn()
  const camera = { screenToBed: (x: number, y: number) => ({ x: x / 1000, y: y / 1000 }) }
  const controller = new InputController(ui as unknown as InterfaceElements, camera as unknown as SandCamera, sound as unknown as SandSound, reset)
  controllers.push(controller)
  const select = (tool: Tool) => dispatch(ui.tools.find((button) => button.dataset.tool === tool)!, 'click')
  const key = (key: string, code = key, values: Record<string, unknown> = {}) => dispatch(ui.canvas, 'keydown', { key, code, ...values })
  const pointer = (type: string, x: number, time: number, values: Record<string, unknown> = {}) => dispatch(ui.canvas, type, {
    pointerId: 1, pointerType: 'mouse', button: 0, pressure: 0.75,
    clientX: x, clientY: 600, timeStamp: time, ...values,
  })
  return { ui, controller, select, key, pointer, windowTarget, reset }
}

describe('Input gesture lifetime', () => {
  test.each([false, true])('pen release preserves the pressure and speed of its drawn tail (submitted=%s)', (submitted) => {
    const { controller, pointer } = fixture()
    const pen = { pointerType: 'pen', pressure: 0.8 }
    pointer('pointerdown', 10, 1000, pen)
    pointer('pointermove', 13, 1010, pen)
    const strokes = submitted ? controller.strokes.nextBatch() : []
    pointer('pointerup', 13, 1100, { pointerType: 'pen', pressure: 0 })
    strokes.push(...controller.strokes.nextBatch())
    expect(strokes).toHaveLength(1)
    expect(strokes[0].pressure).toBeCloseTo(0.8)
    expect(strokes[0].velocity.x).toBeCloseTo(0.3)
    expect(strokes[0].to.x).toBeCloseTo(0.013)
  })

  test('canceling one water pointer discards only its unlanded drops', () => {
    const { controller, select, pointer } = fixture()
    select('water')
    pointer('pointerdown', -100, 1000)
    pointer('pointerdown', 100, 1000, { pointerId: 2 })
    pointer('pointercancel', -100, 1010)
    const drops = controller.water.takeLanded(2000, 48)
    expect(drops).toHaveLength(13)
    expect(drops.every((drop) => drop.x > 0)).toBe(true)
    expect(controller.water.takeSplashes(2000)).toHaveLength(1)
  })

  test('a held pointer keeps drawing with its original tool after the bucket is selected', () => {
    const { controller, select, pointer } = fixture()
    pointer('pointerdown', 10, 1000)
    select('mold')
    pointer('pointermove', 40, 1100)
    const batch = controller.strokes.nextBatch()
    expect(batch.length).toBeGreaterThan(0)
    expect(batch.every((stroke) => stroke.kind === TOOL_KIND.finger)).toBe(true)
  })

  test('a keyboard stroke keeps moving after a deposit tool is selected', () => {
    const { controller, select, key } = fixture()
    key(' ', 'Space')
    select('pour')
    for (let index = 0; index < 4; index++) key('ArrowRight')
    const batch = controller.strokes.nextBatch()
    expect(batch.length).toBeGreaterThan(0)
    expect(batch.every((stroke) => stroke.kind === TOOL_KIND.finger)).toBe(true)
    expect(controller.pourer.pouring).toBe(false)
  })

  test('a held keyboard shovel keeps moving after a contact tool is selected', () => {
    const { controller, select, key } = fixture()
    select('dig')
    key(' ', 'Space', { timeStamp: 1000 })
    select('finger')
    for (let index = 0; index < 4; index++) key('ArrowRight')
    const { digs } = controller.earthworks.take(1050)
    expect(digs.length).toBeGreaterThan(0)
    expect(digs.at(-1)?.x).toBeCloseTo(0.012)
    expect(digs.every((dig) => dig.volume > 0)).toBe(true)
  })

  test.each<Tool>(['pour', 'drip', 'dig'])('a %s gesture released between frames still lands after capture is lost', (tool) => {
    const { ui, controller, select, pointer } = fixture()
    select(tool)
    pointer('pointerdown', 10, 1000)
    pointer('pointerup', 20, 1050)
    dispatch(ui.canvas, 'lostpointercapture', { pointerId: 1, timeStamp: 1050 })
    if (tool === 'dig') {
      const { digs } = controller.earthworks.take(1100)
      expect(digs).toHaveLength(1)
      expect(digs[0].x).toBeCloseTo(0.02)
      expect(digs[0].volume).toBeGreaterThan(0)
    } else {
      const deposits = controller.pourer.take(1100, 48)
      expect(deposits).toHaveLength(1)
      expect(deposits[0].sand).toBeGreaterThan(0)
    }
  })

  test.each<Tool>(['finger', 'pour', 'dig'])('leaving the canvas releases a keyboard-held %s', (tool) => {
    const { ui, controller, select, key } = fixture()
    select(tool)
    key(' ', 'Space')
    controller.takeActions()
    dispatch(ui.canvas, 'blur')
    expect(controller.strokes.holds(-1)).toBe(false)
    expect(controller.pourer.pouring).toBe(false)
    expect(controller.earthworks.digging).toBe(false)
    key(' ', 'Space')
    expect(controller.takeActions()).toEqual(['capture'])
  })

  test('reset lock prevents global shortcuts from changing the tools and scene', () => {
    const { controller, windowTarget } = fixture()
    const daylight = vi.spyOn(controller.daylight, 'next')
    controller.setInteractive(false)
    for (const key of ['2', 't', 'm', 'l', 'w', 'g', 's']) dispatch(windowTarget, 'keydown', { key })
    expect(controller.tool).toBe('finger')
    expect(controller.material).toBe(MATERIALS[0])
    expect(controller.strokes.symmetry).toBe(SYMMETRIES[0])
    expect(controller.autopilot.active).toBe(false)
    expect(daylight).not.toHaveBeenCalled()
    expect(controller.takeActions()).toEqual([])
  })

  test.each(['tool', 'mold', 'material', 'symmetry', 'daylight', 'size', 'writer', 'undo', 'redo', 'reset'])(
    'reset lock rejects a queued %s control event', (control) => {
      const { ui, controller, reset } = fixture()
      const daylight = vi.spyOn(controller.daylight, 'next')
      controller.setInteractive(false)
      ui.controls.openPanel.mockClear()
      const buttons: Record<string, Element> = {
        tool: ui.tools[1], mold: ui.moldButtons[1], material: ui.materialButtons[1],
        symmetry: ui.symmetry, daylight: ui.light, writer: ui.write,
        undo: ui.undo, redo: ui.redo, reset: ui.reset,
      }
      if (control === 'size') {
        ui.radius.value = '22'
        dispatch(ui.radius, 'input')
      } else dispatch(buttons[control], 'click')
      expect(controller.tool).toBe('finger')
      expect(controller.earthworks.shape).toBe('tower')
      expect(controller.material).toBe(MATERIALS[0])
      expect(controller.strokes.symmetry).toBe(SYMMETRIES[0])
      expect(controller.strokes.radius).toBe(0.012)
      expect(controller.autopilot.active).toBe(false)
      expect(daylight).not.toHaveBeenCalled()
      expect(reset).not.toHaveBeenCalled()
      expect(ui.controls.openPanel).not.toHaveBeenCalled()
      expect(controller.takeActions()).toEqual([])
    },
  )

  test('browser shortcuts do not reset or move the keyboard tool', () => {
    const { controller, key, reset } = fixture()
    key('r', 'KeyR', { ctrlKey: true })
    key('ArrowRight', 'ArrowRight', { altKey: true })
    key(' ', 'Space', { metaKey: true })
    expect(reset).not.toHaveBeenCalled()
    expect(controller.strokes.position).toEqual({ x: 0, y: 0 })
    expect(controller.takeActions()).toEqual([])
  })
})
