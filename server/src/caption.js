const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const execP = promisify(execFile);

function tmpFile(ext) {
  return path.join(os.tmpdir(), `cly_cap_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

// ffmpeg drawtext filter-level escaping (file-based, no shell escaping needed)
function escDrawtext(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  "\\'")
    .replace(/:/g,  '\\:')
    .replace(/%/g,  '%%');
}

const FONT_DIR = process.env.FONT_DIR || '/usr/share/fonts/ttf-dejavu';
const F = {
  bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  sans: path.join(FONT_DIR, 'DejaVuSans.ttf'),
  mono: path.join(FONT_DIR, 'DejaVuSansMono.ttf'),
};

const Y_EXPR = {
  top:    'th+20',
  center: '(h-th)/2',
  bottom: 'h-th-20',
};

function buildDrawtext(text, style, position, width) {
  const t    = escDrawtext(text);
  const size = Math.max(18, Math.round(width * 0.072));
  const y    = Y_EXPR[position] || Y_EXPR.bottom;

  const dt = (f, fc, bw, bc, sx, sy, sc) =>
    `drawtext=fontfile='${f}':text='${t}':fontcolor=${fc}:fontsize=${size}` +
    `:borderw=${bw}:bordercolor=${bc}:shadowx=${sx}:shadowy=${sy}:shadowcolor=${sc}` +
    `:x=(w-tw)/2:y=${y}`;

  switch (style) {
    case 'bold':       return dt(F.bold, 'white',   6, 'black@0.85', 3, 3, 'black@0.5');
    case 'neon':       return dt(F.sans, '#00ffcc', 2, '#00ffcc@0.4', 0, 0, '#00ffcc@0.9');
    case 'typewriter': return dt(F.mono, 'white',   0, 'black@0',    2, 2, 'black@0.85');
    case 'clean':      return dt(F.sans, 'white',   1, 'black@0.55', 0, 0, 'black@0');
    default:           return dt(F.bold, 'white',   3, 'black',      0, 0, 'black@0'); // classic
  }
}

async function getGifWidth(inputPath) {
  const { stdout } = await execP('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-select_streams', 'v:0',
    inputPath,
  ]);
  return JSON.parse(stdout).streams?.[0]?.width || 480;
}

async function addCaption(inputBuffer, text, style, position) {
  const inputPath  = tmpFile('.gif');
  const outputPath = tmpFile('.gif');
  const scriptPath = tmpFile('.txt');

  fs.writeFileSync(inputPath, inputBuffer);

  try {
    const width    = await getGifWidth(inputPath);
    const drawtext = buildDrawtext(text, style, position, width);
    const filter   =
      `[0:v]${drawtext}[dt];` +
      `[dt]split[s0][s1];` +
      `[s0]palettegen=max_colors=256:stats_mode=full[p];` +
      `[s1][p]paletteuse=dither=floyd_steinberg[out]`;

    fs.writeFileSync(scriptPath, filter);

    await execP('ffmpeg', [
      '-y', '-i', inputPath,
      '-filter_complex_script', scriptPath,
      '-map', '[out]',
      outputPath,
    ]);

    return fs.readFileSync(outputPath);
  } finally {
    for (const f of [inputPath, outputPath, scriptPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

module.exports = { addCaption };
