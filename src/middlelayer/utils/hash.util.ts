import argon2 from 'argon2';
import crypto from 'crypto';

/**
 * HASH UTILITY LOGIC:
 * Provides cryptographic functions for safeguarding sensitive data.
 * Logic:
 * 1. Passwords: Use Argon2 (state-of-the-art) for high-security hashing.
 * 2. Tokens: Use random hex strings and SHA256 for fast, unique identifiers.
 */
export class HashUtil {
  /**
   * PW Logic: Create a secure, salt-protected hash for user passwords.
   */
  static async hash(data: string): Promise<string> {
    return await argon2.hash(data);
  }

  /**
   * PW Logic: Verify a plain-text password against a stored Argon2 hash.
   */
  static async verify(hash: string, data: string): Promise<boolean> {
    return await argon2.verify(hash, data);
  }

  /**
   * Token Logic: Generate a secure random hex string for one-time tokens.
   */
  static generateRandomToken(bytes: number = 32): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Token Logic: Generate a deterministic SHA256 hash for storing tokens in DB
   * (so even if the DB is leaked, actual login tokens remain secret).
   */
  static hashToken(token: string): string {
    return crypto.createHash('sha256').update(token + process.env.HASH_SECRET).digest('hex');
  }
}

