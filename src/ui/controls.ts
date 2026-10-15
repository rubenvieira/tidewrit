import type { SandSound } from '../audio/sound'
import type { Tool } from '../config'
import type { InterfaceNodes } from './interface'
import { toolIcons, toolLabels, toolTitles } from './tools'

export type Panel = 'tools' | 'scene' | 'create' | 'materials' | 'molds' | 'writer'

/** Owns the dock and transient panels; never reads layout in the render loop. */
export class InterfaceControls {
  private readonly ui: InterfaceNodes
  private readonly controller = new AbortController()
  private readonly panels: Record<Panel, HTMLElement>
  private readonly triggers: Record<Panel, HTMLButtonElement>
  private readonly observer: ResizeObserver
  private active: Panel | undefined
  private interactive = false
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined
  private selectedTool: Tool = 'finger'
  navigatingRadios = false

  constructor(ui: InterfaceNodes) {
    this.ui = ui
    this.panels = { tools: ui.toolPanel, scene: ui.scenePanel, create: ui.createPanel, materials: ui.materials, molds: ui.molds, writer: ui.writer }
    this.triggers = { tools: ui.toolPicker, scene: ui.scenePicker, create: ui.createPicker, materials: ui.material, molds: ui.toolPicker, writer: ui.write }
    const { signal } = this.controller
    const toggle = (panel: Panel) => {
      if (this.active === panel) this.closePanels()
      else this.openPanel(panel)
    }
    ui.toolPicker.addEventListener('click', () => toggle('tools'), { signal })
    ui.scenePicker.addEventListener('click', () => toggle('scene'), { signal })
    ui.createPicker.addEventListener('click', () => toggle('create'), { signal })
    ui.help.addEventListener('click', () => { this.closePanels(); document.querySelector<HTMLDialogElement>('#about')?.showModal() }, { signal })
    for (const button of ui.root.querySelectorAll<HTMLButtonElement>('[data-close-panel]')) {
      button.addEventListener('click', () => this.closePanels(true), { signal })
    }
    // Menus are non-modal: tapping the sand dismisses them and draws immediately.
    document.addEventListener('pointerdown', (event) => {
      if (!this.active || !(event.target instanceof Node)) return
      if (this.panels[this.active].contains(event.target) || ui.toolbar.contains(event.target)) return
      this.closePanels()
    }, { signal })
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape' && this.active) {
        event.preventDefault()
        this.closePanels(true)
      }
    }, { signal })
    // Radio groups have a single tab stop and preserve native slider/field keys.
    for (const group of ui.root.querySelectorAll<HTMLElement>('[role="radiogroup"]')) {
      group.addEventListener('keydown', (event) => {
        const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((button) => !button.disabled)
        const current = buttons.indexOf(event.target as HTMLButtonElement)
        if (current < 0) return
        let next: number
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % buttons.length
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = buttons.length - 1
        else return
        event.preventDefault()
        this.navigatingRadios = true
        try { buttons[next].click() } finally { this.navigatingRadios = false }
        // Selection can close the panel. Return focus only if it stayed open.
        if (!group.closest('[hidden]')) buttons[next].focus({ preventScroll: true })
      }, { signal })
    }
    ui.radius.addEventListener('input', () => this.syncSize(), { signal })
    const place = () => {
      const viewport = window.visualViewport
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight
      const dockTop = ui.toolbar.getBoundingClientRect().top
      const bottom = Math.max(window.innerHeight - dockTop + 12, window.innerHeight - viewportBottom + 12)
      const top = (viewport?.offsetTop ?? 0) + 16
      ui.root.style.setProperty('--panel-bottom', `${Math.round(bottom)}px`)
      ui.root.style.setProperty('--panel-height', `${Math.max(80, window.innerHeight - bottom - top)}px`)
    }
    this.observer = new ResizeObserver(place)
    this.observer.observe(ui.toolbar)
    window.addEventListener('resize', place, { signal })
    window.visualViewport?.addEventListener('resize', place, { signal })
    window.visualViewport?.addEventListener('scroll', place, { signal })
    this.syncTool('finger')
    this.syncSize()
    this.setInteractive(false)
    place()
  }

  openPanel(panel: Panel) {
    if (!this.interactive) return
    this.closePanels()
    this.active = panel
    this.panels[panel].hidden = false
    const trigger = this.triggers[panel]
    trigger.setAttribute('aria-expanded', 'true')
    if (panel === 'molds') trigger.setAttribute('aria-controls', 'molds')
    this.ui.root.classList.add('panel-open')
    const element = this.panels[panel]
    element.tabIndex = -1
    const focus = panel === 'writer' ? this.ui.message : element.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? element.querySelector<HTMLElement>('button:not(.panel-close), input') ?? element
    focus.focus({ preventScroll: true })
    if (panel === 'writer') this.ui.message.select()
  }

  closePanels(restoreFocus = false) {
    const previous = this.active
    this.active = undefined
    for (const panel of Object.keys(this.panels) as Panel[]) {
      this.panels[panel].hidden = true
      this.triggers[panel].setAttribute('aria-expanded', 'false')
    }
    this.ui.toolPicker.setAttribute('aria-controls', 'tool-panel')
    this.ui.root.classList.remove('panel-open')
    if (restoreFocus && previous) {
      const trigger = this.triggers[previous]
      const fallback = previous === 'materials' ? this.ui.scenePicker : this.ui.createPicker
      const target = trigger.closest('[hidden]') ? fallback : trigger
      target.focus({ preventScroll: true })
    }
  }

  syncTool(tool: Tool) {
    this.selectedTool = tool
    this.ui.toolIcon.innerHTML = toolIcons[tool]
    this.ui.toolName.textContent = toolLabels[tool]
    this.ui.toolHint.textContent = toolTitles[tool]
    this.ui.toolPicker.setAttribute('aria-label', `Choose tool: ${toolLabels[tool]}`)
    this.syncRadios()
  }

  syncSize() {
    this.ui.sizeValue.value = this.ui.radius.value
    this.ui.radius.setAttribute('aria-valuetext', `${this.ui.radius.value} millimetres`)
  }

  syncRadios() {
    for (const button of [...this.ui.tools, ...this.ui.materialButtons, ...this.ui.moldButtons]) {
      button.tabIndex = button.getAttribute('aria-checked') === 'true' ? 0 : -1
    }
  }

  setInteractive(interactive: boolean) {
    this.interactive = interactive
    for (const control of this.ui.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.toolbar button, .toolbar input, .panel button, .panel input')) control.disabled = !interactive
    if (!interactive) this.closePanels()
    this.ui.toolHint.textContent = interactive ? toolTitles[this.selectedTool] : 'A fresh start is on its way…'
  }

  connectSound(sound: SandSound) {
    const sync = () => {
      this.ui.sound.setAttribute('aria-pressed', String(!sound.muted))
      this.ui.sound.title = `${sound.muted ? 'Turn sound on' : 'Turn sound off'} (U)`
    }
    const toggle = () => { sound.setMuted(!sound.muted); sync() }
    const { signal } = this.controller
    this.ui.sound.addEventListener('click', toggle, { signal })
    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || this.isEditing(event.target)) return
      if (event.key.toLowerCase() === 'u') { event.preventDefault(); toggle() }
    }, { signal })
    sync()
  }

  announce(message: string) {
    clearTimeout(this.feedbackTimer)
    this.ui.feedback.textContent = message
    this.ui.feedback.hidden = false
    this.feedbackTimer = setTimeout(() => { this.ui.feedback.hidden = true }, 5000)
  }

  private isEditing(target: EventTarget | null) {
    return target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'range'))
  }

  dispose() {
    this.controller.abort()
    this.observer.disconnect()
    clearTimeout(this.feedbackTimer)
  }
}
