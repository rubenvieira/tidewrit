# Water

Moisture is a per-cell field (0 dry, 1 saturated, above 1 a standing film, capped at 1.6) in its own ping-pong buffer pair that follows the sand state index. It is not packed into the state vector because every state lane is already used, and a separate pass keeps the transport kernel within the eight-storage-buffer default limit (transport reads moisture as its eighth binding).

**Landing.** The water tool never makes a contact. Deposits are shared with pour and drip, which add Gaussian sand mounds through the same pass (`pouring.md`). `WaterThrower` turns gestures into drops with landing times (tap: pool plus droplets; drag: trickle every 0.9 size; flick above 0.35 m/s: an elongated splat thrown ahead, with flight time growing with distance). Landed drops are uploaded once per frame (at most 48, after symmetry) and applied by one pass dispatched only over their bounding box. Impact pits use the profile -(1 - r²)·exp(-r²), whose depression and rim integrate to zero, so pits move sand without creating or destroying it.

**Transport.** After each integrate, a hydrate pass advects moisture with the sand that the conservative flux actually moved (mass-weighted mix), adds slow symmetric capillary diffusion (weakened by height difference between neighbors), and moves the film down the water-surface gradient (bed height plus 0.5 mm per film unit). All exchanges are symmetric per link, so water is conserved apart from drying. Damp moisture decays with a 150 s time constant, while film soaks in with a 4 s one. Below the water table, groundwater keeps holes flooded (`earthworks.md`).

**Behavior.** Damp sand gains cohesion: it stands vertical faces up to 3 cm, so damp cuts hold vertical walls and molded and drip castles stand (see `kinetic.md` and `earthworks.md`), holds steeper walls and suppresses grain spray. Past saturation the threshold drops below dry, but runoff drains peaks within a few steps, so a soaked mound turns damp and holds. Slumping only occurs where water actually pools (flooded groove walls). This is deliberate and matches real sand. Dry sand absorbs arriving water up to saturation before any film forms, so puddles collect in grooves only once the surroundings are wet.

**Rendering.** The surface shader samples moisture bilinearly. Damp darkens albedo and reduces glints. Film flattens grain relief, drops roughness to a mirror, and uses a water Fresnel term.

The wave reset dries the rows it rebuilds, and a full reset clears moisture.
