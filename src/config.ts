export const SAND = {
  // An 8 cm bed leaves room to dig real holes down to the water table.
  resolution: 512, extent: 0.8, depth: 0.08, floor: 0.003,
  repose: 0.625, dynamicRepose: 0.48, rate: 32,
  step: 1 / 120, maxSteps: 4, radius: 0.012, indentation: 0.02,
  impactSpeedStart: 0.5, impactSpeedFull: 1.2, impactIndentation: 0.01,
  impactEvacuation: 0.86, impactEjectionFraction: 0.075,
  impactParticleMassMin: 0.0000012, impactParticleMassMax: 0.0000032,
  airborneGrainRadius: 0.00016, airborneReferenceMass: 0.000004,
  airborneShadowResolution: 512, airborneShadowStrength: 1.7,
  particles: 16384, maxContacts: 16,
} as const

export type Point = { x: number; y: number }

// Shader-side contact shape. Values are written into each contact's end.z.
export const TOOL_KIND = { finger: 0, rake: 1, broom: 4, smooth: 2, shell: 3, wind: 5, feet: 6, knife: 8 } as const
export type ContactTool = keyof typeof TOOL_KIND
// Pour, drip and water are not contacts: they land deposits of sand and/or
// moisture through their own pass.
export type DepositTool = 'pour' | 'drip' | 'water'
// Dig and mold move or add sand through the earthworks passes.
export type EarthTool = 'dig' | 'mold'
export type Tool = ContactTool | DepositTool | EarthTool
export const isDepositTool = (tool: Tool): tool is DepositTool => tool === 'pour' || tool === 'drip' || tool === 'water'
export const isEarthTool = (tool: Tool): tool is EarthTool => tool === 'dig' || tool === 'mold'
export const isContactTool = (tool: Tool): tool is ContactTool => tool in TOOL_KIND
export const TOOLS: readonly Tool[] = ['finger', 'knife', 'rake', 'broom', 'smooth', 'wind', 'shell', 'feet', 'dig', 'mold', 'pour', 'drip', 'water']
export const TOOL_KEYS: Record<Tool, string> = {
  finger: '1', rake: '2', broom: '3', smooth: '4', wind: '5', shell: '6', feet: '7', dig: '8', mold: '9', pour: '0', drip: '-', water: '=', knife: 'k',
}

// Tined tools in units of the size slider: tines on each side of the center
// tine, center-to-center spacing, and tine radius.
export const TINES = {
  rake: { half: 3, spacing: 1.5, radius: 0.42 },
  broom: { half: 6, spacing: 0.55, radius: 0.2 },
} as const
const tinedReach = (tines: { half: number; spacing: number; radius: number }) => tines.half * tines.spacing + tines.radius

// Every tool is driven by the one size slider (the finger radius). `reach` is
// the contact's outer half-width written as its radius, `feature` the narrowest
// dimension along the stroke (it bounds path resampling), and `pressure`
// replaces pointer pressure for tools whose depth is set by the tool itself.
export const TOOL_SHAPE: Record<ContactTool, { reach: number; feature: number; pressure?: number; pressureScale?: number }> = {
  finger: { reach: 1, feature: 1 },
  rake: { reach: tinedReach(TINES.rake), feature: TINES.rake.radius, pressureScale: 0.7 },
  broom: { reach: tinedReach(TINES.broom), feature: TINES.broom.radius * 2, pressureScale: 0.45 },
  // Tilted trowel, 3.5 size half-width and half that long, skimming 2.8 mm deep.
  smooth: { reach: 3.5, feature: 0.63, pressure: 0.14 },
  // Stationary press: scallop imprint of 2.6 size outer radius.
  shell: { reach: 2.6, feature: 2.6, pressure: 0.42 },
  // Wind brush of 3 size radius whose ripples have a 1.1 size wavelength.
  wind: { reach: 3, feature: 1, pressure: 0.12 },
  // Bare footprint 6.4 size long (reach is its half-length).
  feet: { reach: 3.2, feature: 3.2, pressure: 0.5 },
  // A thin blade (0.16 size, about 2 mm at the default size) cutting 3.6 cm
  // below the original surface, so one pass slices a sculpture to its base.
  knife: { reach: 0.16, feature: 0.16, pressure: 1.8 },
}
export const SHELL_PRESS_STEPS = 48
export const FOOT_PRESS_STEPS = 30
// Walking gait in units of the size slider: distance between successive
// footprints along the path and each foot's offset from the path centerline.
export const GAIT = { stride: 8, offset: 1.9 } as const
// Ripple wavelength as a fraction of the wind brush reach.
export const WIND_WAVELENGTH = 1.1 / 3

// Dihedral drawing symmetry about the bed center: `rotations` copies around the
// center, each also mirrored across the vertical axis when `mirror` is set.
export const SYMMETRIES = [
  { label: 'Off', rotations: 1, mirror: false },
  { label: 'Mirror', rotations: 1, mirror: true },
  { label: '×4', rotations: 2, mirror: true },
  { label: '×6', rotations: 3, mirror: true },
  { label: '×8', rotations: 4, mirror: true },
] as const
export type Symmetry = (typeof SYMMETRIES)[number]
export const symmetryImages = (symmetry: Symmetry) => symmetry.rotations * (symmetry.mirror ? 2 : 1)

// Moisture is stored per cell: 0 is dry, 1 saturated, above 1 a standing film.
export const WATER = {
  maxMoisture: 1.6, maxDropsPerFrame: 48,
  // Seconds for damp sand to lose 63% of its moisture, and for a standing film
  // to soak in.
  dampEvaporation: 150, filmInfiltration: 4,
  // Film thickness (m) per unit of moisture above saturation, used for runoff.
  filmThickness: 0.0005,
  // Groundwater: holes dug below this height fill with seeping water, and sand
  // within the capillary fringe above it stays damp.
  waterTable: 0.08 - 0.04, capillaryFringe: 0.012,
  // The sun-dried top layer: sand more than this far below the original
  // surface is damp subsurface sand.
  dryLayer: 0.02, subsurfaceWetness: 0.35,
  // Moisture describes the surface layer this thick: sand added on top mixes
  // into it by volume, so a thick dump of loose sand brings its own dampness.
  surfaceLayer: 0.005,
  // Bioluminescence: glow fades with this time constant (s); wet sand needs at
  // least `glowWetness` moisture for disturbed plankton to light up.
  glowFade: 1.3, glowWetness: 0.2,
  // Height of vertical face damp sand can stand (m): capillary cohesion.
  dampHold: 0.03,
} as const

// Digging: scoop volume per second at the default size (scales with size²),
// the scoop radius and how far the spoil is thrown, in units of the size
// slider, and the spoil's moisture. Thrown spoil is loose rather than packed,
// so it carries only enough moisture for about twice the dry cohesion; at the
// subsurface's full dampness it stacked into a needle instead of a heap.
export const DIG = { rate: 3e-5, radius: 2, throw: 3.6, spoilRadius: 0.9, spoilWetness: 0.1, maxPerFrame: 8 } as const

// Bucket molds, turned out as packed damp sand. Radius is in units of the size
// slider; shape heights are in units of the radius.
export const MOLDS = [
  { id: 'tower', label: 'Tower' },
  { id: 'castle', label: 'Castle' },
  { id: 'starfish', label: 'Starfish' },
  { id: 'turtle', label: 'Turtle' },
  { id: 'scallop', label: 'Shell' },
] as const
export type MoldShape = (typeof MOLDS)[number]['id']
export const MOLD = { radius: 3, wetness: 0.55, maxPerFrame: 8 } as const
// Preview-only footprint kind for mold outlines (not a contact).
export const MOLD_PREVIEW_KIND = 7

// Kinetic sand: polymer-bound sand whose strength comes from how packed it is
// rather than from water. Packed material holds crisp near-vertical faces;
// worked material is weaker and crumbly; everything creeps slowly downhill.
export const KINETIC = {
  // Height of vertical face that fully loose and fully packed kinetic sand can
  // stand (m), on top of its granular slope.
  looseHold: 0.004, packedHold: 0.045,
  // Fraction of the slope excess above the dry angle of repose that creeps
  // per substep, so sculptures sag over tens of seconds instead of avalanching.
  creep: 0.0013,
  // Packing of an untouched tray, of molded sand, and of poured or thrown sand.
  initialPacking: 0.55, moldPacking: 1, loosePacking: 0.12,
  // Crumbs: vigorous strokes shed clumps this many times heavier than beach
  // spray grains, thrown this much slower.
  crumbMass: 5, crumbSpeed: 0.35,
} as const

export type SandMaterial = { id: string; label: string; kinetic: boolean; color: readonly [number, number, number] }
// Kinetic colors are target albedos; each grain keeps its own brightness.
export const MATERIALS: readonly SandMaterial[] = [
  { id: 'beach', label: 'Beach', kinetic: false, color: [1, 1, 1] },
  { id: 'kinetic', label: 'Kinetic', kinetic: true, color: [0.7, 0.58, 0.42] },
  { id: 'pink', label: 'Pink', kinetic: true, color: [0.86, 0.46, 0.6] },
  { id: 'blue', label: 'Blue', kinetic: true, color: [0.32, 0.52, 0.84] },
  { id: 'purple', label: 'Purple', kinetic: true, color: [0.56, 0.41, 0.8] },
  { id: 'mint', label: 'Mint', kinetic: true, color: [0.46, 0.76, 0.62] },
]
// A landed deposit: `amount` moisture over a soft disk of `radius`, an impact
// pit of depth `pit`, and `sand` metres of new sand at the center of a
// Gaussian with standard deviation radius / 2 (volume sand · π · radius² / 4).
export type Deposit = { x: number; y: number; radius: number; amount: number; pit: number; pitRadius: number; sand: number; from?: Point }
export const POUR = {
  // Sand volume per second at the default size; scales with size squared.
  rate: 1e-5,
  // Stream deposit radius and drip blob radius, in units of the size slider.
  streamRadius: 0.8, dripRadius: 0.45,
  // Drips per second, the sand volume of one drip at the default size (scales
  // with size cubed), the moisture it carries (just past saturation, so a drip
  // slumps a little then sets as its film drains), and its landing scatter in
  // drip radii.
  dripRate: 7, dripVolume: 2.5e-7, dripWetness: 1.05, dripScatter: 0.35,
  // Falling-grain stream: grains spawned per substep per emitter.
  streamGrains: 40, maxEmitters: 8,
} as const

export type Stroke = {
  from: Point
  to: Point
  velocity: Point
  radius: number
  pressure: number
  active: boolean
  kind: number
  angle: number
  /** Footprint handedness: +1 or its mirror image -1; 0 for other shapes. */
  variant: number
}
export const idleStroke = (): Stroke => ({
  from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, velocity: { x: 0, y: 0 },
  radius: SAND.radius, pressure: 0, active: false, kind: TOOL_KIND.finger, angle: 0, variant: 0,
})
