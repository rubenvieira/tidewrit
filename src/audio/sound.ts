import { sandWorkletSource } from './sand-worklet'

type GestureTrack = {
  x: number
  y: number
  time: number
  velocityX: number
  velocityY: number
  filteredSpeed: number
  speed: number
  pressure: number
  turn: number
  audibleUntil: number
}

type NavigatorWithAudioSession = Navigator & {
  audioSession?: { type: string }
}

const ambientVolume = 0.08
const waveVolume = 0.92
const proceduralVolume = 0.34
const splashVolume = 0.5
const thudVolume = 0.7
// Closely spaced pour drops share one splash voice instead of stacking.
const splashSpacingMilliseconds = 70
const minimumSampleMilliseconds = 1
const motionHoldMilliseconds = 55

function normalizedSpeed(pxPerSecond: number) {
  return Math.max(0, Math.min(1, (pxPerSecond - 24) / 1080))
}

function penPressure(event: PointerEvent) {
  return event.pointerType === 'pen' ? event.pressure : 0
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function requestPlaybackAudioSession() {
  if (!isAppleMobile()) return
  const session = (navigator as NavigatorWithAudioSession).audioSession
  if (!session) return
  try {
    session.type = 'playback'
  } catch {
    return
  }
}

export class SandSound {
  private readonly ambient = new Audio('/scene_assets/beach.mp3')
  private readonly wave = new Audio('/scene_assets/wave.mp3')
  private readonly gestures = new Map<number, GestureTrack>()
  private readonly unlockController = new AbortController()
  private context: AudioContext | undefined
  private ambientSource: MediaElementAudioSourceNode | undefined
  private ambientGain: GainNode | undefined
  private waveSource: MediaElementAudioSourceNode | undefined
  private waveGain: GainNode | undefined
  private sandNode: AudioWorkletNode | undefined
  private proceduralReady: Promise<void> | undefined
  private prepareReady: Promise<void> | undefined
  private readonly waveMetadataReady: Promise<void>
  private waveDuration = 4.754
  private disposed = false
  private splashNoise: AudioBuffer | undefined
  private lastSplash = -Infinity
  private lastThud = -Infinity

  constructor() {
    this.ambient.loop = true
    this.ambient.preload = 'auto'
    // Keep the media element itself at unity. iOS has historically ignored or
    // inconsistently applied HTMLMediaElement.volume, so the audible level is
    // controlled by the shared Web Audio gain stage instead.
    this.ambient.volume = 1
    this.ambient.setAttribute('playsinline', '')

    this.wave.preload = 'auto'
    this.wave.volume = 1
    this.wave.setAttribute('playsinline', '')
    this.waveMetadataReady = this.loadWaveMetadata()

    const unlock = () => { this.activatePlayback() }
    const { signal } = this.unlockController
    window.addEventListener('pointerdown', unlock, { signal, passive: true })
    window.addEventListener('keydown', unlock, { signal })
  }

  prepare() {
    if (this.prepareReady) return this.prepareReady
    this.prepareReady = Promise.all([this.prepareAudio(), this.waveMetadataReady]).then(() => undefined)
    return this.prepareReady
  }

  beginPointer(event: PointerEvent) {
    if (this.disposed) return
    this.activatePlayback()
    this.gestures.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      velocityX: 0,
      velocityY: 0,
      filteredSpeed: 0,
      speed: 0.025,
      pressure: penPressure(event),
      turn: 0,
      audibleUntil: performance.now() + motionHoldMilliseconds,
    })
    this.sendGestureState()
  }

  movePointer(event: PointerEvent, pointerId = event.pointerId) {
    const track = this.gestures.get(pointerId)
    if (!track) return

    const dt = Math.max(minimumSampleMilliseconds, event.timeStamp - track.time) / 1000
    const dx = event.clientX - track.x
    const dy = event.clientY - track.y
    const distance = Math.hypot(dx, dy)
    const rawSpeed = distance / dt
    const blend = 1 - Math.exp(-dt * 18)
    track.filteredSpeed += (rawSpeed - track.filteredSpeed) * blend

    const velocityX = dx / dt
    const velocityY = dy / dt
    const velocityMagnitude = Math.hypot(velocityX, velocityY)
    const oldMagnitude = Math.hypot(track.velocityX, track.velocityY)
    let turn = 0
    if (velocityMagnitude > 20 && oldMagnitude > 20) {
      const dot = (velocityX * track.velocityX + velocityY * track.velocityY) / (velocityMagnitude * oldMagnitude)
      turn = Math.max(0, Math.min(1, (1 - dot) * 0.72))
    }
    const acceleration = Math.hypot(velocityX - track.velocityX, velocityY - track.velocityY) / Math.max(3000, velocityMagnitude * 8)
    turn = Math.min(1, turn + acceleration * 0.35)

    track.x = event.clientX
    track.y = event.clientY
    track.time = event.timeStamp
    track.velocityX = velocityX
    track.velocityY = velocityY
    track.speed = normalizedSpeed(track.filteredSpeed)
    track.pressure = penPressure(event)
    track.turn = turn
    if (distance > 0) track.audibleUntil = performance.now() + motionHoldMilliseconds
    this.sendGestureState()
  }

  /** A short wet splash: band-limited noise whose band falls as the water spreads. */
  playSplash(intensity: number) {
    const context = this.context
    const now = performance.now()
    if (this.disposed || !context || context.state !== 'running' || now - this.lastSplash < splashSpacingMilliseconds) return
    this.lastSplash = now
    if (!this.splashNoise) {
      const length = Math.round(context.sampleRate * 0.6)
      this.splashNoise = context.createBuffer(1, length, context.sampleRate)
      const samples = this.splashNoise.getChannelData(0)
      for (let index = 0; index < length; index++) samples[index] = Math.random() * 2 - 1
    }
    const level = Math.max(0.05, Math.min(1, intensity))
    const duration = 0.12 + 0.38 * level
    const start = context.currentTime
    const source = new AudioBufferSourceNode(context, { buffer: this.splashNoise })
    const band = new BiquadFilterNode(context, { type: 'bandpass', Q: 0.9, frequency: 2600 + 1800 * level })
    band.frequency.exponentialRampToValueAtTime(700, start + duration)
    const gain = new GainNode(context, { gain: 0 })
    gain.gain.linearRampToValueAtTime(splashVolume * level, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    source.connect(band).connect(gain).connect(context.destination)
    source.start(start, Math.random() * 0.1, duration + 0.05)
    source.onended = () => { source.disconnect(); band.disconnect(); gain.disconnect() }
  }

  /** A soft low thud: a shovel scoop landing, or a bucket turned out (intensity 1). */
  playThud(intensity: number) {
    const context = this.context
    const now = performance.now()
    if (this.disposed || !context || context.state !== 'running' || now - this.lastThud < splashSpacingMilliseconds) return
    this.lastThud = now
    if (!this.splashNoise) return this.playSplash(0.01)
    const level = Math.max(0.05, Math.min(1, intensity))
    const duration = 0.09 + 0.16 * level
    const start = context.currentTime
    const source = new AudioBufferSourceNode(context, { buffer: this.splashNoise })
    const body = new BiquadFilterNode(context, { type: 'lowpass', Q: 1.1, frequency: 260 + 380 * level })
    body.frequency.exponentialRampToValueAtTime(90, start + duration)
    const gain = new GainNode(context, { gain: 0 })
    gain.gain.linearRampToValueAtTime(thudVolume * level, start + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    source.connect(body).connect(gain).connect(context.destination)
    source.start(start, Math.random() * 0.2, duration + 0.05)
    source.onended = () => { source.disconnect(); body.disconnect(); gain.disconnect() }
  }

  update(now: number) {
    if (this.gestures.size) this.sendGestureState(now)
  }

  endPointer(pointerId: number) {
    if (!this.gestures.delete(pointerId)) return
    this.sendGestureState()
  }

  cancelAll() {
    if (!this.gestures.size) return
    this.gestures.clear()
    this.sendGestureState()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.unlockController.abort()
    this.cancelAll()
    this.sandNode?.disconnect()
    this.sandNode = undefined
    this.ambientSource?.disconnect()
    this.ambientSource = undefined
    this.ambientGain?.disconnect()
    this.ambientGain = undefined
    this.waveSource?.disconnect()
    this.waveSource = undefined
    this.waveGain?.disconnect()
    this.waveGain = undefined
    if (this.context) void this.context.close()
    this.context = undefined
    this.ambient.pause()
    this.wave.pause()
    this.wave.currentTime = 0
    this.ambient.removeAttribute('src')
    this.wave.removeAttribute('src')
    this.ambient.load()
    this.wave.load()
  }

  private async prepareAudio() {
    if (this.disposed) return
    const context = this.ensureContext()
    const procedural = this.ensureProcedural(context)

    // Make a best-effort autoplay attempt as soon as the scene is setting up.
    // Browsers that permit autoplay can start immediately; restricted browsers
    // keep the graph primed so the first real gesture only has to resume it.
    this.activatePlayback()
    await procedural
  }

  private activatePlayback() {
    if (this.disposed) return
    const context = this.ensureContext()

    // Keep resume() and media play() in the same synchronous user-activation
    // stack. In particular, do not await AudioWorklet.addModule() here: WebKit
    // can consume the transient activation before an asynchronous continuation.
    if (context.state !== 'running') void context.resume().catch(() => undefined)
    void this.playAmbient()
    void this.ensureProcedural(context).then(() => this.sendGestureState())
  }

  private ensureContext() {
    if (this.context) return this.context

    // WebKit maps ordinary Web Audio to an ambient session on iOS, which can
    // be muted by the Ring/Silent switch while HTML media remains audible.
    // A playback session keeps both parts of this game's mix on one route.
    requestPlaybackAudioSession()

    const context = new AudioContext({ latencyHint: 'interactive' })
    const ambientSource = context.createMediaElementSource(this.ambient)
    const ambientGain = new GainNode(context, { gain: ambientVolume })
    ambientSource.connect(ambientGain).connect(context.destination)

    const waveSource = context.createMediaElementSource(this.wave)
    const waveGain = new GainNode(context, { gain: waveVolume })
    waveSource.connect(waveGain).connect(context.destination)

    this.context = context
    this.ambientSource = ambientSource
    this.ambientGain = ambientGain
    this.waveSource = waveSource
    this.waveGain = waveGain
    return context
  }

  get resetDurationSeconds() { return this.waveDuration }

  playResetWave() {
    if (this.disposed) return this.waveDuration
    this.activatePlayback()
    this.wave.pause()
    try { this.wave.currentTime = 0 } catch {
      // Some browsers throw while the media pipeline is still attaching.
    }
    void this.wave.play().catch(() => undefined)
    return this.waveDuration
  }

  private loadWaveMetadata() {
    return new Promise<void>((resolve) => {
      const finalize = () => {
        const duration = this.wave.duration
        if (Number.isFinite(duration) && duration > 0) this.waveDuration = duration
        resolve()
      }
      if (this.wave.readyState >= HTMLMediaElement.HAVE_METADATA) {
        finalize()
        return
      }
      this.wave.addEventListener('loadedmetadata', finalize, { once: true })
      this.wave.addEventListener('error', () => resolve(), { once: true })
      this.wave.load()
    })
  }

  private async playAmbient() {
    if (this.disposed || !this.ambient.paused) return
    await this.ambient.play().catch(() => undefined)
  }

  private ensureProcedural(context: AudioContext) {
    if (this.proceduralReady) return this.proceduralReady
    this.proceduralReady = this.createProcedural(context).catch((error: unknown) => {
      console.warn('[Tidewrit audio] Procedural drawing sound unavailable.', error)
    })
    return this.proceduralReady
  }

  private async createProcedural(context: AudioContext) {
    if (this.disposed || this.sandNode) return
    const blob = new Blob([sandWorkletSource], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (this.disposed || context !== this.context) return

    const sandNode = new AudioWorkletNode(context, 'sand-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    const highpass = new BiquadFilterNode(context, { type: 'highpass', frequency: 90, Q: 0.7 })
    const presence = new BiquadFilterNode(context, { type: 'peaking', frequency: 2200, Q: 0.75, gain: -4.8 })
    const soften = new BiquadFilterNode(context, { type: 'lowpass', frequency: 4800, Q: 0.42 })
    const compressor = new DynamicsCompressorNode(context, {
      threshold: -18,
      knee: 16,
      ratio: 2.2,
      attack: 0.004,
      release: 0.09,
    })
    const master = new GainNode(context, { gain: proceduralVolume })

    sandNode.connect(highpass).connect(presence).connect(soften).connect(compressor).connect(master).connect(context.destination)
    this.sandNode = sandNode
  }

  private sendGestureState(now = performance.now()) {
    if (!this.sandNode) return
    if (!this.gestures.size) {
      this.sandNode.port.postMessage({ type: 'state', gate: 0, speed: 0, pressure: 0, turn: 0 })
      return
    }

    let strongest: GestureTrack | undefined
    let strongestEnergy = -1
    for (const track of this.gestures.values()) {
      if (track.audibleUntil < now) continue
      const energy = track.speed * (0.92 + track.pressure * 0.08)
      if (energy > strongestEnergy) {
        strongest = track
        strongestEnergy = energy
      }
    }
    if (!strongest) {
      this.sandNode.port.postMessage({ type: 'state', gate: 0, speed: 0, pressure: 0, turn: 0 })
      return
    }
    this.sandNode.port.postMessage({
      type: 'state',
      gate: 1,
      speed: strongest.speed,
      pressure: strongest.pressure,
      turn: strongest.turn,
    })
  }
}
