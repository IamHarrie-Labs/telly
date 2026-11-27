// One small line-icon set for the app, drawn on a 20×20 grid with a 1.5 stroke to match the menu.
// Buttons ask for one with data-icon="name"; an icon-only button must also carry aria-label.

const PATHS = {
  check: 'M4 10.5l4 4 8-9',
  logout: 'M8 4H4v12h4M12 6l4 4-4 4M16 10H8',
  trash: 'M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10',
  copy: 'M7 7h9v9H7zM4 13V4h9',
  external: 'M11 4h5v5M16 4l-7 7M14 12v4H4V6h4',
  repeat: 'M4 9a5 5 0 0 1 9-3l2 2M15 4v4h-4M16 11a5 5 0 0 1-9 3l-2-2M5 16v-4h4',
  speaker: 'M4 8h3l4-3v10l-4-3H4zM14 7.5a3.5 3.5 0 0 1 0 5M16 5a7 7 0 0 1 0 10',
  stop: 'M6 6h8v8H6z',
  undo: 'M7 4L3 8l4 4M3 8h9a4 4 0 0 1 0 8H9',
  snippet: 'M5 3h7l3 3v11H5zM8 9h4M8 12h4',
  idea: 'M10 3a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9zM8 17h4',
  ticket: 'M3 6h14v3a1.5 1.5 0 0 0 0 3v3H3v-3a1.5 1.5 0 0 0 0-3zM12 6v9',
  pause: 'M7 5v10M13 5v10',
  cancel: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM5 5l10 10',
  play: 'M7 5l8 5-8 5z',
  calendar: 'M3 5h14v12H3zM3 9h14M7 3v4M13 3v4',
  send: 'M3 10l14-6-6 14-2-6z',
  chevronLeft: 'M12 5l-5 5 5 5',
  chevronRight: 'M8 5l5 5-5 5',
  code: 'M7 6l-4 4 4 4M13 6l4 4-4 4',
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] || '');
  svg.append(path);
  return svg;
}

/** Swaps a button's icon in place, for buttons that change state (Listen ↔ Stop, Copy ↔ Copied). */
export function setIcon(button, name) {
  const current = button.querySelector('svg.icon');
  if (current) current.replaceWith(icon(name));
  else button.prepend(icon(name));
}

/** Gives every [data-icon] element under root its icon, once. */
export function drawIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    if (!node.querySelector(':scope > svg.icon')) node.prepend(icon(node.dataset.icon));
  }
}

/** A button with an icon and, when label is given, words; icon-only buttons get a tooltip. */
export function iconButton(name, { label, title, className = 'small' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = label ? `${className} with-icon` : `${className} icon-btn`;
  button.append(icon(name));
  if (label) button.append(document.createTextNode(label));
  else {
    button.setAttribute('aria-label', title);
    button.title = title;
  }
  return button;
}
