# Time of day and bioluminescence

**Presets.** Light (L) cycles Afternoon, Golden hour, Night, and Morning. Afternoon is exactly the original light: direction (cos −0.8, 0.65, sin −0.8) with a 2.55-intensity warm sun. Transitions take 2.4 s and interpolate azimuth along the shortest turn and elevation, not the direction vector, so the sun travels a sky arc and shadows swing round instead of shrinking through the vertical. The renderer receives a sampled `Daylight` every frame: the direct light color, a sky tint applied to ambient and reflections, a night amount, and a palm-shadow opacity scale.

**What follows the sun.**
- Horizon lighting is recomputed whenever the direction changes, keyed on the direction, and is cached otherwise.
- The airborne-grain shadow uses the live direction.
- The palm tree's shadow projection is now driven by the live direction in its shader. Its projected bounds and on-screen footprint are recomputed from the stored tree positions when the sun moves; during transitions the existing temporal stabilization blends the change.
- Glints scale with the sun's luminance relative to the afternoon sun.

**Bioluminescence.** A per-cell glow field fades with a 1.3 s time constant. It is excited in the hydrate pass by contact in wet sand (moisture ≥ 0.2): a still press counts, motion counts more, and the disturbed shell faintly. Landing water excites it in the deposit pass. Each cell reads only itself, so it updates in place without ping-pong. The surface adds it as blue emission, multiplied by the night amount (daylight drowns it, as on a real beach) and by a steep per-grain random, so it sparkles on individual grains rather than washing over the sand.
