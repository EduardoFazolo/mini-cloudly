const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const KEY = Buffer.from(
  process.env.CLOUDLY_KEY || 'cloudly-default-key-change-me-plz!!',
  'utf8'
).slice(0, 32);

function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, KEY, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: [4 bytes iv-len][iv][16 bytes tag][encrypted]
  return Buffer.concat([
    Buffer.from([iv.length]),
    iv,
    tag,
    enc,
  ]);
}

function decrypt(buf) {
  const ivLen = buf[0];
  const iv = buf.slice(1, 1 + ivLen);
  const tag = buf.slice(1 + ivLen, 1 + ivLen + 16);
  const enc = buf.slice(1 + ivLen + 16);
  const decipher = crypto.createDecipheriv(ALG, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

module.exports = { encrypt, decrypt };
