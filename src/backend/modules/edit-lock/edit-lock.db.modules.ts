import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../../shared/middlewares/error.middleware';

const DEFAULT_LOCK_MINUTES = 10;

type EditLockType = 'USER' | 'ORG' | 'WORKFLOW';

type LockResult = {
  lockAcquired: boolean;
  locked: boolean;
  released: boolean;
  expiresAt: string | null;
  message: string;
};

type LockOperations = {
  release: (now: Date) => Promise<{ count: number }>;
  acquire: (now: Date, expiresAt: Date) => Promise<{ count: number }>;
  extend: (now: Date, expiresAt: Date) => Promise<{ count: number }>;
  current: () => Promise<{
    editLockedBy: string | null;
    editLockedAt: Date | null;
    editLockExpiresAt: Date | null;
  } | null>;
};

export class EditLockDbController {
  private static isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private static requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AppError(`${fieldName} is required`, 400);
    }

    return value.trim();
  }

  /**
   * Resolves the display name for the user who currently holds a lock.
   * Returns "Name (email)" or just email, or "unknown user" as fallback.
   */
  private static async getLockerDisplayName(
    userId: string | null,
  ): Promise<string> {
    if (!userId) return 'unknown user';
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    if (!user) return 'unknown user';
    return user.name ? `${user.name} (${user.email})` : user.email;
  }

  /**
   * Returns the effective lock duration in minutes.
   * Uses addMin if > 0, otherwise falls back to DEFAULT_LOCK_MINUTES (10).
   */
  private static getLockMinutes(addMin?: number): number {
    return addMin && addMin > 0 ? addMin : DEFAULT_LOCK_MINUTES;
  }

  private static getString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private static normalizeEmail(value: unknown): string | null {
    return EditLockDbController.getString(value)?.toLowerCase() || null;
  }

  private static getPendingUserEmail(data: unknown): string | null {
    const source = EditLockDbController.isRecord(data) ? data : {};
    const nestedData = EditLockDbController.isRecord(source.data)
      ? source.data
      : {};
    const basicDetails = EditLockDbController.isRecord(source.basicDetails)
      ? source.basicDetails
      : {};
    const nestedBasicDetails = EditLockDbController.isRecord(
      nestedData.basicDetails,
    )
      ? nestedData.basicDetails
      : {};
    const newData = EditLockDbController.isRecord(source.newData)
      ? source.newData
      : {};
    const newBasicDetails = EditLockDbController.isRecord(newData.basicDetails)
      ? newData.basicDetails
      : {};

    return (
      EditLockDbController.normalizeEmail(source.targetUserEmail) ||
      EditLockDbController.normalizeEmail(basicDetails.email) ||
      EditLockDbController.normalizeEmail(nestedBasicDetails.email) ||
      EditLockDbController.normalizeEmail(newBasicDetails.email)
    );
  }

  private static getPendingOrgNodePath(data: unknown): string | null {
    const source = EditLockDbController.isRecord(data) ? data : {};
    const currentData = EditLockDbController.isRecord(source.currentData)
      ? source.currentData
      : {};

    return (
      EditLockDbController.getString(source.nodePath) ||
      EditLockDbController.getString(source.targetNodePath) ||
      EditLockDbController.getString(currentData.nodePath)
    );
  }

  private static createLockOperations(
    model: {
      updateMany: (args: any) => Promise<{ count: number }>;
      findUnique: (args: any) => Promise<{
        editLockedBy: string | null;
        editLockedAt: Date | null;
        editLockExpiresAt: Date | null;
      } | null>;
    },
    id: string,
    userId: string,
  ): LockOperations {
    return {
      release: (now) =>
        model.updateMany({
          where: {
            id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockedBy: null,
            editLockedAt: null,
            editLockExpiresAt: null,
          },
        }),
      acquire: (now, expiresAt) =>
        model.updateMany({
          where: {
            id,
            OR: [
              { editLockedBy: null },
              { editLockExpiresAt: null },
              { editLockExpiresAt: { lte: now } },
            ],
          },
          data: {
            editLockedBy: userId,
            editLockedAt: now,
            editLockExpiresAt: expiresAt,
          },
        }),
      extend: (now, expiresAt) =>
        model.updateMany({
          where: {
            id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockExpiresAt: expiresAt,
          },
        }),
      current: () =>
        model.findUnique({
          where: { id },
          select: {
            editLockedBy: true,
            editLockedAt: true,
            editLockExpiresAt: true,
          },
        }),
    };
  }

  /**
   * Handles an explicit "lock" request:
   * 1. Try to extend if the same user already holds the lock (atomic).
   * 2. If no active lock, acquire a new one (atomic).
   * 3. If another user holds it, return a detailed message with their name.
   */
  private static async handleLock(
    targetType: EditLockType,
    operations: LockOperations,
    userId: string,
    addMin?: number,
  ): Promise<LockResult> {
    const now = new Date();
    const minutes = EditLockDbController.getLockMinutes(addMin);
    const expiresAt = new Date(now.getTime() + minutes * 60 * 1000);

    // 1. Try to extend — succeeds only if same user holds an active lock
    const extended = await operations.extend(now, expiresAt);
    if (extended.count === 1) {
      return {
        lockAcquired: true,
        locked: true,
        released: false,
        expiresAt: expiresAt.toISOString(),
        message: `${targetType} edit lock extended by ${minutes} minutes`,
      };
    }

    // 2. Try to acquire — succeeds only if no lock or lock is expired
    const acquired = await operations.acquire(now, expiresAt);
    if (acquired.count === 1) {
      return {
        lockAcquired: true,
        locked: true,
        released: false,
        expiresAt: expiresAt.toISOString(),
        message: `${targetType} edit lock acquired for ${minutes} minutes`,
      };
    }

    // 3. Lock held by another user — return detailed message
    const current = await operations.current();
    if (!current) {
      throw new AppError(`${targetType} target not found`, 404);
    }

    const lockerName = await EditLockDbController.getLockerDisplayName(
      current.editLockedBy,
    );
    const lockedSince = current.editLockedAt
      ? current.editLockedAt.toISOString()
      : 'unknown time';
    return {
      lockAcquired: false,
      locked: true,
      released: false,
      expiresAt: current.editLockExpiresAt?.toISOString() || null,
      message: `This record is currently being edited by ${lockerName} since ${lockedSince}`,
    };
  }

  /**
   * Handles an explicit "release" request:
   * 1. Try to release the lock held by the requesting user (atomic).
   * 2. If no active lock exists, return a "no lock" message.
   * 3. If lock is held by another user, return a message with their name.
   */
  private static async handleRelease(
    targetType: EditLockType,
    operations: LockOperations,
    userId: string,
  ): Promise<LockResult> {
    const now = new Date();

    // 1. Try to release — succeeds only if same user holds an active lock
    const released = await operations.release(now);
    if (released.count === 1) {
      return {
        lockAcquired: false,
        locked: false,
        released: true,
        expiresAt: null,
        message: `${targetType} edit lock released successfully`,
      };
    }

    // 2. Check if any active lock exists at all
    const current = await operations.current();
    if (
      !current ||
      !current.editLockedBy ||
      !current.editLockExpiresAt ||
      current.editLockExpiresAt <= now
    ) {
      return {
        lockAcquired: false,
        locked: false,
        released: false,
        expiresAt: null,
        message: `No active ${targetType} edit lock found to release`,
      };
    }

    // 3. Lock held by another user — cannot release
    const lockerName = await EditLockDbController.getLockerDisplayName(
      current.editLockedBy,
    );
    return {
      lockAcquired: false,
      locked: true,
      released: false,
      expiresAt: current.editLockExpiresAt.toISOString(),
      message: `Cannot release: lock is held by ${lockerName}`,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Per-type lock handlers
  // ────────────────────────────────────────────────────────────────────────

  private static async processUserLock(
    userId: string,
    companyId: string,
    target: Record<string, unknown>,
    subtype: string,
    addMin?: number,
  ): Promise<LockResult> {
    const email = EditLockDbController.requireString(
      target.email,
      'Email',
    ).toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        email,
        userMappings: { some: { companyId } },
      },
      select: { id: true },
    });

    if (!user) {
      const pendingRequests = await prisma.userOnboarding.findMany({
        where: {
          companyId,
          ...(subtype === 'release' ? {} : { status: 'PENDING' }),
          type: 'INITIATE',
        },
        select: { id: true, data: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const pendingRequest = pendingRequests.find(
        (request) =>
          EditLockDbController.getPendingUserEmail(request.data) === email,
      );

      if (!pendingRequest) {
        throw new AppError('User target not found in this company', 404);
      }

      const operations = EditLockDbController.createLockOperations(
        prisma.userOnboarding as any,
        pendingRequest.id,
        userId,
      );

      return subtype === 'release'
        ? EditLockDbController.handleRelease('USER', operations, userId)
        : EditLockDbController.handleLock('USER', operations, userId, addMin);
    }

    const operations: LockOperations = {
      release: (now) =>
        prisma.user.updateMany({
          where: {
            id: user.id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockedBy: null,
            editLockedAt: null,
            editLockExpiresAt: null,
          },
        }),
      acquire: (now, expiresAt) =>
        prisma.user.updateMany({
          where: {
            id: user.id,
            OR: [
              { editLockedBy: null },
              { editLockExpiresAt: null },
              { editLockExpiresAt: { lte: now } },
            ],
          },
          data: {
            editLockedBy: userId,
            editLockedAt: now,
            editLockExpiresAt: expiresAt,
          },
        }),
      extend: (now, expiresAt) =>
        prisma.user.updateMany({
          where: {
            id: user.id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockExpiresAt: expiresAt,
          },
        }),
      current: () =>
        prisma.user.findUnique({
          where: { id: user.id },
          select: {
            editLockedBy: true,
            editLockedAt: true,
            editLockExpiresAt: true,
          },
        }),
    };

    return subtype === 'release'
      ? EditLockDbController.handleRelease('USER', operations, userId)
      : EditLockDbController.handleLock('USER', operations, userId, addMin);
  }

  private static async processOrgLock(
    userId: string,
    companyId: string,
    target: Record<string, unknown>,
    subtype: string,
    addMin?: number,
  ): Promise<LockResult> {
    const nodePath = EditLockDbController.requireString(
      target.nodePath,
      'Node path',
    );
    const node = await prisma.orgStructure.findFirst({
      where: { companyId, nodePath },
      select: { id: true },
    });

    if (!node) {
      const pendingRequests = await prisma.orgStructureReq.findMany({
        where: {
          companyId,
          ...(subtype === 'release' ? {} : { status: 'PENDING' }),
          type: 'INITIATE',
        },
        select: { id: true, data: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const pendingRequest = pendingRequests.find(
        (request) =>
          EditLockDbController.getPendingOrgNodePath(request.data) === nodePath,
      );

      if (!pendingRequest) {
        throw new AppError('Organization target not found in this company', 404);
      }

      const operations = EditLockDbController.createLockOperations(
        prisma.orgStructureReq as any,
        pendingRequest.id,
        userId,
      );

      return subtype === 'release'
        ? EditLockDbController.handleRelease('ORG', operations, userId)
        : EditLockDbController.handleLock('ORG', operations, userId, addMin);
    }

    const operations: LockOperations = {
      release: (now) =>
        prisma.orgStructure.updateMany({
          where: {
            id: node.id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockedBy: null,
            editLockedAt: null,
            editLockExpiresAt: null,
          },
        }),
      acquire: (now, expiresAt) =>
        prisma.orgStructure.updateMany({
          where: {
            id: node.id,
            OR: [
              { editLockedBy: null },
              { editLockExpiresAt: null },
              { editLockExpiresAt: { lte: now } },
            ],
          },
          data: {
            editLockedBy: userId,
            editLockedAt: now,
            editLockExpiresAt: expiresAt,
          },
        }),
      extend: (now, expiresAt) =>
        prisma.orgStructure.updateMany({
          where: {
            id: node.id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockExpiresAt: expiresAt,
          },
        }),
      current: () =>
        prisma.orgStructure.findUnique({
          where: { id: node.id },
          select: {
            editLockedBy: true,
            editLockedAt: true,
            editLockExpiresAt: true,
          },
        }),
    };

    return subtype === 'release'
      ? EditLockDbController.handleRelease('ORG', operations, userId)
      : EditLockDbController.handleLock('ORG', operations, userId, addMin);
  }

  private static async processWorkflowLock(
    userId: string,
    companyId: string,
    target: Record<string, unknown>,
    subtype: string,
    addMin?: number,
  ): Promise<LockResult> {
    const nodePath = EditLockDbController.requireString(
      target.nodePath,
      'Node path',
    );
    const module = EditLockDbController.requireString(target.module, 'Module');
    const subModule = EditLockDbController.requireString(
      target.subModule,
      'Sub-module',
    );
    const levelsHash = EditLockDbController.requireString(
      target.levelsHash,
      'Levels hash',
    );

    const node = await prisma.orgStructure.findFirst({
      where: { companyId, nodePath },
      select: { id: true },
    });
    if (!node) {
      throw new AppError('Workflow target not found in this company', 404);
    }

    const workflow = await prisma.workflow.findFirst({
      where: {
        companyId,
        nodeId: node.id,
        module,
        subModule,
        levelsHash,
      },
      select: { id: true },
    });

    if (!workflow) {
      const pendingRequest = await prisma.workflowReq.findFirst({
        where: {
          companyId,
          nodeId: node.id,
          module,
          subModule,
          levelsHash,
          ...(subtype === 'release' ? {} : { status: 'PENDING' }),
          type: 'INITIATE',
        },
        select: { id: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

      if (!pendingRequest) {
        throw new AppError('Workflow target not found in this company', 404);
      }

      const operations = EditLockDbController.createLockOperations(
        prisma.workflowReq as any,
        pendingRequest.id,
        userId,
      );

      return subtype === 'release'
        ? EditLockDbController.handleRelease('WORKFLOW', operations, userId)
        : EditLockDbController.handleLock(
            'WORKFLOW',
            operations,
            userId,
            addMin,
          );
    }

    const operations: LockOperations = {
      release: (now) =>
        prisma.workflow.updateMany({
          where: {
            id: workflow.id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockedBy: null,
            editLockedAt: null,
            editLockExpiresAt: null,
          },
        }),
      acquire: (now, expiresAt) =>
        prisma.workflow.updateMany({
          where: {
            id: workflow.id,
            OR: [
              { editLockedBy: null },
              { editLockExpiresAt: null },
              { editLockExpiresAt: { lte: now } },
            ],
          },
          data: {
            editLockedBy: userId,
            editLockedAt: now,
            editLockExpiresAt: expiresAt,
          },
        }),
      extend: (now, expiresAt) =>
        prisma.workflow.updateMany({
          where: {
            id: workflow.id,
            editLockedBy: userId,
            editLockExpiresAt: { gt: now },
          },
          data: {
            editLockExpiresAt: expiresAt,
          },
        }),
      current: () =>
        prisma.workflow.findUnique({
          where: { id: workflow.id },
          select: {
            editLockedBy: true,
            editLockedAt: true,
            editLockExpiresAt: true,
          },
        }),
    };

    return subtype === 'release'
      ? EditLockDbController.handleRelease('WORKFLOW', operations, userId)
      : EditLockDbController.handleLock('WORKFLOW', operations, userId, addMin);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────

  static async toggle(req: Request, res: Response, next: NextFunction) {
    try {
      const type = EditLockDbController.requireString(
        req.body?.type,
        'Type',
      ).toUpperCase() as EditLockType;
      const userId = EditLockDbController.requireString(
        req.body?.userId,
        'User ID',
      );
      const companyId = EditLockDbController.requireString(
        req.body?.companyId,
        'Company ID',
      );
      const target =
        req.body?.target && typeof req.body.target === 'object'
          ? (req.body.target as Record<string, unknown>)
          : null;

      // New fields: subtype defaults to 'lock', addMin defaults to 0
      const subtype =
        typeof req.body?.subtype === 'string' &&
        ['lock', 'release'].includes(req.body.subtype.toLowerCase())
          ? req.body.subtype.toLowerCase()
          : 'lock';
      const addMin =
        typeof req.body?.addMin === 'number' && req.body.addMin >= 0
          ? req.body.addMin
          : 0;

      if (!target || !['USER', 'ORG', 'WORKFLOW'].includes(type)) {
        throw new AppError('Valid type and target are required', 400);
      }

      let result: LockResult;
      switch (type) {
        case 'USER':
          result = await EditLockDbController.processUserLock(
            userId,
            companyId,
            target,
            subtype,
            addMin,
          );
          break;
        case 'ORG':
          result = await EditLockDbController.processOrgLock(
            userId,
            companyId,
            target,
            subtype,
            addMin,
          );
          break;
        case 'WORKFLOW':
          result = await EditLockDbController.processWorkflowLock(
            userId,
            companyId,
            target,
            subtype,
            addMin,
          );
          break;
        default:
          throw new AppError('Unsupported edit lock type', 400);
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
