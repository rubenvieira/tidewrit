// Play chrome: the shared header, dock, hint, About dialog and loading screen
// for every experiment on play.rubenv.net. Source of truth: rubenv.net/play-chrome.
// Copied into each experiment by play-chrome/sync.sh; edit it there, not in a copy.
import './play-chrome.css';

export const PLAY_HOME = 'https://play.rubenv.net/';

const LOGO_PATHS = '<path class="pc-r" d="M8 12H89C118 12 139 31 139 57C139 81 122 99 98 99H83.333L134 175H107L41.667 77H93C108 77 117 69 117 57C117 43 106 34 90 34H22.667Z"/><path class="pc-r" d="M181.2 42H207.4L132.9 166.167L119.1 145.5Z"/><path class="pc-dot" d="M200.4 10H226.6L212.2 34H186Z"/>';
export const logo = `<svg class="pc-logo" viewBox="0 0 235 184" aria-hidden="true">${LOGO_PATHS}</svg>`;

/** A 24×24 line icon in the Play style. */
export const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const icons = {
  sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path class="pc-wave" d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/><path class="pc-mute" d="m16 9.5 5 5m0-5-5 5"/>'),
  keep: icon('<path d="M4 8.5h3.2L9 6h6l1.8 2.5H20v10H4z"/><circle cx="12" cy="13" r="3.2"/>'),
  info: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>'),
  all: icon('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
  reset: icon('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4h4"/>'),
  pause: icon('<path d="M9 6v12M15 6v12"/>'),
  play: icon('<path d="M8 5.5v13l10.5-6.5z"/>'),
  show: icon('<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  fullscreen: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  record: icon('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  share: icon('<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/>'),
  settings: icon('<path d="M5 7h9M18 7h1M5 17h3M12 17h7"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
};

export interface BarOptions {
  /** The experiment's name, e.g. "Pastel de Nata". */
  title: string;
  /** One short line shown beside the title on wide screens. */
  tagline?: string;
  /** Extra round buttons after Sound / Save / About (HTML from `iconButton`). */
  extras?: string;
  /** Leave out a utility the experiment cannot offer. */
  sound?: boolean;
  keep?: boolean;
  about?: boolean;
  /** Sound starts off everywhere; set true only if the piece cannot work silently. */
  soundOn?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A round icon button for the bar. */
export const iconButton = (id: string, label: string, svg: string, attrs = '') =>
  `<button id="${id}" class="pc-icon" type="button" title="${esc(label)}" ${attrs}>${svg}<span class="pc-sr">${esc(label)}</span></button>`;

/** The header bar. Keeps the ids #sound, #keep and #about-open that experiments wire up. */
export function barHTML(o: BarOptions): string {
  const utilities = [
    o.sound !== false ? `<button id="sound" class="pc-icon pc-sound" type="button" aria-pressed="${o.soundOn ? 'true' : 'false'}" title="Sound">${icons.sound}<span class="pc-sr">Sound</span></button>` : '',
    o.keep !== false ? iconButton('keep', 'Save a picture', icons.keep) : '',
    o.about !== false ? iconButton('about-open', 'About and controls (?)', icons.info, 'aria-haspopup="dialog"') : '',
    o.extras ?? '',
  ].join('');
  return `<header class="pc-bar pc-glass">
    <div class="pc-crumb"><a class="pc-home" href="${PLAY_HOME}" target="_top" title="All experiments on Play">${logo}<span class="pc-play">Play /</span></a><h1 class="pc-title">${esc(o.title)}</h1></div>
    ${o.tagline ? `<p class="pc-tagline">${esc(o.tagline)}</p>` : ''}
    <div class="pc-actions">${utilities}<a class="pc-all" href="${PLAY_HOME}" target="_top">${icons.all}<span>All experiments</span></a></div>
  </header>`;
}

export interface AboutOptions {
  title: string;
  /** One or two paragraphs on what the piece is (HTML allowed). */
  intro: string;
  /** Rows of the controls list: [label, HTML]. Keep Tools / View / Keys in that order. */
  items: [string, string][];
  /** The close button's words, e.g. "Back to the table". */
  close?: string;
}

/** The About dialog (#about). */
export function aboutHTML(o: AboutOptions): string {
  return `<dialog id="about" class="pc-about" aria-labelledby="about-title">
    <form method="dialog">
      <h2 id="about-title">${logo}${esc(o.title)}</h2>
      ${o.intro.trim().startsWith('<') ? o.intro : `<p>${o.intro}</p>`}
      <dl>${o.items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="pc-about-actions"><button value="close" class="pc-primary">${esc(o.close ?? 'Back to it')}</button></div>
      <p class="pc-about-links"><a href="${PLAY_HOME}" target="_top">More experiments on Play</a></p>
    </form>
  </dialog>`;
}

/** The loading screen. Add `pc-ready` to <body> (or call `ready()`) to fade it out. */
export const loadingHTML = (text: string) =>
  `<div class="pc-loading" role="status">${logo}<span>${esc(text)}</span></div>`;

/** The hint pill above the dock; write into its <output>. */
export const hintHTML = () => `<p class="pc-hint hint"><output aria-live="polite"></output></p>`;

export const ready = () => document.body.classList.add('pc-ready');

/** Saves the canvas as a PNG. For WebGL, call it right after drawing, in the same frame. */
export function savePicture(canvas: HTMLCanvasElement, name: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

export interface MountOptions {
  /** The experiment's highlight colour for the active tool and sliders. */
  accent?: string;
  /** Text colour on the accent; dark by default. */
  onAccent?: string;
  /** Background behind the loading screen; usually the scene's clear colour. */
  night?: string;
  /** Called when the interface is hidden or shown with H. */
  onHide?: (hidden: boolean) => void;
  /** Set false when the experiment already handles H itself. */
  hideKey?: boolean;
}

/** Wires the shared behaviour: accent, About (button and ?), hiding with H. */
export function mountChrome(o: MountOptions = {}) {
  const root = document.documentElement.style;
  if (o.accent) root.setProperty('--pc-accent', o.accent);
  if (o.onAccent) root.setProperty('--pc-on-accent', o.onAccent);
  if (o.night) root.setProperty('--pc-night', o.night);
  if (!document.querySelector('.pc-dock')) document.body.classList.add('pc-no-dock');

  const about = document.querySelector<HTMLDialogElement>('#about');
  document.querySelector('#about-open')?.addEventListener('click', () => about?.showModal());

  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'pc-show';
  show.hidden = true;
  show.innerHTML = `${icons.show}<span>Show controls</span>`;
  document.body.appendChild(show);
  const setHidden = (hidden: boolean) => {
    document.body.classList.toggle('pc-hidden', hidden);
    show.hidden = !hidden;
    o.onHide?.(hidden);
  };
  show.addEventListener('click', () => setHidden(false));

  addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || t?.closest?.('input, textarea, select, [contenteditable], dialog')) return;
    if (e.key === '?' && about && !about.open) { e.preventDefault(); about.showModal(); }
    else if (o.hideKey !== false && (e.key === 'h' || e.key === 'H')) setHidden(!document.body.classList.contains('pc-hidden'));
  });
  return { setHidden, about };
}
