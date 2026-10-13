import { MATERIALS, MOLDS, SYMMETRIES, TOOLS, TOOL_KEYS, type Tool } from '../config'
import { DAYLIGHTS } from '../render/daylight'

export type InterfaceElements = ReturnType<typeof createInterface>

const toolLabels: Record<Tool, string> = {
  finger: 'Finger', knife: 'Knife', rake: 'Rake', broom: 'Broom', smooth: 'Smooth', wind: 'Wind',
  shell: 'Shell', feet: 'Feet', dig: 'Dig', mold: 'Bucket', pour: 'Pour', drip: 'Drip', water: 'Water',
}
const toolTitles: Record<Tool, string> = {
  finger: 'Draw with a fingertip',
  knife: 'Slice cleanly through anything',
  rake: 'Comb parallel grooves',
  broom: 'Sweep fine streaks',
  smooth: 'Level the sand with a flat blade',
  wind: 'Brush an area to grow wind ripples',
  shell: 'Tap to press a scallop shell',
  feet: 'Drag to walk footprints, tap for one',
  dig: 'Hold to dig a hole, drag to dig a trench',
  mold: 'Tap to turn out a bucket mold',
  pour: 'Hold to pour a stream of dry sand',
  drip: 'Hold to drip wet sand into castles',
  water: 'Tap to splash, drag to pour, flick to throw water',
}
const icon = (path: string) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
const toolIcons: Record<Tool, string> = {
  finger: icon('<path d="M9.5 21v-9.5a1.75 1.75 0 0 1 3.5 0V15l3.6.9a2 2 0 0 1 1.4 2.4L17.2 21"/><path d="M7 7.5a4.5 4.5 0 0 1 8.5-2"/>'),
  knife: icon('<path d="M4 20 15.5 8.5l3 3L7 23"/><path d="M15.5 8.5 19.5 4.5a2.1 2.1 0 0 1 3 3l-4 4"/>'),
  rake: icon('<path d="M12 3v8M5 11h14M5 11v6M8.5 11v6M12 11v6M15.5 11v6M19 11v6"/>'),
  broom: icon('<path d="M12 3v8M8 11h8l2.5 9h-13z"/><path d="M9.5 15v5M12 15v5M14.5 15v5"/>'),
  smooth: icon('<path d="M3.5 17h12l5-4h-12z"/><path d="M13 13V7.5a2 2 0 0 1 2-2h1.5"/>'),
  wind: icon('<path d="M3 8.5h10.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12.5h15a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 16.5h7"/>'),
  shell: icon('<path d="M12 20 4.2 10a8.2 8.2 0 0 1 15.6 0z"/><path d="M12 20 8.2 6.6M12 20V5.4M12 20l3.8-13.4M10 20h4"/>'),
  feet: icon('<ellipse cx="8.5" cy="15.5" rx="2.4" ry="4"/><ellipse cx="15.5" cy="8.5" rx="2.4" ry="4"/><path d="M7 10.2h.01M10 10.4h.01M14 3.2h.01M17 3.4h.01"/>'),
  dig: icon('<path d="M15.5 3.5 20.5 8.5"/><path d="M18 6 10.5 13.5"/><path d="M11.8 12.2 6.6 17.4a2.6 2.6 0 0 1-3.7-3.7l5.2-5.2z"/>'),
  mold: icon('<path d="M5.5 8h13l-1.8 12H7.3z"/><path d="M5.5 8a6.5 4 0 0 1 13 0"/><path d="M9 12.5h6"/>'),
  pour: icon('<path d="M4.5 3.5h7l-1.2 4.5H5.7z"/><path d="M8.5 8v5.5M8.5 15.5v.5"/><path d="M3 20.5 8.5 17l5.5 3.5z"/>'),
  drip: icon('<path d="M12 21c-3 0-4.2-1.4-4.2-2.8 0-1.6 1.6-2.6 4.2-2.6s4.2 1 4.2 2.6c0 1.4-1.2 2.8-4.2 2.8z"/><path d="M12 15.6c-1.9 0-2.8-.9-2.8-1.9 0-1.2 1.1-2 2.8-2s2.8.8 2.8 2c0 1-.9 1.9-2.8 1.9z"/><path d="M12 11.7c-1.2 0-1.8-.7-1.8-1.4 0-.9.7-1.6 1.8-1.6s1.8.7 1.8 1.6c0 .7-.6 1.4-1.8 1.4z"/><path d="M12 8.7V4"/>'),
  water: icon('<path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>'),
}
const shortcut = (tool: Tool) => TOOL_KEYS[tool].toUpperCase()

export function createInterface(root: HTMLDivElement) {
  root.innerHTML = `
    <canvas class="surface" aria-label="Interactive sand bed. Drag to draw. Keys 1 to 0, minus and equals pick finger, rake, broom, smoother, wind, shell, feet, dig, bucket, pour, drip or water; K picks the knife. T changes the sand, M changes symmetry, L changes the time of day, G starts a zen garden, W writes a message. Arrow keys move a virtual tool; hold Space to draw. Brackets change tool size. Control Z undoes, S saves an image, R resets." tabindex="0"></canvas>
    <header class="masthead">
      <h1 class="brand" aria-label="Sandboard">
        <span aria-hidden="true">s</span><span aria-hidden="true">a</span><span aria-hidden="true">n</span><span aria-hidden="true">d</span><span aria-hidden="true">b</span><span aria-hidden="true">o</span><span aria-hidden="true">a</span><span aria-hidden="true">r</span><span aria-hidden="true">d</span>
      </h1>
    </header>
    <nav class="actions" aria-label="History and export">
      <button id="undo" type="button" title="Undo (Ctrl/⌘ Z)" aria-label="Undo" disabled>${icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>')}</button>
      <button id="redo" type="button" title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo" disabled>${icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>')}</button>
      <button id="save" type="button" title="Save image (S)" aria-label="Save image">${icon('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>')}</button>
    </nav>
    <nav class="toolbar" aria-label="Sand tools">
      <div class="tools" role="radiogroup" aria-label="Tool">${TOOLS.map((tool, index) => `<button type="button" role="radio" data-tool="${tool}" aria-checked="${index === 0}" aria-label="${toolLabels[tool]}" title="${toolTitles[tool]} (${shortcut(tool)})">${toolIcons[tool]}<span>${toolLabels[tool]}</span></button>`).join('')}</div>
      <span class="divider" aria-hidden="true"></span>
      <label>Size <input id="radius" type="range" min="6" max="22" step="1" value="12" aria-label="Tool size" /></label>
      <span class="divider" aria-hidden="true"></span>
      <div class="modes">
        <button id="symmetry" type="button" title="Drawing symmetry (M)" aria-label="Symmetry: ${SYMMETRIES[0].label}">Symmetry <b>${SYMMETRIES[0].label}</b></button>
        <button id="material" type="button" title="Sand (T)" aria-expanded="false" aria-controls="materials" aria-label="Sand: ${MATERIALS[0].label}">Sand <b>${MATERIALS[0].label}</b></button>
        <button id="light" type="button" title="Time of day (L)" aria-label="Time of day: ${DAYLIGHTS[0].label}"><b>${DAYLIGHTS[0].label}</b></button>
        <button id="zen" type="button" title="Let a rake draw a zen garden (G)" aria-pressed="false">Zen garden</button>
        <button id="write" type="button" title="Write a message in the sand (W)" aria-expanded="false" aria-controls="writer">Write</button>
      </div>
      <span class="divider" aria-hidden="true"></span>
      <button id="reset" type="button" title="Return to untouched sand (R)">Start again</button>
    </nav>
    <div id="materials" class="options" role="radiogroup" aria-label="Sand" hidden>${MATERIALS.map((material, index) => `<button type="button" role="radio" data-material="${material.id}" aria-checked="${index === 0}">${material.kinetic ? `<i style="background: rgb(${material.color.map((channel) => Math.round(channel * 255)).join(' ')})"></i>` : ''}${material.label}</button>`).join('')}</div>
    <div id="molds" class="options" role="radiogroup" aria-label="Bucket mold" hidden>${MOLDS.map((mold, index) => `<button type="button" role="radio" data-mold="${mold.id}" aria-checked="${index === 0}">${mold.label}</button>`).join('')}</div>
    <form id="writer" class="writer" hidden autocomplete="off">
      <input id="message" type="text" maxlength="48" placeholder="A message for the sand" aria-label="Message to write in the sand" enterkeyhint="go" />
      <button type="submit">Write it</button>
    </form>
    <section class="overlay" aria-live="polite">
      <div class="boot-panel"><h2>One quiet moment.</h2><p class="status">Preparing the sand bed…</p><div class="boot-line"></div><pre class="diagnostics" hidden></pre><button id="reload" hidden>Try again</button></div>
    </section>`
  const element = <ElementType extends HTMLElement>(selector: string) => root.querySelector<ElementType>(selector)!
  element<HTMLButtonElement>('#reload').onclick = () => window.location.reload()
  return {
    canvas: element<HTMLCanvasElement>('canvas'), overlay: element<HTMLElement>('.overlay'),
    title: element<HTMLElement>('.boot-panel h2'), status: element<HTMLElement>('.status'),
    diagnostics: element<HTMLElement>('.diagnostics'), reload: element<HTMLButtonElement>('#reload'),
    radius: element<HTMLInputElement>('#radius'), reset: element<HTMLButtonElement>('#reset'),
    tools: [...root.querySelectorAll<HTMLButtonElement>('[data-tool]')],
    symmetry: element<HTMLButtonElement>('#symmetry'), zen: element<HTMLButtonElement>('#zen'), light: element<HTMLButtonElement>('#light'),
    write: element<HTMLButtonElement>('#write'), writer: element<HTMLFormElement>('#writer'), message: element<HTMLInputElement>('#message'),
    molds: element<HTMLElement>('#molds'), moldButtons: [...root.querySelectorAll<HTMLButtonElement>('[data-mold]')],
    material: element<HTMLButtonElement>('#material'), materials: element<HTMLElement>('#materials'), materialButtons: [...root.querySelectorAll<HTMLButtonElement>('[data-material]')],
    undo: element<HTMLButtonElement>('#undo'), redo: element<HTMLButtonElement>('#redo'), save: element<HTMLButtonElement>('#save'),
  }
}
