/** A representative football still for the spike, generated as an inline SVG
 * data URI rather than shipped as a photo.
 *
 * Three reasons it is not a JPEG:
 *  - The gate runs on a phone against a dev server over LAN wifi, often with
 *    no internet. A data URI cannot fail to load.
 *  - No binary asset enters the repo for a spike that will be deleted.
 *  - The dimensions are known exactly, so coordinate-space assertions have a
 *    fixed reference.
 *
 * It is sized like a real all-22 frame (1600x1000) so the render-scale and
 * memory numbers the HUD reports are the numbers a real photo would produce.
 * A genuine film still can be dropped in later by changing this one constant;
 * nothing else depends on its contents.
 */

export const SPIKE_IMAGE_SIZE = { width: 1600, height: 1000 };

const OFFENSE_Y = 620;
const DEFENSE_Y = 470;

/** Interior line, tackles and tight end, evenly spread about the ball. */
const LINE_X = [520, 640, 760, 880, 1000, 1120];
const DEFENSIVE_FRONT_X = [580, 700, 820, 940, 1060];

function field(): string {
  const yardLines = Array.from({ length: 11 }, (_, index) => {
    const x = 100 + index * 140;
    return `<line x1="${x}" y1="60" x2="${x}" y2="940" stroke="#eaf3ea" stroke-width="${
      index % 2 === 0 ? 4 : 2
    }" opacity="0.55"/>`;
  }).join('');

  const hashes = Array.from({ length: 44 }, (_, index) => {
    const x = 90 + index * 34;
    return `<line x1="${x}" y1="392" x2="${x}" y2="412" stroke="#eaf3ea" stroke-width="3" opacity="0.4"/>
            <line x1="${x}" y1="640" x2="${x}" y2="660" stroke="#eaf3ea" stroke-width="3" opacity="0.4"/>`;
  }).join('');

  return `${yardLines}${hashes}`;
}

function offense(): string {
  const linemen = LINE_X.map(
    (x) =>
      `<circle cx="${x}" cy="${OFFENSE_Y}" r="26" fill="#f8fafc" stroke="#0f172a" stroke-width="4"/>`,
  ).join('');

  return `${linemen}
    <circle cx="820" cy="710" r="26" fill="#f8fafc" stroke="#0f172a" stroke-width="4"/>
    <text x="820" y="719" font-family="Helvetica,Arial" font-size="24" font-weight="bold"
      text-anchor="middle" fill="#0f172a">Q</text>
    <circle cx="820" cy="810" r="26" fill="#f8fafc" stroke="#0f172a" stroke-width="4"/>
    <text x="820" y="819" font-family="Helvetica,Arial" font-size="24" font-weight="bold"
      text-anchor="middle" fill="#0f172a">RB</text>
    <circle cx="300" cy="${OFFENSE_Y}" r="26" fill="#f8fafc" stroke="#0f172a" stroke-width="4"/>
    <circle cx="1340" cy="${OFFENSE_Y}" r="26" fill="#f8fafc" stroke="#0f172a" stroke-width="4"/>`;
}

function defense(): string {
  const front = DEFENSIVE_FRONT_X.map(
    (x) => `<g stroke="#facc15" stroke-width="7" stroke-linecap="round">
      <line x1="${x - 20}" y1="${DEFENSE_Y - 20}" x2="${x + 20}" y2="${DEFENSE_Y + 20}"/>
      <line x1="${x + 20}" y1="${DEFENSE_Y - 20}" x2="${x - 20}" y2="${DEFENSE_Y + 20}"/>
    </g>`,
  ).join('');

  const backers = [700, 940].map(
    (x) => `<g stroke="#facc15" stroke-width="7" stroke-linecap="round">
      <line x1="${x - 20}" y1="330" x2="${x + 20}" y2="370"/>
      <line x1="${x + 20}" y1="330" x2="${x - 20}" y2="370"/>
    </g>`,
  ).join('');

  const secondary = [
    [300, 330],
    [1340, 330],
    [820, 180],
  ]
    .map(
      ([x, y]) => `<g stroke="#facc15" stroke-width="7" stroke-linecap="round">
      <line x1="${x - 18}" y1="${y - 18}" x2="${x + 18}" y2="${y + 18}"/>
      <line x1="${x + 18}" y1="${y - 18}" x2="${x - 18}" y2="${y + 18}"/>
    </g>`,
    )
    .join('');

  return `${front}${backers}${secondary}`;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SPIKE_IMAGE_SIZE.width}" height="${SPIKE_IMAGE_SIZE.height}" viewBox="0 0 ${SPIKE_IMAGE_SIZE.width} ${SPIKE_IMAGE_SIZE.height}">
  <defs>
    <linearGradient id="turf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2f6b3d"/>
      <stop offset="100%" stop-color="#245530"/>
    </linearGradient>
  </defs>
  <rect width="${SPIKE_IMAGE_SIZE.width}" height="${SPIKE_IMAGE_SIZE.height}" fill="url(#turf)"/>
  ${field()}
  <line x1="100" y1="545" x2="1500" y2="545" stroke="#38bdf8" stroke-width="5" opacity="0.85"/>
  ${defense()}
  ${offense()}
  <text x="40" y="70" font-family="Helvetica,Arial" font-size="30" font-weight="bold" fill="#eaf3ea"
    opacity="0.75">SPIKE STILL - 2nd &amp; 6</text>
</svg>`;

/** encodeURIComponent rather than base64: no btoa/Buffer branch to get wrong
 * across jsdom and the browser, and the payload is smaller for text. */
export const SPIKE_IMAGE_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
