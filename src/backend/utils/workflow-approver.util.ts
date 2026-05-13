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
   * Main entry point for resolving and persisting the approval chain for a new request.
   * This method is designed to be called within a Prisma transaction to ensure atomic
   * creation of the request and its associated approver rows.
   *
   * Why we use it:
   * - It transforms the abstract workflow definition (levels, rules) into concrete
   *   assignments (specific user IDs) based on the current organization state.
   * - It enforces business rules like one-person-per-level and initiator exclusion.
   *
   * @param tx     - Prisma transaction client (TxClient) to maintain atomicity.
   * @param params - Configuration including levelsHash, module context, and initiator details.
   * @returns      - An object containing the resolved workflowId and the list of created approver records.
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
    // We first determine which workflow applies. It could be an explicit structure
    // (identified by levelsHash) or a default workflow assigned to the company module.
    let workflow = await this.resolveWorkflow(tx, {
      levelsHash,
      module,
      subModule,
      companyId,
    });

    const defaultWorkflowNames = [
      'ORG_STR_WORKFLOW_DEFAULT',
      'USER_ACC_WORKFLOW_DEFAULT',
      'WORK_FLOW_WORKFLOW_DEFAULT',
    ];

    // Check if the workflow is a system-restricted "DEFAULT" workflow.
    // This affects how strictly we resolve approvers (Restricted = Signatories only).
    const isRestrictedWorkflow =
      workflow &&
      (defaultWorkflowNames.includes(workflow.name) ||
        workflow.name.includes('DEFAULT'));

    // ── Step 2: Fetch workflow levels (ordered by level number) ──────────────
    // The levels define the sequence of approvals (Level 1, Level 2, etc.).
    // We order by level 'asc' to process the chain chronologically.
    let levels = workflow
      ? await (tx as any).workflowLevel.findMany({
          where: { workflowId: workflow.id },
          orderBy: { level: 'asc' },
        })
      : [];

    // Fallback logic: If no specific workflow is found, we apply a hardcoded
    // "1M_1C_1" (1 Maker, 1 Checker, 1 Level) pattern to avoid blocking the request.
    if (!workflow || levels.length === 0) {
      if (!workflow) {
        workflow = { id: 'SYSTEM_DEFAULT', name: '1M_1C_1_WORKFLOW' };
      }
      levels = [
        {
          level: 1,
          approver1: 'DEFAULT', // Triggers exhaustive search in resolveByApproverType
          approverType: 'OR',
        },
      ];
    }

    // 3a. Get the initiator's org node path. This is critical for:
    // - NODE_APPROVER: Finding managers in the same department/team.
    // - HIERARCHY_APPROVER: Identifying managers higher up the org tree (Ancestors).
    const requestNode = await (tx as any).orgStructure.findUnique({
      where: { id: nodeId },
    });

    if (!requestNode) {
      throw new AppError(
        'Organization node not found for approver resolution',
        400,
      );
    }

    // 3b. Fetch global access users (Signatories/Admins).
    // These users are "Wildcard" approvers who can approve any request within their scope.
    const globalAccessUsers = await this.getGlobalAccessUserIds(
      tx,
      companyId,
      subModule,
      isRestrictedWorkflow,
    );

    // 3c. Fetch the initiator's Reporting Manager (RM) chain.
    // This resolves the immediate and secondary managers for 'REPORTING_MANAGER' types.
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

      // Resolve primary approver type (e.g., NODE_APPROVER).
      // We perform a specific database lookup based on the strategy defined in the level.
      const approver1Users = await this.resolveByApproverType(
        tx,
        level.approver1,
        companyId,
        requestNode,
        rmChain,
        subModule,
        isRestrictedWorkflow,
      );
      console.log(`[WorkflowApprover] Level ${level.level}: Found ${approver1Users.length} primary approvers`);
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
          isRestrictedWorkflow,
        );
        console.log(`[WorkflowApprover] Level ${level.level}: Found ${approver2Users.length} secondary approvers`);
        approver2Users.forEach((id: string) => approverSet.add(id));
      }

      // Always add global access users to every level.
      // Signatories and SaaS Admins act as ultimate fallback approvers for any level.
      console.log(`[WorkflowApprover] Level ${level.level}: Adding ${globalAccessUsers.length} global access users`);
      globalAccessUsers.forEach((id: string) => approverSet.add(id));

      // ── Enforce Maker-Checker Separation & Uniqueness ─────────────────────
      // 1. One user per level: A user who is an approver for Level 1 cannot be
      //    an approver for Level 2. This prevents a single user from self-approving
      //    the entire chain.
      usedApprovers.forEach((id) => approverSet.delete(id));
      // 2. Maker cannot be Checker: The initiator (Maker) can never approve
      //    their own request (Checker).
      approverSet.delete(initiatorId);

      // ── Step 6: Determine mandatoryCount from AND/OR logic ─────────────────
      // If the level type is 'AND', we require two unique approvals (approver1 + approver2).
      // If 'OR', any one approval from the pool is sufficient.
      let mandatoryCount = 1;
      if (level.approverType === 'AND' && level.approver2) {
        mandatoryCount = 2;
      }

      // Logic: The initiator cannot be an approver in their own workflow.
      const poolSize = approverSet.size;
      const isInitiatorInPool = false;
      const availableUniqueApprovers = poolSize;

      console.log(`[WorkflowApprover] Level ${level.level}: Final Pool Size=${poolSize}, InitiatorExcluded=${isInitiatorInPool}, Available=${availableUniqueApprovers}`);

      // Final validation: Ensure the pool of unique eligible approvers meets
      // the minimum mandatory count required for this level.
      if (availableUniqueApprovers < mandatoryCount) {
        throw new AppError(
          `Insufficient approvers at level ${level.level}. Need at least ${mandatoryCount} unique approver(s), found ${availableUniqueApprovers}. The initiator cannot be an approver in their own workflow.`,
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
   * Resolves the correct Workflow to use for a specific company context.
   *
   * Logic:
   * 1. If 'levelsHash' is provided (customized workflow via UI), we fetch that
   *    specific version to ensure structure integrity.
   * 2. Otherwise, we fetch the 'DEFAULT' workflow assigned to that company module.
   *    Default workflows act as global templates (e.g. "USER_ACC_WORKFLOW_DEFAULT").
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
    // Priority 1: Fetch by explicit structure hash
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

    // Priority 2: Fetch the default template for the module/subModule
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
   * Router for approver resolution strategies.
   * It maps the abstract ApproverType enum to specific database lookup functions.
   *
   * Strategies:
   * - GLOBAL_APPROVER: Uses company-wide signatories.
   * - REPORTING_MANAGER: Uses the initiator's manager chain.
   * - NODE_APPROVER: Uses managers assigned to the SAME org node.
   * - HIERARCHY_APPROVER: Uses managers assigned to PARENT org nodes.
   */
  private static async resolveByApproverType(
    tx: TxClient,
    type: string,
    companyId: string,
    node: any,
    rmChain: string[],
    subModule: string,
    isRestricted: boolean = false,
  ): Promise<string[]> {
    if (isRestricted) {
      return this.getAllEligibleApproverIds(
        tx,
        companyId,
        node,
        rmChain,
        subModule,
      );
    }

    switch (type) {
      case 'GLOBAL_APPROVER':
        // All users with global access for this company — used by default workflows
        return this.getGlobalAccessUserIds(tx, companyId, subModule);

      case 'REPORTING_MANAGER':
        // Return the RM chain — these are the user IDs up the reporting hierarchy
        return this.filterUserIdsBySubModuleApproval(
          tx,
          companyId,
          rmChain,
          subModule,
        );

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
        // Fallback: 1M_1C_1 pattern — collect ALL eligible approvers across
        // global, node, hierarchy, and all subModule access types
        return this.getAllEligibleApproverIds(
          tx,
          companyId,
          node,
          rmChain,
          subModule,
        );
    }
  }

  /**
   * Resolves the reporting lineage for a user.
   * It recursively fetches managers up the chain using the 'reportingManager' field
   * in UserMapping. This is vital for hierarchical approvals.
   *
   * Logic:
   * - Recursive walk up the 'user_mapping' table.
   * - Includes cycle detection to prevent infinite loops (Set<visited>).
   * - Limited to 10 levels to prevent deep recursion performance issues.
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

    return Array.from(new Set<string>(accesses.map((a: any) => a.userId)));
  }

  /**
   * Resolves managers from the parent levels of the organizational hierarchy.
   * Uses ltree paths to identify ancestor nodes.
   *
   * Example: For a request at 'NEXORA.HR.RECRUITMENT', it checks 'NEXORA' and 'NEXORA.HR'.
   *
   * Logic:
   * - Splits the nodePath into parts to reconstruct parent paths.
   * - Fetches users with 'approve: true' on these parent nodes.
   * - Enforces Propagation Rules:
   *   - ALL_CHILD: Access propagates to all descendants.
   *   - IMMEDIATE_CHILD: Access propagates ONLY to direct children.
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
      select: { id: true, nodePath: true },
    });

    const parentNodeIds = parentNodes.map((n: any) => n.id);
    if (parentNodeIds.length === 0) return [];

    // Find users with approve roles on these parent nodes, respecting propagation rules
    const accesses = await (tx as any).userAccess.findMany({
      where: {
        companyId,
        nodeId: { in: parentNodeIds },
        isGlobalAccess: false,
        role: {
          approve: true,
          subCategory: subModule,
        },
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: {
        userId: true,
        nodeId: true,
        accessCategory: true,
      },
    });

    // Filter by propagation rules:
    // 1. ALL_CHILD: Valid for any node in the path below the parent.
    // 2. IMMEDIATE_CHILD: Valid ONLY if the parent is the direct parent of the request node.
    const directParentPath = parentPaths[parentPaths.length - 1];
    const directParentNode = parentNodes.find((n: any) => n.nodePath === directParentPath);
    const directParentId = directParentNode?.id;

    const filteredUserIds = accesses
      .filter((acc: any) => {
        if (acc.accessCategory === 'ALL_CHILD') return true;
        if (acc.accessCategory === 'IMMEDIATE_CHILD' && acc.nodeId === directParentId) return true;
        return false;
      })
      .map((acc: any) => acc.userId);

    return Array.from(new Set<string>(filteredUserIds));
  }

  /**
   * Collects ALL eligible approver IDs across every access dimension:
   * - Global access users
   * - Node-level approvers (same node)
   * - Hierarchy approvers (parent nodes)
   * - Reporting manager chain
   * - Users with approve access on ANY subModule (USER_ACC, ORG_STR, WORK_FLOW)
   *
   * This is the fallback used when approver type is null/default (1M_1C_1 pattern).
   */
  private static async getAllEligibleApproverIds(
    tx: TxClient,
    companyId: string,
    node: any,
    rmChain: string[],
    subModule: string,
  ): Promise<string[]> {
    const allIds = new Set<string>();

    // 1. Global access users
    const globalIds = await this.getGlobalAccessUserIds(tx, companyId, subModule);
    globalIds.forEach((id) => allIds.add(id));

    // 2. Node approvers (same node)
    const nodeIds = await this.getNodeApprovers(tx, companyId, node.id, subModule);
    nodeIds.forEach((id) => allIds.add(id));

    // 3. Hierarchy approvers (parent nodes)
    if (node.nodePath) {
      const hierarchyIds = await this.getHierarchyApprovers(tx, companyId, node.nodePath, subModule);
      hierarchyIds.forEach((id) => allIds.add(id));
    }

    // 4. Reporting manager chain
    const managerIds = await this.filterUserIdsBySubModuleApproval(
      tx,
      companyId,
      rmChain,
      subModule,
    );
    managerIds.forEach((id) => allIds.add(id));

    // 5. Cross-subModule approvers — users who have approve access on
    //    USER_ACC, ORG_STR, or WORK_FLOW for this company (not just the current subModule)
    return Array.from(allIds);
  }

  /**
   * Fetches user IDs that have approve-capable roles across ALL subModules
   * (USER_ACC, ORG_STR, WORK_FLOW) for the given company and node.
   * Includes hierarchy-based access (ALL_CHILD on parent nodes).
   */
  private static async filterUserIdsBySubModuleApproval(
    tx: TxClient,
    companyId: string,
    userIds: string[],
    subModule: string,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];

    // 2. Fetch users with approve access on any of the target subModules
    const accesses = await (tx as any).userAccess.findMany({
      where: {
        companyId,
        userId: { in: userIds },
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
        OR: [
          { roleCode: null, isGlobalAccess: true },
          { role: { category: 'SAAS_ADMIN', approve: true } },
          { role: { approve: true, subCategory: subModule } },
        ],
      },
      select: { userId: true },
    });

    return Array.from(new Set<string>(accesses.map((a: any) => a.userId)));
  }

  /**
   * Resolves Global Access users (SaaS Admins, Signatories).
   * Global access users have visibility across the entire company.
   *
   * Logic:
   * - Filters by `isGlobalAccess: true` in the 'user_access' table.
   * - Validates that the user's role has `approve: true` for the target subModule.
   * - SaaS Admins are always included as they have super-admin privileges.
   * - Role-less global users (Signatories) are always included as ultimate approvers.
   */
  static async getGlobalAccessUserIds(
    tx: TxClient,
    companyId: string,
    subModule: string,
    isRestricted: boolean = false,
  ): Promise<string[]> {
    if (isRestricted) {
      // In restricted (Default) workflows, we only allow pure Signatories (role-less global users).
      return this.getSignatoryIds(tx, companyId);
    }
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
        isGlobalAccess: true,
        role: {
          select: {
            approve: true,
            category: true,
            subCategory: true,
          },
        },
      },
    });

    // Inclusion Logic:
    // 1. Role-less Signatory (Pure Global Access)
    // 2. SaaS Admin (Super Admin context)
    // 3. Department Admin (Role matches subModule + Approve permission)
    const eligibleUserIds = accesses
      .filter((a: any) => {
        if (!a.roleCode) return true;

        const hasApprove = a.role?.approve === true;
        const subCategoryMatches = a.role?.subCategory === subModule;
        const isSaasAdmin = a.role?.category === 'SAAS_ADMIN' || a.role?.subCategory === 'SAAS_ADMIN';

        return hasApprove && (subCategoryMatches || isSaasAdmin);
      })
      .map((a: any) => a.userId);

    return Array.from(new Set<string>(eligibleUserIds));
  }

  /**
   * Fetches only the Signatories for a company.
   * Signatories are defined as users with isGlobalAccess: true AND roleCode: null.
   */
  private static async getSignatoryIds(
    tx: TxClient,
    companyId: string,
  ): Promise<string[]> {
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
      select: { userId: true },
    });

    return Array.from(new Set<string>(accesses.map((a: any) => a.userId)));
  }

  /**
   * Retrieves all eligible approver IDs for a specific request across all pending levels.
   * This is used by the authorization middleware and controllers to verify if a user
   * has the right to take action on a request.
   *
   * Logic:
   * - Queries the 'workflow_approver' table for all 'PENDING' rows tied to the reqId.
   * - Collects and deduplicates all user IDs from the 'approversList' JSON column.
   *
   * @param reqId    - The request record ID (UserOnboarding, etc.).
   * @param reqTable - Table identifier.
   * @returns        - Flat array of unique approver user IDs.
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
   * Identifies the current active approval level for a request.
   * In a multi-level workflow, approvals must happen sequentially (Level 1 then Level 2).
   *
   * Logic:
   * - Fetches the first 'PENDING' level ordered by level number ascending.
   * - If Level 1 is APPROVED, it will return Level 2.
   */
  static async getCurrentPendingLevel(reqId: string, reqTable: string) {
    const pendingLevel = await prisma.workflowApprover.findFirst({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });

    return pendingLevel;
  }

  /**
   * Transitions a specific workflow level to the 'APPROVED' state.
   * After marking a level as approved, it checks if there are any subsequent levels.
   *
   * Logic:
   * 1. Updates the target level row to 'APPROVED'.
   * 2. Searches for the next level in the sequence that is still 'PENDING'.
   * 3. Returns the next level metadata to the caller (so they can decide if the
   *    entire request is finished or just partially approved).
   *
   * @param tx       - Transaction client.
   * @param reqId    - Request ID.
   * @param reqTable - Table identifier.
   * @param level    - The level number being processed.
   * @returns        - The next pending level row, or null if this was the final level.
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
   * Transitions ALL levels for a request to the 'REJECTED' state.
   * Rejection is immediate and terminal — if one level rejects, the entire
   * workflow stops.
   */
  static async rejectAllLevels(tx: TxClient, reqId: string, reqTable: string) {
    await (tx as any).workflowApprover.updateMany({
      where: { reqId, reqTable },
      data: { status: 'REJECTED' },
    });
  }

  /**
   * Enriches a basic approvers list with global company approvers.
   * Used primarily for history and audit logs to show everyone who *could*
   * have approved the request at that time.
   *
   * Logic:
   * - Combines the stored IDs with active global users and subModule admins.
   * - Ensures the initiator is always excluded from the final list.
   */
  static async getEnrichedApproverIds(
    companyId: string,
    storedApproverIds: string[],
    initiatorId: string | null,
    subModule: string,
  ): Promise<string[]> {
    // Fetch all users who are eligible as approvers:
    // 1. Global access users
    // 2. Users with approve-capable roles for this SPECIFIC subModule
    const [globalUserIds, subModuleAccesses] = await Promise.all([
      this.getGlobalAccessUserIds(prisma as any, companyId, subModule),
      prisma.userAccess.findMany({
        where: {
          companyId,
          role: {
            approve: true,
            subCategory: subModule,
          },
          user: {
            userMappings: {
              some: { companyId, status: 'ACTIVE' },
            },
          },
        },
        select: { userId: true },
      }),
    ]);

    const enrichedSet = new Set(storedApproverIds);
    globalUserIds.forEach((id) => enrichedSet.add(id));
    subModuleAccesses.forEach((a) => enrichedSet.add(a.userId));

    // Maker can't be checker
    if (initiatorId) {
      const beforeCount = enrichedSet.size;
      const wasDeleted = enrichedSet.delete(initiatorId);
      console.log(`[WorkflowApprover] Enriching for SubModule=${subModule}: InitiatorId=${initiatorId}, FoundInPool=${wasDeleted}, Before=${beforeCount}, After=${enrichedSet.size}`);
    } else {
      console.log(`[WorkflowApprover] Enriching for SubModule=${subModule}: WARNING - InitiatorId is NULL, skipping exclusion`);
    }

    return Array.from(enrichedSet);
  }

  /**
   * Checks if a user has already approved a previous level for the given request.
   * Used to enforce 'unique individuals per level' even when approver lists overlap.
   */
  static async isAlreadyApproved(
    tx: TxClient,
    reqId: string,
    reqTable: string,
    approverId: string,
  ): Promise<boolean> {
    const historyMap: Record<string, { table: string; field: string }> = {
      user_onboarding: { table: 'userHistory', field: 'reqId' },
      org_structure_req: { table: 'orgHistory', field: 'orgReqId' },
      workflow_req: { table: 'workflowReqHistory', field: 'workflowReqId' },
    };

    const config = historyMap[reqTable];
    if (!config) return false;

    const previous = await (tx as any)[config.table].findFirst({
      where: {
        [config.field]: reqId,
        event: 'APPROVED',
        eventUserId: approverId,
      },
    });

    return !!previous;
  }
}
