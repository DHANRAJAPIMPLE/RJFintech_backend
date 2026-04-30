import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';

import { AppError } from '../../middlewares/error.middleware';

export class CompanyDbController {
  static async getMyCompanies(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.body;

      const userMappings = await prisma.userMapping.findMany({
        where: { userId: userId },
        include: {
          company: true,
        },
      });

      res.status(200).json(userMappings);
    } catch (error) {
      next(error);
    }
  }

  static async getGroupCompanies(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      // 1. Fetch groups and their companies (Active)
      const groups = await prisma.groupCompany.findMany({
        include: {
          companyMappings: {
            include: {
              company: {
                include: {
                  userMappings: {
                    include: {
                      user: {
                        include: {
                          userAccesses: {
                            where: {
                              isGlobalAccess: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      // 2. Fetch companies NOT in any group (Solo)
      const soloCompanies = await prisma.company.findMany({
        where: {
          companyMappings: {
            none: {},
          },
        },
        include: {
          userMappings: {
            include: {
              user: {
                include: {
                  userAccesses: {
                    where: {
                      isGlobalAccess: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      // 3. Fetch pending onboarding records
      const pendingOnboardings = await prisma.companyOnboarding.findMany({
        where: { status: 'PENDING' },
      });

      // 4. Fetch history for active and pending records to get initiator/approver
      const allActiveCompanyCodes = [
        ...groups.flatMap((g: any) =>
          g.companyMappings.map((cm: any) => cm.company.companyCode),
        ),
        ...soloCompanies.map((c: any) => c.companyCode),
      ];
      const allGroupCodes = groups.map((g: any) => g.groupCode);
      const allPendingCodes = pendingOnboardings.map((onb) => onb.companyCode);

      const allCodes = [
        ...new Set([
          ...allActiveCompanyCodes,
          ...allGroupCodes,
          ...allPendingCodes,
        ]),
      ];

      const histories = await prisma.companyHistory.findMany({
        where: {
          companyCode: { in: allCodes },
        },
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Map history info for easy lookup
      // Key: companyCode_event, Value: user details
      const historyMap = new Map();
      histories.forEach((h) => {
        const key = `${h.companyCode}_${h.event}`;
        if (!historyMap.has(key)) {
          historyMap.set(key, {
            user: h.user,
            createdAt: h.createdAt,
          });
        }
      });

      // 5. Attach history info to groups and companies
      const enhancedGroups = groups.map((g: any) => {
        const initiateHistory = historyMap.get(`${g.groupCode}_INITIATE`);
        const approveHistory = historyMap.get(`${g.groupCode}_APPROVE`);

        return {
          ...g,
          initiator: initiateHistory?.user || null,
          approver: approveHistory?.user || null,
          approvedAt: approveHistory?.createdAt || null,
          createdAt: initiateHistory?.createdAt || g.createdAt,
          companyMappings: g.companyMappings.map((cm: any) => {
            const compInit = historyMap.get(
              `${cm.company.companyCode}_INITIATE`,
            );
            const compApprove = historyMap.get(
              `${cm.company.companyCode}_APPROVE`,
            );
            return {
              ...cm,
              company: {
                ...cm.company,
                initiator: compInit?.user || initiateHistory?.user || null,
                approver: compApprove?.user || approveHistory?.user || null,
                approvedAt:
                  compApprove?.createdAt || approveHistory?.createdAt || null,
                createdAt:
                  compInit?.createdAt ||
                  initiateHistory?.createdAt ||
                  cm.company.createdAt,
              },
            };
          }),
        };
      });

      const enhancedSoloCompanies = soloCompanies.map((c: any) => {
        const compInit = historyMap.get(`${c.companyCode}_INITIATE`);
        const compApprove = historyMap.get(`${c.companyCode}_APPROVE`);
        return {
          ...c,
          initiator: compInit?.user || null,
          approver: compApprove?.user || null,
          approvedAt: compApprove?.createdAt || null,
          createdAt: compInit?.createdAt || c.createdAt,
        };
      });

      // Also enhance pendingOnboardings if needed
      const enhancedPending = pendingOnboardings.map((onb: any) => {
        const init = historyMap.get(`${onb.companyCode}_INITIATE`);
        return {
          ...onb,
          initiator: init?.user || null,
        };
      });

      res.status(200).json({
        groups: enhancedGroups,
        soloCompanies: enhancedSoloCompanies,
        pendingOnboardings: enhancedPending,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCompanyByCode(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode } = req.body;
      const company = await prisma.company.findUnique({
        where: { companyCode },
      });
      res.json(company);
    } catch (error) {
      next(error);
    }
  }

  static async createCompanyOnboarding(req: Request, res: Response) {
    const { initiatorId, ...onboardingData } = req.body;
    const companyCode = onboardingData.companyCode;

    const onboarding = await prisma.$transaction(async (tx) => {
      const onb = await tx.companyOnboarding.create({
        data: onboardingData,
      });
      if (initiatorId && companyCode) {
        await tx.companyHistory.create({
          data: {
            companyCode,
            event: 'INITIATE',
            eventUserId: initiatorId,
          },
        });

        // Add history for each signatory
        const signatories = (onboardingData.data as any)?.signatories || [];
        for (const sig of signatories) {
          if (sig.email) {
            await tx.userHistory.create({
              data: {
                email: sig.email,
                event: 'INITIATE',
                eventUserId: initiatorId,
                companyCode: companyCode,
              },
            });
          }
        }
      }
      return onb;
    });
    res.status(201).json(onboarding);
  }

  static async getCompanyOnboardingById(req: Request, res: Response) {
    const { id } = req.body;
    const onboarding = await prisma.companyOnboarding.findUnique({
      where: { id },
    });
    res.json(onboarding);
  }

  static async handleCompanyOnboardingStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, action, approverId, remark } = req.body;
      const result = await prisma.$transaction(async (tx) => {
        // 1. Fetch onboarding
        const onboarding = await tx.companyOnboarding.findUnique({
          where: { id },
        });

        if (!onboarding) {
          throw new AppError('Onboarding request not found', 404);
        }
        console.log('Status : ', onboarding.status);
        if (onboarding.status !== 'PENDING') {
          throw new AppError('Onboarding request already processed', 400);
        }

        // // Optional: permission check (if stored)
        // if (
        //   onboarding.accessibleBy &&
        //   !onboarding.accessibleBy.includes(approverId)
        // ) {
        //   throw new AppError('Unauthorized to process this request', 403);
        // }

        // =========================
        // 🔴 REJECT FLOW
        // =========================
        if (action === 'rejected') {
          await tx.companyOnboarding.update({
            where: { id },
            data: {
              status: 'REJECTED',
              approvalRemark: remark,
            },
          });

          if (onboarding.companyCode) {
            await tx.companyHistory.create({
              data: {
                companyCode: onboarding.companyCode,
                event: 'REJECTED',
                eventUserId: approverId,
              },
            });

            // Add history for each signatory
            const signatories = (onboarding.data as any)?.signatories || [];
            for (const sig of signatories) {
              if (sig.email) {
                await tx.userHistory.create({
                  data: {
                    email: sig.email,
                    event: 'REJECTED',
                    eventUserId: approverId,
                    companyCode: onboarding.companyCode,
                  },
                });
              }
            }
          }

          return { message: 'Onboarding rejected successfully' };
        }

        // =========================
        // 🟢 APPROVE FLOW
        // =========================

        const data = onboarding.data as any;
        const { group, company, signatories } = data;

        let groupId = '';

        // 2. Handle group association or creation
        if (onboarding.groupCode) {
          let groupObj = await tx.groupCompany.findUnique({
            where: { groupCode: onboarding.groupCode },
          });

          if (!groupObj && group && group.name) {
            // Create the new group if it doesn't exist
            groupObj = await tx.groupCompany.create({
              data: {
                groupName: group.name,
                groupCode: onboarding.groupCode,
                status: 'ACTIVE',
              },
            });
          }

          if (groupObj) {
            groupId = groupObj.id;
          }
        }

        // 3. Create company
        let newCompany;
        try {
          newCompany = await tx.company.create({
            data: {
              legalName: company.name,
              gstNumber: company.gst,
              address: company.address,
              brandName: company.brand,
              iecode: company.ieCode,
              companyCode: onboarding.companyCode as string,
              registrationDate: company.registeredAt
                ? new Date(company.registeredAt)
                : new Date(),
              status: 'ACTIVE',
            },
          });
        } catch (error: any) {
          if (error.code === 'P2002') {
            const field = error.meta?.target?.[0] || 'unique field';
            throw new AppError(
              `A company with this ${field} already exists.`,
              400,
            );
          }
          throw error;
        }

        // 4. Map company to group
        if (groupId) {
          await tx.companyMapping.create({
            data: {
              companyId: newCompany.id,
              groupId,
            },
          });
        }

        // 5. Create root org node
        const nodePath = (onboarding.companyCode as string)
          .replace(/[^a-zA-Z0-9]/g, '')
          .toUpperCase();

        const rootNode = await tx.orgStructure.create({
          data: {
            companyId: newCompany.id,
            nodePath,
            nodeName: company.name,
            nodeType: 'ROOT',
            parentId: null,
          },
        });

        // 6. Handle signatories
        for (const sig of signatories) {
          let user = await tx.user.findUnique({
            where: { email: sig.email },
          });

          if (!user) {
            const defaultPassword = await HashUtil.hash('Welcome@123');

            user = await tx.user.create({
              data: {
                email: sig.email,
                name: sig.name,
                phone: sig.phone,
                password: defaultPassword,
              },
            });
          }

          await tx.userMapping.create({
            data: {
              userId: user.id,
              companyId: newCompany.id,
              status: 'ACTIVE',
              designation: sig.designation,
              employeeId: sig.employeeId || '',
            },
          });

          await tx.userAccess.create({
            data: {
              userId: user.id,
              roleCode: null,
              nodeId: rootNode.id,
              accessType: null,
              companyId: newCompany.id,
              isGlobalAccess: true,
            },
          });

          // 6.2 Add User History for signatory approval
          await tx.userHistory.create({
            data: {
              email: sig.email,
              event: 'APPROVED',
              eventUserId: approverId,
              companyCode: onboarding.companyCode,
            },
          });
        }

        // 7. Update onboarding status
        await tx.companyOnboarding.update({
          where: { id },
          data: {
            status: 'APPROVED',
            approvalRemark: remark,
          },
        });

        // 8. History
        if (onboarding.companyCode) {
          await tx.companyHistory.create({
            data: {
              companyCode: onboarding.companyCode,
              event: 'APPROVED',
              eventUserId: approverId,
            },
          });
        }

        return {
          message: 'Onboarding approved and company created successfully',
          companyId: newCompany.id,
        };
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async fetchCompanyHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode } = req.body;

      const histories = await prisma.companyHistory.findMany({
        where: { companyCode },
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const formattedHistories = histories.map((h) => ({
        companyCode: h.companyCode,
        event: h.event,
        createdAt: h.createdAt,
        user: h.user,
      }));

      res.json(formattedHistories);
    } catch (error) {
      next(error);
    }
  }
}
