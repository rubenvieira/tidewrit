import { afterEach, describe, expect, test, vi } from 'vitest'
import { InterfaceControls, type Panel } from '../src/ui/controls'
import type { InterfaceNodes } from '../src/ui/interface'

// Only the DOM operations used by panel coordination are modeled here. Query
// results are supplied by the fixture; this is not an HTML or CSS implementation.
class Element extends EventTarget {
  static focused: Element | undefined
  parent: Element | undefined
  hidden = false
  disabled = false
  tabIndex = 0
  value = ''
  type = ''
  textContent = ''
  innerHTML = ''
  isContentEditable = false
  readonly queries = new Map<string, () => Element[]>()
  readonly attributes = new Map<string, string>()
  private readonly classes = new Set<string>()
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  }
  readonly style = { setProperty: vi.fn() }
  readonly getBoundingClientRect = vi.fn(() => ({ top: 620 }))
  readonly select = vi.fn()
  append(...children: Element[]) { for (const child of children) child.parent = this }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  querySelectorAll(selector: string) { return this.queries.get(selector)?.() ?? [] }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  contains(target: Element) {
    for (let node: Element | undefined = target; node; node = node.parent) if (node === this) return true
    return false
  }
  closest(selector: string) {
    if (selector !== '[hidden]') return null
    if (this.hidden) return this
    for (let node = this.parent; node; node = node.parent) if (node.hidden) return node
    return null
  }
  focus() { Element.focused = this }
  click() { if (!this.disabled) dispatch(this, 'click') }
}

class Input extends Element {}
class TextArea extends Element {}

function dispatch(target: EventTarget, type: string, values: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true })
  for (const [name, value] of Object.entries(values)) Object.defineProperty(event, name, { value })
  target.dispatchEvent(event)
  return event
}

const instances: InterfaceControls[] = []
afterEach(() => {
  for (const controls of instances.splice(0)) controls.dispose()
  Element.focused = undefined
  vi.unstubAllGlobals()
})

function fixture() {
  const documentTarget = new EventTarget()
  const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 800 })
  const windowTarget = Object.assign(new EventTarget(), { innerHeight: 800, visualViewport: viewport })
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('window', windowTarget)
  vi.stubGlobal('Node', Element)
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('HTMLInputElement', Input)
  vi.stubGlobal('HTMLTextAreaElement', TextArea)
  vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect = disconnect })
  const element = () => new Element()
  const ui = {
    root: element(), toolbar: element(), canvas: element(),
    toolPicker: element(), scenePicker: element(), createPicker: element(),
    toolPanel: element(), scenePanel: element(), createPanel: element(),
    materials: element(), molds: element(), writer: element(), helpPanel: element(),
    material: element(), write: element(), help: element(), light: element(), symmetry: element(), zen: element(), reset: element(), sound: element(),
    toolIcon: element(), toolName: element(), toolHint: element(), sizeValue: element(), feedback: element(),
    radius: Object.assign(new Input(), { value: '12', type: 'range' }), message: new Input(),
    tools: [element(), element(), element()], materialButtons: [element(), element()], moldButtons: [element(), element()],
  }
  const panels: Record<Panel, Element> = { tools: ui.toolPanel, scene: ui.scenePanel, create: ui.createPanel, materials: ui.materials, molds: ui.molds, writer: ui.writer, help: ui.helpPanel }
  ui.root.append(ui.toolbar, ui.canvas, ...Object.values(panels))
  ui.toolbar.append(ui.toolPicker, ui.scenePicker, ui.createPicker, ui.radius, ui.reset)
  ui.scenePanel.append(ui.material, ui.light, ui.symmetry)
  ui.createPanel.append(ui.zen, ui.write, ui.help)
  ui.writer.append(ui.message)
  const groups = [element(), element(), element()]
  const radios = [ui.tools, ui.materialButtons, ui.moldButtons]
  for (const [index, panel] of [ui.toolPanel, ui.materials, ui.molds].entries()) {
    const buttons = radios[index]
    panel.append(groups[index])
    groups[index].append(...buttons)
    groups[index].queries.set('[role="radio"]', () => buttons)
    buttons.forEach((button, index) => button.setAttribute('aria-checked', String(index === 0)))
    panel.queries.set('[aria-checked="true"]', () => buttons.filter((button) => button.getAttribute('aria-checked') === 'true'))
    panel.queries.set('button:not(.panel-close), input', () => buttons)
  }
  ui.scenePanel.queries.set('button:not(.panel-close), input', () => [ui.material, ui.light, ui.symmetry])
  ui.createPanel.queries.set('button:not(.panel-close), input', () => [ui.zen, ui.write, ui.help])
  const closeButtons = Object.values(panels).map((panel) => { const close = element(); panel.append(close); return close })
  const interactive = [ui.toolPicker, ui.scenePicker, ui.createPicker, ui.radius, ui.reset, ui.material, ui.write, ui.help, ui.light, ui.symmetry, ui.zen, ui.message, ...radios.flat(), ...closeButtons]
  ui.root.queries.set('[data-close-panel]', () => closeButtons)
  ui.root.queries.set('[role="radiogroup"]', () => groups)
  ui.root.queries.set('.toolbar button, .toolbar input, .panel button, .panel input', () => interactive)
  const controls = new InterfaceControls(ui as unknown as InterfaceNodes)
  instances.push(controls)
  controls.setInteractive(true)
  return { ui, controls, panels, groups, interactive, closeButtons, documentTarget, windowTarget, viewport, observe, disconnect }
}

describe('Transient interface panels', () => {
  test('opening a second panel closes the first and updates its trigger', () => {
    const { ui, controls, panels } = fixture()
    ui.toolPicker.click()
    expect(ui.toolPanel.hidden).toBe(false)
    expect(ui.toolPicker.getAttribute('aria-expanded')).toBe('true')
    ui.scenePicker.click()
    expect(Object.values(panels).filter((panel) => !panel.hidden)).toEqual([ui.scenePanel])
    expect(ui.toolPicker.getAttribute('aria-expanded')).toBe('false')
    expect(ui.scenePicker.getAttribute('aria-expanded')).toBe('true')
    expect(ui.root.classList.contains('panel-open')).toBe(true)
    controls.closePanels()
    expect(ui.root.classList.contains('panel-open')).toBe(false)
  })

  test.each<Panel>(['materials', 'writer', 'help'])('Escape from %s returns focus to a visible dock trigger', (panel) => {
    const { ui, controls, documentTarget, panels } = fixture()
    controls.openPanel(panel === 'materials' ? 'scene' : 'create')
    controls.openPanel(panel)
    const event = dispatch(documentTarget, 'keydown', { key: 'Escape' })
    expect(event.defaultPrevented).toBe(true)
    expect(Object.values(panels).every((panel) => panel.hidden)).toBe(true)
    expect(Element.focused).toBe(panel === 'materials' ? ui.scenePicker : ui.createPicker)
    expect(Element.focused?.closest('[hidden]')).toBeNull()
  })

  test('opening tools focuses the checked radio and opening help focuses its panel', () => {
    const { ui, controls } = fixture()
    ui.tools[0].setAttribute('aria-checked', 'false')
    ui.tools[2].setAttribute('aria-checked', 'true')
    controls.openPanel('tools')
    expect(Element.focused).toBe(ui.tools[2])
    controls.openPanel('help')
    expect(Element.focused).toBe(ui.helpPanel)
    expect(ui.helpPanel.tabIndex).toBe(-1)
    controls.openPanel('writer')
    expect(Element.focused).toBe(ui.message)
    expect(ui.message.select).toHaveBeenCalledOnce()
  })

  test('locking closes every panel, disables editing controls, and rejects reopening', () => {
    const { ui, controls, panels, interactive, documentTarget } = fixture()
    controls.openPanel('tools')
    controls.setInteractive(false)
    expect(Object.values(panels).every((panel) => panel.hidden)).toBe(true)
    expect(interactive.every((control) => control.disabled)).toBe(true)
    controls.openPanel('scene')
    dispatch(documentTarget, 'keydown', { key: '?' })
    expect(Object.values(panels).every((panel) => panel.hidden)).toBe(true)
    controls.setInteractive(true)
    expect(interactive.every((control) => !control.disabled)).toBe(true)
    ui.scenePicker.click()
    expect(ui.scenePanel.hidden).toBe(false)
  })

  test('arrow navigation selects and focuses a radio while keeping its panel open', () => {
    const { ui, controls, groups } = fixture()
    const whileSelecting: boolean[] = []
    for (const button of ui.tools) button.addEventListener('click', () => {
      whileSelecting.push(controls.navigatingRadios)
      for (const other of ui.tools) other.setAttribute('aria-checked', String(other === button))
      controls.syncRadios()
      if (!controls.navigatingRadios) controls.closePanels()
    })
    controls.openPanel('tools')
    const event = dispatch(groups[0], 'keydown', { key: 'ArrowRight', target: ui.tools[0] })
    expect(event.defaultPrevented).toBe(true)
    expect(whileSelecting).toEqual([true])
    expect(controls.navigatingRadios).toBe(false)
    expect(ui.toolPanel.hidden).toBe(false)
    expect(Element.focused).toBe(ui.tools[1])
    expect(ui.tools.map((button) => button.tabIndex)).toEqual([-1, 0, -1])
    ui.tools[1].click()
    expect(ui.toolPanel.hidden).toBe(true)
  })

  test('an outside pointer dismisses a panel but its contents and toolbar preserve it', () => {
    const { ui, controls, documentTarget } = fixture()
    controls.openPanel('tools')
    dispatch(documentTarget, 'pointerdown', { target: ui.tools[0] })
    dispatch(documentTarget, 'pointerdown', { target: ui.radius })
    expect(ui.toolPanel.hidden).toBe(false)
    const event = dispatch(documentTarget, 'pointerdown', { target: ui.canvas })
    expect(ui.toolPanel.hidden).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  test('disposal disconnects layout observation and removes input and resize listeners', () => {
    const { ui, controls, documentTarget, windowTarget, viewport, observe, disconnect } = fixture()
    expect(observe).toHaveBeenCalledWith(ui.toolbar)
    controls.dispose()
    expect(disconnect).toHaveBeenCalledOnce()
    ui.toolbar.getBoundingClientRect.mockClear()
    ui.toolPicker.click()
    dispatch(documentTarget, 'keydown', { key: '?' })
    dispatch(windowTarget, 'resize')
    dispatch(viewport, 'resize')
    dispatch(viewport, 'scroll')
    expect(ui.toolPanel.hidden).toBe(true)
    expect(ui.helpPanel.hidden).toBe(true)
    expect(ui.toolbar.getBoundingClientRect).not.toHaveBeenCalled()
  })
})
