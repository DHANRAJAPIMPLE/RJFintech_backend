import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AppError } from '../../middlewares/error.middleware';
import { NotificationService } from '../notifications/notification.db.modules';
import { HistoryUserUtil } from '../../utils/history-user.util';
import {
  appendCursorWhere,
  buildPage,
  getInMemoryPageRows,
  getPageOrder,
  isRowInCursorDirection,
  resolveCursorPagination,
} from '../../../shared/utils/cursor-pagination.util';

/**
 * Controller for managing company records, group associations, and the company onboarding lifecycle.
 * Handles the transition from a pending company request to a live production environment.
 */
export class CompanyDbController {
  private static async resolveNotificationCompanyId(
    userId?: string,
    companyId?: string | null,
  ) {
    if (companyId) return companyId;
    if (!userId) return null;

    const mapping = await prisma.userMapping.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { companyId: true },
      orderBy: { createdAt: 'desc' },
    });

    return mapping?.companyId || null;
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
   * Fetches one cursor-paginated active or pending company list.
   */
  static async getGroupCompanies(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const viewerUserId =
        typeof req.body?.userId === 'string' ? req.body.userId : null;
      const rawStatusType =
        typeof req.body?.statusType === 'string'
          ? req.body.statusType.trim().toLowerCase()
          : '';
      if (rawStatusType !== 'active' && rawStatusType !== 'pending') {
        throw new AppError('Invalid statusType', 400);
      }
      const statusType = rawStatusType as 'active' | 'pending';
      const query =
        typeof req.body?.query === 'string' && req.body.query.trim()
          ? req.body.query.trim()
          : null;
      const pagination = resolveCursorPagination(req.body ?? {});
      const buildCompanyWhere = (status: 'ACTIVE' | 'INACTIVE') => ({
        status,
        ...(query
          ? {
              OR: [
                {
                  legalName: { contains: query, mode: 'insensitive' as const },
                },
                {
                  companyCode: {
                    contains: query,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  gstNumber: {
                    contains: query,
                    mode: 'insensitive' as const,
                  },
                },
                { ieCode: { contains: query, mode: 'insensitive' as const } },
                {
                  companyMappings: {
                    some: {
                      group: {
                        OR: [
                          {
                            name: {
                              contains: query,
                              mode: 'insensitive' as const,
                            },
                          },
                          {
                            groupCode: {
                              contains: query,
                              mode: 'insensitive' as const,
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      });
      const pendingWhere = { status: 'PENDING' as const };
      const activeWhere = buildCompanyWhere('ACTIVE');
      const inactiveWhere = buildCompanyWhere('INACTIVE');
      const normalizedQuery = query?.toLowerCase() || null;
      const filteredPendingRows = normalizedQuery
        ? (
            await prisma.companyOnboarding.findMany({ where: pendingWhere })
          ).filter((onboarding) => {
            const data = onboarding.data as any;
            return [
              onboarding.companyCode,
              onboarding.groupCode,
              data?.company?.name,
              data?.company?.gst,
              data?.company?.ieCode,
              data?.group?.name,
            ].some(
              (value) =>
                typeof value === 'string' &&
                value.toLowerCase().includes(normalizedQuery),
            );
          })
        : null;
      const listWhere =
        statusType === 'active' ? activeWhere : pendingWhere;
      const pageWhere = pagination.cursor
        ? appendCursorWhere(
            listWhere as any,
            pagination.cursor,
            pagination.direction === 'prev' ? 'newer' : 'older',
          )
        : listWhere;
      const newWhere = pagination.topCursor
        ? appendCursorWhere(listWhere as any, pagination.topCursor, 'newer')
        : null;
      const companyInclude = {
        companyMappings: {
          take: 1,
          include: {
            group: { select: { groupCode: true, name: true } },
          },
        },
        userAccesses: {
          where: { isGlobalAccess: true },
          include: {
            user: { include: { userMappings: true } },
          },
        },
      } as const;
      const [activeCount, inactiveCount, pendingCount, selectedRows, newCount] =
        await Promise.all([
          prisma.company.count({ where: activeWhere }),
          prisma.company.count({ where: inactiveWhere }),
          filteredPendingRows
            ? Promise.resolve(filteredPendingRows.length)
            : prisma.companyOnboarding.count({ where: pendingWhere }),
          statusType === 'active'
            ? prisma.company.findMany({
                where: pageWhere as any,
                include: companyInclude,
                orderBy: getPageOrder(pagination.direction) as any,
                skip: pagination.cursor ? 0 : pagination.offset,
                take: pagination.limit + 1,
              })
            : filteredPendingRows
              ? Promise.resolve(
                  getInMemoryPageRows(filteredPendingRows, pagination),
                )
              : prisma.companyOnboarding.findMany({
                  where: pageWhere as any,
                  orderBy: getPageOrder(pagination.direction) as any,
                  skip: pagination.cursor ? 0 : pagination.offset,
                  take: pagination.limit + 1,
                }),
          newWhere
            ? statusType === 'active'
              ? prisma.company.count({ where: newWhere as any })
              : filteredPendingRows && pagination.topCursor
                ? Promise.resolve(
                    filteredPendingRows.filter((onboarding) =>
                      isRowInCursorDirection(
                        onboarding,
                        pagination.topCursor!,
                        'newer',
                      ),
                    ).length,
                  )
                : prisma.companyOnboarding.count({ where: newWhere as any })
            : Promise.resolve(0),
        ]);
      const pageData = buildPage(selectedRows as any[], pagination, newCount);
      const firstPageRow = pageData.pageRows[0];
      if (pagination.cursor && !pagination.isPagePagination && firstPageRow) {
        const newerWhere = appendCursorWhere(
          listWhere as any,
          firstPageRow,
          'newer',
        );
        const newerCount =
          statusType === 'active'
            ? await prisma.company.count({ where: newerWhere as any })
            : filteredPendingRows
              ? filteredPendingRows.filter((onboarding) =>
                  isRowInCursorDirection(onboarding, firstPageRow, 'newer'),
                ).length
              : await prisma.companyOnboarding.count({
                  where: newerWhere as any,
                });
        pageData.pageInfo.page = Math.floor(newerCount / pagination.limit) + 1;
      }

      if (statusType === 'active') {
        const companies = pageData.pageRows.map((company: any) => {
          const signatories = company.userAccesses.map((userAccess: any) => {
            const mapping = userAccess.user.userMappings.find(
              (userMapping: any) => userMapping.companyId === company.id,
            );
            return {
              name: userAccess.user.name,
              email: userAccess.user.email,
              phone: userAccess.user.phone,
              designation: mapping?.designation || null,
              employeeId: mapping?.employeeId || null,
            };
          });
          const companyData = { ...company };
          delete companyData.userAccesses;
          return { ...companyData, signatories };
        });

        return res.status(200).json({
          data: companies,
          activeCount,
          inactiveCount,
          pendingCount,
          pageInfo: pageData.pageInfo,
        });
      }

      const pendingCodes = pageData.pageRows.map(
        (onboarding: any) => onboarding.companyCode,
      );
      const histories = await prisma.companyHistory.findMany({
        where: {
          companyCode: { in: pendingCodes },
          event: 'INITIATE',
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        ...histories.map((history) => history.eventUserId),
      ]);
      const initiatorByCompanyCode = new Map<string, unknown>();
      histories.forEach((history) => {
        if (!initiatorByCompanyCode.has(history.companyCode)) {
          initiatorByCompanyCode.set(
            history.companyCode,
            HistoryUserUtil.formatAuditUser(
              history.user,
              history.eventUserId,
              saasAdminUserIds,
              viewerUserId,
            ),
          );
        }
      });
      const pending = pageData.pageRows.map((onboarding: any) => ({
        ...onboarding,
        initiator: initiatorByCompanyCode.get(onboarding.companyCode) || null,
      }));

      return res.status(200).json({
        data: pending,
        activeCount,
        inactiveCount,
        pendingCount,
        pageInfo: pageData.pageInfo,
      });
    } catch (error) {
      return next(error);
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
   */

  static async createCompanyOnboarding(req: Request, res: Response) {
    const { initiatorId, notificationCompanyId, ...onboardingData } = req.body;
    const companyCode = onboardingData.companyCode;
    const resolvedNotificationCompanyId =
      await CompanyDbController.resolveNotificationCompanyId(
        initiatorId,
        notificationCompanyId,
      );
    onboardingData.eligibleApprovers =
      NotificationService.mergeRecipientUserIds(
        onboardingData.eligibleApprovers || [],
      ).filter((userId) => userId !== initiatorId);
    const notificationRecipients = onboardingData.eligibleApprovers;

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
      }
      return onb;
    });

    if (resolvedNotificationCompanyId && initiatorId) {
      await NotificationService.createRequestNotification({
        companyId: resolvedNotificationCompanyId,
        type: 'INITIATE',
        referenceType: 'COMPANY',
        referenceId: onboarding.id,
        referenceName: (onboardingData.data as any)?.company?.name,
        createdBy: initiatorId,
        recipientUserIds: notificationRecipients,
        includeCreatedBy: true,
      });
    }

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
      const { id, action, approverId, remark, notificationCompanyId } =
        req.body;
      const actionStr = String(action || '').toLowerCase();
      const isRejectAction = actionStr === 'reject' || actionStr === 'rejected';
      const isApproveAction =
        actionStr === 'approve' || actionStr === 'approved';

      if (!isRejectAction && !isApproveAction) {
        throw new AppError('Invalid company onboarding action', 400);
      }

      const resolvedNotificationCompanyId =
        await CompanyDbController.resolveNotificationCompanyId(
          approverId,
          notificationCompanyId,
        );
      let notificationRecipients: string[] = [];
      let notificationSubject = 'Company';
      let notificationCompanyCode: string | null = null;

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

        notificationRecipients = onboarding.eligibleApprovers || [];
        notificationCompanyCode = onboarding.companyCode || null;
        notificationSubject =
          (onboarding.data as any)?.company?.name ||
          onboarding.companyCode ||
          notificationSubject;

        // Authorization check
        if (
          onboarding.eligibleApprovers &&
          onboarding.eligibleApprovers.length > 0 &&
          !onboarding.eligibleApprovers.includes(approverId)
        ) {
          throw new AppError('Unauthorized to process this request', 403);
        }

        // --- REJECT FLOW ---
        if (isRejectAction) {
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

          return {
            message: 'Onboarding rejected successfully',
            status: 'REJECTED',
          };
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
              nodeType: 'ROOT',
              parentNode: null,
              newNodeName: company.name,
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
          const levelsHash = `DEFAULT_${dwf.subModule}_1M_1C_1`;
          const workflowData = {
            name: dwf.name,
            module: 'SYSTEM_ACCESS',
            subModule: dwf.subModule,
            roleCode: dwf.roleCode,
            nodeId: rootNode.id,
            nodePath: rootNode.nodePath,
            nodeName: rootNode.nodeName,
            nodeType: rootNode.nodeType,
            workflowType: 'NODE',
            levelsHash,
            alias: '1M_1C_D',
            levels: {
              // eslint-disable-next-line @typescript-eslint/naming-convention -- Workflow levels use numeric keys.
              1: {
                approver1: 'NODE_APPROVER',
                type: 'OR',
              },
            },
          };

          const workflow = await tx.workflow.create({
            data: {
              name: dwf.name,
              alias: '1M_1C_D',
              module: 'SYSTEM_ACCESS',
              subModule: dwf.subModule,
              roleCode: dwf.roleCode,
              companyId: newCompany.id,
              nodeId: rootNode.id,
              levelsHash,
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

          const workflowReq = await tx.workflowReq.create({
            data: {
              companyId: newCompany.id,
              nodeId: rootNode.id,
              module: 'SYSTEM_ACCESS',
              subModule: dwf.subModule,
              levelsHash,
              workflowId: workflow.id,
              alias: '1M_1C_D',
              status: 'APPROVED',
              data: {
                ...workflowData,
                workflowId: workflow.id,
              },
              eligibleApprovers: [],
            },
          });

          await tx.workflow.update({
            where: { id: workflow.id },
            data: { workflowReqIds: [workflowReq.id] },
          });

          await tx.workflowReq.update({
            where: { id: workflowReq.id },
            data: {
              data: {
                ...workflowData,
                workflowId: workflow.id,
                workflowReqId: workflowReq.id,
              },
            },
          });

          await tx.workflowReqHistory.create({
            data: {
              workflowReqId: workflowReq.id,
              companyId: newCompany.id,
              event: 'APPROVED',
              eventUserId: approverId,
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
          status: 'APPROVED',
        };
      });

      if (resolvedNotificationCompanyId && approverId) {
        const requestInitiatorId =
          await NotificationService.getCompanyRequestInitiatorId(
            notificationCompanyCode,
          );
        const notificationRecipientUserIds =
          NotificationService.mergeRecipientUserIds(
            notificationRecipients,
            requestInitiatorId,
          );

        await NotificationService.createRequestNotification({
          companyId: resolvedNotificationCompanyId,
          type: result.status === 'REJECTED' ? 'REJECT' : 'ONBOARDED',
          referenceType: 'COMPANY',
          referenceId: id,
          referenceName: notificationSubject,
          createdBy: approverId,
          recipientUserIds: notificationRecipientUserIds,
          isPending: false,
        });
      }

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
      const { companyCode, userId: viewerUserId } = req.body;

      const histories = await prisma.companyHistory.findMany({
        where: { companyCode },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const saasAdminUserIds = await HistoryUserUtil.getSaasAdminUserIds([
        viewerUserId,
        ...histories.map((h) => h.eventUserId),
      ]);

      const formattedHistories = histories.map((h) => ({
        companyCode: h.companyCode,
        event: h.event,
        createdAt: h.createdAt,
        user: HistoryUserUtil.formatAuditUser(
          h.user,
          h.eventUserId,
          saasAdminUserIds,
          viewerUserId,
        ),
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
