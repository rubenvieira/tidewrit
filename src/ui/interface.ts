import { MATERIALS, MOLDS, SYMMETRIES, TOOLS } from '../config'
import { DAYLIGHTS } from '../render/daylight'
import { InterfaceControls } from './controls'
import { aboutHTML, barHTML, logo } from '../play-chrome/play-chrome.ts'
import { icon, shortcut, toolIcons, toolLabels, toolTitles } from './tools'

export type InterfaceNodes = ReturnType<typeof createElements>
export type InterfaceElements = ReturnType<typeof createInterface>

const closeButton = `<button class="panel-close" type="button" data-close-panel aria-label="Close panel">${icon('<path d="m6 6 12 12M18 6 6 18"/>')}</button>`
const panelHeading = (id: string, title: string, eyebrow: string) => `<div class="panel-heading"><div><p class="eyebrow">${eyebrow}</p><h2 id="${id}">${title}</h2></div>${closeButton}</div>`

function createElements(root: HTMLDivElement) {
  root.innerHTML = `
    <canvas class="surface" aria-label="Interactive sand bed" aria-describedby="canvas-instructions" tabindex="0"></canvas>
    <p id="canvas-instructions" class="sr-only">Drag to draw in the sand. Use the tools menu to choose a tool. With the canvas focused, arrow keys move the tool and holding Space draws. Brackets change size. Control or Command Z undoes. R resets. Press ? for all shortcuts.</p>
    ${barHTML({ title: 'Tidewrit', tagline: 'A little room to play.' })}
    <p id="tool-hint" class="pc-hint tool-hint">${toolTitles.finger}</p>
      <nav class="toolbar pc-dock pc-glass pc-wrap" aria-label="Sand controls">
        <button id="tool-picker" class="tool-picker" type="button" aria-expanded="false" aria-controls="tool-panel"><span id="tool-icon" class="pc-keep-label">${toolIcons.finger}</span><span id="tool-name">Finger</span>${icon('<path d="m8 10 4 4 4-4"/>')}</button>
        <label class="size-control"><span>Size <output id="size-value" for="radius">12</output></span><input id="radius" type="range" min="6" max="22" step="1" value="12" aria-label="Tool size" /></label>
        <button id="scene-picker" class="scene-picker" type="button" aria-expanded="false" aria-controls="scene-panel">${icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>')}<span>Scene</span></button>
        <button id="create-picker" class="create-picker" type="button" aria-expanded="false" aria-controls="create-panel">${icon('<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>')}<span>Create</span></button>
        <span class="pc-sep"></span>
        <button id="undo" class="pc-only" type="button" title="Undo (Ctrl/⌘ Z)" aria-label="Undo" disabled>${icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>')}</button>
        <button id="redo" class="pc-only" type="button" title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo" disabled>${icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>')}</button>
        <button id="reset" class="reset pc-only" type="button" title="Wash the sand clean (R)" aria-label="Start again">${icon('<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7"/>')}</button>
      </nav>
    <section id="tool-panel" class="panel tool-panel" aria-labelledby="tool-panel-title" hidden>
      ${panelHeading('tool-panel-title', 'Make your mark.', 'Your tools')}
      <div class="tools" role="radiogroup" aria-label="Tool">${TOOLS.map((tool, index) => `<button type="button" role="radio" data-tool="${tool}" aria-checked="${index === 0}" tabindex="${index === 0 ? 0 : -1}" aria-label="${toolLabels[tool]}" title="${toolTitles[tool]} (${shortcut(tool)})">${toolIcons[tool]}<span>${toolLabels[tool]}</span><kbd>${shortcut(tool)}</kbd></button>`).join('')}</div>
      <p class="panel-note">Slow for detail. A quick stroke sends grains flying.</p>
    </section>
    <section id="scene-panel" class="panel" aria-labelledby="scene-panel-title" hidden>
      ${panelHeading('scene-panel-title', 'Set the mood.', 'Your patch of sand')}
      <div class="scene-settings">
        <button id="material" type="button" title="Sand (T)" aria-expanded="false" aria-controls="materials" aria-label="Sand: ${MATERIALS[0].label}"><span>Sand</span><b>${MATERIALS[0].label}</b></button>
        <button id="light" type="button" title="Time of day (L)" aria-label="Time of day: ${DAYLIGHTS[0].label}"><span>Time of day</span><b>${DAYLIGHTS[0].label}</b></button>
        <button id="symmetry" type="button" title="Drawing symmetry (M)" aria-label="Symmetry: ${SYMMETRIES[0].label}"><span>Symmetry</span><b>${SYMMETRIES[0].label}</b></button>
      </div>
      <p class="panel-note">Try night for a little bioluminescence.</p>
    </section>
    <section id="create-panel" class="panel" aria-labelledby="create-panel-title" hidden>
      ${panelHeading('create-panel-title', 'Follow a little curiosity.', 'Something to try')}
      <div class="create-options">
        <button id="zen" type="button" title="Let a rake draw a zen garden (G)" aria-pressed="false">${toolIcons.rake}<span><b>Zen garden</b><small>Let the rake wander. Tap again to stop.</small></span></button>
        <button id="write" type="button" title="Write a message in the sand (W)" aria-expanded="false" aria-controls="writer">${icon('<path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4"/>')}<span><b>A message in the sand</b><small>A few words, drawn one stroke at a time.</small></span></button>
        <button id="help" type="button" aria-haspopup="dialog" aria-controls="about">${icon('<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01"/>')}<span><b>A few pointers</b><small>Gestures, tools and keyboard shortcuts.</small></span></button>
      </div>
    </section>
    <section id="materials" class="panel" aria-labelledby="materials-title" hidden>
      ${panelHeading('materials-title', 'Find your texture.', 'Sand')}
      <div class="material-options" role="radiogroup" aria-label="Sand">${MATERIALS.map((material, index) => `<button type="button" role="radio" data-material="${material.id}" aria-checked="${index === 0}" tabindex="${index === 0 ? 0 : -1}"><i style="background: rgb(${material.color.map((channel) => Math.round(channel * 255)).join(' ')})"></i>${material.label}</button>`).join('')}</div>
      <p class="panel-note">Kinetic sand holds sharper edges. Try it with the knife.</p>
    </section>
    <section id="molds" class="panel" aria-labelledby="molds-title" hidden>
      ${panelHeading('molds-title', 'Turn out something new.', 'Bucket shapes')}
      <div class="mold-options" role="radiogroup" aria-label="Bucket mold">${MOLDS.map((mold, index) => `<button type="button" role="radio" data-mold="${mold.id}" aria-checked="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${mold.label}</button>`).join('')}</div>
      <p class="panel-note">Pick a shape, then tap the sand to place it.</p>
    </section>
    <form id="writer" class="panel writer" aria-labelledby="writer-title" hidden autocomplete="off">
      ${panelHeading('writer-title', 'Leave a little message.', 'Written by the sand')}
      <label class="sr-only" for="message">Message to write in the sand</label>
      <div class="writer-field"><input id="message" type="text" maxlength="48" placeholder="Wish you were here <3" enterkeyhint="go" /><button type="submit">Write it</button></div>
      <p class="panel-note">Letters, numbers and &lt;3 for a heart. Up to 48 characters.</p>
    </form>
    ${aboutHTML({
      title: 'Tidewrit',
      intro: 'A patch of sand simulated grain by grain on your graphics card. Drag a finger through it. Hold to pour or dig, tap to stamp a shell or bucket, and flick water to throw it. On a touch screen, try a few fingers at once.',
      items: [
        ['Tools', 'Pick one from the tool button in the dock. Slow for detail; a quick stroke sends grains flying.'],
        ['Scene', 'Sand, time of day and drawing symmetry. Try night for a little bioluminescence.'],
        ['Create', 'Let a rake draw a zen garden, or have the sand write a message.'],
        ['Keyboard', 'With the sand focused, arrow keys move the tool and holding <kbd>Space</kbd> draws. <kbd>[</kbd> <kbd>]</kbd> change size.'],
        ['Keys', '<kbd>Ctrl/⌘ Z</kbd> undo · <kbd>⇧</kbd> redo · T sand · L light · M symmetry · G zen garden · W write · S save · U sound · R reset · H hides the interface · ? this page.'],
      ],
      close: 'Back to the sand',
    })}
    <p id="feedback" class="feedback" role="status" aria-live="polite" aria-atomic="true" hidden></p>
    <section class="overlay" aria-live="polite"><div class="boot-panel">${logo}<h2>One quiet moment.</h2><p class="status">Preparing the sand bed…</p><div class="boot-line"></div><pre class="diagnostics" hidden></pre><button id="reload" type="button" hidden>Try again</button></div></section>`
  const element = <ElementType extends HTMLElement>(selector: string) => root.querySelector<ElementType>(selector)!
  element<HTMLButtonElement>('#reload').onclick = () => window.location.reload()
  return {
    root, canvas: element<HTMLCanvasElement>('canvas'), overlay: element<HTMLElement>('.overlay'),
    title: element<HTMLElement>('.boot-panel h2'), status: element<HTMLElement>('.status'),
    diagnostics: element<HTMLElement>('.diagnostics'), reload: element<HTMLButtonElement>('#reload'),
    radius: element<HTMLInputElement>('#radius'), reset: element<HTMLButtonElement>('#reset'),
    tools: [...root.querySelectorAll<HTMLButtonElement>('[data-tool]')],
    symmetry: element<HTMLButtonElement>('#symmetry'), zen: element<HTMLButtonElement>('#zen'), light: element<HTMLButtonElement>('#light'),
    write: element<HTMLButtonElement>('#write'), writer: element<HTMLFormElement>('#writer'), message: element<HTMLInputElement>('#message'),
    molds: element<HTMLElement>('#molds'), moldButtons: [...root.querySelectorAll<HTMLButtonElement>('[data-mold]')],
    material: element<HTMLButtonElement>('#material'), materials: element<HTMLElement>('#materials'), materialButtons: [...root.querySelectorAll<HTMLButtonElement>('[data-material]')],
    undo: element<HTMLButtonElement>('#undo'), redo: element<HTMLButtonElement>('#redo'), save: element<HTMLButtonElement>('#keep'),
    sound: element<HTMLButtonElement>('#sound'), help: element<HTMLButtonElement>('#help'),
    toolbar: element<HTMLElement>('.toolbar'), toolPicker: element<HTMLButtonElement>('#tool-picker'),
    scenePicker: element<HTMLButtonElement>('#scene-picker'), createPicker: element<HTMLButtonElement>('#create-picker'),
    toolPanel: element<HTMLElement>('#tool-panel'), scenePanel: element<HTMLElement>('#scene-panel'), createPanel: element<HTMLElement>('#create-panel'),
    toolIcon: element<HTMLElement>('#tool-icon'), toolName: element<HTMLElement>('#tool-name'), toolHint: element<HTMLElement>('#tool-hint'),
    sizeValue: element<HTMLOutputElement>('#size-value'), feedback: element<HTMLElement>('#feedback'),
  }
}

export function createInterface(root: HTMLDivElement) {
  const nodes = createElements(root)
  return { ...nodes, controls: new InterfaceControls(nodes) }
}
