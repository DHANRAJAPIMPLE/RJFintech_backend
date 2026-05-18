import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AppError } from '../../middlewares/error.middleware';
import { getPagination } from '../../../shared/utils/pagination.util';

/**
 * Controller for managing company records, group associations, and the company onboarding lifecycle.
 * Handles the transition from a pending company request to a live production environment.
 */
export class CompanyDbController {
  private static getPendingGroupKey(onboarding: {
    id: string;
    groupCode?: string | null;
    companyCode?: string | null;
  }) {
    return (
      onboarding.groupCode ||
      `SOLO_PENDING_${onboarding.companyCode || onboarding.id}`
    );
  }

  private static mapSignatories(userAccesses: any[], companyId: string) {
    return userAccesses.map((ua: any) => {
      const mapping = ua.user.userMappings.find(
        (m: any) => m.companyId === companyId,
      );
      return {
        name: ua.user.name,
        email: ua.user.email,
        phone: ua.user.phone,
        designation: mapping?.designation || null,
        employeeId: mapping?.employeeId || null,
      };
    });
  }

  private static formatCompanyDetails(company: any) {
    return {
      companyCode: company.companyCode,
      name: company.legalName,
      gst: company.gstNumber,
      brand: company.brandName,
      ieCode: company.ieCode || '',
      registration: company.registrationDate,
      address: company.address || '',
      signatories: company.signatories || [],
    };
  }

  private static async getGroupCompanyCounts() {
    const [
      activeGroupCount,
      activeSoloCount,
      inactiveGroupFromActiveCount,
      inactiveGroupCount,
      inactiveSoloCount,
      pendingGroupRows,
      pendingSoloCount,
    ] = await Promise.all([
      prisma.groupCompany.count({
        where: {
          status: 'ACTIVE',
          companyMappings: {
            some: { company: { status: 'ACTIVE' } },
          },
        },
      }),
      prisma.company.count({
        where: {
          status: 'ACTIVE',
          companyMappings: { none: {} },
        },
      }),
      prisma.groupCompany.count({
        where: {
          status: 'ACTIVE',
          companyMappings: {
            some: { company: { status: 'INACTIVE' } },
          },
        },
      }),
      prisma.groupCompany.count({
        where: { status: 'INACTIVE' },
      }),
      prisma.company.count({
        where: {
          status: 'INACTIVE',
          companyMappings: { none: {} },
        },
      }),
      prisma.companyOnboarding.groupBy({
        by: ['groupCode'],
        where: {
          status: 'PENDING',
          groupCode: { not: null },
        },
      }),
      prisma.companyOnboarding.count({
        where: {
          status: 'PENDING',
          groupCode: null,
        },
      }),
    ]);

    return {
      activeCount: activeGroupCount + activeSoloCount,
      inactiveCount:
        inactiveGroupFromActiveCount + inactiveGroupCount + inactiveSoloCount,
      pendingCount: pendingGroupRows.length + pendingSoloCount,
    };
  }

  private static async getPaginatedActiveGroups(offset: number, limit: number) {
    const activeGroupCount = await prisma.groupCompany.count({
      where: {
        status: 'ACTIVE',
        companyMappings: {
          some: { company: { status: 'ACTIVE' } },
        },
      },
    });

    const groupTake =
      offset < activeGroupCount
        ? Math.min(limit, activeGroupCount - offset)
        : 0;
    const soloTake = limit - groupTake;
    const soloOffset = Math.max(0, offset - activeGroupCount);

    const [groups, soloCompanies] = await Promise.all([
      groupTake > 0
        ? prisma.groupCompany.findMany({
            where: {
              status: 'ACTIVE',
              companyMappings: {
                some: { company: { status: 'ACTIVE' } },
              },
            },
            skip: offset,
            take: groupTake,
            orderBy: { createdAt: 'desc' },
            include: {
              companyMappings: {
                where: { company: { status: 'ACTIVE' } },
                include: {
                  company: {
                    include: {
                      userAccesses: {
                        where: { isGlobalAccess: true },
                        include: {
                          user: {
                            include: {
                              userMappings: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      soloTake > 0
        ? prisma.company.findMany({
            where: {
              status: 'ACTIVE',
              companyMappings: { none: {} },
            },
            skip: soloOffset,
            take: soloTake,
            orderBy: { createdAt: 'desc' },
            include: {
              userAccesses: {
                where: { isGlobalAccess: true },
                include: {
                  user: {
                    include: {
                      userMappings: true,
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const groupRows = groups.map((g: any) => ({
      groupDetails: {
        groupCode: g.groupCode,
        groupName: g.name,
      },
      companyDetails: g.companyMappings.map((cm: any) => {
        const signatories = CompanyDbController.mapSignatories(
          cm.company.userAccesses,
          cm.company.id,
        );
        return CompanyDbController.formatCompanyDetails({
          ...cm.company,
          signatories,
        });
      }),
    }));

    const soloRows = soloCompanies.map((c: any) => {
      const signatories = CompanyDbController.mapSignatories(
        c.userAccesses,
        c.id,
      );
      return {
        groupDetails: null,
        companyDetails: [
          CompanyDbController.formatCompanyDetails({ ...c, signatories }),
        ],
      };
    });

    return [...groupRows, ...soloRows];
  }

  private static async getPaginatedPendingGroups(
    offset: number,
    limit: number,
  ) {
    const [groupRows, soloRows] = await Promise.all([
      prisma.companyOnboarding.groupBy({
        by: ['groupCode'],
        where: {
          status: 'PENDING',
          groupCode: { not: null },
        },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: 'desc' } },
      }),
      prisma.companyOnboarding.findMany({
        where: {
          status: 'PENDING',
          groupCode: null,
        },
        select: { id: true, companyCode: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const pageKeys = [
      ...groupRows.map((row) => ({
        groupKey: row.groupCode as string,
        groupCode: row.groupCode as string,
        id: null as string | null,
        sortDate: row._max.createdAt || new Date(0),
      })),
      ...soloRows.map((row) => ({
        groupKey: CompanyDbController.getPendingGroupKey(row),
        groupCode: null as string | null,
        id: row.id,
        sortDate: row.createdAt,
      })),
    ]
      .sort((a, b) => b.sortDate.getTime() - a.sortDate.getTime())
      .slice(offset, offset + limit);

    if (pageKeys.length === 0) return [];

    const groupCodes = pageKeys
      .map((key) => key.groupCode)
      .filter(Boolean) as string[];
    const soloIds = pageKeys.map((key) => key.id).filter(Boolean) as string[];
    const orderMap = new Map(
      pageKeys.map((key, index) => [key.groupKey, index]),
    );

    const pendingOnboardings = (
      await prisma.companyOnboarding.findMany({
        where: {
          status: 'PENDING',
          OR: [
            ...(groupCodes.length > 0
              ? [{ groupCode: { in: groupCodes } }]
              : []),
            ...(soloIds.length > 0 ? [{ id: { in: soloIds } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
      })
    )
      .map((onb) => ({
        ...onb,
        groupKey: CompanyDbController.getPendingGroupKey(onb),
      }))
      .sort((a, b) => {
        const groupDiff =
          (orderMap.get(a.groupKey) ?? 0) - (orderMap.get(b.groupKey) ?? 0);
        if (groupDiff !== 0) return groupDiff;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });

    const companyCodes = pendingOnboardings
      .map((onb) => onb.companyCode)
      .filter(Boolean);
    const histories =
      companyCodes.length > 0
        ? await prisma.companyHistory.findMany({
            where: {
              companyCode: { in: companyCodes },
            },
            include: {
              user: { select: { name: true, email: true } },
            },
            orderBy: { createdAt: 'desc' },
          })
        : [];

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

    const pendingGroups: Record<string, any> = {};
    pendingOnboardings.forEach((onb: any) => {
      const onbData = onb.data || {};
      const group = onbData.group || {};
      const company = onbData.company || {};
      const signatories = onbData.signatories || [];
      const groupKey = onb.groupKey;

      if (!pendingGroups[groupKey]) {
        pendingGroups[groupKey] = {
          groupDetails: onb.groupCode
            ? {
                groupCode: onb.groupCode,
                groupName: group.name || 'Pending Group',
              }
            : null,
          companyDetails: [],
        };
      }

      const init = historyMap.get(`${onb.companyCode}_INITIATE`);
      pendingGroups[groupKey].companyDetails.push({
        companyId: onb.id,
        companyCode: onb.companyCode,
        name: company.name || '',
        gst: company.gst || '',
        brand: company.brand || '',
        iecode: company.ieCode || '',
        registration: company.registeredAt ? company.registeredAt : '',
        address: company.address || '',
        initiatorName: init?.user?.name || null,
        initiatorEmail: init?.user?.email || null,
        initiatedDate: onb.createdAt,
        signatories: signatories.map((s: any) => ({
          name: s.name || '',
          email: s.email || '',
          phone: s.phone || '',
          designation: s.designation || '',
          employeeId: s.employeeId || '',
        })),
      });
    });

    return Object.values(pendingGroups);
  }

  private static async getPaginatedGroupCompanies(req: Request, res: Response) {
    const { listType } = req.body;
    const { offset, limit } = getPagination(req.body);
    const counts = await CompanyDbController.getGroupCompanyCounts();
    const data =
      listType === 'active'
        ? await CompanyDbController.getPaginatedActiveGroups(offset, limit)
        : await CompanyDbController.getPaginatedPendingGroups(offset, limit);

    return res.status(200).json({
      data,
      ...counts,
      limit,
      offset,
    });
  }

  /**
   * Fetches all companies that a specific user is mapped to.
   */
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

  /**
   * Fetches a structured view of all company records for the administration panel.
   * This method performs a multi-step aggregation:
   * 1. Retrieves Group Companies and their associated Active companies.
   * 2. Retrieves Solo Companies (those not mapped to any group).
   * 3. Retrieves Pending Onboarding requests.
   * 4. Enriches all records with Initiator and Approver data from the history tables.
   */
  static async getGroupCompanies(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      if (req.body.listType === 'active' || req.body.listType === 'pending') {
        await CompanyDbController.getPaginatedGroupCompanies(req, res);
        return;
      }

      // 1. Fetch groups and their companies (Active)
      const groups = await prisma.groupCompany.findMany({
        include: {
          companyMappings: {
            include: {
              company: {
                include: {
                  userAccesses: {
                    where: { isGlobalAccess: true },
                    include: {
                      user: {
                        include: {
                          userMappings: true,
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
          userAccesses: {
            where: { isGlobalAccess: true },
            include: {
              user: {
                include: {
                  userMappings: true,
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

      // 4. Resolve audit history for all entities to identify who initiated/approved them
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

      // 5. Enhance Active data with history
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
            const signatories = cm.company.userAccesses.map((ua: any) => {
              const mapping = ua.user.userMappings.find(
                (m: any) => m.companyId === cm.company.id,
              );
              return {
                name: ua.user.name,
                email: ua.user.email,
                phone: ua.user.phone,
                designation: mapping?.designation || null,
                employeeId: mapping?.employeeId || null,
              };
            });

            // Remove internal mapping fields to keep response clean
            const { userAccesses, ...companyData } = cm.company;

            return {
              ...cm,
              company: {
                ...companyData,
                signatories,
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
        const signatories = c.userAccesses.map((ua: any) => {
          const mapping = ua.user.userMappings.find(
            (m: any) => m.companyId === c.id,
          );
          return {
            name: ua.user.name,
            email: ua.user.email,
            phone: ua.user.phone,
            designation: mapping?.designation || null,
            employeeId: mapping?.employeeId || null,
          };
        });

        const { userAccesses, ...companyData } = c;

        return {
          ...companyData,
          signatories,
          initiator: compInit?.user || null,
          approver: compApprove?.user || null,
          approvedAt: compApprove?.createdAt || null,
          createdAt: compInit?.createdAt || c.createdAt,
        };
      });

      // 6. Enhance Pending data with history
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

  /**
   * Fetches basic company information by its unique company code.
   */
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

  /**
   * Fetches basic company information by its unique ID.
   */
  static async getCompanyById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.body;
      const company = await prisma.company.findUnique({
        where: { id },
        include: {
          companyMappings: {
            include: {
              group: true,
            },
          },
        },
      });
      res.json(company);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Initiates a new company onboarding request.
   * Performs an atomic transaction to:
   * 1. Create a CompanyOnboarding record.
   * 2. Log 'INITIATE' events in CompanyHistory.
   * 3. Log 'INITIATE' events in UserHistory for all proposed signatories.
   */

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

        const signatories = (onboardingData.data as any)?.signatories || [];
        for (const sig of signatories) {
          if (sig.email) {
            // Only log user history if company already exists (e.g. for re-onboarding or existing company)
            const company = await tx.company.findUnique({
              where: { companyCode },
            });
            if (company) {
              await tx.userHistory.create({
                data: {
                  email: sig.email,
                  event: 'INITIATE',
                  eventUserId: initiatorId,
                  companyId: company.id,
                },
              });
            }
          }
        }
      }
      return onb;
    });
    res.status(201).json(onboarding);
  }

  /**
   * Fetches a specific company onboarding request by ID.
   */
  static async getCompanyOnboardingById(req: Request, res: Response) {
    const { id } = req.body;
    const onboarding = await prisma.companyOnboarding.findUnique({
      where: { id },
    });
    res.json(onboarding);
  }

  /**
   * Processes the approval or rejection of a company onboarding request.
   * This is one of the most critical transactions in the system.
   * Approval logic:
   * 1. Handles Group Creation: If a group code is provided and doesn't exist, it creates the Group.
   * 2. Creates Company: Inserts the live production 'Company' record.
   * 3. Links Company to Group: Creates a 'CompanyMapping' entry.
   * 4. Initializes Hierarchy: Creates a 'ROOT' organization node for the new company.
   * 5. Handles Signatories:
   *    - Creates 'User' records (if they don't exist).
   *    - Creates 'UserMapping' to link them to the new company.
   *    - Grants 'isGlobalAccess' permissions at the ROOT node level.
   * 6. Finalizes Onboarding: Updates request status to 'APPROVED' and logs history.
   */
  static async handleCompanyOnboardingStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, action, approverId, remark } = req.body;
      const result = await prisma.$transaction(async (tx) => {
        // 1. Fetch onboarding record
        const onboarding = await tx.companyOnboarding.findUnique({
          where: { id },
        });

        if (!onboarding) {
          throw new AppError('Onboarding request not found', 404);
        }

        if (onboarding.status !== 'PENDING') {
          throw new AppError('Onboarding request already processed', 400);
        }

        // Authorization check
        if (
          onboarding.eligibleApprovers &&
          onboarding.eligibleApprovers.length > 0 &&
          !onboarding.eligibleApprovers.includes(approverId)
        ) {
          throw new AppError('Unauthorized to process this request', 403);
        }

        // --- REJECT FLOW ---
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

            const signatories = (onboarding.data as any)?.signatories || [];
            for (const sig of signatories) {
              if (sig.email) {
                // Find company if it exists (might not exist if rejected before creation)
                const company = await tx.company.findUnique({
                  where: { companyCode: onboarding.companyCode },
                });
                if (company) {
                  await tx.userHistory.create({
                    data: {
                      email: sig.email,
                      event: 'REJECTED',
                      eventUserId: approverId,
                      companyId: company.id,
                    },
                  });
                }
              }
            }
          }

          return { message: 'Onboarding rejected successfully' };
        }

        // --- APPROVE FLOW ---
        const data = onboarding.data as any;
        const { group, company, signatories } = data;

        let groupId = '';

        // 1. Group Setup
        if (onboarding.groupCode) {
          let groupObj = await tx.groupCompany.findUnique({
            where: { groupCode: onboarding.groupCode },
          });

          if (!groupObj && group && group.name) {
            groupObj = await tx.groupCompany.create({
              data: {
                name: group.name,
                groupCode: onboarding.groupCode,
                status: 'ACTIVE',
              },
            });
          }

          if (groupObj) {
            groupId = groupObj.id;
          }
        }

        // 2. Company Creation
        let newCompany;
        try {
          newCompany = await tx.company.create({
            data: {
              legalName: company.name,
              gstNumber: company.gst,
              address: company.address,
              brandName: company.brand || null,
              ieCode: company.ieCode,
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

        // 3. Mapping to Group
        if (groupId) {
          await tx.companyMapping.create({
            data: {
              companyId: newCompany.id,
              groupId,
            },
          });
        }

        // 4. Hierarchical Root Node
        const nodePath = (onboarding.companyCode as string)
          .replace(/[^a-zA-Z0-9]/g, '')
          .toUpperCase();

        const rootNodeReq = await tx.orgStructureReq.create({
          data: {
            companyId: newCompany.id,
            status: 'APPROVED',
            data: {
              newNodeName: company.name,
              nodeType: 'ROOT',
              parentNode: null,
            },
            remarks: 'Initial root node created during company onboarding',
          },
        });

        const rootNode = await tx.orgStructure.create({
          data: {
            companyId: newCompany.id,
            nodePath,
            nodeName: company.name,
            nodeType: 'ROOT',
            parentId: null,
          },
        });

        await tx.orgHistory.create({
          data: {
            companyId: newCompany.id,
            event: 'APPROVED',
            eventUserId: approverId,
            orgReqId: rootNodeReq.id,
          },
        });

        // 4b. Create default workflows for SYSTEM_ACCESS
        const defaultWorkflows = [
          {
            name: 'USER_ACC_WORKFLOW_DEFAULT',
            subModule: 'USER_ACC',
            roleCode: 'USER_ACC_MGR',
          },
          {
            name: 'ORG_STR_WORKFLOW_DEFAULT',
            subModule: 'ORG_STR',
            roleCode: 'ORG_STR_MGR',
          },
          {
            name: 'WORK_FLOW_WORKFLOW_DEFAULT',
            subModule: 'WORK_FLOW',
            roleCode: 'WORK_FLOW_MGR',
          },
        ];

        for (const dwf of defaultWorkflows) {
          const workflow = await tx.workflow.create({
            data: {
              name: dwf.name,
              alias: '1M_1C_1',
              module: 'SYSTEM_ACCESS',
              subModule: dwf.subModule,
              roleCode: dwf.roleCode,
              companyId: newCompany.id,
              nodeId: rootNode.id,
              levelsHash: `DEFAULT_${dwf.subModule}_1M_1C_1`,
              levels: {
                create: [
                  {
                    level: 1,
                    approver1: 'NODE_APPROVER',
                    approverType: 'OR',
                  },
                ],
              },
            },
          });
        }

        // 5. Signatories Setup
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

          // Map user to company
          await tx.userMapping.create({
            data: {
              userId: user.id,
              companyId: newCompany.id,
              status: 'ACTIVE',
              designation: sig.designation || '',
              employeeId: sig.employeeId || '',
            },
          });

          // Grant Global Access to Signatories
          const existingAccess = await tx.userAccess.findFirst({
            where: {
              userId: user.id,
              roleCode: 'CORP_ADMIN',
              companyId: newCompany.id,
              nodeId: rootNode.id,
            },
          });

          if (existingAccess) {
            throw new AppError(
              `User '${sig.email}' already has global access assigned for this company`,
              400,
            );
          }

          await tx.userAccess.create({
            data: {
              userId: user.id,
              roleCode: 'CORP_ADMIN',
              nodeId: rootNode.id,
              accessType: 'PRIMARY',
              companyId: newCompany.id,
              isGlobalAccess: true,
              accessCategory: 'ALL_CHILD',
            },
          });

          // Log signatory approval history
          await tx.userHistory.create({
            data: {
              email: sig.email,
              event: 'APPROVED',
              eventUserId: approverId,
              companyId: newCompany.id,
            },
          });
        }

        // 6. Finalize request
        await tx.companyOnboarding.update({
          where: { id },
          data: {
            status: 'APPROVED',
            approvalRemark: remark,
          },
        });

        // 7. Log company-level history
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

  /**
   * Fetches the audit trail for a specific company code.
   */
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

  /**
   * Validates if a GST Number or IE Code is already in use.
   * Scans both production records and pending onboarding requests.
   */
  static async checkCompany(req: Request, res: Response, next: NextFunction) {
    try {
      const { gstNumber, ieCode } = req.body;

      // Build conditions only for provided values
      const conditions = [];

      if (gstNumber) {
        conditions.push({ gstNumber });
      }

      if (ieCode) {
        conditions.push({ ieCode });
      }

      // If nothing provided, skip checking
      if (conditions.length === 0) {
        return res.status(200).json({
          exists: false,
          message: 'No GST Number or IE Code provided',
        });
      }

      // 1. Check master records
      const masterCheck = await prisma.company.findFirst({
        where: {
          OR: conditions,
        },
      });

      if (masterCheck) {
        return res.status(200).json({
          exists: true,
          message: 'GST Number or IE Code already exists in master records',
        });
      }

      // Build onboarding conditions
      const onboardingConditions = [];

      if (gstNumber) {
        onboardingConditions.push({
          data: {
            path: ['company', 'gst'],
            equals: gstNumber,
          },
        });
      }

      if (ieCode) {
        onboardingConditions.push({
          data: {
            path: ['company', 'ieCode'],
            equals: ieCode,
          },
        });
      }

      // 2. Check pending onboarding requests
      const onboardingCheck = await prisma.companyOnboarding.findFirst({
        where: {
          status: 'PENDING',
          OR: onboardingConditions,
        },
      });

      if (onboardingCheck) {
        return res.status(200).json({
          exists: true,
          message: 'GST Number or IE Code already exists in pending onboarding',
        });
      }

      return res.status(200).json({ exists: false });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Checks if any of the provided signatory emails are already associated with a PENDING onboarding request.
   * Prevents signatory collision across different company onboarding attempts.
   */
  static async checkSignatories(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { emails } = req.body;

      if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(200).json({ exists: false });
      }

      const pendingOnboardings = await prisma.companyOnboarding.findMany({
        where: { status: 'PENDING' },
      });

      const existingEmails: string[] = [];
      pendingOnboardings.forEach((onb) => {
        const onbData = onb.data as any;
        const onbSignatories = onbData?.signatories || [];
        onbSignatories.forEach((s: any) => {
          if (emails.includes(s.email)) {
            existingEmails.push(s.email);
          }
        });
      });

      if (existingEmails.length > 0) {
        return res.status(200).json({
          exists: true,
          message: `Following signatories are already part of another pending company onboarding: ${[
            ...new Set(existingEmails),
          ].join(', ')}`,
        });
      }

      res.status(200).json({ exists: false });
    } catch (error) {
      next(error);
    }
  }
}
