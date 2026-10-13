# Undo and redo

Snapshots hold only the conserved bed: height and moisture, 8 bytes per cell (2 MiB at 512²). Undo and redo together keep at most 16, so history is bounded at 32 MiB, and buffers are recycled rather than reallocated. Activity, velocity, flux, contact, and airborne grains are transient and are cleared on restore, so a restored bed starts at rest. Grains still airborne at capture time are not part of the snapshot, which is a negligible mass difference.

One snapshot is taken per gesture: at pointer down when no other pointer is held (multi-touch shares it), at keyboard drawing start, at zen garden start, and before "Start again", so the wave reset is undoable. Captures are queued by input and encoded at the start of the next frame, before that frame's substeps, so the snapshot always precedes the stroke it guards. Undo and redo cancel live strokes, pending water, and the autopilot first.
