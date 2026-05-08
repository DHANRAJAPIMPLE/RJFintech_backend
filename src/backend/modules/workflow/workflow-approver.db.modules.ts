import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../../shared/middlewares/error.middleware';

/**
 * WorkflowApproverValidator:
 * Validates workflow approver requirements and resolves eligible approver user IDs.
 *
 * When a workflowId is provided during initiation (org/user/workflow), this module:
 * 1. Fetches the workflow and its approval levels.
 * 2. For each level, resolves approver user IDs based on the approver type:
 *    - HIERARCHY_APPROVER: Fetches all users in parent nodes using ltree (@>) operator.
 *    - REPORTING_MANAGER: Fetches the reporting manager chain for the initiating user.
 *    - NODE_APPROVER: Fetches users assigned to the same node (the node sent in the request).
 * 3. Validates that the workflow has enough unique approvers for each level.
 * 4. Returns the de-duplicated eligible approvers list.
 */
export class WorkflowApproverValidator {
  /**
   * Validates and resolves eligible approvers for a given workflow.
   *
   * Request body:
   * - workflowId: UUID of the active workflow
   * - initiatorId: UUID of the user initiating the request
   * - nodePath: The node path context (the node the request is about)
   * - companyId: UUID of the company
   *
   * Response:
   * - success: boolean
   * - eligibleApprovers: string[] (unique user IDs)
   * - levelDetails: detailed breakdown per level
   */
  static async validateWorkflowApprovers(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { workflowId, initiatorId, nodePath, companyId } = req.body;

      if (!workflowId || !companyId) {
        throw new AppError('workflowId and companyId are required', 400);
      }

      // 1. Fetch the workflow with its approval levels
      const workflow = await prisma.workflow.findUnique({
        where: { id: workflowId },
        include: {
          levels: {
            orderBy: { level: 'asc' },
          },
          orgStructure: true,
        },
      });

      if (!workflow) {
        throw new AppError('Workflow not found', 404);
      }

      if (workflow.companyId !== companyId) {
        throw new AppError('Workflow does not belong to this company', 400);
      }

      // 2. Resolve the contextual node (the node from the request or from the workflow)
      const resolvedNodePath = nodePath || workflow.orgStructure?.nodePath;

      if (!resolvedNodePath) {
        throw new AppError('Node path is required for approver resolution', 400);
      }

      // Fetch the org node for context
      const contextNode = await prisma.orgStructure.findFirst({
        where: {
          nodePath: resolvedNodePath,
          companyId,
        },
      });

      if (!contextNode) {
        throw new AppError(`Node path '${resolvedNodePath}' not found`, 400);
      }

      // 3. Resolve approvers for each level
      const allApproverIds: string[] = [];
      const levelDetails: any[] = [];

      for (const level of workflow.levels) {
        const approverTypes = [level.approver1];
        if (level.approver2) {
          approverTypes.push(level.approver2);
        }

        const levelApproverSets: string[][] = [];

        for (const approverType of approverTypes) {
          let resolvedIds: string[] = [];

          switch (approverType) {
            case 'HIERARCHY_APPROVER':
              resolvedIds = await WorkflowApproverValidator.getHierarchyApprovers(
                companyId,
                resolvedNodePath,
              );
              break;

            case 'REPORTING_MANAGER':
              resolvedIds = await WorkflowApproverValidator.getReportingManagerApprovers(
                initiatorId,
                companyId,
              );
              break;

            case 'NODE_APPROVER':
              resolvedIds = await WorkflowApproverValidator.getNodeApprovers(
                companyId,
                contextNode.id,
              );
              break;

            default:
              throw new AppError(`Unknown approver type: ${approverType}`, 400);
          }

          levelApproverSets.push(resolvedIds);
        }

        // 4. Validate based on approval type (AND/OR)
        let levelApprovers: string[] = [];

        if (level.approverType === 'AND') {
          // AND: Both approver sets must have users; combine all unique users
          for (let i = 0; i < levelApproverSets.length; i++) {
            if (levelApproverSets[i].length === 0) {
              throw new AppError(
                `Workflow level ${level.level}: No users found for approver type '${approverTypes[i]}'. ` +
                `The AND condition requires approvers from all configured types.`,
                400,
              );
            }
          }
          // Combine all approvers from all sets
          levelApprovers = Array.from(
            new Set(levelApproverSets.flat()),
          );
        } else {
          // OR: At least one of the approver sets must have users
          levelApprovers = Array.from(
            new Set(levelApproverSets.flat()),
          );
          if (levelApprovers.length === 0) {
            throw new AppError(
              `Workflow level ${level.level}: No approvers found for any configured type. ` +
              `At least one approver is required.`,
              400,
            );
          }
        }

        // 5. Validate minimum approver count for AND conditions with 2 approvers
        if (level.approver2 && level.approverType === 'AND') {
          // Need at least 2 unique users when AND with 2 approver types
          const uniqueApprovers = new Set(levelApprovers);
          if (uniqueApprovers.size < 2) {
            throw new AppError(
              `Workflow level ${level.level}: AND condition requires at least 2 unique approvers, ` +
              `but only ${uniqueApprovers.size} unique user(s) found.`,
              400,
            );
          }
        }

        levelDetails.push({
          level: level.level,
          approverType: level.approverType,
          approver1Type: level.approver1,
          approver2Type: level.approver2,
          resolvedApprovers: levelApprovers,
          count: levelApprovers.length,
        });

        allApproverIds.push(...levelApprovers);
      }

      // 6. Validate total unique approvers across all levels
      // Filter out the initiator — initiator cannot approve their own request
      const uniqueApprovers = Array.from(new Set(allApproverIds)).filter(
        (id) => id !== initiatorId,
      );

      // Calculate the minimum required unique approvers based on workflow config
      let minRequiredApprovers = 0;
      for (const level of workflow.levels) {
        if (level.approver2 && level.approverType === 'AND') {
          minRequiredApprovers += 2;
        } else {
          minRequiredApprovers += 1;
        }
      }

      if (uniqueApprovers.length < minRequiredApprovers) {
        throw new AppError(
          `Workflow requires at least ${minRequiredApprovers} unique approver(s) across all levels, ` +
          `but only ${uniqueApprovers.length} unique user(s) found in the database (excluding initiator).`,
          400,
        );
      }

      res.status(200).json({
        success: true,
        eligibleApprovers: uniqueApprovers,
        levelDetails,
        totalUniqueApprovers: uniqueApprovers.length,
        minRequiredApprovers,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * HIERARCHY_APPROVER:
   * Fetches all user IDs from PARENT nodes of the given node path using ltree @> operator.
   * This traverses UP the org tree to find users assigned to ancestor nodes.
   */
  private static async getHierarchyApprovers(
    companyId: string,
    nodePath: string,
  ): Promise<string[]> {
    // Use raw query with ltree @> operator to find parent nodes
    // o.node_path @> target means o.node_path is an ancestor of (or equal to) target
    const parentNodeUsers: any[] = await prisma.$queryRaw`
      SELECT DISTINCT ua.user_id
      FROM org_structure o
      JOIN user_access ua ON ua.node_id = o.id AND ua.company_id = o.company_id
      JOIN user_mapping um ON um.user_id = ua.user_id AND um.company_id = o.company_id AND um.status = 'ACTIVE'
      WHERE o.company_id = ${companyId}::uuid
        AND o.node_path::ltree @> ${nodePath}::ltree
    `;

    return parentNodeUsers.map((u: any) => u.user_id);
  }

  /**
   * REPORTING_MANAGER:
   * Fetches the reporting manager IDs for the initiating user within the company.
   * Traverses the reporting chain upward to collect all manager user IDs.
   */
  private static async getReportingManagerApprovers(
    initiatorId: string,
    companyId: string,
  ): Promise<string[]> {
    const managerIds: string[] = [];
    let currentUserId = initiatorId;
    const visited = new Set<string>();

    // Walk up the reporting manager chain (max 10 levels to prevent infinite loops)
    for (let i = 0; i < 10; i++) {
      const mapping = await prisma.userMapping.findFirst({
        where: {
          userId: currentUserId,
          companyId,
          status: 'ACTIVE',
        },
        select: {
          reportingManager: true,
        },
      });

      if (!mapping?.reportingManager) break;

      const managerId = mapping.reportingManager;

      // Prevent circular references
      if (visited.has(managerId)) break;
      visited.add(managerId);

      managerIds.push(managerId);
      currentUserId = managerId;
    }

    return managerIds;
  }

  /**
   * NODE_APPROVER:
   * Fetches all user IDs that are assigned to the SAME node (the node in the request).
   * Only includes active users with access to that specific node.
   */
  private static async getNodeApprovers(
    companyId: string,
    nodeId: string,
  ): Promise<string[]> {
    const nodeUsers = await prisma.userAccess.findMany({
      where: {
        companyId,
        nodeId,
        user: {
          userMappings: {
            some: {
              companyId,
              status: 'ACTIVE',
            },
          },
        },
      },
      select: {
        userId: true,
      },
    });

    return Array.from(new Set(nodeUsers.map((u) => u.userId)));
  }
}
