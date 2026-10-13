# Drawing symmetry

Symmetry is dihedral about the bed center: `rotations` copies, each optionally mirrored across the vertical axis (Mirror = 2 images, ×4 = D2, ×6 = D3, ×8 = D4). It is applied when contacts leave the queue, not when input arrives, so pointer tracks, resampling, and timing stay single-valued and only the per-substep contact batch grows.

A queued contact is taken only when all of its images fit in the batch, so a mandala never renders with a missing arm. `maxContacts` is 16 so ×8 symmetry still moves two segments per substep; the contact pass loops only over active contacts and rejects by reach first, so the larger cap costs nothing when symmetry is off. Mirrored shells reflect their orientation (the scallop is symmetric about its own axis, so reflection is angle negation). Water drops use the same transforms.
