import type { Request } from 'express';

export const extractClientIp = (req: Request): string | null => {
  const forwardedFor = req.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || null;
  }

  return (
    req.get('x-real-ip') ||
    req.get('cf-connecting-ip') ||
    req.ip ||
    req.socket.remoteAddress ||
    null
  );
};
