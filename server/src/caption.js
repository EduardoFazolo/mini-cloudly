const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const execP = promisify(execFile);

function tmpFile(ext) {
  return path.join(os.tmpdir(), `cly_cap_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

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

function buildDrawtext(text, style, x_pct, y_pct, width, height) {
  const t    = escDrawtext(text);
  const size = Math.max(18, Math.round(width * 0.072));
  const px   = Math.round(x_pct * width);
  const py   = Math.round(y_pct * height);
  const x    = `max(0\\,min(w-tw\\,${px}-tw/2))`;
  const y    = `max(0\\,min(h-th\\,${py}-th/2))`;

  const dt = (f, fc, bw, bc, sx, sy, sc) =>
    `drawtext=fontfile='${f}':text='${t}':fontcolor=${fc}:fontsize=${size}` +
    `:borderw=${bw}:bordercolor=${bc}:shadowx=${sx}:shadowy=${sy}:shadowcolor=${sc}` +
    `:x=${x}:y=${y}`;

  switch (style) {
    case 'bold':       return dt(F.bold, 'white',   6, 'black@0.85', 3, 3, 'black@0.5');
    case 'neon':       return dt(F.sans, '#00ffcc', 2, '#00ffcc@0.4', 0, 0, '#00ffcc@0.9');
    case 'typewriter': return dt(F.mono, 'white',   0, 'black@0',    2, 2, 'black@0.85');
    case 'clean':      return dt(F.sans, 'white',   1, 'black@0.55', 0, 0, 'black@0');
    default:           return dt(F.bold, 'white',   3, 'black',      0, 0, 'black@0');
  }
}

async function getGifDimensions(inputPath) {
  const { stdout } = await execP('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-select_streams', 'v:0',
    inputPath,
  ]);
  const s = JSON.parse(stdout).streams?.[0];
  return { width: s?.width || 480, height: s?.height || 320 };
}

// texts: [{ text, style, x_pct, y_pct }, ...]
async function addCaption(inputBuffer, texts) {
  const inputPath  = tmpFile('.gif');
  const outputPath = tmpFile('.gif');
  const scriptPath = tmpFile('.txt');

  fs.writeFileSync(inputPath, inputBuffer);

  try {
    const { width, height } = await getGifDimensions(inputPath);

    const chain = texts
      .map(t => buildDrawtext(t.text, t.style, t.x_pct, t.y_pct, width, height))
      .join(',');

    const filter =
      `[0:v]${chain}[dt];` +
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
