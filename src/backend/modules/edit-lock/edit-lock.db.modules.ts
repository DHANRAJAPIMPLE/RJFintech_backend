import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../../shared/middlewares/error.middleware';

const LOCK_DURATION_MS = 30 * 60 * 1000;

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
  current: () => Promise<{ editLockExpiresAt: Date | null } | null>;
};

export class EditLockDbController {
  private static requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AppError(`${fieldName} is required`, 400);
    }

    return value.trim();
  }

  private static async toggleResolvedLock(
    targetType: EditLockType,
    operations: LockOperations,
  ): Promise<LockResult> {
    const now = new Date();

    const released = await operations.release(now);
    if (released.count === 1) {
      return {
        lockAcquired: false,
        locked: false,
        released: true,
        expiresAt: null,
        message: `${targetType} edit lock released`,
      };
    }

    const expiresAt = new Date(now.getTime() + LOCK_DURATION_MS);
    const acquired = await operations.acquire(now, expiresAt);
    if (acquired.count === 1) {
      return {
        lockAcquired: true,
        locked: true,
        released: false,
        expiresAt: expiresAt.toISOString(),
        message: `${targetType} edit lock acquired for 30 minutes`,
      };
    }

    const current = await operations.current();
    if (!current) {
      throw new AppError(`${targetType} target not found`, 404);
    }

    return {
      lockAcquired: false,
      locked: true,
      released: false,
      expiresAt: current.editLockExpiresAt?.toISOString() || null,
      message: 'This record is currently being edited by another user',
    };
  }

  private static async toggleUserLock(
    userId: string,
    companyId: string,
    target: Record<string, unknown>,
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
      throw new AppError('User target not found in this company', 404);
    }

    return EditLockDbController.toggleResolvedLock('USER', {
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
      current: () =>
        prisma.user.findUnique({
          where: { id: user.id },
          select: { editLockExpiresAt: true },
        }),
    });
  }

  private static async toggleOrgLock(
    userId: string,
    companyId: string,
    target: Record<string, unknown>,
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
      throw new AppError('Organization target not found in this company', 404);
    }

    return EditLockDbController.toggleResolvedLock('ORG', {
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
      current: () =>
        prisma.orgStructure.findUnique({
          where: { id: node.id },
          select: { editLockExpiresAt: true },
        }),
    });
  }

  private static async toggleWorkflowLock(
    userId: string,
    companyId: string,
    target: Record<string, unknown>,
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
      throw new AppError('Workflow target not found in this company', 404);
    }

    return EditLockDbController.toggleResolvedLock('WORKFLOW', {
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
      current: () =>
        prisma.workflow.findUnique({
          where: { id: workflow.id },
          select: { editLockExpiresAt: true },
        }),
    });
  }

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

      if (!target || !['USER', 'ORG', 'WORKFLOW'].includes(type)) {
        throw new AppError('Valid type and target are required', 400);
      }

      let result: LockResult;
      switch (type) {
        case 'USER':
          result = await EditLockDbController.toggleUserLock(
            userId,
            companyId,
            target,
          );
          break;
        case 'ORG':
          result = await EditLockDbController.toggleOrgLock(
            userId,
            companyId,
            target,
          );
          break;
        case 'WORKFLOW':
          result = await EditLockDbController.toggleWorkflowLock(
            userId,
            companyId,
            target,
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
