# Untouched bed relief

The initial bed and the wave reset share `bedRelief()` (`simulation/bed-relief.ts`), so a reset lays down exactly the surface the app starts with. It is smooth value noise at four scales: centimetre swells of about ±0.2 mm and ±0.1 mm at 4.5 and 1.7 cm, millimetre bumps at 5.5 and 2.9 mm, and the tray's original long, low undulation. It replaced independent random heights per 1.5 mm cell, which looked like a regular woven grid under a low sun. Slopes stay far below the angle of repose, so the relief never flows on its own.
