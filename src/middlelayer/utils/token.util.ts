import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access_secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh_secret';

/**
 * TOKEN UTILITY LOGIC:
 * Handles the generation and verification of JSON Web Tokens (JWT).
 * Logic:
 * 1. Access Tokens: Short-lived (1m) tokens for authorizing API requests.
 * 2. Refresh Tokens: Long-lived session management handled via cookies/DB.
 */
export class TokenUtil {
  /**
   * Logic: Signs a payload with the private secret to create a one-minute session token.
   */
  static generateAccessToken(payload: { userId: string }): string {
    return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
  }

  /**
   * Logic: Cryptographically validates the token's integrity and expiration.
   */
  static verifyAccessToken(token: string) {
    return jwt.verify(token, ACCESS_SECRET);
  }

  /**
   * Logic: Inspects the inner payload of a token WITHOUT verifying the signature.
   * Useful during silent refresh when the token is already expired.
   */
  static decodeToken(token: string) {
    return jwt.decode(token);
  }
}

