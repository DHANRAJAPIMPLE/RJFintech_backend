import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AccessUtil } from '../../utils/access.util';
import { AppError } from '../../middlewares/error.middleware';

export class UserDbController {
  static async fetchAllUsers(req: Request, res: Response, next: NextFunction) {
    try {
      // Logic: Fetch raw users with their related mappings, company, and access details
      const { companyCode } = req.body;
      let companyId: string | undefined;

      if (companyCode) {
        const company = await prisma.company.findUnique({
          where: { companyCode: companyCode },
        });
        if (company) {
          companyId = company.id;
        }
      }

      const users = await prisma.user.findMany({
        where: companyId
          ? {
              userMappings: {
                some: {
                  companyId: companyId,
                },
              },
            }
          : {},
        include: {
          userMappings: {
            include: {
              company: true,
              manager: true,
            },
          },
          userAccesses: {
            include: {
              role: true,
              orgStructure: true,
            },
          },
        },
      });

      // Logic: Fetch raw pending user onboardings
      const pendingOnboardings = await prisma.userOnboarding.findMany({
        where: { status: 'PENDING' },
        // Relation fields were removed
      });

      // Fetch history for these pending onboardings to get initiator/approver
      const pendingEmails = pendingOnboardings.map((onb: any) => (onb.data as any)?.basicDetails?.email).filter(Boolean);
      
      const histories = await prisma.userHistory.findMany({
        where: {
          email: { in: pendingEmails },
        },
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Map history info for easy lookup
      const historyMap = new Map();
      histories.forEach((h) => {
        const key = `${h.email}_${h.event}`;
        if (!historyMap.has(key)) {
          historyMap.set(key, h);
        }
      });

      const enhancedPending = pendingOnboardings.map((onb: any) => {
        const email = (onb.data as any)?.basicDetails?.email;
        const init = historyMap.get(`${email}_INITIATE`);
        const approve = historyMap.get(`${email}_APPROVE`);
        return {
          ...onb,
          initiator: init?.user || null,
          approver: approve?.user || null,
        };
      });

      res.status(200).json({
        users,
        pendingOnboardings: enhancedPending,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateUserStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, status } = req.body;
      await prisma.userMapping.updateMany({
        where: { userId },
        data: { status },
      });
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }

    static async createUserOnboarding(req: Request, res: Response) {
    const { initiatorId, ...onboardingData } = req.body;
    const email = onboardingData.data?.basicDetails?.email;

    const onboarding = await prisma.$transaction(async (tx) => {
      const onb = await tx.userOnboarding.create({
        data: onboardingData,
      });
      if (initiatorId && email) {
        await tx.userHistory.create({
          data: {
            email,
            event: 'INITIATE',
            eventUserId: initiatorId,
            companyCode: onboardingData.companyCode,
          },
        });
      }
      return onb;
    });
    res.status(201).json(onboarding);
  }

  // --- Get Operations ---



  static async getUserOnboardingById(req: Request, res: Response) {
    const { id } = req.body;
    const onboarding = await prisma.userOnboarding.findUnique({
      where: { id },
    });
    res.json(onboarding);
  }



  static async handleUserOnboardingStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, status, approverId, remark } = req.body;

      const onboarding = await prisma.userOnboarding.findUnique({
        where: { id },
      });

      if (!onboarding) {
        throw new AppError('User onboarding request not found', 404);
      }

      const data = onboarding.data as any;
      const { basicDetails, permissions } = data || {};
      const {
        name,
        email,
        phone,
        reportingManager,
        designation,
        employeeId,
      } = basicDetails || {};

      await prisma.$transaction(async (tx) => {
        // =========================
        // ✅ APPROVED FLOW
        // =========================
        if (status === 'approve') {
          const manager = await tx.user.findUnique({
            where: { email: reportingManager },
            include: {
              userMappings: {
                include: { company: true },
              },
            },
          });

          if (!manager) throw new AppError('Manager not found', 404);

          let company;
          if (onboarding.companyCode) {
            company = await tx.company.findUnique({
              where: { companyCode: onboarding.companyCode },
            });
          }

          if (!company && manager.userMappings[0]) {
            company = manager.userMappings[0].company;
          }

          if (!company) throw new AppError('Company not found', 404);

          let user = await tx.user.findUnique({ where: { email } });

          if (!user) {
            const defaultPassword = await HashUtil.hash('Welcome@123');
            user = await tx.user.create({
              data: {
                email,
                name,
                phone,
                password: defaultPassword,
              },
            });
          }

          await tx.userMapping.create({
            data: {
              userId: user.id,
              companyId: company.id,
              reportingManager: manager.id,
              status: 'ACTIVE',
              designation,
              employeeId,
            },
          });

          if (Array.isArray(permissions)) {
            for (const perm of permissions) {
              const { accessType, roleName, nodePath } = perm;

              const role = await tx.roles.findUnique({
                where: { roleName },
              });

              const node = await tx.orgStructure.findUnique({
                where: { nodePath },
              });

              if (role && node) {
                await tx.userAccess.create({
                  data: {
                    userId: user.id,
                    roleCode: role.roleCode,
                    nodeId: node.id,
                    accessType,
                    companyId: company.id,
                    isGlobalAccess: false,
                  },
                });
              }
            }
          }

          await tx.userOnboarding.update({
            where: { id },
            data: {
              status: 'APPROVED',
              approvalRemark: remark,
            },
          });

          if (email && approverId) {
            await tx.userHistory.create({
              data: {
                email,
                event: 'APPROVED',
                eventUserId: approverId,
                companyCode: onboarding.companyCode || '',
              },
            });
          }
        }

        // =========================
        // ❌ REJECTED FLOW
        // =========================
        else if (status === 'reject') {
          const updated = await tx.userOnboarding.update({
            where: { id },
            data: {
              status: 'REJECTED',
              approvalRemark: remark,
            },
          });

          const userEmail = (updated.data as any)?.basicDetails?.email;

          if (approverId && userEmail) {
            await tx.userHistory.create({
              data: {
                email: userEmail,
                event: 'REJECTED',
                eventUserId: approverId,
                companyCode: onboarding.companyCode || '',
              },
            });
          }
        }

        // =========================
        // ⚠️ INVALID STATUS
        // =========================
        else {
          throw new AppError('Invalid status', 400);
        }
      });

      res.status(200).json({
        message: `User onboarding ${status}d successfully`,
      });
    } catch (error) {
      next(error);
    }
  }


  static async getUserHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, companyCode } = req.body;
      const history = await prisma.userHistory.findMany({
        where: {
          email,
          companyCode
        },
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      const formattedHistory = history.map(h => ({
        email: h.email,
        companyCode: h.companyCode,
        event: h.event,
        createdAt: h.createdAt,
        user: h.user
      }));

      res.status(200).json(formattedHistory);
    } catch (error) {
      next(error);
    }
  }

}
