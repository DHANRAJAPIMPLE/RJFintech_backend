import argon2 from 'argon2';
import crypto from 'crypto';

/**
 * HASH UTILITY LOGIC:
 * Provides cryptographic functions for safeguarding sensitive data.
 * SHARED between Middle Layer and Backend Service.
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
   * Token Logic: Generate a secure random hex string for identifiers.
   */
  static generateRandomToken(bytes: number = 32): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Token Logic: Generate a deterministic SHA256 hash for storing tokens.
   */
  static hashToken(token: string): string {
    const salt = process.env.HASH_SECRET || 'default_salt';
    return crypto
      .createHash('sha256')
      .update(token + salt)
      .digest('hex');
  }
}
