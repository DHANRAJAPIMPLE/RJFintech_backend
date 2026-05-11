import { prisma } from '../lib/prisma';
import { AppError } from '../middlewares/error.middleware';
import type { PrismaClient } from '@prisma/client';

/**
 * Transactional Prisma client type used when running inside $transaction blocks.
 * Omit the transaction methods themselves to avoid nested transactions.
 */
type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Parameters required for resolving workflow approvers.
 *
 * @property workflowId   - Optional explicit workflow ID. If omitted, the system
 *                          fetches the default workflow for the given module + subModule.
 * @property module       - The module category (e.g. 'SYSTEM_ACCESS').
 * @property subModule    - The sub-module category (e.g. 'USER_ACC', 'ORG_STR', 'WORK_FLOW').
 * @property companyId    - UUID of the company context.
 * @property nodeId       - UUID of the org node the request is scoped to.
 * @property initiatorId  - UUID of the user who initiated the request (excluded from approvers).
 * @property reqId        - UUID of the request record (UserOnboarding, OrgStructureReq, WorkflowReq).
 * @property reqTable     - Table name identifier ('user_onboarding' | 'org_structure_req' | 'workflow_req').
 */
interface ResolveApproversParams {
  levelsHash?: string | null;
  module: string;
  subModule: string;
  companyId: string;
  nodeId: string;
  initiatorId: string;
  reqId: string;
  reqTable: string;
}

/**
 * WorkflowApproverUtil — Central utility for resolving and creating
 * WorkflowApprover rows when any approval request is initiated.
 *
 * Flow:
 * 1. Resolve the workflow (explicit ID or default for section).
 * 2. Fetch the workflow's levels (WorkflowLevel).
 * 3. For each level, resolve approver user IDs based on ApproverType:
 *    - REPORTING_MANAGER: The initiator's reporting manager chain.
 *    - NODE_APPROVER: Users with approve-capable roles on the SAME node.
 *    - HIERARCHY_APPROVER: Users with approve-capable roles on PARENT nodes.
 * 4. Add global-access users to every level.
 * 5. Exclude the initiator from all levels.
 * 6. Validate that each level has enough unique approvers (≥ mandatoryCount derived from AND/OR logic).
 * 7. Create WorkflowApprover rows in the database.
 */
export class WorkflowApproverUtil {
  /**
   * Main entry point — call inside a Prisma $transaction.
   * Creates WorkflowApprover rows for the given request.
   *
   * @param tx     - Prisma transaction client
   * @param params - Approver resolution parameters
   * @returns      - Array of created WorkflowApprover records
   */
  static async resolveAndCreateApprovers(
    tx: TxClient,
    params: ResolveApproversParams,
  ) {
    const {
      levelsHash,
      module,
      subModule,
      companyId,
      nodeId,
      initiatorId,
      reqId,
      reqTable,
    } = params;

    // ── Step 1: Resolve the workflow ─────────────────────────────────────────
    const workflow = await this.resolveWorkflow(tx, {
      levelsHash,
      module,
      subModule,
      companyId,
    });

    if (!workflow) {
      throw new AppError(
        `No workflow found for module '${module}', subModule '${subModule}'. Please create a workflow first.`,
        400,
      );
    }

    // ── Step 2: Fetch workflow levels (ordered by level number) ──────────────
    const levels = await (tx as any).workflowLevel.findMany({
      where: { workflowId: workflow.id },
      orderBy: { level: 'asc' },
    });

    if (!levels || levels.length === 0) {
      throw new AppError(
        `Workflow '${workflow.name}' has no approval levels configured.`,
        400,
      );
    }

    // ── Step 3: Fetch contextual data for approver resolution ────────────────
    // 3a. Get the initiator's org node path for RM and hierarchy lookups
    const requestNode = await (tx as any).orgStructure.findUnique({
      where: { id: nodeId },
    });

    if (!requestNode) {
      throw new AppError(
        'Organization node not found for approver resolution',
        400,
      );
    }

    // 3b. Fetch global access users for this company (always eligible as approvers)
    const globalAccessUsers = await this.getGlobalAccessUserIds(
      tx,
      companyId,
      subModule,
    );

    // 3c. Fetch the initiator's reporting manager chain
    const rmChain = await this.getReportingManagerChain(
      tx,
      initiatorId,
      companyId,
    );

    // ── Step 4: Resolve approvers for each level ─────────────────────────────
    const approverRows: any[] = [];
    // Track approvers already assigned to a level — each user can only approve at ONE level
    const usedApprovers = new Set<string>();

    for (const level of levels) {
      const approverSet = new Set<string>();

      // Resolve approver1 (always present)
      const approver1Users = await this.resolveByApproverType(
        tx,
        level.approver1,
        companyId,
        requestNode,
        rmChain,
        subModule,
      );
      approver1Users.forEach((id: string) => approverSet.add(id));

      // Resolve approver2 (optional)
      if (level.approver2) {
        const approver2Users = await this.resolveByApproverType(
          tx,
          level.approver2,
          companyId,
          requestNode,
          rmChain,
          subModule,
        );
        approver2Users.forEach((id: string) => approverSet.add(id));
      }

      // Always add global access users as potential approvers
      globalAccessUsers.forEach((id: string) => approverSet.add(id));

      // ── Step 5: Exclude the initiator ──────────────────────────────────────
      approverSet.delete(initiatorId);

      // ── Step 5b: Exclude approvers already assigned to a previous level ────
      // Each user can only be an eligible approver at ONE level per request
      for (const usedId of usedApprovers) {
        approverSet.delete(usedId);
      }

      // ── Step 6: Determine mandatoryCount from AND/OR logic ─────────────────
      // AND = both approver types must approve → count how many distinct approver types we have
      // OR  = only one approver needed
      let mandatoryCount = 1;
      if (level.approverType === 'AND' && level.approver2) {
        mandatoryCount = 2;
      }

      // Validate minimum approvers
      if (approverSet.size < mandatoryCount) {
        throw new AppError(
          `Insufficient approvers at level ${level.level}. ` +
            `Need at least ${mandatoryCount} unique approver(s), found ${approverSet.size}. ` +
            `The initiator cannot be an approver in their own workflow.`,
          400,
        );
      }

      // Mark these approvers as used so they won't appear in subsequent levels
      for (const id of approverSet) {
        usedApprovers.add(id);
      }

      approverRows.push({
        workflowId: workflow.id,
        reqId,
        reqTable,
        level: level.level,
        approversList: Array.from(approverSet),
        mandatoryCount,
        status: 'PENDING',
      });
    }

    // ── Step 7: Bulk create WorkflowApprover rows ────────────────────────────

    const created = [];
    for (const row of approverRows) {
      const record = await (tx as any).workflowApprover.create({ data: row });
      created.push(record);
    }

    return {
      workflowId: workflow.id,
      approvers: created,
    };
  }

  /**
   * Resolves the correct Workflow to use.
   * Priority:
   * 1. If workflowId is provided, use that exact workflow.
   * 2. Otherwise, fetch the default workflow for this module + subModule in the company.
   *    Default workflows are identified by name pattern '{SUBMODULE}_WORKFLOW_DEFAULT'.
   */
  private static async resolveWorkflow(
    tx: TxClient,
    opts: {
      levelsHash?: string | null;
      module: string;
      subModule: string;
      companyId: string;
    },
  ) {
    // Explicit levelsHash provided — use it to find the unique workflow structure
    if (opts.levelsHash) {
      const workflow = await (tx as any).workflow.findFirst({
        where: { levelsHash: opts.levelsHash, companyId: opts.companyId },
      });
      if (!workflow) {
        throw new AppError(
          `Workflow with hash '${opts.levelsHash}' not found for this company`,
          404,
        );
      }
      return workflow;
    }

    // No explicit workflow — find the default for this section
    // Default workflows are named like 'USER_ACC_WORKFLOW_DEFAULT'
    const defaultWorkflow = await (tx as any).workflow.findFirst({
      where: {
        companyId: opts.companyId,
        module: opts.module,
        subModule: opts.subModule,
        name: { contains: 'DEFAULT' },
      },
      orderBy: { createdAt: 'desc' },
    });

    return defaultWorkflow;
  }

  /**
   * Resolves user IDs based on the ApproverType enum.
   *
   * @param type       - GLOBAL_APPROVER | REPORTING_MANAGER | NODE_APPROVER | HIERARCHY_APPROVER
   * @param companyId  - Company context
   * @param node       - The org node the request is scoped to
   * @param rmChain    - Pre-fetched reporting manager chain for the initiator
   */
  private static async resolveByApproverType(
    tx: TxClient,
    type: string,
    companyId: string,
    node: any,
    rmChain: string[],
    subModule: string,
  ): Promise<string[]> {
    switch (type) {
      case 'GLOBAL_APPROVER':
        // All users with global access for this company — used by default workflows
        return this.getGlobalAccessUserIds(tx, companyId, subModule);

      case 'REPORTING_MANAGER':
        // Return the RM chain — these are the user IDs up the reporting hierarchy
        return rmChain;

      case 'NODE_APPROVER':
        // Users who have approve permission on the SAME node
        return this.getNodeApprovers(tx, companyId, node.id, subModule);

      case 'HIERARCHY_APPROVER':
        // Users who have approve permission on any PARENT node in the hierarchy
        return this.getHierarchyApprovers(
          tx,
          companyId,
          node.nodePath,
          subModule,
        );

      default:
        return [];
    }
  }

  /**
   * Walks up the reporting manager chain for a user within a company.
   * Returns an array of manager user IDs (excludes the user themselves).
   * Stops when no further manager is found or a cycle is detected.
   */
  private static async getReportingManagerChain(
    tx: TxClient,
    userId: string,
    companyId: string,
  ): Promise<string[]> {
    const chain: string[] = [];
    const visited = new Set<string>();
    let currentUserId = userId;

    // Walk up to 10 levels to prevent infinite loops
    for (let i = 0; i < 10; i++) {
      const mapping = await (tx as any).userMapping.findFirst({
        where: {
          userId: currentUserId,
          companyId,
          status: 'ACTIVE',
        },
        select: { reportingManager: true },
      });

      if (!mapping?.reportingManager) break;
      if (visited.has(mapping.reportingManager)) break; // Cycle detection

      visited.add(mapping.reportingManager);
      chain.push(mapping.reportingManager);
      currentUserId = mapping.reportingManager;
    }

    return chain;
  }

  /**
   * Fetches user IDs who have an approve-capable role on the SAME node.
   * These are users whose UserAccess points to the exact nodeId and whose
   * role has `approve = true`.
   */
  private static async getNodeApprovers(
    tx: TxClient,
    companyId: string,
    nodeId: string,
    subModule: string,
  ): Promise<string[]> {
    const accesses = await (tx as any).userAccess.findMany({
      where: {
        companyId,
        nodeId,
        isGlobalAccess: false,
        role: {
          approve: true,
          OR: [{ subCategory: subModule }],
        },
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: { userId: true },
    });

    return [...new Set(accesses.map((a: any) => a.userId))];
  }

  /**
   * Fetches user IDs who have an approve-capable role on any PARENT node
   * in the ltree path hierarchy.
   *
   * For example, if node path is 'COMPANY.DIVISION.DEPT', this checks:
   * - 'COMPANY'
   * - 'COMPANY.DIVISION'
   * (Excludes the node itself — that's covered by NODE_APPROVER.)
   */
  private static async getHierarchyApprovers(
    tx: TxClient,
    companyId: string,
    nodePath: string,
    subModule: string,
  ): Promise<string[]> {
    // Build parent paths from the ltree path
    const parts = nodePath.split('.');
    const parentPaths: string[] = [];
    let currentPath = '';

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath += (i === 0 ? '' : '.') + parts[i];
      parentPaths.push(currentPath);
    }

    if (parentPaths.length === 0) return [];

    // Find parent node IDs
    const parentNodes = await (tx as any).orgStructure.findMany({
      where: {
        companyId,
        nodePath: { in: parentPaths },
      },
      select: { id: true },
    });

    const parentNodeIds = parentNodes.map((n: any) => n.id);
    if (parentNodeIds.length === 0) return [];

    // Find users with approve roles on these parent nodes
    const accesses = await (tx as any).userAccess.findMany({
      where: {
        companyId,
        nodeId: { in: parentNodeIds },
        isGlobalAccess: false,
        role: {
          approve: true,
          OR: [{ subCategory: subModule }],
        },
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: { userId: true },
    });

    return [...new Set(accesses.map((a: any) => a.userId))];
  }

  /**
   * Fetches all user IDs with Global Access for a company.
   * Global-access users are eligible as approvers across all levels,
   * BUT only if they have `approve: true` on their linked role
   * (or have no role assigned — roleCode is null).
   * These users must also have an ACTIVE mapping to the company.
   */
  private static async getGlobalAccessUserIds(
    tx: TxClient,
    companyId: string,
    subModule: string,
  ): Promise<string[]> {
    // Fetch all global-access records with their linked role
    const accesses = await (tx as any).userAccess.findMany({
      where: {
        companyId,
        isGlobalAccess: true,
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: {
        userId: true,
        roleCode: true,
        role: {
          select: {
            approve: true,
            subCategory: true,
          },
        },
      },
    });

    // Include the user only if:
    //   (a) they are global (isGlobalAccess: true)
    //   AND
    //   (b) (they have no role assigned OR their role has approve: true)
    //   AND
    //   (their role subCategory matches subModule)
    const eligibleUserIds = accesses
      .filter((a: any) => {
        // If no role, assume super admin access
        if (!a.roleCode) return true;

        const hasApprove = a.role?.approve === true;
        const subCategoryMatches = a.role?.subCategory === subModule;

        return hasApprove && subCategoryMatches;
      })
      .map((a: any) => a.userId);

    return [...new Set(eligibleUserIds)];
  }

  /**
   * Retrieves all eligible approver IDs for a specific request across all pending levels.
   * Used by the action endpoints to verify if a user is authorized to approve.
   *
   * @param reqId    - The request record ID
   * @param reqTable - Table identifier ('user_onboarding' | 'org_structure_req' | 'workflow_req')
   * @returns        - Flat array of unique approver user IDs across all pending levels
   */
  static async getEligibleApproversForRequest(
    reqId: string,
    reqTable: string,
  ): Promise<string[]> {
    const approverRows = await prisma.workflowApprover.findMany({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });

    const allApprovers = new Set<string>();
    for (const row of approverRows) {
      const list = row.approversList as string[];
      if (Array.isArray(list)) {
        list.forEach((id) => allApprovers.add(id));
      }
    }

    return Array.from(allApprovers);
  }

  /**
   * Gets the current pending level for a request.
   * Returns the lowest-numbered level that is still PENDING.
   * Returns null if all levels are approved.
   */
  static async getCurrentPendingLevel(reqId: string, reqTable: string) {
    const pendingLevel = await prisma.workflowApprover.findFirst({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });

    return pendingLevel;
  }

  /**
   * Marks a specific approval level as APPROVED.
   * Returns the next pending level if it exists, or null if all levels are now approved.
   *
   * @param reqId    - Request ID
   * @param reqTable - Table identifier
   * @param level    - The level number being approved
   * @param tx       - Transaction client
   * @returns        - The next pending level row, or null if all done
   */
  static async approveLevel(
    tx: TxClient,
    reqId: string,
    reqTable: string,
    level: number,
  ) {
    // Mark current level as APPROVED
    await (tx as any).workflowApprover.updateMany({
      where: { reqId, reqTable, level },
      data: { status: 'APPROVED' },
    });

    // Check if there's a next pending level
    const nextLevel = await (tx as any).workflowApprover.findFirst({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });

    return nextLevel || null;
  }

  /**
   * Marks ALL levels for a request as REJECTED.
   *
   * @param tx       - Transaction client
   * @param reqId    - Request ID
   * @param reqTable - Table identifier
   */
  static async rejectAllLevels(tx: TxClient, reqId: string, reqTable: string) {
    await (tx as any).workflowApprover.updateMany({
      where: { reqId, reqTable },
      data: { status: 'REJECTED' },
    });
  }
}
