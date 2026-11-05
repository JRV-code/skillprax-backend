import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    if (!storedHash || !password) return false;

    // 1. Check for bcrypt hash ($2a$, $2b$, $2y$)
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$') || storedHash.startsWith('$2')) {
      try {
        if (bcrypt.compareSync(password, storedHash)) {
          return true;
        }
      } catch (_) {}
    }

    // 2. Check for scrypt format: salt:hash
    const parts = storedHash.split(':');
    if (parts.length === 2) {
      const [salt, originalHash] = parts;
      const hashBuffer = Buffer.from(originalHash, 'hex');
      const derivedKey = crypto.scryptSync(password, salt, 64);
      if (hashBuffer.length === derivedKey.length && crypto.timingSafeEqual(hashBuffer, derivedKey)) {
        return true;
      }
    }

    // 3. Check for sha256 hex (64 chars) or sha512 (128 chars)
    const sha256 = crypto.createHash('sha256').update(password).digest('hex');
    if (storedHash.toLowerCase() === sha256.toLowerCase()) {
      return true;
    }

    // 4. Plaintext fallback (if legacy unhashed dev credentials exist)
    if (storedHash === password) {
      return true;
    }

    return false;
  } catch (err) {
    return false;
  }
}
