# The sand dock

The dock keeps the current tool, size, scene, creative actions, and reset visible. All thirteen tools remain available in the tool panel, with names and keyboard shortcuts. On narrow screens the dock uses two rows and the tool panel uses a four-column grid; touch targets do not shrink as more tools are added. The tool hint describes the selected gesture without placing instructions over the working surface.

Only one panel is open at a time. Panels are non-modal: tapping the sand closes the panel and starts that same gesture. Escape or the close button returns focus to an available dock control; selecting a drawing tool returns focus to the sand, while selecting the bucket opens its shape chooser. Material selection returns to scene settings. Radio groups use one tab stop and arrow/Home/End selection without dismissing their panel. Opening a group focuses its selected option.

Panel placement follows the measured dock and the visual viewport, including the on-screen keyboard. Layout is updated through ResizeObserver and viewport events, never from the render loop. Reset closes all panels and disables every editing control, including material and mold options. Sound remains available during a wash. The sound toggle persists its mute state; U toggles it, and ? opens the pointers and shortcuts panel.

Export feedback distinguishes a generated download, a completed share, cancellation, and failure. It never claims that a file reached disk: the browser owns download delivery. Unsupported-only messages stay in the writer with feedback instead of silently dismissing it.
