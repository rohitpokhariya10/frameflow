import sharp from 'sharp';

/**
 * A tent card's artwork, drawn: a white page, a mint panel with a diamond lattice, a border of dots along the panel's edge,
 * leaves and a flower at the top right over the border, a boat with white dots on it at the bottom right, a star at the left.
 */
export async function artwork() {
  const W = 900, H = 1200, dots: string[] = [];
  for (let x = 60; x <= 840; x += 30) for (const y of [80, 1120]) dots.push(`<circle cx="${x}" cy="${y}" r="8" fill="#c6f000" stroke="#0b6b3a" stroke-width="3"/>`);
  for (let y = 110; y <= 1090; y += 30) for (const x of [60, 840]) dots.push(`<circle cx="${x}" cy="${y}" r="8" fill="#c6f000" stroke="#0b6b3a" stroke-width="3"/>`);
  const lattice = '<pattern id="d" width="80" height="50" patternUnits="userSpaceOnUse"><path d="M0 25 L40 0 L80 25 L40 50 Z" fill="none" stroke="#fcfad7" stroke-width="3"/></pattern>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${lattice}</defs><rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="60" y="80" width="780" height="1040" fill="#baf5d7"/><rect x="60" y="80" width="780" height="1040" fill="url(#d)"/>${dots.join('')}
    <ellipse cx="790" cy="120" rx="70" ry="30" fill="#2fbf4a" transform="rotate(-35 790 120)"/><ellipse cx="740" cy="150" rx="60" ry="24" fill="#5fe052" transform="rotate(20 740 150)"/>
    <circle cx="760" cy="190" r="34" fill="#ff7043" stroke="#7a1f00" stroke-width="4"/><circle cx="760" cy="190" r="12" fill="#ffd54f"/>
    <path d="M520 1060 Q700 1150 880 960 L880 1080 Q700 1190 520 1060 Z" fill="#ff7043" stroke="#3b1400" stroke-width="4"/>
    ${[[650, 1105], [700, 1105], [750, 1094]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5" fill="#ffffff"/>`).join('')}
    <polygon points="200,600 214,640 256,640 222,664 236,704 200,680 164,704 178,664 144,640 186,640" fill="#8e44ff"/></svg>`;
  return { png: await sharp(Buffer.from(svg)).png().toBuffer(), W, H };
}
/** The leaves (two rotated ellipses) and the flower (a circle) of the drawn artwork, as a decomposition would give them. */
export function leafAndFlowerMasks(W: number, H: number) {
  const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number, deg: number) => { const a = (-deg * Math.PI) / 180, dx = x - cx, dy = y - cy, u = dx * Math.cos(a) - dy * Math.sin(a), v = dx * Math.sin(a) + dy * Math.cos(a); return (u / (rx + 2)) ** 2 + (v / (ry + 2)) ** 2 <= 1; };
  const leaves = new Uint8Array(W * H), flower = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (inEllipse(x, y, 790, 120, 70, 30, -35) || inEllipse(x, y, 740, 150, 60, 24, 20)) leaves[y * W + x] = 1;
    if ((x - 760) ** 2 + (y - 190) ** 2 <= 38 ** 2) flower[y * W + x] = 1;
  }
  return { leaves, flower };
}

/** The drawn artwork as an offer poster: a headline and a line of copy on the panel (a template to scan and reuse). */
export async function artworkPosterPng() {
  const { png, W, H } = await artwork(), sans = 'font-family="DejaVu Sans, Arial, sans-serif"';
  const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="130" y="420" ${sans} font-weight="700" font-size="110" fill="#0b3d2e">Big Sale</text><text x="130" y="540" ${sans} font-size="52" fill="#0b3d2e">On all cards</text></svg>`);
  return sharp(png).composite([{ input: text, left: 0, top: 0 }]).png().toBuffer();
}
