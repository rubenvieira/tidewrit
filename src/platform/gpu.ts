import type { BootMonitor } from './boot'

export async function createGpu(canvas: HTMLCanvasElement, monitor: BootMonitor) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. A secure context and supported GPU/browser are required.')
  monitor.stage('Requesting GPU')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No hardware WebGPU adapter is available.')
  if (adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required, not a software fallback.')
  monitor.setAdapter([adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' / '))
  const device = await adapter.requestDevice({ label: 'Tidewrit GPU' })
  let disposed = false
  void device.lost.then((info) => {
    if (!disposed) monitor.fail(new Error(`GPU device lost (${info.reason}): ${info.message}`))
  })
  device.addEventListener('uncapturederror', (event) => monitor.fail(new Error(`Uncaptured GPU error: ${event.error.message}`)))
  const context = canvas.getContext('webgpu')
  try {
    monitor.assertHealthy()
    if (!context) throw new Error('The browser could not create a WebGPU canvas context.')
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })
    return { device, context, format, dispose: () => { disposed = true; context.unconfigure(); device.destroy() } }
  } catch (error) { disposed = true; device.destroy(); throw error }
}
