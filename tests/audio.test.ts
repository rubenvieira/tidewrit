import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandSound } from '../src/audio/sound'

class FakeParam {
  value: number
  constructor(value = 0) { this.value = value }
  setValueAtTime = vi.fn((value: number) => { this.value = value })
  linearRampToValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}

class FakeNode {
  connections: FakeNode[] = []
  connect(destination: FakeNode) {
    this.connections.push(destination)
    return destination
  }
  disconnect = vi.fn(() => { this.connections = [] })
}

class FakeGain extends FakeNode {
  static instances: FakeGain[] = []
  gain: FakeParam
  constructor(_context: FakeContext, options: { gain?: number } = {}) {
    super()
    this.gain = new FakeParam(options.gain ?? 1)
    FakeGain.instances.push(this)
  }
}

class FakeFilter extends FakeNode {
  frequency = new FakeParam()
}

class FakeBufferSource extends FakeNode {
  static instances: FakeBufferSource[] = []
  onended: (() => void) | null = null
  start = vi.fn()
  constructor() {
    super()
    FakeBufferSource.instances.push(this)
  }
}

class FakeWorklet extends FakeNode {
  static instances: FakeWorklet[] = []
  port = { postMessage: vi.fn() }
  constructor() {
    super()
    FakeWorklet.instances.push(this)
  }
}

class FakeContext {
  static instances: FakeContext[] = []
  destination = new FakeNode()
  mediaSources: FakeNode[] = []
  state = 'suspended'
  currentTime = 0
  sampleRate = 48000
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
  resume = vi.fn(() => { this.state = 'running'; return Promise.resolve() })
  suspend = vi.fn(() => { this.state = 'suspended'; return Promise.resolve() })
  close = vi.fn(() => { this.state = 'closed'; return Promise.resolve() })
  constructor() { FakeContext.instances.push(this) }
  createMediaElementSource() {
    const source = new FakeNode()
    this.mediaSources.push(source)
    return source
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) }
  }
}

class FakeMedia extends EventTarget {
  static instances: FakeMedia[] = []
  static metadataReady = true
  static HAVE_METADATA = 1
  readyState = FakeMedia.metadataReady ? 1 : 0
  duration = FakeMedia.metadataReady ? 6.1 : NaN
  loop = false
  preload = ''
  volume = 1
  currentTime = 0
  paused = true
  play = vi.fn(() => { this.paused = false; return Promise.resolve() })
  pause = vi.fn(() => { this.paused = true })
  load = vi.fn()
  setAttribute = vi.fn()
  removeAttribute = vi.fn()
  constructor() {
    super()
    FakeMedia.instances.push(this)
  }
}

class FakeDocument extends EventTarget {
  visibilityState = 'visible'
  setHidden(hidden: boolean) {
    this.visibilityState = hidden ? 'hidden' : 'visible'
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

let page: FakeDocument
let storage: Map<string, string>
let sounds: SandSound[]

function createSound() {
  const sound = new SandSound()
  sounds.push(sound)
  return sound
}

function reaches(node: FakeNode, target: FakeNode): boolean {
  return node === target || node.connections.some(next => reaches(next, target))
}

beforeEach(() => {
  page = new FakeDocument()
  storage = new Map()
  sounds = []
  FakeGain.instances = []
  FakeBufferSource.instances = []
  FakeWorklet.instances = []
  FakeContext.instances = []
  FakeMedia.instances = []
  FakeMedia.metadataReady = true
  vi.stubGlobal('document', page)
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('navigator', { userAgent: 'test', platform: 'test', maxTouchPoints: 0 })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  })
  vi.stubGlobal('Audio', FakeMedia)
  vi.stubGlobal('HTMLMediaElement', FakeMedia)
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorklet)
  vi.stubGlobal('GainNode', FakeGain)
  vi.stubGlobal('BiquadFilterNode', FakeFilter)
  vi.stubGlobal('DynamicsCompressorNode', FakeNode)
  vi.stubGlobal('AudioBufferSourceNode', FakeBufferSource)
})

afterEach(() => {
  for (const sound of sounds) sound.dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sound controls', () => {
  it('routes ambient, reset, drawing, splash and thud through one master gain', async () => {
    storage.set('tidewrit.audio.muted', 'false')
    const sound = createSound()
    await sound.prepare()
    sound.playResetWave()
    sound.playSplash(1)
    sound.playThud(1)

    const context = FakeContext.instances[0]
    const master = FakeGain.instances.find(gain => gain.connections.includes(context.destination))!
    expect(master.gain.value).toBe(1)
    expect(FakeGain.instances.filter(gain => gain.connections.includes(context.destination))).toHaveLength(1)
    const voices = [...context.mediaSources, ...FakeWorklet.instances, ...FakeBufferSource.instances]
    expect(voices).toHaveLength(5)
    for (const voice of voices) expect(reaches(voice, master)).toBe(true)

    sound.setMuted(true)
    expect(master.gain.value).toBe(0)
    expect(context.suspend).toHaveBeenCalled()
    expect(FakeMedia.instances.every(media => media.paused)).toBe(true)
    expect(FakeWorklet.instances[0].port.postMessage).toHaveBeenLastCalledWith({
      type: 'state', gate: 0, speed: 0, pressure: 0, turn: 0,
    })
  })

  it('starts persisted mute silently and keeps reset timing independent of audio', async () => {
    storage.set('tidewrit.audio.muted', 'true')
    const sound = createSound()
    await sound.prepare()
    const context = FakeContext.instances[0]
    expect(sound.muted).toBe(true)
    expect(FakeGain.instances[0].gain.value).toBe(0)
    expect(context.resume).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new Event('keydown'))
    sound.playSplash(1)
    sound.playThud(1)
    expect(sound.playResetWave()).toBe(6.1)
    expect(sound.resetDurationSeconds).toBe(6.1)
    expect(FakeMedia.instances.every(media => media.play.mock.calls.length === 0)).toBe(true)
    expect(FakeBufferSource.instances).toHaveLength(0)

    sound.setMuted(false)
    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(FakeMedia.instances[0].play).toHaveBeenCalledTimes(1)
    expect(FakeGain.instances[0].gain.value).toBe(1)
    expect(storage.get('tidewrit.audio.muted')).toBe('false')
    expect(sound.playResetWave()).toBe(6.1)
  })

  it('queues resume synchronously even when the previous suspend is pending', async () => {
    storage.set('tidewrit.audio.muted', 'false')
    const sound = createSound()
    await sound.prepare()
    const context = FakeContext.instances[0]
    let finishSuspend: () => void = () => undefined
    context.suspend.mockImplementation(() => new Promise<void>(resolve => { finishSuspend = resolve }))
    context.resume.mockClear()
    FakeMedia.instances[0].play.mockClear()

    sound.setMuted(true)
    expect(context.state).toBe('running')
    sound.setMuted(false)
    // These calls must occur before the next microtask to retain user activation.
    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(FakeMedia.instances[0].play).toHaveBeenCalledTimes(1)
    finishSuspend()
  })

  it('silences a hidden page, resumes ambience only, and preserves the mute choice', async () => {
    storage.set('tidewrit.audio.muted', 'false')
    const sound = createSound()
    await sound.prepare()
    sound.playResetWave()
    const [ambient, wave] = FakeMedia.instances
    page.setHidden(true)
    expect(FakeGain.instances[0].gain.value).toBe(0)
    expect(ambient.paused).toBe(true)
    expect(wave.paused).toBe(true)
    const resumeCalls = FakeContext.instances[0].resume.mock.calls.length
    sound.setMuted(false)
    expect(FakeContext.instances[0].resume).toHaveBeenCalledTimes(resumeCalls)

    page.setHidden(false)
    expect(FakeGain.instances[0].gain.value).toBe(1)
    expect(ambient.paused).toBe(false)
    expect(wave.play).toHaveBeenCalledTimes(1)

    sound.setMuted(true)
    page.setHidden(true)
    page.setHidden(false)
    expect(sound.muted).toBe(true)
    expect(FakeGain.instances[0].gain.value).toBe(0)
    expect(ambient.paused).toBe(true)
    expect(storage.get('tidewrit.audio.muted')).toBe('true')
  })

  it('starts hidden pages silently and removes playback listeners on disposal', async () => {
    page.setHidden(true)
    const sound = createSound()
    await sound.prepare()
    const context = FakeContext.instances[0]
    expect(FakeGain.instances[0].gain.value).toBe(0)
    expect(context.resume).not.toHaveBeenCalled()
    sound.dispose()
    page.setHidden(false)
    window.dispatchEvent(new Event('pointerdown'))
    sound.setMuted(false)
    expect(context.resume).not.toHaveBeenCalled()
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('works when preference storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => { throw new Error('storage unavailable') },
    })
    const sound = createSound()
    expect(sound.muted).toBe(true)
    expect(() => sound.setMuted(false)).not.toThrow()
    expect(sound.muted).toBe(false)
  })

  it('starts muted until someone turns sound on', () => {
    expect(createSound().muted).toBe(true)
  })
})

describe('optional reset media readiness', () => {
  it('bounds boot waiting and accepts late metadata for subsequent reset timing', async () => {
    vi.useFakeTimers()
    FakeMedia.metadataReady = false
    const sound = createSound()
    const ready = vi.fn()
    const preparation = sound.prepare().then(ready)
    await vi.advanceTimersByTimeAsync(1499)
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await preparation
    expect(ready).toHaveBeenCalledTimes(1)
    expect(sound.resetDurationSeconds).toBe(4.754)

    const wave = FakeMedia.instances[1]
    wave.duration = 5.3
    wave.dispatchEvent(new Event('loadedmetadata'))
    expect(sound.resetDurationSeconds).toBe(5.3)
    sound.setMuted(true)
    expect(sound.playResetWave()).toBe(5.3)
  })

  it('releases metadata wait and timers on disposal', async () => {
    vi.useFakeTimers()
    FakeMedia.metadataReady = false
    const sound = createSound()
    const preparation = sound.prepare()
    sound.dispose()
    await preparation
    expect(vi.getTimerCount()).toBe(0)
    const wave = FakeMedia.instances[1]
    wave.duration = 9
    wave.dispatchEvent(new Event('loadedmetadata'))
    expect(sound.resetDurationSeconds).toBe(4.754)
  })
})
