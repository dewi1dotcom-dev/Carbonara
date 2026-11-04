// Top-down "exploded" car diagram for marking damage. Front of the car is up,
// so the car's left side is on the left of the drawing.
import { s } from './ui.js';

const W = 320;
const H = 428;

const CENTER = [
  { id: 'front_bumper', label: 'Front bumper', short: 'Bumper', x: 108, y: 14, w: 104, h: 22, rx: 11 },
  { id: 'hood', label: 'Bonnet / hood', short: 'Bonnet', x: 100, y: 38, w: 120, h: 84, rx: 14 },
  { id: 'windscreen', label: 'Windscreen', short: 'Windscreen', x: 106, y: 124, w: 108, h: 34, rx: 6 },
  { id: 'roof', label: 'Roof', short: 'Roof', x: 106, y: 160, w: 108, h: 118, rx: 6 },
  { id: 'rear_window', label: 'Rear window', short: 'Rear window', x: 106, y: 280, w: 108, h: 30, rx: 6 },
  { id: 'boot', label: 'Boot / tailgate', short: 'Boot', x: 100, y: 312, w: 120, h: 78, rx: 14 },
  { id: 'rear_bumper', label: 'Rear bumper', short: 'Bumper', x: 108, y: 392, w: 104, h: 22, rx: 11 },
];

const LEFT = [
  { id: 'wing_lf', label: 'Left front wing', x: 62, y: 38, w: 36, h: 84, rx: 8 },
  { id: 'door_lf', label: 'Left front door', x: 62, y: 124, w: 36, h: 92, rx: 4 },
  { id: 'door_lr', label: 'Left rear door', x: 62, y: 218, w: 36, h: 92, rx: 4 },
  { id: 'quarter_lr', label: 'Left rear quarter', x: 62, y: 312, w: 36, h: 78, rx: 8 },
  { id: 'mirror_l', label: 'Left mirror', x: 42, y: 128, w: 18, h: 16, rx: 4 },
  { id: 'wheel_lf', label: 'Left front wheel / tyre', x: 34, y: 56, w: 24, h: 48, rx: 8 },
  { id: 'wheel_lr', label: 'Left rear wheel / tyre', x: 34, y: 328, w: 24, h: 48, rx: 8 },
];

const RIGHT = LEFT.map((p) => ({
  ...p,
  id: p.id.replace(/_l(f|r)?$/, (m, a) => `_r${a ?? ''}`),
  label: p.label.replace('Left', 'Right'),
  x: W - p.x - p.w,
}));

export const DIAGRAM_PANELS = [...CENTER, ...LEFT, ...RIGHT];

export const EXTRA_PANELS = [
  { id: 'headlight_l', label: 'Left headlight' },
  { id: 'headlight_r', label: 'Right headlight' },
  { id: 'taillight_l', label: 'Left tail light' },
  { id: 'taillight_r', label: 'Right tail light' },
  { id: 'sill_l', label: 'Left sill' },
  { id: 'sill_r', label: 'Right sill' },
  { id: 'grille', label: 'Grille' },
  { id: 'underbody', label: 'Underbody' },
  { id: 'interior', label: 'Interior' },
  { id: 'other', label: 'Other' },
];

export const PANEL_LABELS = Object.fromEntries(
  [...DIAGRAM_PANELS, ...EXTRA_PANELS].map((p) => [p.id, p.label]),
);

/**
 * @param {object} o
 * @param {Array} o.damages      damages with pos_x/pos_y (0..1)
 * @param {boolean} o.editable   tap to add when true
 * @param {(panel:string,x:number,y:number)=>void} o.onAdd
 * @param {(damage:object, index:number)=>void} o.onSelect
 */
export function carDiagram({ damages, editable, onAdd, onSelect }) {
  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`, class: `car-diagram${editable ? ' editable' : ''}`,
    role: 'img', 'aria-label': 'Car damage diagram, front at the top',
  });

  for (const p of DIAGRAM_PANELS) {
    svg.append(s('rect', {
      class: 'panel', x: p.x, y: p.y, width: p.w, height: p.h, rx: p.rx, dataset: { panel: p.id },
    }, s('title', {}, p.label)));
    if (p.short) {
      svg.append(s('text', { class: 'panel-label', x: p.x + p.w / 2, y: p.y + p.h / 2 + 3 }, p.short));
    }
  }
  svg.append(
    s('text', { class: 'side-label', x: 14, y: H / 2, transform: `rotate(-90 14 ${H / 2})` }, 'LEFT'),
    s('text', { class: 'side-label', x: W - 14, y: H / 2, transform: `rotate(90 ${W - 14} ${H / 2})` }, 'RIGHT'),
  );

  damages.forEach((d, i) => {
    if (d.pos_x == null || d.pos_y == null) return;
    const cx = d.pos_x * W;
    const cy = d.pos_y * H;
    const g = s('g', { class: `marker sev-${d.severity}`, tabindex: 0 },
      s('circle', { cx, cy, r: 10 }),
      s('text', { x: cx, y: cy + 4 }, String(i + 1)),
      s('title', {}, `${i + 1}: ${PANEL_LABELS[d.panel] ?? d.panel} – ${d.damage_type} (${d.severity})`));
    g.addEventListener('click', (e) => { e.stopPropagation(); onSelect?.(d, i); });
    svg.append(g);
  });

  if (editable) {
    svg.addEventListener('click', (e) => {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      const panel = e.target.closest?.('[data-panel]')?.dataset.panel ?? 'other';
      const clamp = (v) => Math.min(1, Math.max(0, v));
      onAdd?.(panel, clamp(p.x / W), clamp(p.y / H));
    });
  }
  return svg;
}
