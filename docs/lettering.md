# Writing in the sand

`input/lettering.ts` is an original single-stroke font (A–Z, 0–9, `. , ! ? ' - + : &` and ♥, also typed as `<3`) drawn with lines, elliptical arcs and Catmull-Rom curves in cap-height units. Strokes are ordered and directed as a hand would write them, because the autopilot plays them back literally. A dot is a tiny circle, since a fingertip held still leaves no mark by design. Lowercase is uppercased and unsupported characters are dropped before layout.

Layout tries one to four lines (greedy wrap toward equal widths) and keeps the arrangement with the largest letters that fit the visible bed between the masthead and toolbar, capped at a 9 cm cap height. Screen up is bed −y, so glyph y maps to decreasing bed y. The finger radius is 8.5% of the cap height (4–12 mm), and writing runs at 0.22 m/s through the same autopilot as the zen garden, so it is undoable as one step and can be drawn over while it writes.
