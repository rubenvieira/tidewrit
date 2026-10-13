import { SandSound } from './audio/sound'
import { DIG, POUR, SAND, WATER, idleStroke } from './config'
import { InputController } from './input/controller'
import type { BootMonitor } from './platform/boot'
import { createGpu } from './platform/gpu'
import { WaveResetEffect } from './reset/effect'
import { waveResetViewport } from './reset/viewport'
import { useMobileGrainFiltering, useSingleFrameResetPacing } from './platform/mobile'
import { drawingBuffer } from './platform/viewport'
import { ImageExport, deliverImage } from './render/image-export'
import { SandRenderer } from './render/renderer'
import { FixedClock } from './simulation/clock'
import { SandHistory } from './simulation/history'
import { SandSolver } from './simulation/solver'
import type { InterfaceElements } from './ui/interface'

export async function startTidewrit(ui: InterfaceElements, monitor: BootMonitor) {
  const gpu = await createGpu(ui.canvas, monitor)
  const solver = new SandSolver(gpu.device)
  const renderer = new SandRenderer(gpu.device, solver, gpu.format, useMobileGrainFiltering())
  const history = new SandHistory(gpu.device, solver)
  const imageExport = new ImageExport(gpu.device, gpu.format)
  const sound = new SandSound()
  ui.controls.connectSound(sound)
  const soundReady = sound.prepare()
  const clock = new FixedClock(SAND.step, SAND.maxSteps)
  const listeners = new AbortController()
  let input: InputController | undefined
  let animation = 0
  let stopped = false
  let framesInFlight = 0
  let resizePending = true
  let resetPending = false
  let waveResetInteractive = false
  let waveResetNeedsTransientClear = false
  const singleFrameResetPacing = useSingleFrameResetPacing()
  const resetFrameBudget = singleFrameResetPacing ? 1 : 2
  const waveReset = new WaveResetEffect()
  let toolbarInteractive = false
  let saving = false
  const syncHistoryButtons = () => {
    ui.undo.disabled = !toolbarInteractive || !history.canUndo
    ui.redo.disabled = !toolbarInteractive || !history.canRedo
    ui.save.disabled = !toolbarInteractive || saving
  }
  const setToolbarInteractive = (interactive: boolean) => {
    toolbarInteractive = interactive
    ui.controls.setInteractive(interactive)
    input?.setInteractive(interactive)
    syncHistoryButtons()
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(animation)
    listeners.abort()
    input?.dispose()
    ui.controls.dispose()
    sound.dispose()
    history.dispose(); renderer.dispose(); solver.dispose(); gpu.dispose()
  }
  monitor.setStop(stop)
  const resize = () => {
    if (!resizePending) return
    const size = drawingBuffer(window.innerWidth, window.innerHeight, window.devicePixelRatio)
    if (!size) return
    resizePending = false
    ui.canvas.width = size.width; ui.canvas.height = size.height
    renderer.resize(size.width, size.height)
  }
  try {
    monitor.stage('Initializing sand transport')
    await solver.initialize()
    await history.initialize()
    monitor.stage('Compiling granular lighting')
    await renderer.initialize()
    monitor.stage('Rendering the first surface')
    resize()
    const encoder = gpu.device.createCommandEncoder()
    solver.encode(encoder, [[], []])
    renderer.encode(encoder, gpu.context.getCurrentTexture().createView(), idleStroke(), performance.now())
    gpu.device.queue.submit([encoder.finish()])
    await gpu.device.queue.onSubmittedWorkDone()
    monitor.assertHealthy()
    await soundReady
    input = new InputController(ui, renderer.camera, sound, () => { resetPending = true })
    setToolbarInteractive(true)
    const frame = (now: number) => {
      if (stopped) return
      animation = requestAnimationFrame(frame)
      sound.update(now)
      const frameBudget = waveResetInteractive ? resetFrameBudget : 1
      if (document.hidden) { clock.reset(); return }
      // GPU backpressure must not erase elapsed simulation time. On iOS WebKit
      // queue completion can arrive a display interval late; resetting here
      // starves the fixed-step solver while pointer samples continue to queue.
      if (framesInFlight >= frameBudget) return
      try {
        resize()
        const encoder = gpu.device.createCommandEncoder()
        const activeInput = input!
        solver.setKinetic(activeInput.material.kinetic)
        let exportImage = false
        if (!waveResetInteractive) {
          for (const action of activeInput.takeActions()) {
            if (action === 'capture') history.capture(encoder)
            else if (action === 'undo') history.undo(encoder)
            else if (action === 'redo') history.redo(encoder)
            else if (action === 'save') exportImage = !saving
          }
        }
        if (resetPending && !waveResetInteractive) {
          resetPending = false
          // "Start again" is itself undoable.
          history.capture(encoder)
          activeInput.autopilot.stop()
          waveResetInteractive = true
          sound.cancelAll()
          waveReset.start(now, sound.playResetWave(), waveResetViewport(renderer.camera))
          waveResetNeedsTransientClear = true
          clock.reset()
          setToolbarInteractive(false)
        }
        const waveState = waveReset.update(now)
        if (waveResetInteractive) {
          clock.reset()
          if (waveResetNeedsTransientClear) {
            solver.clearTransientState(encoder)
            waveResetNeedsTransientClear = false
          }
          if (waveState.erase) solver.encodeWaveReset(encoder, waveState)
          if (waveState.justFinished) {
            waveResetInteractive = false
            clock.reset(now)
            // The final dry frame is submitted below before browser input can
            // dispatch again. Re-enable immediately at the audio endpoint;
            // the one-frame GPU gate still prevents simulation overtaking it.
            setToolbarInteractive(true)
          }
        }
        if (!waveResetInteractive) {
          activeInput.autopilot.update(now)
          const water = activeInput.water.takeLanded(now, WATER.maxDropsPerFrame)
          solver.encodeDeposits(encoder, [...water, ...activeInput.pourer.take(now, WATER.maxDropsPerFrame - water.length)])
          for (const splash of activeInput.water.takeSplashes(now)) sound.playSplash(splash.intensity)
          if (activeInput.pourer.takeDrips().length) sound.playSplash(0.07)
          const earthworks = activeInput.earthworks.take(now)
          solver.encodeEarthworks(encoder, earthworks.digs, earthworks.molds)
          for (const thud of activeInput.earthworks.takeThuds()) sound.playThud(thud)
        }
        // Thrown spoil falls through the same grain stream as poured sand.
        const streams = waveResetInteractive ? [] : [...activeInput.pourer.emitters(), ...activeInput.earthworks.spoilEmitters()]
        const streamRadius = activeInput.pourer.pouring ? activeInput.pourer.size * POUR.streamRadius : activeInput.earthworks.size * DIG.spoilRadius
        solver.setPour(streams, streamRadius)
        const zenActive = String(activeInput.autopilot.active)
        if (ui.zen.getAttribute('aria-pressed') !== zenActive) ui.zen.setAttribute('aria-pressed', zenActive)
        syncHistoryButtons()
        const count = waveResetInteractive ? 0 : clock.advance(now)
        if (count > 0) solver.encode(encoder, Array.from({ length: count }, () => activeInput.strokes.nextBatch()))
        renderer.setDaylight(activeInput.daylight.sample(now))
        renderer.setMaterial(activeInput.material)
        const preview = activeInput.preview()
        renderer.encode(encoder, gpu.context.getCurrentTexture().createView(), preview.cursor, now, preview.visible, waveState, preview.tool)
        const finishExport = exportImage
          ? imageExport.encode(encoder, ui.canvas.width, ui.canvas.height, (target) => renderer.encode(encoder, target, idleStroke(), now, false, waveState))
          : undefined
        gpu.device.queue.submit([encoder.finish()])
        if (finishExport) {
          saving = true
          ui.save.disabled = true
          ui.controls.announce('Preparing your image…')
          void finishExport().then(deliverImage).then((result) => {
            if (stopped) return
            ui.controls.announce(result === 'shared' ? 'Image shared.' : result === 'cancelled' ? 'Sharing cancelled.' : 'Image ready. Check your downloads.')
          }).catch((error: unknown) => {
            console.error('[Tidewrit] Image export failed', error)
            if (!stopped) ui.controls.announce('The image could not be saved. Please try again.')
          }).finally(() => {
            saving = false
            syncHistoryButtons()
          })
        }
        framesInFlight++
        void gpu.device.queue.onSubmittedWorkDone().then(() => {
          framesInFlight = Math.max(0, framesInFlight - 1)
        }).catch((error: unknown) => monitor.fail(error))
      } catch (error) { monitor.fail(error) }
    }
    window.addEventListener('resize', () => { resizePending = true }, { signal: listeners.signal })
    window.visualViewport?.addEventListener('resize', () => { resizePending = true }, { signal: listeners.signal })
    document.addEventListener('visibilitychange', () => clock.reset(), { signal: listeners.signal })
    window.addEventListener('pagehide', stop, { once: true, signal: listeners.signal })
    import.meta.hot?.dispose(stop)
    animation = requestAnimationFrame(frame)
  } catch (error) { stop(); throw error }
}
