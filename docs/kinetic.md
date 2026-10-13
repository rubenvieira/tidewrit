# Kinetic sand

The Sand chooser switches the whole bed between beach sand, held together by water, and kinetic sand, held together by a binder whose strength depends on how packed the sand is. The concepts come from Sculpt & Settle's particle-and-bond model: packing governs strength, and material that has been moved is worked loose. They are re-derived here for the heightfield; none of its code is used.

**Cohesion is a holding height.** For both materials, cohesion is the height of vertical face the sand can stand (Rankine's critical height of a cohesive cut), added on top of the granular slope threshold. This replaced a multiplier on the repose slope: even at 14× the dry repose slope, neighboring 1.5 mm cells could differ by only about 1 cm, so knife cuts and castle walls refilled within frames. Damp beach sand holds 3 cm (flooding removes it); kinetic sand holds 0.4 cm loose to 4.5 cm packed. A bond is severed only where both of its cells are under a tool's core, so the faces a cut leaves keep their full strength and displaced sand is pushed outward instead of pouring back.

The holding height limits a whole face, not each cell step. Applied per link, it let a staircase of steps, each within the limit, stand arbitrarily tall: even barely damp spoil (0.1 moisture, about 2 mm of hold) stacked into a 6 cm peak at about 60°. Each link therefore also looks one cell further down. If the drop over those two cells (the local relief) already exceeds the holding height, the face is taller than the material can stand and the cohesive term fades out between one and two holding heights. Single tall faces up to the holding height, such as castle walls, knife cuts and hole walls, stay vertical; tall heaps and staircases slump to their granular angle. It costs one extra read per link.

**Packing** is a per-cell field (0 loose to 1 molded) that describes the surface layer and rides with the sand in the hydrate pass:
- sand a tool shoves into a cell is compressed and keeps its packing;
- sand that arrives by flowing on its own (slumping, creeping) tumbles loose, arriving at half its packing;
- a tool's core presses the sand under it firm;
- poured, dripped and thrown sand lands loose (0.12), mixed into the surface layer by volume;
- molds land fully packed;
- the tray starts at 0.55, and resets restore that.

Packing is tracked in both modes but only governs strength in kinetic mode. It is part of undo snapshots (12 bytes per cell).

**Creep.** Kinetic sand never avalanches. Instead, everything steeper than dry sand's angle of repose creeps at 0.13% of its excess per substep, so sculptures hold their edges for the first seconds and then sag and spread over tens of seconds. Molded detail does round off; that slow flow is part of the material.

**Crumbs.** Fast strokes shed half the frontier ejection budget, as clumps five times heavier and thrown at 35% of the speed. They read as tumbling crumbs rather than spray. Ambient agitation launches are off.

**Knife.** The knife (K) is a thin, deep blade: a 0.16-size capsule cutting 3.6 cm below the original surface. A heightfield has to put the slit's volume (about two cells wide) into lips beside the cut, and some of that crumbles back in. One pass cuts a clean slit about 40% of the way through a tower; further passes cut deeper. It works in both materials.

**Look.** Kinetic grains are finer (0.24 mm against 0.43 mm) and matte (glints at 8%). Packed faces are smoother, with grain relief reduced by up to 55%, and worked material looks porous, with more crevice occlusion. Colors are target albedos, so each grain keeps its own brightness.

Freshly cut faces were a stretch goal: in Sculpt & Settle, slices bend as sheets and fall away, which a heightfield cannot represent.
