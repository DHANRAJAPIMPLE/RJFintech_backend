/**
 * MIDDLE LAYER CONFIGURATION:
 * Centralizes all environment-specific and policy constants.
 * This is used to manage URLs for backend communication, cookie policies, 
 * and token expiration times in a single location for easier maintenance.
 */
export const config = {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:5001',
  backendAuthUrl: `${process.env.BACKEND_URL || 'http://localhost:5001'}/internal/auth`,
  backendCompanyUrl: `${process.env.BACKEND_URL || 'http://localhost:5001'}/internal/company`,

  cookieOptions: {
    httpOnly: true,

    secure: false,
    sameSite: 'lax',
    path: '/',
  },

  accessTokenMaxAge: 15 * 60 * 1000, // 15 minutes
  refreshTokenMaxAge: 24 * 60 * 60 * 1000, // 24 hours
} as const;
