export const mapAuthError = (internalError: string): string => {
  const genericMessage = 'Invalid credentials';

  // Logic: List of errors that should be masked with "Invalid credentials"
  const sensitiveErrors = [
    'User already exists',
    'Invalid credentials',
    'User not found',
    'Password incorrect',
    'Invalid password',
    'User already logged in another device',
    'Unauthorized - Invalid session',
    'Unauthorized - Invalid token',
    'Invalid force login token',
    'Unauthorized - Refresh token missing',
    'Refresh token missing',
    'Invalid or expired session',
  ];

  if (sensitiveErrors.some((err) => internalError.includes(err))) {
    return genericMessage;
  }

  return internalError || genericMessage;
};
