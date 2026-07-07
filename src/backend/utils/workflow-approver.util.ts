import { prisma } from '../lib/prisma';
import { AppError } from '../middlewares/error.middleware';
import type { PrismaClient } from '@prisma/client';

/**
 * Transaction scoped Prisma client. The workflow engine is normally called from
 * request-creation and approval transactions, so it must not open nested
 * transactions of its own.
 */
type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Inputs needed to convert a workflow definition into concrete approver rows.
 * levelsHash is optional by design: null means "use the module default".
 */
interface ResolveApproversParams {
  levelsHash?: string | null;
  module: string;
  subModule: string;
  companyId: string;
  nodeId: string;
  initiatorId: string;
  excludedUserIds?: string[];
  reqId: string;
  reqTable: string;
}

interface RequestNode {
  id: string;
  nodePath: string;
}

interface WorkflowLike {
  id: string;
  name: string;
}

interface WorkflowLevelLike {
  level: number;
  approver1: string;
  approver2?: string | null;
  approverType: string;
}

interface ResolveApproversResult {
  workflowId: string;
  approvers: any[];
  eligibleApprovers: string[];
  currentLevelApprovers: string[];
  autoApprove: boolean;
}

interface ApproverRowDraft {
  workflowId: string;
  reqId: string;
  reqTable: string;
  level: number;
  approversList: string[];
  mandatoryCount: number;
  status: 'PENDING';
}

interface ApprovalPathRow {
  level: number;
  approversList: string[];
  mandatoryCount: number;
}

interface HistoryConfig {
  table: string;
  field: string;
}

interface RequestConfig {
  table: string;
}

/**
 * WorkflowApproverUtil is the single source of truth for workflow approver
 * resolution. Controllers should create the business request first, then call
 * this utility in the same transaction so request rows and approver rows are
 * committed together.
 */
export class WorkflowApproverUtil {
  /**
   * Resolve the active/custom/default workflow, build each level's eligible
   * approver list, persist workflow_approver rows, and sync the request-level
   * eligibleApprovers array used by legacy screens and quick filters.
   */
  static async resolveAndCreateApprovers(
    tx: TxClient,
    params: ResolveApproversParams,
  ): Promise<ResolveApproversResult> {
    const {
      levelsHash,
      module,
      subModule,
      companyId,
      nodeId,
      initiatorId,
      excludedUserIds = [],
      reqId,
      reqTable,
    } = params;
    const excludedApproverIds = new Set([initiatorId, ...excludedUserIds]);

    const requestNode = await (tx as any).orgStructure.findUnique({
      where: { id: nodeId },
      select: { id: true, nodePath: true },
    });

    if (!requestNode) {
      throw new AppError(
        'Organization node not found for approver resolution',
        400,
      );
    }

    const workflow = await this.resolveWorkflow(tx, {
      levelsHash,
      module,
      subModule,
      companyId,
    });

    const levels = await this.resolveWorkflowLevels(tx, {
      workflow,
      levelsHash,
      subModule,
    });
    const approvalLevels = levels.filter(
      (level) => !this.isNoApproverLevel(level),
    );

    const rmChain = await this.getReportingManagerChain(
      tx,
      initiatorId,
      companyId,
    );

    // Global access users are added to every level because they are company
    // wide approvers. They are still excluded if they initiated the request,
    // and history-based eligibility prevents them from approving twice.
    const globalAccessUsers = await this.getGlobalAccessUserIds(
      tx,
      companyId,
      subModule,
    );

    const approverRows: ApproverRowDraft[] = [];
    const requestEligibleApprovers = new Set<string>();

    for (const level of approvalLevels) {
      const approverSet = new Set<string>();

      const primaryApprovers = await this.resolveByApproverType(tx, {
        type: level.approver1,
        companyId,
        node: requestNode,
        rmChain,
        subModule,
      });
      primaryApprovers.forEach((id) => approverSet.add(id));

      // AND levels may need two independent approval sources. OR levels still
      // accept approver2 as an additional candidate pool when it is configured.
      if (level.approver2) {
        const secondaryApprovers = await this.resolveByApproverType(tx, {
          type: level.approver2,
          companyId,
          node: requestNode,
          rmChain,
          subModule,
        });
        secondaryApprovers.forEach((id) => approverSet.add(id));
      }

      globalAccessUsers.forEach((id) => approverSet.add(id));

      // Maker-checker and target-user separation start at persisted approver
      // resolution so excluded users never appear as eligible approvers.
      excludedApproverIds.forEach((id) => approverSet.delete(id));

      const mandatoryCount = this.getMandatoryCount(level);
      const approversList = Array.from(approverSet);

      if (approversList.length < mandatoryCount) {
        throw new AppError(
          `Insufficient approvers at level ${level.level}. Need ${mandatoryCount} unique approver(s), found ${approversList.length}. The initiator cannot approve their own request.`,
          400,
        );
      }

      approversList.forEach((id) => requestEligibleApprovers.add(id));

      approverRows.push({
        workflowId: workflow.id,
        reqId,
        reqTable,
        level: level.level,
        approversList,
        mandatoryCount,
        status: 'PENDING',
      });
    }

    // A user is allowed to appear in more than one level, but may approve only
    // once for the same request. This feasibility check prevents workflows that
    // would become impossible after valid approvals start consuming users.
    this.assertApprovalPathIsFeasible(
      approverRows,
      'Workflow approver setup is not feasible.',
      initiatorId,
    );

    const created = [];
    for (const row of approverRows) {
      const record = await (tx as any).workflowApprover.create({ data: row });
      created.push(record);
    }

    await this.syncRequestEligibleApprovers(
      tx,
      reqTable,
      reqId,
      Array.from(requestEligibleApprovers),
    );

    const currentLevelApprovers = approverRows
      .sort((left, right) => left.level - right.level)[0]?.approversList || [];

    return {
      workflowId: workflow.id,
      approvers: created,
      eligibleApprovers: Array.from(requestEligibleApprovers),
      currentLevelApprovers: this.unique(currentLevelApprovers),
      autoApprove: approverRows.length === 0,
    };
  }

  /**
   * Workflow selection:
   * - levelsHash present: use the approved/custom workflow for that hash.
   * - levelsHash null: use the latest DEFAULT workflow for the module section.
   * - no default row found: use a virtual one-level default so initiation is
   *   not blocked by missing seed data.
   */
  private static async resolveWorkflow(
    tx: TxClient,
    opts: {
      levelsHash?: string | null;
      module: string;
      subModule: string;
      companyId: string;
    },
  ): Promise<WorkflowLike> {
    if (opts.levelsHash) {
      const workflow = await (tx as any).workflow.findFirst({
        where: {
          levelsHash: opts.levelsHash,
          companyId: opts.companyId,
          module: opts.module,
          subModule: opts.subModule,
          status: 'ACTIVE',
        },
        select: { id: true, name: true },
      });

      if (!workflow) {
        throw new AppError(
          `Workflow with hash '${opts.levelsHash}' not found for this company`,
          404,
        );
      }

      return workflow;
    }

    const defaultWorkflow = await (tx as any).workflow.findFirst({
      where: {
        companyId: opts.companyId,
        module: opts.module,
        subModule: opts.subModule,
        name: { contains: 'DEFAULT' },
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true },
    });

    return (
      defaultWorkflow ?? {
        id: `SYSTEM_DEFAULT_${opts.subModule}`,
        name: `${opts.subModule}_WORKFLOW_DEFAULT`,
      }
    );
  }

  /**
   * Loads workflow levels from the resolved workflow. Default workflows always
   * fall back to one NODE_APPROVER level when their level rows are missing,
   * matching the seeded "1 maker, 1 checker, 1 level" behavior.
   */
  private static async resolveWorkflowLevels(
    tx: TxClient,
    opts: {
      workflow: WorkflowLike;
      levelsHash?: string | null;
      subModule: string;
    },
  ): Promise<WorkflowLevelLike[]> {
    const levels = await (tx as any).workflowLevel.findMany({
      where: { workflowId: opts.workflow.id },
      orderBy: { level: 'asc' },
      select: {
        level: true,
        approver1: true,
        approver2: true,
        approverType: true,
      },
    });

    if (levels.length > 0) {
      return levels;
    }

    if (opts.levelsHash) {
      throw new AppError(
        `Workflow '${opts.workflow.name}' has no approval levels configured`,
        400,
      );
    }

    return [
      {
        level: 1,
        approver1: 'NODE_APPROVER',
        approver2: null,
        approverType: 'OR',
      },
    ];
  }

  /**
   * Routes a configured approver type to the concrete resolver. Each resolver
   * returns user IDs only; de-duplication and initiator exclusion happen at the
   * level assembly step.
   */
  private static async resolveByApproverType(
    tx: TxClient,
    opts: {
      type: string;
      companyId: string;
      node: RequestNode;
      rmChain: string[];
      subModule: string;
    },
  ): Promise<string[]> {
    switch (opts.type) {
      case 'GLOBAL_APPROVER':
        return this.getGlobalAccessUserIds(tx, opts.companyId, opts.subModule);

      case 'REPORTING_MANAGER':
        return this.filterUserIdsBySubModuleApproval(
          tx,
          opts.companyId,
          opts.rmChain,
          opts.subModule,
        );

      case 'NODE_APPROVER':
        return this.getNodeApprovers(
          tx,
          opts.companyId,
          opts.node.id,
          opts.subModule,
        );

      case 'HIERARCHY_APPROVER':
        return this.getHierarchyApprovers(
          tx,
          opts.companyId,
          opts.node.nodePath,
          opts.subModule,
        );

      case 'NO_APPROVER':
        return [];

      default:
        return this.getAllEligibleApproverIds(
          tx,
          opts.companyId,
          opts.node,
          opts.rmChain,
          opts.subModule,
        );
    }
  }

  /**
   * Reporting-manager approval starts with the initiator's UserMapping row and
   * walks upward through reportingManager. The visited set protects production
   * traffic from accidental cycles in manager data.
   */
  private static async getReportingManagerChain(
    tx: TxClient,
    userId: string,
    companyId: string,
  ): Promise<string[]> {
    const chain: string[] = [];
    const visited = new Set<string>([userId]);
    let currentUserId = userId;

    for (let depth = 0; depth < 10; depth++) {
      const mapping = await (tx as any).userMapping.findFirst({
        where: {
          userId: currentUserId,
          companyId,
          status: 'ACTIVE',
        },
        select: { reportingManager: true },
      });

      const managerId = mapping?.reportingManager;
      if (!managerId || visited.has(managerId)) break;

      visited.add(managerId);
      chain.push(managerId);
      currentUserId = managerId;
    }

    return chain;
  }

  /**
   * NODE_APPROVER means the approver has an approve-enabled role for the same
   * node ID as the request. This keeps default workflows node-scoped instead of
   * company-wide.
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
          subCategory: subModule,
        },
        user: {
          userMappings: {
            some: { companyId, status: 'ACTIVE' },
          },
        },
      },
      select: { userId: true },
    });

    return this.unique(accesses.map((access: any) => access.userId));
  }

  /**
   * HIERARCHY_APPROVER means users with approve-enabled roles on ancestor nodes
   * of the request node. We use nodePath to find those ancestors because the
   * workflow rule is about the org hierarchy, not just direct parent IDs.
   */
  private static async getHierarchyApprovers(
    tx: TxClient,
    companyId: string,
    nodePath: string,
    subModule: string,
  ): Promise<string[]> {
    const ancestorPaths = this.getAncestorPaths(nodePath);
    if (ancestorPaths.length === 0) return [];

    const ancestorNodes = await (tx as any).orgStructure.findMany({
      where: {
        companyId,
        nodePath: { in: ancestorPaths },
      },
      select: { id: true },
    });

    const ancestorNodeIds = ancestorNodes.map((node: any) => node.id);
    if (ancestorNodeIds.length === 0) return [];

    const accesses = await (tx as any).userAccess.findMany({
      where: {
        companyId,
        nodeId: { in: ancestorNodeIds },
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
      select: { userId: true },
    });

    return this.unique(accesses.map((access: any) => access.userId));
  }

  /**
   * Conservative fallback for unknown level types. It collects every approver
   * source for the request scope so a malformed old workflow does not silently
   * create an empty approval chain.
   */
  private static async getAllEligibleApproverIds(
    tx: TxClient,
    companyId: string,
    node: RequestNode,
    rmChain: string[],
    subModule: string,
  ): Promise<string[]> {
    const allIds = new Set<string>();

    const [globalIds, nodeIds, hierarchyIds, managerIds] = await Promise.all([
      this.getGlobalAccessUserIds(tx, companyId, subModule),
      this.getNodeApprovers(tx, companyId, node.id, subModule),
      this.getHierarchyApprovers(tx, companyId, node.nodePath, subModule),
      this.filterUserIdsBySubModuleApproval(tx, companyId, rmChain, subModule),
    ]);

    [...globalIds, ...nodeIds, ...hierarchyIds, ...managerIds].forEach((id) =>
      allIds.add(id),
    );

    return Array.from(allIds);
  }

  /**
   * Filters a candidate list, such as reporting managers, to users who can
   * approve this subModule. Global access is accepted because those users are
   * company-wide approvers by business rule.
   */
  private static async filterUserIdsBySubModuleApproval(
    tx: TxClient,
    companyId: string,
    userIds: string[],
    subModule: string,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];

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
          { isGlobalAccess: true },
          { role: { category: 'SAAS_ADMIN', approve: true } },
          { role: { approve: true, subCategory: subModule } },
        ],
      },
      select: { userId: true },
    });

    return this.unique(accesses.map((access: any) => access.userId));
  }

  /**
   * Global access users can appear in every pending row for both default and
   * custom workflows. Runtime eligibility still limits them to one approval
   * per request without rewriting stored approver rows.
   */
  static async getGlobalAccessUserIds(
    tx: TxClient,
    companyId: string,
    _subModule?: string,
    _isRestricted?: boolean,
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

    return this.unique(accesses.map((access: any) => access.userId));
  }

  /**
   * Keeps only users who are actively mapped to the provided company.
   * This protects runtime approver displays from stale or cross-company IDs.
   */
  static async filterUsersToActiveCompanyMembers(
    tx: TxClient,
    companyId: string,
    userIds: string[],
  ): Promise<string[]> {
    const normalizedUserIds = this.unique(userIds);
    if (normalizedUserIds.length === 0) return [];

    const mappings = await (tx as any).userMapping.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        userId: { in: normalizedUserIds },
      },
      select: { userId: true },
    });

    const activeUserIds = new Set<string>(
      mappings.map((mapping: any) => String(mapping.userId || '').trim()),
    );

    return normalizedUserIds.filter((userId: string) =>
      activeUserIds.has(userId),
    );
  }

  /**
   * Returns the flat current eligible approver list for a request. The stored
   * workflow_approver rows are authoritative, and already-approved users are
   * removed so callers do not offer an approval action twice.
   */
  static async getEligibleApproversForRequest(
    reqId: string,
    reqTable: string,
  ): Promise<string[]> {
    const approverRows = await prisma.workflowApprover.findMany({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });

    const initiatorId = await this.getInitiatorId(
      prisma as any,
      reqId,
      reqTable,
    );
    const approvedUsers = new Set(
      await this.getApprovedUserIds(prisma as any, reqId, reqTable),
    );
    if (initiatorId) approvedUsers.add(initiatorId);

    const allApprovers = new Set<string>();

    for (const row of approverRows) {
      for (const userId of this.toStringArray(row.approversList)) {
        if (!approvedUsers.has(userId)) {
          allApprovers.add(userId);
        }
      }
    }

    return Array.from(allApprovers);
  }

  /**
   * Multi-level workflows are sequential: only the lowest pending level is
   * actionable. If an AND level has one approval but still needs another, this
   * method returns that same level until mandatoryCount is satisfied.
   */
  static async getCurrentPendingLevel(reqId: string, reqTable: string) {
    return prisma.workflowApprover.findFirst({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });
  }

  /**
   * Applies one approval to a level. The row is marked APPROVED only after the
   * number of distinct approval history entries for that level reaches
   * mandatoryCount. Stored approver rows are not pruned; active eligibility is
   * filtered from approval history so the same person can approve only once.
   */
  static async approveLevel(
    tx: TxClient,
    reqId: string,
    reqTable: string,
    level: number,
    approverId?: string,
  ) {
    const currentLevel = await (tx as any).workflowApprover.findFirst({
      where: { reqId, reqTable, level, status: 'PENDING' },
    });

    if (!currentLevel) {
      return this.getNextPendingLevel(tx, reqId, reqTable);
    }

    const currentApprovers = this.toStringArray(currentLevel.approversList);
    if (approverId && !currentApprovers.includes(approverId)) {
      throw new AppError(
        `Unauthorized: You are not an eligible approver for level ${level}`,
        403,
      );
    }

    const initiatorId = await this.getInitiatorId(tx, reqId, reqTable);
    if (approverId && initiatorId === approverId) {
      throw new AppError('Initiator cannot approve their own request', 403);
    }

    if (
      approverId &&
      (await this.isAlreadyApproved(tx, reqId, reqTable, approverId))
    ) {
      throw new AppError('You have already approved this request once', 403);
    }

    const approvedUsersForLevel = new Set(
      await this.getApprovedUserIds(tx, reqId, reqTable, level),
    );
    if (approverId) {
      approvedUsersForLevel.add(approverId);
    }

    const mandatoryCount = currentLevel.mandatoryCount || 1;
    const levelSatisfied = approvedUsersForLevel.size >= mandatoryCount;

    // Before accepting the approval, simulate "one user, one level" consumption.
    // This prevents a valid click from leaving later levels with no possible
    // unique approver path.
    if (approverId) {
      await this.assertPendingPathAfterApprovalIsFeasible(tx, {
        reqId,
        reqTable,
        level,
        approverId,
        currentLevelSatisfied: levelSatisfied,
        approvedCountForCurrentLevel: approvedUsersForLevel.size,
      });
    }

    if (levelSatisfied) {
      await (tx as any).workflowApprover.updateMany({
        where: { reqId, reqTable, level },
        data: { status: 'APPROVED' },
      });
    }

    // No pruning: all eligible users remain in the list even after approval
    // to maintain a complete audit trail of potential approvers.

    await this.syncPendingEligibleApprovers(
      tx,
      reqTable,
      reqId,
      approverId ? [approverId] : [],
    );

    return this.getNextPendingLevel(tx, reqId, reqTable);
  }

  /**
   * Rejection is terminal. No pending approvers should remain on the request
   * once a rejection has been accepted.
   */
  static async rejectAllLevels(tx: TxClient, reqId: string, reqTable: string) {
    await (tx as any).workflowApprover.updateMany({
      where: { reqId, reqTable },
      data: { status: 'REJECTED' },
    });

    await this.syncRequestEligibleApprovers(tx, reqTable, reqId, []);
  }

  /**
   * History views should show currently actionable approvers only. The stored
   * row remains complete for audit/debugging, while this filters the initiator
   * and users who have already approved this request.
   */
  static async getEnrichedApproverIds(
    companyId: string,
    storedApproverIds: string[],
    initiatorId: string | null,
    _subModule: string,
    approvedUserIds: string[] = [],
  ): Promise<string[]> {
    const excludedUsers = new Set(approvedUserIds);
    if (initiatorId) excludedUsers.add(initiatorId);

    const companyScopedApprovers = await this.filterUsersToActiveCompanyMembers(
      prisma as any,
      companyId,
      storedApproverIds,
    );

    return companyScopedApprovers.filter(
      (userId) => !excludedUsers.has(userId),
    );
  }

  /**
   * A user who has any APPROVED history entry for the request has already spent
   * their one approval for that request.
   */
  static async isAlreadyApproved(
    tx: TxClient,
    reqId: string,
    reqTable: string,
    approverId: string,
  ): Promise<boolean> {
    const config = this.getHistoryConfig(reqTable);
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

  private static getMandatoryCount(level: WorkflowLevelLike): number {
    return level.approverType === 'AND' && level.approver2 ? 2 : 1;
  }

  private static isNoApproverLevel(level: WorkflowLevelLike) {
    return level.approver1 === 'NO_APPROVER' && !level.approver2;
  }

  private static getAncestorPaths(nodePath: string): string[] {
    if (!nodePath) return [];
    const parts = nodePath.split('.');
    return parts
      .slice(0, -1)
      .map((_, index) => parts.slice(0, index + 1).join('.'));
  }

  private static unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }

  private static toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  }

  private static getHistoryConfig(reqTable: string): HistoryConfig | null {
    const historyMap: Record<string, HistoryConfig> = {
      user_onboarding: { table: 'userHistory', field: 'reqId' },
      org_structure_req: { table: 'orgHistory', field: 'orgReqId' },
      workflow_req: { table: 'workflowReqHistory', field: 'workflowReqId' },
    };

    return historyMap[reqTable] ?? null;
  }

  private static getRequestConfig(reqTable: string): RequestConfig | null {
    const requestMap: Record<string, RequestConfig> = {
      user_onboarding: { table: 'userOnboarding' },
      org_structure_req: { table: 'orgStructureReq' },
      workflow_req: { table: 'workflowReq' },
    };

    return requestMap[reqTable] ?? null;
  }

  private static async getApprovedUserIds(
    tx: TxClient,
    reqId: string,
    reqTable: string,
    level?: number,
  ): Promise<string[]> {
    const config = this.getHistoryConfig(reqTable);
    if (!config) return [];

    const approvals = await (tx as any)[config.table].findMany({
      where: {
        [config.field]: reqId,
        event: 'APPROVED',
        ...(typeof level === 'number' ? { level } : {}),
      },
      select: { eventUserId: true },
    });

    return this.unique(approvals.map((approval: any) => approval.eventUserId));
  }

  private static async getInitiatorId(
    tx: TxClient,
    reqId: string,
    reqTable: string,
  ): Promise<string | null> {
    const config = this.getHistoryConfig(reqTable);
    if (!config) return null;

    const initiatorLog = await (tx as any)[config.table].findFirst({
      where: {
        [config.field]: reqId,
        event: 'INITIATE',
      },
      select: { eventUserId: true },
    });

    if (initiatorLog?.eventUserId) {
      return initiatorLog.eventUserId;
    }

    const requestConfig = this.getRequestConfig(reqTable);
    if (!requestConfig) return null;

    const request = await (tx as any)[requestConfig.table].findUnique({
      where: { id: reqId },
      select: { initiatorId: true },
    });

    return request?.initiatorId || null;
  }

  private static async getNextPendingLevel(
    tx: TxClient,
    reqId: string,
    reqTable: string,
  ) {
    return (tx as any).workflowApprover.findFirst({
      where: { reqId, reqTable, status: 'PENDING' },
      orderBy: { level: 'asc' },
    });
  }

  private static async syncPendingEligibleApprovers(
    tx: TxClient,
    reqTable: string,
    reqId: string,
    extraExcludedUserIds: string[] = [],
  ) {
    const pendingRows = await (tx as any).workflowApprover.findMany({
      where: { reqId, reqTable, status: 'PENDING' },
      select: { approversList: true },
    });

    const initiatorId = await this.getInitiatorId(tx, reqId, reqTable);
    const approvedUsers = new Set(
      await this.getApprovedUserIds(tx, reqId, reqTable),
    );
    if (initiatorId) approvedUsers.add(initiatorId);
    extraExcludedUserIds.forEach((userId) => approvedUsers.add(userId));

    const eligible = new Set<string>();

    for (const row of pendingRows) {
      for (const userId of this.toStringArray(row.approversList)) {
        if (!approvedUsers.has(userId)) {
          eligible.add(userId);
        }
      }
    }

    await this.syncRequestEligibleApprovers(
      tx,
      reqTable,
      reqId,
      Array.from(eligible),
    );
  }

  private static async syncRequestEligibleApprovers(
    tx: TxClient,
    reqTable: string,
    reqId: string,
    eligibleApprovers: string[],
  ) {
    const modelMap: Record<string, string> = {
      user_onboarding: 'userOnboarding',
      org_structure_req: 'orgStructureReq',
      workflow_req: 'workflowReq',
    };

    const modelName = modelMap[reqTable];
    if (!modelName) return;

    await (tx as any)[modelName].update({
      where: { id: reqId },
      data: { eligibleApprovers: this.unique(eligibleApprovers) },
    });
  }

  /**
   * Uses bipartite matching to prove that each required approval slot can be
   * filled by a distinct user. This is safer than only checking each level in
   * isolation because the same user may be present on multiple levels.
   */
  private static assertApprovalPathIsFeasible(
    rows: ApprovalPathRow[],
    failurePrefix: string,
    initiatorId: string | null = null,
  ) {
    const slots: { level: number; candidates: string[] }[] = [];

    for (const row of rows) {
      for (let slot = 0; slot < row.mandatoryCount; slot++) {
        const candidates = this.unique(row.approversList);
        slots.push({
          level: row.level,
          candidates: initiatorId
            ? candidates.filter((id) => id !== initiatorId)
            : candidates,
        });
      }
    }

    if (slots.length === 0) return;

    const userToSlot = new Map<string, number>();
    const tryAssign = (slotIndex: number, seenUsers: Set<string>): boolean => {
      for (const userId of slots[slotIndex]?.candidates ?? []) {
        if (seenUsers.has(userId)) continue;
        seenUsers.add(userId);

        const assignedSlot = userToSlot.get(userId);
        if (assignedSlot === undefined || tryAssign(assignedSlot, seenUsers)) {
          userToSlot.set(userId, slotIndex);
          return true;
        }
      }

      return false;
    };

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      if (!tryAssign(slotIndex, new Set<string>())) {
        const requiredApprovals = slots.length;
        const uniqueCandidates = new Set(
          rows.flatMap((row) => row.approversList),
        ).size;

        throw new AppError(
          `${failurePrefix} It requires ${requiredApprovals} distinct approval(s) across all levels, but only ${uniqueCandidates} eligible user(s) can satisfy the level rules after excluding the initiator and previous approvers.`,
          400,
        );
      }
    }
  }

  private static async assertPendingPathAfterApprovalIsFeasible(
    tx: TxClient,
    opts: {
      reqId: string;
      reqTable: string;
      level: number;
      approverId: string;
      currentLevelSatisfied: boolean;
      approvedCountForCurrentLevel: number;
    },
  ) {
    const pendingRows = await (tx as any).workflowApprover.findMany({
      where: {
        reqId: opts.reqId,
        reqTable: opts.reqTable,
        status: 'PENDING',
      },
      orderBy: { level: 'asc' },
      select: {
        level: true,
        approversList: true,
        mandatoryCount: true,
      },
    });

    const remainingRows: ApprovalPathRow[] = [];
    const consumedApprovers = new Set(
      await this.getApprovedUserIds(tx, opts.reqId, opts.reqTable),
    );
    consumedApprovers.add(opts.approverId);

    const initiatorId = await this.getInitiatorId(
      tx,
      opts.reqId,
      opts.reqTable,
    );
    if (initiatorId) consumedApprovers.add(initiatorId);

    for (const row of pendingRows) {
      if (row.level < opts.level) continue;

      const approversList = this.toStringArray(row.approversList).filter(
        (id) => !consumedApprovers.has(id),
      );

      if (row.level === opts.level) {
        if (opts.currentLevelSatisfied) continue;

        remainingRows.push({
          level: row.level,
          approversList,
          mandatoryCount: Math.max(
            0,
            row.mandatoryCount - opts.approvedCountForCurrentLevel,
          ),
        });
        continue;
      }

      remainingRows.push({
        level: row.level,
        approversList,
        mandatoryCount: row.mandatoryCount,
      });
    }

    this.assertApprovalPathIsFeasible(
      remainingRows.filter((row) => row.mandatoryCount > 0),
      'This approval would leave the remaining workflow without enough approvers.',
    );
  }
}
