// Pictograms for the 14 allergens, in the style of the Food Standards
// Agency's allergen icons and chart: a coloured disc per allergen with a
// white drawing, its name underneath. The drawings are ComplyTrack's own
// (most are Lucide icons, ISC licence; peanuts, sesame and mustard are drawn
// here), not the FSA's artwork. They are plain SVG strings so the printed
// chart (lib/allergens.ts) and the screens share them.

/** Each allergen's drawing on a 24 x 24 grid, white 2px lines. */
const DRAWINGS: Record<string, string> = {
  celery: '<path d="M2 22c1.25-.987 2.27-1.975 3.9-2.2a5.56 5.56 0 0 1 3.8 1.5 4 4 0 0 0 6.187-2.353 3.5 3.5 0 0 0 3.69-5.116A3.5 3.5 0 0 0 20.95 8 3.5 3.5 0 1 0 16 3.05a3.5 3.5 0 0 0-5.831 1.373 3.5 3.5 0 0 0-5.116 3.69 4 4 0 0 0-2.348 6.155C3.499 15.42 4.409 16.712 4.2 18.1 3.926 19.743 3.014 20.732 2 22"/><path d="M2 22 17 7"/>',
  gluten: '<path d="M2 22 16 8"/><path d="M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z"/><path d="M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"/><path d="M15.47 13.47 17 15l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"/><path d="M19.47 9.47 21 11l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L13 11l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"/>',
  crustaceans: '<path d="M11 12h.01"/><path d="M13 22c.5-.5 1.12-1 2.5-1-1.38 0-2-.5-2.5-1"/><path d="M14 2a3.28 3.28 0 0 1-3.227 1.798l-6.17-.561A2.387 2.387 0 1 0 4.387 8H15.5a1 1 0 0 1 0 13 1 1 0 0 0 0-5H12a7 7 0 0 1-7-7V8"/><path d="M14 8a8.5 8.5 0 0 1 0 8"/><path d="M16 16c2 0 4.5-4 4-6"/>',
  eggs: '<path d="M12 2C8 2 4 8 4 14a8 8 0 0 0 16 0c0-6-4-12-8-12"/>',
  fish: '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/><path d="M18 12v.5"/><path d="M16 17.93a9.77 9.77 0 0 1 0-11.86"/><path d="M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"/><path d="M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4"/><path d="m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98"/>',
  lupin: '<circle cx="12" cy="12" r="3"/><path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5"/><path d="M12 7.5V9"/><path d="M7.5 12H9"/><path d="M16.5 12H15"/><path d="M12 16.5V15"/><path d="m8 8 1.88 1.88"/><path d="M14.12 9.88 16 8"/><path d="m8 16 1.88-1.88"/><path d="M14.12 14.12 16 16"/>',
  milk: '<path d="M8 2h8"/><path d="M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2"/><path d="M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0"/>',
  molluscs: '<path d="M14 11a2 2 0 1 1-4 0 4 4 0 0 1 8 0 6 6 0 0 1-12 0 8 8 0 0 1 16 0 10 10 0 1 1-20 0 11.93 11.93 0 0 1 2.42-7.22 2 2 0 1 1 3.16 2.44"/>',
  tree_nuts: '<path d="M12 4V2"/><path d="M5 10v4a7.004 7.004 0 0 0 5.277 6.787c.412.104.802.292 1.102.592L12 22l.621-.621c.3-.3.69-.488 1.102-.592A7.003 7.003 0 0 0 19 14v-4"/><path d="M12 4C8 4 4.5 6 4 8c-.243.97-.919 1.952-2 3 1.31-.082 1.972-.29 3-1 .54.92.982 1.356 2 2 1.452-.647 1.954-1.098 2.5-2 .595.995 1.151 1.427 2.5 2 1.31-.621 1.862-1.058 2.5-2 .629.977 1.162 1.423 2.5 2 1.209-.548 1.68-.967 2-2 1.032.916 1.683 1.157 3 1-1.297-1.036-1.758-2.03-2-3-.5-2-4-4-8-4Z"/>',
  soya: '<path d="M10.165 6.598C9.954 7.478 9.64 8.36 9 9c-.64.64-1.521.954-2.402 1.165A6 6 0 0 0 8 22c7.732 0 14-6.268 14-14a6 6 0 0 0-11.835-1.402Z"/><path d="M5.341 10.62a4 4 0 1 0 5.279-5.28"/>',
  sulphites: '<path d="M8 22h8"/><path d="M7 10h10"/><path d="M12 15v7"/><path d="M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z"/>',
  peanuts: '<path d="M12 2C8.7 2 7 4.3 7 6.8c0 1.9 1.2 3 1.2 5.2S7 15.3 7 17.2C7 19.7 8.7 22 12 22s5-2.3 5-4.8c0-1.9-1.2-3-1.2-5.2s1.2-3.3 1.2-5.2C17 4.3 15.3 2 12 2Z"/><path d="M10.5 6.5h.01"/><path d="M13.5 8.5h.01"/><path d="M10.5 16h.01"/><path d="M13.5 18h.01"/>',
  sesame: '<ellipse cx="8" cy="8.5" rx="2.4" ry="4" transform="rotate(-25 8 8.5)"/><ellipse cx="16" cy="8" rx="2.4" ry="4" transform="rotate(20 16 8)"/><ellipse cx="12" cy="17" rx="2.4" ry="4" transform="rotate(-5 12 17)"/>',
  mustard: '<path d="M10 2h4l1 4H9Z"/><path d="M8 6h8l1 3v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Z"/><path d="M7 12h10"/><path d="M7 17h10"/>',
};

/** Disc colours: each allergen its own, all dark enough for a white drawing. */
export const ALLERGEN_COLOURS: Record<string, string> = {
  celery: "#4d7c0f",
  gluten: "#92400e",
  crustaceans: "#dc2626",
  eggs: "#d97706",
  fish: "#1d4ed8",
  lupin: "#7e22ce",
  milk: "#0284c7",
  molluscs: "#0f766e",
  mustard: "#a16207",
  tree_nuts: "#78350f",
  peanuts: "#c2410c",
  sesame: "#57534e",
  soya: "#15803d",
  sulphites: "#9f1239",
};

/**
 * One allergen's pictogram as an SVG string. Unknown keys give an empty
 * string. `title` names it for screen readers; leave it out when the name
 * is printed next to the icon.
 */
export function allergenIconSvg(key: string, size = 32, title?: string): string {
  const drawing = DRAWINGS[key];
  if (!drawing) return "";
  const label = title ? ` role="img" aria-label="${title.replace(/["<>&]/g, "")}"` : ` aria-hidden="true"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"${label}>`
    + `<circle cx="16" cy="16" r="16" fill="${ALLERGEN_COLOURS[key]}"/>`
    + `<g transform="translate(6 6) scale(0.8333)" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${drawing}</g>`
    + `</svg>`;
}
