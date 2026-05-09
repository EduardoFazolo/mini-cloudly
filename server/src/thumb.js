const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const execP = promisify(execFile);

const extMap = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv', 'image/gif': '.gif',
};

async function generateThumb(decryptedBuf, mime, thumbPath) {
  const ext  = extMap[mime] || '.mp4';
  const tmp  = path.join(os.tmpdir(), `cly_th_${Date.now()}${ext}`);

  fs.writeFileSync(tmp, decryptedBuf);
  try {
    // -ss before -i = fast container seek; works even if video < 1s
    await execP('ffmpeg', [
      '-y', '-ss', '00:00:01', '-i', tmp,
      '-frames:v', '1',
      '-vf', 'scale=320:-1:flags=lanczos',
      '-q:v', '4',
      thumbPath,
    ]);

    // If that produced nothing (very short clip), grab first frame instead
    if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size < 100) {
      await execP('ffmpeg', [
        '-y', '-i', tmp,
        '-frames:v', '1',
        '-vf', 'scale=320:-1:flags=lanczos',
        '-q:v', '4',
        thumbPath,
      ]);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { generateThumb };
