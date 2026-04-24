import argon2 from 'argon2';
import crypto from 'crypto';

/**
 * HASH UTILITY LOGIC (Backend Service):
 * Logic:
 * 1. Passwords: Use Argon2 for high-security hashing.
 * 2. Tokens: Use random hex strings and SHA256 for session management.
 */
export class HashUtil {
  static async hash(data: string): Promise<string> {
    return await argon2.hash(data);
  }

  static async verify(hash: string, data: string): Promise<boolean> {
    return await argon2.verify(hash, data);
  }

  static generateRandomToken(bytes: number = 32): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  static hashToken(token: string): string {
    const salt = process.env.HASH_SECRET || 'default_backend_salt';
    return crypto
      .createHash('sha256')
      .update(token + salt)
      .digest('hex');
  }
}
