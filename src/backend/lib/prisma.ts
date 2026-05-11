import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * PRISMA CLIENT SINGLETON:
 * Ensures only one instance of PrismaClient is used, preventing connection leaks.
 */
export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Ltree Utility:
 * Provides helpers for hierarchical path manipulation (dot-separated strings).
 */
export const ltree = {
  /**
   * Returns all ancestor paths for a given dot-separated path.
   * Example: 'ROOT.DIV.DEPT' -> ['ROOT', 'ROOT.DIV']
   */
  getAncestors: (path: string): string[] => {
    if (!path) return [];
    const parts = path.split('.');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'));
  },

  /**
   * Returns the direct parent path.
   * Example: 'ROOT.DIV.DEPT' -> 'ROOT.DIV'
   */
  getParent: (path: string): string | null => {
    if (!path || !path.includes('.')) return null;
    return path.substring(0, path.lastIndexOf('.'));
  }
};
