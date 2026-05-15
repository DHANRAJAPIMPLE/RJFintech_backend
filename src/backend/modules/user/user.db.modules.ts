import type { Request, Response, NextFunction } from 'express';
import { prisma, ltree } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AppError } from '../../middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';
import { resolveCompanyId } from '../../shared/resolveCompanyId';
import { formatHistoryPipeline } from '../../shared/historyFormatter';

/**
 * Controller for managing user accounts, mappings to companies, and onboarding workflows.
 * Handles production user data and pending user requests.
 */
export class UserDbController {
  /**
   * Fetches all users associated with a company, including those with pending onboarding requests.
   * This method performs several steps to provide a unified view:
   * 1. Fetches 'active' and 'inactive' users from the production tables.
   * 2. Fetches 'pending' users from the onboarding table.
   * 3. Enhances pending user data with initiator and manager information for UI display.
   */
  static async fetchAllUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode, companyId, userId } = req.body;
      const resolvedCompanyId = await resolveCompanyId({ companyId, companyCode });

      // Check if requester is a global access user
      let isGlobal = true;
      let allVisibleNodeIds: string[] = [];
      let allVisibleNodePaths: string[] = [];

      if (userId) {
        const globalAccess = await prisma.userAccess.findFirst({
          where: {
            userId,
            companyId: resolvedCompanyId,
            isGlobalAccess: true,
          },
        });

        if (!globalAccess) {
          isGlobal = false;
          // Get all node-specific accesses to determine the visibility scope
          const requesterAccesses = await prisma.userAccess.findMany({
            where: {
              userId,
              companyId: resolvedCompanyId,
              accessType: 'PRIMARY',
              roleCode: { startsWith: 'USER_ACC' },
            },
            include: { orgStructure: { select: { nodePath: true } } },
          });

          if (requesterAccesses.length > 0) {
            const nodePaths = requesterAccesses
              .filter((a) => a.accessCategory === 'NODE')
              .map((a) => a.orgStructure.nodePath);

            const immediateChildPaths = requesterAccesses
              .filter((a) => a.accessCategory === 'IMMEDIATE_CHILD')
              .map((a) => a.orgStructure.nodePath);

            const allChildPaths = requesterAccesses
              .filter((a) => a.accessCategory === 'ALL_CHILD')
              .map((a) => a.orgStructure.nodePath);

            // Fetch all nodes that fall within the requester's visibility categories
            const visibleNodes = await prisma.orgStructure.findMany({
              where: {
                companyId: resolvedCompanyId,
                OR: [
                  // 1. Direct nodes (for NODE, IMMEDIATE_CHILD, ALL_CHILD)
                  {
                    nodePath: {
                      in: [
                        ...nodePaths,
                        ...immediateChildPaths,
                        ...allChildPaths,
                      ],
                    },
                  },
                  // 2. All descendants (for ALL_CHILD)
                  ...allChildPaths.map((path) => ({
                    nodePath: { startsWith: `${path}.` },
                  })),
                  // 3. Immediate children only (for IMMEDIATE_CHILD)
                  ...immediateChildPaths.map((path) => ({
                    parent: { nodePath: path },
                  })),
                ],
              },
              select: { id: true, nodePath: true },
            });

            allVisibleNodeIds = visibleNodes.map((n) => n.id);
            allVisibleNodePaths = visibleNodes.map((n) => n.nodePath);
          }
        }
      }

      // 1. Fetch production users with their full organizational context
      const users = await prisma.user.findMany({
        where: {
          userMappings: {
            some: {
              companyId: resolvedCompanyId,
            },
          },
          // Visibility Rule: 
          // - Global users (Signatories) can see all users.
          // - Non-global users can ONLY see users within their assigned node scope.
          // - Non-global users CANNOT see any user who has isGlobalAccess: true.
          ...(isGlobal
            ? {}
            : {
                AND: [
                  {
                    userAccesses: {
                      some: {
                        nodeId: { in: allVisibleNodeIds },
                        accessType: 'PRIMARY',
                      },
                    },
                  },
                  {
                    userAccesses: {
                      none: {
                        isGlobalAccess: true,
                        companyId: resolvedCompanyId,
                      },
                    },
                  },
                ],
              }),
        },
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

      // 2. Fetch pending onboarding requests
      const allPendingOnboardings = await prisma.userOnboarding.findMany({
        where: {
          status: 'PENDING',
          companyId: resolvedCompanyId,
        },
      });

      // Filter pending requests:
      // - Global users can see all pending requests.
      // - Non-global users can ONLY see requests within their assigned node scope.
      // - Non-global users CANNOT see any pending request for a Global Access user (isGlobalUser: true or Corp Admin role).
      const pendingOnboardings = isGlobal
        ? allPendingOnboardings
        : allPendingOnboardings.filter((onb: any) => {
            const data = onb.data as any;
            const basic = data?.basicDetails || {};
            const permissions = data?.permissions || [];

            // Rule: Exclude global signatory onboarding requests from non-global view
            const isGlobalRequest =
              basic.isGlobalUser === true ||
              permissions.some((p: any) => p.roleName === 'Corp Admin');
            if (isGlobalRequest) return false;

            return permissions.some(
              (p: any) =>
                p.accessType === 'PRIMARY' &&
                allVisibleNodePaths.includes(p.nodePath),
            );
          });

      // 3. Enhance pending records with audit trail and manager info
      const pendingEmails = pendingOnboardings
        .map((onb: any) => (onb.data as any)?.basicDetails?.email)
        .filter(Boolean);

      const histories = await prisma.userHistory.findMany({
        where: {
          email: { in: pendingEmails },
          companyId: resolvedCompanyId,
        },
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const historyMap = new Map();
      histories.forEach((h) => {
        const key = `${h.email}_${h.event}`;
        if (!historyMap.has(key)) {
          historyMap.set(key, h);
        }
      });

      const managerEmails = pendingOnboardings
        .map((onb: any) => (onb.data as any)?.basicDetails?.reportingManager)
        .filter(Boolean);

      const managers = await prisma.user.findMany({
        where: {
          email: { in: managerEmails },
        },
        select: { name: true, email: true },
      });

      const managerMap = new Map();
      managers.forEach((m) => managerMap.set(m.email, m));

      // 4. Resolve workflow names and aliases for pending requests
      const workflowIds = Array.from(new Set(pendingOnboardings.map((onb: any) => onb.workflowId).filter(Boolean))) as string[];
      const workflowDetails = await prisma.workflow.findMany({
        where: { id: { in: workflowIds } },
        select: { id: true, name: true, alias: true }
      });
      const workflowMap = new Map(workflowDetails.map(w => [w.id, w]));

      const enhancedPending = pendingOnboardings.map((onb: any) => {
        const dataBlob = onb.data as any;
        const email = dataBlob?.basicDetails?.email;
        const managerEmail = dataBlob?.basicDetails?.reportingManager;

        const init = historyMap.get(`${email}_INITIATE`);
        const approve = historyMap.get(`${email}_APPROVE`);
        const managerInfo = managerMap.get(managerEmail);
        const w = onb.workflowId ? workflowMap.get(onb.workflowId) : null;

        return {
          ...onb,
          initiator: init?.user || null,
          approver: approve?.user || null,
          workflowName: w?.name || 'N/A',
          alias: w?.alias || 'N/A',
          reportingManagerInfo: managerInfo
            ? {
              name: managerInfo.name,
              email: managerInfo.email,
            }
            : null,
        };
      });

 

      const activeUsers: any[] = [];
      const inactiveUsers: any[] = [];

      users.forEach((u) => {
        const mapping = u.userMappings[0];
        const formattedUser = {
          basicDetails: {
            name: u.name,
            email: u.email,
            phone: u.phone,
            createdAt: u.createdAt,
            designation: mapping?.designation || null,
            employeeId: mapping?.employeeId || null,
            reportingManagerName: mapping?.manager?.name || null,
            reportingManagerEmail: mapping?.manager?.email || null,
          },
          primary: u.userAccesses
            .filter((a) => a.accessType === 'PRIMARY' || a.isGlobalAccess)
            .map((a) => ({
              roleCategory: a.role?.category,
              roleSubCategory: a.role?.subCategory,
              roleName: a.role?.roleName,
              nodeName: a.orgStructure?.nodeName,
              nodePath: a.orgStructure?.nodePath,
              nodeType: a.orgStructure?.nodeType,
              accessCategory: a.accessCategory,
            })),
          secondary: u.userAccesses
            .filter((a) => a.accessType === 'SECONDARY' && !a.isGlobalAccess)
            .map((a) => ({
              roleCategory: a.role?.category,
              roleSubCategory: a.role?.subCategory,
              roleName: a.role?.roleName,
              nodeName: a.orgStructure?.nodeName,
              nodePath: a.orgStructure?.nodePath,
              nodeType: a.orgStructure?.nodeType,
              accessCategory: a.accessCategory,
            })),
        };

        if (mapping?.status === 'ACTIVE') {
          activeUsers.push(formattedUser);
        } else {
          inactiveUsers.push(formattedUser);
        }
      });

      const pendingUsers = enhancedPending.map((onb: any) => {
        const dataBlob = onb.data as any;
        const basic = dataBlob?.basicDetails || {};
        const permissions = dataBlob?.permissions || [];

        const primary: any[] = [];
        const secondary: any[] = [];

        permissions.forEach((p: any) => {
          const access = {
            roleCategory: p.roleCategory,
            roleSubCategory: p.roleSubCategory,
            roleName: p.roleName,
            nodeName: p.nodeName,
            nodePath: p.nodePath,
            nodeType: p.nodeType,
            accessCategory: p.accessCategory,
          };
          // Condition: isGlobal true then comes in primary
          if (
            p.isGlobal === true ||
            p.isGlobalAccess === true ||
            p.accessType === 'PRIMARY'
          ) {
            primary.push(access);
          } else {
            secondary.push(access);
          }
        });

        return {
          id: onb.id,

          approver: onb.approver,
          basicDetails: {
            name: basic.name,
            email: basic.email,
            phone: basic.phone,
            createdAt: onb.createdAt,
            designation: basic.designation || null,
            employeeId: basic.employeeId || null,
            reportingManagerName: onb.reportingManagerInfo?.name || null,
            reportingManagerEmail: onb.reportingManagerInfo?.email || null,
            initiatorName: onb.initiator?.name || null,
            initiatorEmail: onb.initiator?.email || null,
            initiatedDate: onb.createdAt,
            workflowName: onb.workflowName,
            alias: onb.alias,
          },
          primary,
          secondary,
        };
      });

      res.status(200).json({
        message: 'Users fetched successfully!',
        code: 200,
        data: {
          activeUsers,
          pendingUsers,
          inactiveUsers,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Updates the status (ACTIVE/INACTIVE) of a user mapping for a specific company.
   */
  static async updateUserStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
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

  /**
   * Creates a new user onboarding request in the database.
   * Performs an atomic transaction to create the request and the initial history log.
   */
  /**
   * Creates a new user onboarding request.
   * Performs an atomic transaction to:
   * 1. Create the onboarding record.
   * 2. Resolve the workflow (explicit or default for USER_ACC section).
   * 3. Build WorkflowApprover rows for each approval level.
   * 4. Log the INITIATE event in UserHistory with the reqId.
   */
  static async createUserOnboarding(req: Request, res: Response) {
    const {
      initiatorId,
      companyCode,
      companyId,
      groupCode,
      levelsHash,
      ...onboardingData
    } = req.body;
    const resolvedCompanyId = await resolveCompanyId({ companyId, companyCode });

    const email = onboardingData.data?.basicDetails?.email;
    const permissions = onboardingData.data?.permissions || [];
    const hasCorpAdminRole = Array.isArray(permissions) && permissions.some((p: any) => p.roleName === 'Corp Admin');

    // ── Initiator Restriction for Corp Admin ──
    if (hasCorpAdminRole) {
      const initiatorAccess = await prisma.userAccess.findFirst({
        where: {
          userId: initiatorId,
          companyId: resolvedCompanyId,
          isGlobalAccess: true,
        },
      });
      if (!initiatorAccess) {
        throw new AppError(
          'Unauthorized: Only a signatory (Global Access user) can initiate a request containing the Corp Admin role',
          403,
        );
      }
    }

    // Fetch all global access users for this company to ensure they are in the master eligible list
    const globalUsers = await WorkflowApproverUtil.getGlobalAccessUserIds(prisma as any, resolvedCompanyId, 'USER_ACC');

    // Master eligible list includes both configured and global approvers.
    // Initiator is excluded from all active approval lists.
    const masterEligible = new Set([...(onboardingData.eligibleApprovers || []), ...globalUsers]);
    onboardingData.eligibleApprovers = Array.from(masterEligible).filter((id) => id !== initiatorId);

    const onboarding = await prisma.$transaction(async (tx) => {
      let groupId: string | null = null;
      if (groupCode) {
        const group = await tx.groupCompany.findUnique({
          where: { groupCode },
        });
        if (group) {
          groupId = group.id;
        }
      }

      const onb = await tx.userOnboarding.create({
        data: {
          ...onboardingData,
          companyId: resolvedCompanyId,
          groupId: groupId,
        },
      });

      // ── Resolve workflow approvers and create WorkflowApprover rows ──────
      // Determine the node for approver resolution from the permissions data
      const permissions = onboardingData.data?.permissions || [];
      let nodeId: string | null = null;

      if (permissions.length > 0 && permissions[0].nodePath) {
        const node = await tx.orgStructure.findFirst({
          where: {
            nodePath: permissions[0].nodePath,
            companyId: resolvedCompanyId,
          },
        });
        if (node) nodeId = node.id;
      }

      // Fallback to root node if no specific node was found
      if (!nodeId) {
        const rootNode = await tx.orgStructure.findFirst({
          where: { companyId: resolvedCompanyId, nodeType: 'ROOT' },
        });
        if (rootNode) nodeId = rootNode.id;
      }

      if (nodeId && initiatorId) {
        const { workflowId: resolvedWorkflowId } =
          await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
            levelsHash: levelsHash || null,
            module: 'SYSTEM_ACCESS',
            subModule: 'USER_ACC',
            companyId: resolvedCompanyId,
            nodeId,
            initiatorId,
            reqId: onb.id,
            reqTable: 'user_onboarding',
          });

        // Store the resolved workflowId in the onboarding record
        await tx.userOnboarding.update({
          where: { id: onb.id },
          data: { workflowId: resolvedWorkflowId },
        });
      }

      // Log INITIATE event with reqId reference
      if (initiatorId && email) {
        await tx.userHistory.create({
          data: {
            email,
            event: 'INITIATE',
            eventUserId: initiatorId,
            companyId: resolvedCompanyId,
            reqId: onb.id,
          },
        });
      }
      return onb;
    });
    res.status(201).json(onboarding);
  }


  /**
   * Fetches a single user onboarding request by its ID.
   */
  static async getUserOnboardingById(req: Request, res: Response) {
    const { id } = req.body;
    const onboarding = await prisma.userOnboarding.findUnique({
      where: { id },
    });
    res.json(onboarding);
  }

  /**
   * Handles the approval or rejection of a user onboarding request.
   * Approval Flow:
   * 1. Checks if the user exists; if not, creates a new production 'User' record with a default password.
   * 2. Creates a 'UserMapping' to link the user to the company with a reporting manager.
   * 3. Iterates through requested permissions and creates 'UserAccess' records for each Role + Node pair.
   * 4. Updates the request status to 'APPROVED' and logs the audit history.
   */
  /**
   * Handles the approval or rejection of a user onboarding request.
   * Level-wise Approval Flow:
   * 1. Checks the current pending level from WorkflowApprover.
   * 2. Verifies the approver is in the current level's approversList.
   * 3. Marks the level as APPROVED and checks if more levels remain.
   * 4. If all levels are approved → creates user, mapping, access records.
   * 5. If rejected at any level → marks all levels REJECTED.
   * 6. Logs level-wise events in UserHistory.
   */
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

      // ── Check WorkflowApprover for level-wise authorization ──────────────
      const currentLevel = await WorkflowApproverUtil.getCurrentPendingLevel(
        id,
        'user_onboarding',
      );

      // If workflow approver rows exist, enforce level-wise checks
      if (currentLevel) {
        const approversList = currentLevel.approversList as string[];
        if (
          Array.isArray(approversList) &&
          !approversList.includes(approverId)
        ) {
          throw new AppError(
            `Unauthorized: You are not an eligible approver for level ${currentLevel.level}`,
            403,
          );
        }
      } else {
        // Fallback to legacy eligibleApprovers check if no WorkflowApprover rows exist
        if (
          onboarding.eligibleApprovers &&
          onboarding.eligibleApprovers.length > 0 &&
          !onboarding.eligibleApprovers.includes(approverId)
        ) {
          throw new AppError('Unauthorized to process this request', 403);
        }
      }

      // --- Prevent Self-Approval ---
      const initiatorLog = await prisma.userHistory.findFirst({
        where: { reqId: id, event: 'INITIATE' },
      });
      if (initiatorLog && initiatorLog.eventUserId === approverId) {
        throw new AppError('Initiator cannot approve their own request', 403);
      }

      // --- Prevent Double Approval ---
      const alreadyApproved = await WorkflowApproverUtil.isAlreadyApproved(prisma as any, id, 'user_onboarding', approverId);
      if (alreadyApproved) {
        throw new AppError('You have already approved this request once', 403);
      }

      const data = onboarding.data as any;
      const { basicDetails, permissions } = data || {};
      const { name, email, phone, reportingManager, designation, employeeId } =
        basicDetails || {};

      // ── Approver Restriction and Signatory Check ──
      const statusStr = status.toString().toLowerCase();
      const isApproving = statusStr === 'approve' || statusStr === 'approved';
      const hasCorpAdminRole = Array.isArray(permissions) && permissions.some((p: any) => p.roleName === 'Corp Admin');

      const approverAccess = await prisma.userAccess.findFirst({
        where: {
          userId: approverId,
          companyId: onboarding.companyId,
          isGlobalAccess: true,
        },
      });
      const approverIsSignatory = !!approverAccess;

      if (hasCorpAdminRole && isApproving) {
        if (!approverIsSignatory) {
          throw new AppError(
            'Unauthorized: Only a signatory (Global Access user) can approve a request containing the Corp Admin role',
            403,
          );
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        // =========================
        const statusStr = status.toString().toLowerCase();
        // =========================
        // ✅ APPROVED FLOW
        // =========================
        if (statusStr === 'approve' || statusStr === 'approved') {
          // ── Level-wise approval: mark current level as APPROVED ──────────
          let allLevelsApproved = true;
          const approvedLevel = currentLevel?.level || null;


          if (currentLevel) {
            const nextLevel = await WorkflowApproverUtil.approveLevel(
              tx,
              id,
              'user_onboarding',
              currentLevel.level,
              approverId,
            );
            // If there's a next pending level, the request is NOT fully approved yet
            if (nextLevel) {
              allLevelsApproved = false;
            }
          }

          // Log level-wise APPROVED event in history
          if (email && approverId) {
            await tx.userHistory.create({
              data: {
                email,
                event: 'APPROVED',
                eventUserId: approverId,
                companyId: onboarding.companyId,
                reqId: id,
                level: approvedLevel,
                remarks: remark,
              },
            });
          }

          // If NOT all levels are approved, return early (partial approval)
          if (!allLevelsApproved) {
            return { status: 'PARTIAL_APPROVED', level: approvedLevel };
          }

          // ── All levels approved — proceed with production user creation ───
          const manager = await tx.user.findUnique({
            where: { id: approverId },
            include: {
              userMappings: {
                include: { company: true },
              },
            },
          });

          let reportingManagerId: string | null = null;
          if (reportingManager) {
            const reportingManagerCheck = await tx.user.findUnique({
              where: { email: reportingManager },
              include: {
                userMappings: {
                  include: { company: true },
                },
              },
            });

            if (!reportingManagerCheck) {
              throw new AppError('Reporting Manager not found', 404);
            }
            reportingManagerId = reportingManagerCheck.id;
          }

          if (!manager) throw new AppError('Manager not found', 404);

          const company = await tx.company.findUnique({
            where: { id: onboarding.companyId },
          });

          if (!company) throw new AppError('Company not found', 404);

          // 1. Production User Creation
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

          // 2. Map User to Company
          await tx.userMapping.create({
            data: {
              userId: user.id,
              companyId: company.id,
              reportingManager: reportingManagerId,
              status: 'ACTIVE',
              designation,
              employeeId,
            },
          });

          // 3. Setup Granular Access Permissions
          // Rule: isGlobalUser flag OR assigning Corp Admin role grants global access
          if (hasCorpAdminRole) {
            // Use nodePath from permissions if available, otherwise fallback to company ROOT node
            const globalPerm = Array.isArray(permissions) ? permissions.find((p: any) => p.roleName === 'Corp Admin' || p.isGlobalAccess) : null;
            const rootNode = await tx.orgStructure.findFirst({
              where: {
                companyId: company.id,
                ...(globalPerm?.nodePath
                  ? { nodePath: globalPerm.nodePath }
                  : { nodeType: 'ROOT' }),
              },
            });

            if (rootNode) {
              const existingAccess = await tx.userAccess.findFirst({
                where: {
                  userId: user.id,
                  roleCode: "CORP_ADMIN",
                  companyId: company.id,
                  nodeId: rootNode.id,
                },
              });

              if (existingAccess) {
                await tx.userAccess.update({
                  where: { id: existingAccess.id },
                  data: {
                    isGlobalAccess: true,
                    accessCategory: globalPerm?.accessCategory || 'ALL_CHILD',
                    accessType: 'PRIMARY',
                  },
                });
              } else {
                await tx.userAccess.create({
                  data: {
                    userId: user.id,
                    roleCode: "CORP_ADMIN",
                    nodeId: rootNode.id,
                    companyId: company.id,
                    isGlobalAccess: true,
                    accessCategory: globalPerm?.accessCategory || 'ALL_CHILD',
                    accessType: 'PRIMARY',
                  },
                });
              }
            }
          }
          if (Array.isArray(permissions)) {
            for (const perm of permissions) {
              const { accessType, roleName, nodePath, accessCategory } = perm;
              if (!roleName || roleName === 'Corp Admin') continue; // Skip Corp Admin as it's handled above
              const finalCategory = accessCategory;


              const role = await tx.roles.findUnique({
                where: { roleName },
              });

              const node = await tx.orgStructure.findUnique({
                where: { nodePath },
              });

              if (role && node) {
                // Use upsert to handle overlapping permissions (e.g. explicit child node vs propagated from parent)
                await tx.userAccess.upsert({
                  where: {
                    userId_roleCode_companyId_nodeId: {
                      userId: user.id,
                      roleCode: role.roleCode,
                      companyId: company.id,
                      nodeId: node.id,
                    },
                  },
                  update: {
                    accessType: accessType as any,
                    accessCategory: finalCategory as any,
                  },
                  create: {
                    userId: user.id,
                    roleCode: role.roleCode,
                    nodeId: node.id,
                    accessType: accessType as any,
                    accessCategory: finalCategory as any,
                    companyId: company.id,
                    isGlobalAccess: false,
                  },
                });

                // ─── A. UPWARD PROPAGATION: Existing parent-level users to this node ───
                const parentPaths = ltree.getAncestors(nodePath);
                if (parentPaths.length > 0) {
                  const parentNodes = await tx.orgStructure.findMany({
                    where: { companyId: company.id, nodePath: { in: parentPaths } },
                  });
                  const parentNodeIds = parentNodes.map((n) => n.id);
                  const directParentPath = ltree.getParent(nodePath);
                  const directParentId = parentNodes.find(
                    (n) => n.nodePath === directParentPath,
                  )?.id;

                  if (parentNodeIds.length > 0) {
                    const propagatingParentAccesses = await tx.userAccess.findMany({
                      where: {
                        companyId: company.id,
                        nodeId: { in: parentNodeIds },
                        isGlobalAccess: false,
                        OR: [
                          { accessCategory: 'ALL_CHILD' },
                          directParentId
                            ? { nodeId: directParentId, accessCategory: 'IMMEDIATE_CHILD' }
                            : undefined,
                        ].filter(Boolean) as any,
                      },
                    });

                    const parentToChildAccesses = propagatingParentAccesses.map(
                      (access) => ({
                        userId: access.userId,
                        roleCode: access.roleCode,
                        nodeId: node.id,
                        accessType: 'SECONDARY' as any,
                        accessCategory:
                          access.accessCategory === 'IMMEDIATE_CHILD'
                            ? ('NODE' as any)
                            : access.accessCategory,
                        companyId: company.id,
                        isGlobalAccess: false,
                      }),
                    );

                    if (parentToChildAccesses.length > 0) {
                      await tx.userAccess.createMany({
                        data: parentToChildAccesses,
                        skipDuplicates: true,
                      });
                    }
                  }
                }

                // ─── B. DOWNWARD PROPAGATION: New user to existing child nodes ───
                if (finalCategory === 'ALL_CHILD' || finalCategory === 'IMMEDIATE_CHILD') {
                  const children = await tx.orgStructure.findMany({
                    where: {
                      companyId: company.id,
                      ...(finalCategory === 'ALL_CHILD'
                        ? { nodePath: { startsWith: `${nodePath}.` } }
                        : { parent: { nodePath } }),
                    },
                  });

                  if (children.length > 0) {
                    const childAccesses = children.map((child) => ({
                      userId: user.id,
                      roleCode: role.roleCode,
                      nodeId: child.id,
                      accessType: 'SECONDARY' as any,
                      accessCategory:
                        finalCategory === 'IMMEDIATE_CHILD'
                          ? ('NODE' as any)
                          : ('ALL_CHILD' as any),
                      companyId: company.id,
                      isGlobalAccess: false,
                    }));

                    await tx.userAccess.createMany({
                      data: childAccesses,
                      skipDuplicates: true,
                    });
                  }
                }
              }
            }
          }

          // 4. Update request status to fully APPROVED
          await tx.userOnboarding.update({
            where: { id },
            data: {
              status: 'APPROVED',
              approvalRemark: remark,
            },
          });

          return { status: 'APPROVED' };
        }

        // =========================
        // ❌ REJECTED FLOW
        // =========================
        else if (statusStr === 'reject' || statusStr === 'rejected') {
          // Reject all remaining approval levels
          await WorkflowApproverUtil.rejectAllLevels(tx, id, 'user_onboarding');

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
                companyId: onboarding.companyId,
                reqId: id,
                level: currentLevel?.level || null,
                remarks: remark,
              },
            });
          }

          return { status: 'REJECTED' };
        }

        // =========================
        // ⚠️ INVALID STATUS
        // =========================
        else {
          throw new AppError('Invalid status', 400);
        }
      });

      let message = `User onboarding ${status}d successfully`;
      if (result && result.status === 'PARTIAL_APPROVED') {
        message = `User request approved at Level ${result.level}, pending remaining approval`;
      } else if (result && result.status === 'APPROVED') {
        message = 'User approved and onboarded';
      } else if (result && result.status === 'REJECTED') {
        message = 'User request rejected';
      }

      res.status(200).json({
        message,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetches the audit trail for a specific user within a company.
   */
  static async getUserHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, companyCode, companyId } = req.body;
      const resolvedCompanyId = await resolveCompanyId({ companyId, companyCode });

      const history = await prisma.userHistory.findMany({
        where: {
          email,
          companyId: resolvedCompanyId,
        },
        include: {
          user: {
            include: {
              userMappings: {
                where: { companyId: resolvedCompanyId },
              },
              userAccesses: {
                where: { companyId: resolvedCompanyId },
              },
            },
          },
          company: { select: { companyCode: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Filter out rejected request histories (user-specific pre-processing)
      const workflowApproversRaw = await prisma.workflowApprover.findMany({
        where: { reqId: { in: Array.from(new Set(history.map((h) => h.reqId).filter(Boolean))) as string[] } },
        orderBy: { level: 'asc' },
      });

      const rejectedReqIds = new Set<string>();
      const wfMapTemp = new Map<string, any[]>();
      workflowApproversRaw.forEach((wa) => {
        const existing = wfMapTemp.get(wa.reqId) || [];
        existing.push(wa);
        wfMapTemp.set(wa.reqId, existing);
      });
      for (const [reqId, levels] of wfMapTemp.entries()) {
        if (levels.some((l: any) => l.status === 'REJECTED')) {
          rejectedReqIds.add(reqId);
        }
      }
      history.forEach((h) => {
        if (h.reqId && h.event === 'REJECTED') {
          rejectedReqIds.add(h.reqId);
        }
      });

      const activeHistory = history.filter(h => !h.reqId || !rejectedReqIds.has(h.reqId));

      // Use shared history formatter for the common pipeline
      const resultList = await formatHistoryPipeline(activeHistory, {
        getReqId: (h) => h.reqId,
        getEvent: (h) => h.event,
        getEventUserId: (h) => h.eventUserId,
        companyId: resolvedCompanyId,
        subModule: 'USER_ACC',
        getUserAccesses: (h) => (h as any).user?.userAccesses || [],
        getUser: (h) => (h as any).user,
        buildPendingEntry: (h, approvers, pendingLevel) => ({
          email: (h as any).email,
          companyCode: (h as any).company.companyCode,
          event: `L${pendingLevel} Pending Approval`,
          createdAt: null,
          eligibleapprovers: approvers,
        }),
        buildHistoryEntry: (h, user, _workflowStatus) => ({
          email: (h as any).email,
          companyCode: (h as any).company.companyCode,
          event: (h as any).event,
          level: (h as any).level,
          createdAt: (h as any).createdAt,
          remarks: (h as any).remarks,
          user,
        }),
      });

      res.status(200).json({
        message: 'User history fetched successfully!',
        code: 200,
        data: resultList,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Utility to check if a user already has a pending onboarding request by email.
   * Prevents multiple submissions for the same email.
   */
  static async getPendingUsers(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { email } = req.body;
      const user = await prisma.userOnboarding.findFirst({
        where: {
          status: 'PENDING',
          data: {
            path: ['basicDetails', 'email'],
            equals: email,
          },
        },
      });
      res.status(200).json(user);
    } catch (error) {
      next(error);
    }
  }
  /**
   * Fetches organizational nodes for a user based on global status and sub-category.
   */
  static async fetchCompanyNodes(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId, companyId, subCategory } = req.body;

      const userMapping = await prisma.userMapping.findUnique({
        where: {
          userId_companyId: {
            userId,
            companyId,
          },
        },
        select: { designation: true },
      });

      const designation = userMapping?.designation || '';

      const globalAccess = await prisma.userAccess.findFirst({
        where: {
          userId,
          companyId,
          isGlobalAccess: true,
        },
      });

      if (globalAccess) {
        const nodes = await prisma.orgStructure.findMany({
          where: { companyId },
          select: {
            nodeName: true,
            nodePath: true,
            nodeType: true,
            workflows: {
              where: { subModule: subCategory },
              select: {
                levelsHash: true,
                name: true,
                alias: true,
              },
            },
          },
        });
        return res.status(200).json({
          nodes,
          access: {
            designation,
            isGlobalUser: !!globalAccess,
          },
        });
      } else {
        if (!subCategory) {
          return res.status(200).json([]);
        }

        const userAccesses = await prisma.userAccess.findMany({
          where: {
            userId,
            companyId,
            role: {
              subCategory: subCategory,
            },
          },
          include: {
            orgStructure: {
              select: {
                nodeName: true,
                nodePath: true,
                nodeType: true,
                workflows: {
                  where: { subModule: subCategory },
                  select: {
                    levelsHash: true,
                    name: true,
                    alias: true,
                  },
                },
              },
            },
          },
        });

        const nodes = userAccesses
          .map((ua) => ua.orgStructure)
          .filter(
            (node, index, self) =>
              index === self.findIndex((t) => t.nodePath === node.nodePath),
          );

        return res.status(200).json({
          nodes,
          access: {
            designation,
            isGlobalUser: !!globalAccess,
          },
        });
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * Counts unique users assigned to a specific node path for a company, grouped by subCategory.
   */
  static async fetchUsersByNodePathCount(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { nodePath, companyId } = req.body;

      if (!nodePath) {
        throw new AppError('Node path is required', 400);
      }

      // Fetch all user accesses for this node path, including their roles
      const userAccesses = await prisma.userAccess.findMany({
        where: {
          orgStructure: {
            nodePath: nodePath,
          },
          ...(companyId ? { companyId } : {}),
        },
        include: {
          role: true,
        },
      });

      // Group unique user IDs by subCategory and permissionLevel
      const countsMap: Record<
        string,
        { MANAGER: Set<string>; USER: Set<string>; VIEWER: Set<string> }
      > = {};

      userAccesses.forEach((ua) => {
        const subCat = ua.role?.subCategory;
        const pLevel = ua.role?.permissionLevel?.toUpperCase();

        if (
          subCat &&
          pLevel &&
          (pLevel === 'MANAGER' || pLevel === 'USER' || pLevel === 'VIEWER')
        ) {
          if (!countsMap[subCat]) {
            countsMap[subCat] = {
              MANAGER: new Set(),
              USER: new Set(),
              VIEWER: new Set(),
            };
          }
          countsMap[subCat][pLevel as 'MANAGER' | 'USER' | 'VIEWER'].add(
            ua.userId,
          );
        }
      });

      // Transform the map into the desired response format and filter out zero-count sub-categories
      const finalData: Record<string, any> = {};

      Object.entries(countsMap).forEach(([subCat, levels]) => {
        const managerCount = levels.MANAGER.size;
        const userCount = levels.USER.size;
        const viewerCount = levels.VIEWER.size;

        // Only include sub-categories that have at least one user in any level
        if (managerCount > 0 || userCount > 0 || viewerCount > 0) {
          finalData[subCat] = [
            {
              label: 'Checker',
              count: managerCount,
              permissionlevel: 'MANAGER',
            },
            {
              label: 'Maker',
              count: userCount,
              permissionlevel: 'USER',
            },
            {
              label: 'Viewer',
              count: viewerCount,
              permissionlevel: 'VIEWER',
            },
          ];
        }
      });

      res.status(200).json({
        message: 'User counts fetched successfully!',
        code: 200,
        data: finalData,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verifies if a user has global access permissions within a company.
   */
  static async checkGlobalUserStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { userId, companyId } = req.body;

      const globalAccess = await prisma.userAccess.findFirst({
        where: {
          userId,
          companyId,
          isGlobalAccess: true,
        },
        include: {
          orgStructure: true,
        },
      });

      res.status(200).json({ isGlobal: !!globalAccess, globalAccess });

    } catch (error) {
      next(error);
    }
  }
}
