/**
 * Renders one frame into an offscreen copy of the canvas and encodes it as a
 * PNG. Rendering into a dedicated texture keeps the export independent of the
 * canvas presentation timing and of any on-screen UI.
 */
export class ImageExport {
  private readonly device: GPUDevice
  private readonly format: GPUTextureFormat
  constructor(device: GPUDevice, format: GPUTextureFormat) { this.device = device; this.format = format }

  /** Encodes `render` into a capture texture and returns a finisher to call after submit. */
  encode(encoder: GPUCommandEncoder, width: number, height: number, render: (target: GPUTextureView) => void) {
    const texture = this.device.createTexture({ label: 'Image export', size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    render(texture.createView())
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256
    const buffer = this.device.createBuffer({ label: 'Image export readback', size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height])
    return async () => {
      try {
        await buffer.mapAsync(GPUMapMode.READ)
        const source = new Uint8Array(buffer.getMappedRange())
        const pixels = new Uint8ClampedArray(width * height * 4)
        const swap = this.format === 'bgra8unorm'
        for (let row = 0; row < height; row++) {
          const from = row * bytesPerRow
          const to = row * width * 4
          for (let column = 0; column < width * 4; column += 4) {
            pixels[to + column] = source[from + column + (swap ? 2 : 0)]
            pixels[to + column + 1] = source[from + column + 1]
            pixels[to + column + 2] = source[from + column + (swap ? 0 : 2)]
            pixels[to + column + 3] = 255
          }
        }
        buffer.unmap()
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0)
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'))
      } finally {
        buffer.destroy(); texture.destroy()
      }
    }
  }
}

/** Shares the image where the platform offers a share sheet with files, otherwise downloads it. */
export async function deliverImage(blob: Blob) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const file = new File([blob], `sand-${stamp}.png`, { type: 'image/png' })
  const coarse = window.matchMedia('(pointer: coarse)').matches
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
  }
  const url = URL.createObjectURL(file)
  const link = Object.assign(document.createElement('a'), { href: url, download: file.name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
