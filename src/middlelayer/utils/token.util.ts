import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access_secret';
const _REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh_secret';

/**
 * Token Utility:
 * Centralizes the management of JSON Web Tokens (JWT).
 * 
 * Why we use it:
 * - To generate short-lived Access Tokens for stateless API authorization.
 * - To cryptographically verify token integrity and expiration.
 * - To safely decode token payloads (without verification) when handling expired tokens during silent refresh.
 */
export class TokenUtil {
  /**
   * Logic: Signs a payload with the private secret to create a one-minute session token.
   */
  static generateAccessToken(payload: {
    userId: string;
    companyId: string;
  }): string {
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
