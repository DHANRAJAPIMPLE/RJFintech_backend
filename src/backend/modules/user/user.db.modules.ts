import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';
import { AppError } from '../../middlewares/error.middleware';
import { WorkflowApproverUtil } from '../../utils/workflow-approver.util';

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
      const { companyCode, companyId } = req.body;
      let resolvedCompanyId = companyId;

      // Resolve companyId for filtering production users
      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('Company code or companyId is required', 400);
        }
        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

      // 1. Fetch production users with their full organizational context
      const users = await prisma.user.findMany({
        where: {
          userMappings: {
            some: {
              companyId: resolvedCompanyId,
            },
          },
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
      const pendingOnboardings = await prisma.userOnboarding.findMany({
        where: {
          status: 'PENDING',
          companyId: resolvedCompanyId,
        },
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

      const enhancedPending = pendingOnboardings.map((onb: any) => {
        const dataBlob = onb.data as any;
        const email = dataBlob?.basicDetails?.email;
        const managerEmail = dataBlob?.basicDetails?.reportingManager;

        const init = historyMap.get(`${email}_INITIATE`);
        const approve = historyMap.get(`${email}_APPROVE`);
        const managerInfo = managerMap.get(managerEmail);

        return {
          ...onb,
          initiator: init?.user || null,
          approver: approve?.user || null,
          reportingManagerInfo: managerInfo
            ? {
                name: managerInfo.name,
                email: managerInfo.email,
              }
            : null,
        };
      });

      // 4. Format all users into the requested structure
      const formatDate = (date: Date) => {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}-${month}-${year}`;
      };

      const activeUsers: any[] = [];
      const inactiveUsers: any[] = [];

      users.forEach((u) => {
        const mapping = u.userMappings[0];
        const formattedUser = {
          basicDetails: {
            name: u.name,
            email: u.email,
            phone: u.phone,
            createdAt: formatDate(u.createdAt),
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
            createdAt: formatDate(onb.createdAt),
            designation: basic.designation || null,
            employeeId: basic.employeeId || null,
            reportingManagerName: onb.reportingManagerInfo?.name || null,
            reportingManagerEmail: onb.reportingManagerInfo?.email || null,
            initiatorName: onb.initiator?.name || null,
            initiatorEmail: onb.initiator?.email || null,
            initiatedDate: onb.createdAt,
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
    const { initiatorId, companyCode, companyId, groupCode, workflowId, ...onboardingData } = req.body;
    let resolvedCompanyId = companyId;

    if (!resolvedCompanyId) {
      if (!companyCode) {
        throw new AppError('companyCode or companyId is required', 400);
      }
      const company = await prisma.company.findUnique({
        where: { companyCode },
      });
      if (!company) {
        throw new AppError('Company not found', 404);
      }
      resolvedCompanyId = company.id;
    }

    const email = onboardingData.data?.basicDetails?.email;

    // Filter out the initiator from eligible approvers — initiator cannot approve their own request
    if (initiatorId && onboardingData.eligibleApprovers) {
      onboardingData.eligibleApprovers = onboardingData.eligibleApprovers.filter(
        (id: string) => id !== initiatorId,
      );
    }

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
          where: { nodePath: permissions[0].nodePath, companyId: resolvedCompanyId },
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
        const { workflowId: resolvedWorkflowId } = await WorkflowApproverUtil.resolveAndCreateApprovers(tx, {
          workflowId: workflowId || null,
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
        id, 'user_onboarding',
      );

      // If workflow approver rows exist, enforce level-wise checks
      if (currentLevel) {
        const approversList = currentLevel.approversList as string[];
        if (Array.isArray(approversList) && !approversList.includes(approverId)) {
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

      const data = onboarding.data as any;
      const { basicDetails, permissions } = data || {};
      const { name, email, phone, reportingManager, designation, employeeId } =
        basicDetails || {};

      const result = await prisma.$transaction(async (tx) => {
        // =========================
        // ✅ APPROVED FLOW
        // =========================
        if (status === 'approve') {
          // ── Level-wise approval: mark current level as APPROVED ──────────
          let allLevelsApproved = true;
          const approvedLevel = currentLevel?.level || null;

          if (currentLevel) {
            const nextLevel = await WorkflowApproverUtil.approveLevel(
              tx, id, 'user_onboarding', currentLevel.level,
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

          const reportingManagerCheck = await tx.user.findUnique({
            where: { email: reportingManager },
            include: {
              userMappings: {
                include: { company: true },
              },
            },
          });

          if (!reportingManagerCheck)
            throw new AppError('Reporting Manager not found', 404);
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
              reportingManager: reportingManagerCheck.id,
              status: 'ACTIVE',
              designation,
              employeeId,
            },
          });

          // 3. Setup Granular Access Permissions
          if (Array.isArray(permissions)) {
            for (const perm of permissions) {
              const { accessType, roleName, nodePath, accessCategory } = perm;
              const finalCategory = accessCategory;

              const role = await tx.roles.findUnique({
                where: { roleName },
              });

              const node = await tx.orgStructure.findUnique({
                where: { nodePath },
              });

              if (role && node) {
                // Check if this specific access already exists to enforce uniqueness
                const existingAccess = await tx.userAccess.findUnique({
                  where: {
                    userId_roleCode_companyId_nodeId: {
                      userId: user.id,
                      roleCode: role.roleCode,
                      companyId: company.id,
                      nodeId: node.id,
                    },
                  },
                });

                if (existingAccess) {
                  throw new AppError(
                    `User already has role '${role.roleName}' assigned for this node`,
                    400,
                  );
                }

                await tx.userAccess.create({
                  data: {
                    userId: user.id,
                    roleCode: role.roleCode,
                    nodeId: node.id,
                    accessType,
                    accessCategory: finalCategory,
                    companyId: company.id,
                    isGlobalAccess: false,
                  },
                });
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
        else if (status === 'reject') {
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
        message = `User request approved at Level ${result.level}, pending next level approval`;
      } else if (result && result.status === 'APPROVED') {
        message = 'User approved and onboarded';
      } else if (result && result.status === 'REJECTED') {
        message = 'User request rejected';
      }

      res.status(200).json({
        message,
        data: result
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
      let resolvedCompanyId = companyId;

      if (!resolvedCompanyId) {
        if (!companyCode) {
          throw new AppError('companyCode or companyId is required', 400);
        }
        const company = await prisma.company.findUnique({
          where: { companyCode },
        });
        if (!company) throw new AppError('Company not found', 404);
        resolvedCompanyId = company.id;
      }

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

      // 1. Collect all unique request IDs to fetch their workflow approval status
      const reqIds = Array.from(new Set(history.map((h) => h.reqId).filter(Boolean))) as string[];
      
      const workflowApprovers = await prisma.workflowApprover.findMany({
        where: { reqId: { in: reqIds } },
        orderBy: { level: 'asc' },
      });

      // 2. Resolve approver details (names/emails)
      const allApproverIds = new Set<string>();
      workflowApprovers.forEach(wa => {
        if (Array.isArray(wa.approversList)) {
          wa.approversList.forEach((id: any) => allApproverIds.add(String(id)));
        }
      });
      const approverDetails = await prisma.user.findMany({
        where: { id: { in: Array.from(allApproverIds) } },
        select: { id: true, name: true, email: true }
      });
      const approverMap = new Map(approverDetails.map(u => [u.id, u]));

      // Group workflow levels by reqId
      const workflowMap = new Map<string, any[]>();
      workflowApprovers.forEach((wa) => {
        const existing = workflowMap.get(wa.reqId) || [];
        existing.push(wa);
        workflowMap.set(wa.reqId, existing);
      });

      const resultList: any[] = [];
      const handledPendingReqs = new Set<string>();

      // 3. Inject "Pending Approval" entries for any active requests
      history.forEach((h) => {
        if (h.reqId && !handledPendingReqs.has(h.reqId)) {
          const levels = workflowMap.get(h.reqId);
          if (levels) {
            const currentPending = levels.find(l => l.status === 'PENDING');
            if (currentPending) {
              const approvers = (currentPending.approversList as string[])
                .map(id => {
                  const u = approverMap.get(id);
                  return u ? { name: u.name, email: u.email } : null;
                })
                .filter(Boolean);

              resultList.push({
                email: h.email,
                companyCode: h.company.companyCode,
                event: `L${currentPending.level} Pending Approval`,
                createdAt: null,
                eligibleapprovers: approvers
              });
            }
          }
          handledPendingReqs.add(h.reqId);
        }
      });

      // 4. Add actual history entries
      const formattedHistory = history.map((h) => {
        const initiatorMapping = h.user?.userMappings?.[0];
        const initiatorAccesses = h.user?.userAccesses || [];
        
        const isSaasAdmin = initiatorAccesses.some(a => a.roleCode === 'SAAS_ADMIN');
        const isTeams = isSaasAdmin || (!h.user && h.eventUserId === null);

        const levels = h.reqId ? workflowMap.get(h.reqId) : null;
        let workflowStatus = null;
        
        if (levels && levels.length > 0) {
          const allApproved = levels.every((l: any) => l.status === 'APPROVED');
          const isRejected = levels.some((l: any) => l.status === 'REJECTED');
          const currentPending = levels.find((l: any) => l.status === 'PENDING');

          workflowStatus = {
            overallStatus: isRejected ? 'REJECTED' : allApproved ? 'APPROVED' : 'PENDING',
            currentLevel: currentPending ? currentPending.level : (allApproved ? levels.length : null),
            totalLevels: levels.length,
            levels: levels
              .filter((l: any) => l.level <= (currentPending?.level || levels.length))
              .map((l: any) => ({
                level: l.level,
                status: l.status
              }))
          };
        }

        return {
          email: h.email,
          companyCode: h.company.companyCode,
          event: h.event,
          level: h.level, 
          createdAt: h.createdAt,
          user: isTeams
            ? { name: 'Teams', email: 'Teams' }
            : { name: h.user?.name || 'System', email: h.user?.email || 'system@internal' },
        };
      });

      resultList.push(...formattedHistory);

      res.status(200).json({
        message: 'User history fetched successfully!',
        code: 200,
        data: resultList
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
              id: true,
              name: true,
              alias: true,
            },
          },
        },
      });
      return res.status(200).json(nodes);
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
                  id: true,
                  name: true,
                  alias: true,
                },
              },
            },
          },
        },
      });
  console.log(userAccesses);
      const nodes = userAccesses
        .map((ua) => ua.orgStructure)
        .filter(
          (node, index, self) =>
            index === self.findIndex((t) => t.nodePath === node.nodePath),
        );
    console.log(nodes);
      return res.status(200).json(nodes);
    }
  } catch (error) {
    next(error);
  }
}
}


