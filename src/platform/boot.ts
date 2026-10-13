import type { InterfaceElements } from '../ui/interface'

export class BootMonitor {
  private currentStage = 'Starting'
  private failure: Error | undefined
  private stop: (() => void) | undefined
  private adapter = 'unavailable'
  private readonly ui: InterfaceElements

  constructor(ui: InterfaceElements) { this.ui = ui }
  stage(stage: string) { this.assertHealthy(); this.currentStage = stage; this.ui.status.textContent = `${stage}…` }
  setAdapter(description: string) { this.adapter = description }
  setStop(stop: () => void) { this.stop = stop }
  assertHealthy() { if (this.failure) throw this.failure }

  async run(start: () => Promise<void>) {
    try {
      await start()
      this.assertHealthy()
      this.currentStage = 'Running'
      this.ui.overlay.classList.add('ready')
      this.ui.overlay.setAttribute('aria-hidden', 'true')
    } catch (error) { this.fail(error) }
  }

  fail(reason: unknown) {
    if (this.failure) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.failure = error
    this.stop?.()
    this.ui.overlay.classList.remove('ready')
    this.ui.overlay.classList.add('failed')
    this.ui.overlay.removeAttribute('aria-hidden')
    this.ui.title.textContent = 'The sand could not continue.'
    this.ui.status.textContent = 'Tidewrit requires a current browser and hardware-accelerated WebGPU. No lower-quality renderer has been substituted.'
    this.ui.diagnostics.hidden = false
    this.ui.diagnostics.textContent = [
      `Stage: ${this.currentStage}`, `Error: ${error.message}`,
      `Viewport: ${window.innerWidth} × ${window.innerHeight}; device DPR: ${window.devicePixelRatio}`,
      `Drawing buffer: ${this.ui.canvas.width} × ${this.ui.canvas.height}`,
      `Adapter: ${this.adapter}`, `Platform: ${navigator.userAgent}`,
    ].join('\n')
    this.ui.reload.hidden = false
    console.error(`[Tidewrit: ${this.currentStage}]`, error)
  }
}
