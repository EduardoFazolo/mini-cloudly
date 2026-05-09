const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const execP = promisify(execFile);

function tmpFile(ext) {
  return path.join(os.tmpdir(), `cly_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

function mimeToExt(mime) {
  const m = {
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv',
    'image/gif': '.gif', 'image/jpeg': '.jpg',
    'image/png': '.png', 'image/webp': '.webp',
  };
  return m[mime] || '.bin';
}

async function ffmpeg(...args) {
  await execP('ffmpeg', ['-y', ...args]);
}

async function ffprobe(file) {
  const { stdout } = await execP('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', file,
  ]);
  return JSON.parse(stdout);
}

// ─── Video ───
// Two-pass with calculated bitrate. Verifies output size and re-encodes
// with lower bitrate if container overhead pushed it over target.

async function compressVideo(inputPath, outputPath, mime, targetBytes) {
  const info     = await ffprobe(inputPath);
  const duration = parseFloat(info.format.duration);
  if (!duration || duration < 0.1) throw new Error('cannot determine video duration');

  const isWebm = mime === 'video/webm';

  async function encodeAtBitrate(vkbps, outPath) {
    const logBase = tmpFile('');
    try {
      if (isWebm) {
        await ffmpeg(
          '-i', inputPath,
          '-c:v', 'libvpx-vp9', '-b:v', `${vkbps}k`,
          '-deadline', 'good', '-cpu-used', '2',
          '-c:a', 'libopus', '-b:a', '96k',
          outPath,
        );
      } else {
        // H.264 two-pass — deterministic bitrate targeting
        await ffmpeg(
          '-i', inputPath,
          '-c:v', 'libx264', '-b:v', `${vkbps}k`,
          '-preset', 'slow', '-tune', 'film',
          '-pass', '1', '-passlogfile', logBase,
          '-an', '-f', 'null', '/dev/null',
        );
        await ffmpeg(
          '-i', inputPath,
          '-c:v', 'libx264', '-b:v', `${vkbps}k`,
          '-preset', 'slow', '-tune', 'film',
          '-pass', '2', '-passlogfile', logBase,
          '-c:a', 'aac', '-b:a', '96k',
          outPath,
        );
      }
    } finally {
      for (const f of [`${logBase}-0.log`, `${logBase}-0.log.mbtree`]) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }

  const audioBitrate = 96;
  // Target 93% of desired size to absorb container overhead
  const safeTarget   = targetBytes * 0.93;
  let videoBitrate   = Math.max(50, Math.floor((safeTarget * 8) / duration / 1000) - audioBitrate);

  let attempt = 0;
  while (attempt < 3) {
    const out = tmpFile(mimeToExt(mime));
    try {
      await encodeAtBitrate(videoBitrate, out);
      const size = fs.statSync(out).size;

      if (size <= targetBytes) {
        // Success — move to final output
        fs.renameSync(out, outputPath);
        return;
      }

      // Still over — cut bitrate proportionally to actual overshoot
      const overshoot = size / targetBytes;
      videoBitrate    = Math.max(50, Math.floor(videoBitrate / overshoot));
      attempt++;
    } finally {
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
    }
  }

  throw new Error('could not compress video to target size after 3 attempts');
}

// ─── GIF ───
// Iterative: reduce fps → scale → lossy aggressiveness until under target.

async function compressGif(inputPath, outputPath, targetBytes) {
  const stages = [
    { fps: 20, maxW: 800, lossy: 80  },
    { fps: 15, maxW: 640, lossy: 100 },
    { fps: 10, maxW: 480, lossy: 120 },
    { fps:  8, maxW: 360, lossy: 150 },
    { fps:  6, maxW: 280, lossy: 180 },
  ];

  for (const { fps, maxW, lossy } of stages) {
    const scale       = `fps=${fps},scale='min(iw,${maxW})':-1:flags=lanczos`;
    const palettePath = tmpFile('.png');
    const ffmpegOut   = tmpFile('.gif');

    try {
      await ffmpeg(
        '-i', inputPath,
        '-vf', `${scale},palettegen=max_colors=256:stats_mode=full`,
        palettePath,
      );
      await ffmpeg(
        '-i', inputPath, '-i', palettePath,
        '-filter_complex', `${scale}[x];[x][1:v]paletteuse=dither=floyd_steinberg`,
        ffmpegOut,
      );
      await execP('gifsicle', ['-O3', `--lossy=${lossy}`, '--colors', '256', ffmpegOut, '-o', outputPath]);

      const size = fs.statSync(outputPath).size;
      if (size <= targetBytes) return; // done

      // Try next stage
      try { fs.unlinkSync(outputPath); } catch {}
    } finally {
      try { fs.unlinkSync(palettePath); } catch {}
      try { fs.unlinkSync(ffmpegOut);   } catch {}
    }
  }

  throw new Error('could not compress GIF to target size — try a smaller target');
}

// ─── Images ───
// Iterative quality reduction with sharp. Never guesses — keeps trying until
// output is under target. Falls back to dimension scaling as last resort.

async function compressImage(inputBuf, mime, targetBytes) {
  const sharp = require('sharp');

  const qualitySteps = [90, 82, 74, 66, 58, 50, 42, 34];

  for (const quality of qualitySteps) {
    let result;

    if (mime === 'image/jpeg') {
      result = await sharp(inputBuf).jpeg({ quality, mozjpeg: true }).toBuffer();
    } else if (mime === 'image/png') {
      result = await sharp(inputBuf).png({ quality, compressionLevel: 9, palette: true }).toBuffer();
    } else if (mime === 'image/webp') {
      result = await sharp(inputBuf).webp({ quality, effort: 6 }).toBuffer();
    } else {
      result = await sharp(inputBuf).toBuffer();
    }

    if (result.length <= targetBytes) return result;
  }

  // Quality alone wasn't enough — scale dimensions down iteratively
  const meta     = await sharp(inputBuf).metadata();
  const origW    = meta.width  || 2000;
  const origH    = meta.height || 2000;
  let scaleFactor = 0.85;

  while (scaleFactor > 0.1) {
    const w = Math.round(origW * scaleFactor);
    const h = Math.round(origH * scaleFactor);

    let pipeline = sharp(inputBuf).resize(w, h, { fit: 'inside', withoutEnlargement: true });
    let result;

    if (mime === 'image/jpeg') {
      result = await pipeline.jpeg({ quality: 50, mozjpeg: true }).toBuffer();
    } else if (mime === 'image/png') {
      result = await pipeline.png({ quality: 50, compressionLevel: 9, palette: true }).toBuffer();
    } else if (mime === 'image/webp') {
      result = await pipeline.webp({ quality: 50, effort: 6 }).toBuffer();
    } else {
      result = await pipeline.toBuffer();
    }

    if (result.length <= targetBytes) return result;
    scaleFactor -= 0.1;
  }

  throw new Error('could not compress image to target size — try a smaller target');
}

// ─── Entry point ───

async function compress(inputBuffer, mime, targetBytes) {
  if (!targetBytes || targetBytes <= 0) throw new Error('targetBytes required');

  if (mime.startsWith('image/') && mime !== 'image/gif') {
    const result = await compressImage(inputBuffer, mime, targetBytes);
    if (result.length >= inputBuffer.length) {
      throw new Error('already at or below target size');
    }
    return result;
  }

  const ext        = mimeToExt(mime);
  const inputPath  = tmpFile(ext);
  const outputPath = tmpFile(ext);
  fs.writeFileSync(inputPath, inputBuffer);

  try {
    if (mime === 'image/gif') {
      await compressGif(inputPath, outputPath, targetBytes);
    } else {
      await compressVideo(inputPath, outputPath, mime, targetBytes);
    }

    const result = fs.readFileSync(outputPath);
    if (result.length >= inputBuffer.length) {
      throw new Error('already at or below target size');
    }
    return result;
  } finally {
    try { fs.unlinkSync(inputPath);  } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

module.exports = { compress };
