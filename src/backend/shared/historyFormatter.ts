import { prisma } from '../lib/prisma';
import { WorkflowApproverUtil } from '../utils/workflow-approver.util';

/**
 * Shared history formatting pipeline.
 *
 * Extracts the repeated logic from getUserHistory, fetchOrgHistory, and
 * fetchWorkflowHistory. The three modules share identical logic for:
 *
 * 1. Collecting unique reqIds → fetching WorkflowApprover rows
 * 2. Grouping workflow levels by reqId
 * 3. Building initiator/approvedUser maps from history events
 * 4. Enriching approver lists via WorkflowApproverUtil.getEnrichedApproverIds
 * 5. Resolving approver details (name/email with SAAS_ADMIN masking)
 * 6. Injecting "Pending Approval" synthetic entries
 * 7. Computing workflowStatus per history row
 * 8. Formatting user info with SAAS_ADMIN / Teams masking
 *
 * Each module provides a config object to customize the parts that differ:
 * - How to extract reqId from a history row
 * - How to extract eventUserId / event from a history row
 * - Which subModule string to pass to getEnrichedApproverIds
 * - How to build the pending entry and the formatted history entry (module-specific fields)
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface HistoryFormatterConfig<THistoryRow> {
  /** Extract the request ID from a history row (e.g. h.reqId, h.orgReqId, h.workflowReqId) */
  getReqId: (h: THistoryRow) => string | null | undefined;

  /** Extract the event string (INITIATE, APPROVED, REJECTED…) */
  getEvent: (h: THistoryRow) => string;

  /** Extract the eventUserId */
  getEventUserId: (h: THistoryRow) => string | null | undefined;

  /** The resolved companyId for the request context */
  companyId: string;

  /** 
   * The subModule string used for approver enrichment.
   * Can be a static string or a function per-reqId (workflow uses per-request subModules).
   */
  subModule: string | ((reqId: string) => string);

  /** 
   * Build the module-specific fields for a "pending approval" entry.
   * Receives the history row and resolved eligible approvers.
   */
  buildPendingEntry: (
    h: THistoryRow,
    approvers: Array<{ name: string; email: string }>,
    pendingLevel: number,
  ) => Record<string, any>;

  /** 
   * Build the module-specific fields for a formatted history entry.
   * Receives the history row, resolved user info, and workflowStatus.
   */
  buildHistoryEntry: (
    h: THistoryRow,
    user: { name: string; email: string },
    workflowStatus: any | null,
  ) => Record<string, any>;

  /**
   * Extract user accesses from the history row for SAAS_ADMIN detection.
   * Different modules include userAccesses in different shapes.
   */
  getUserAccesses: (h: THistoryRow) => Array<{ roleCode: string; companyId?: string }>;

  /**
   * Extract the user object from the history row (for name/email fallback).
   */
  getUser: (h: THistoryRow) => { name?: string | null; email?: string | null } | null | undefined;
}

// ── Core Pipeline ───────────────────────────────────────────────────────────

/**
 * Runs the shared history formatting pipeline.
 * Returns the combined resultList (pending entries first, then formatted history).
 */
export async function formatHistoryPipeline<THistoryRow>(
  histories: THistoryRow[],
  config: HistoryFormatterConfig<THistoryRow>,
): Promise<any[]> {
  const { companyId } = config;

  // 1. Collect all unique request IDs to fetch their workflow approval status
  const reqIds = Array.from(
    new Set(histories.map((h) => config.getReqId(h)).filter(Boolean)),
  ) as string[];

  const workflowApprovers = await prisma.workflowApprover.findMany({
    where: { reqId: { in: reqIds } },
    orderBy: { level: 'asc' },
  });

  // Group workflow levels by reqId
  const workflowMap = new Map<string, any[]>();
  workflowApprovers.forEach((wa) => {
    const existing = workflowMap.get(wa.reqId) || [];
    existing.push(wa);
    workflowMap.set(wa.reqId, existing);
  });

  // Build request-level maps used to filter displayed approvers.
  const initiatorMap = new Map<string, string>();
  const approvedUserMap = new Map<string, Set<string>>();
  const subModuleMap = new Map<string, string>();

  histories.forEach((h) => {
    const reqId = config.getReqId(h);
    if (reqId) {
      if (config.getEvent(h) === 'INITIATE' && config.getEventUserId(h)) {
        initiatorMap.set(reqId, config.getEventUserId(h)!);
      }
      if (config.getEvent(h) === 'APPROVED' && config.getEventUserId(h)) {
        const approvedUsers = approvedUserMap.get(reqId) || new Set<string>();
        approvedUsers.add(config.getEventUserId(h)!);
        approvedUserMap.set(reqId, approvedUsers);
      }
    }
  });

  // Resolve subModule per reqId if it's a function
  if (typeof config.subModule === 'function') {
    histories.forEach((h) => {
      const reqId = config.getReqId(h);
      if (reqId && typeof config.subModule === 'function') {
        const sub = config.subModule(reqId);
        if (sub) subModuleMap.set(reqId, sub);
      }
    });
  }

  // Filter each stored approver list for active display only. The DB row is not mutated.
  for (const [reqId, levels] of workflowMap.entries()) {
    const initiatorId = initiatorMap.get(reqId) || null;
    const subModule = typeof config.subModule === 'function'
      ? (subModuleMap.get(reqId) || config.subModule(reqId))
      : config.subModule;
    const approvedUserIds = Array.from(
      approvedUserMap.get(reqId) ?? new Set<string>(),
    );
    for (const level of levels) {
      const storedList = Array.isArray(level.approversList)
        ? (level.approversList as string[])
        : [];
      level.approversList = await WorkflowApproverUtil.getEnrichedApproverIds(
        companyId,
        storedList,
        initiatorId,
        subModule,
        approvedUserIds,
      );
    }
  }

  // 2. Resolve approver details (names/emails) from enriched lists
  const allApproverIds = new Set<string>();
  for (const levels of workflowMap.values()) {
    for (const level of levels) {
      (level.approversList as string[]).forEach((id: string) =>
        allApproverIds.add(id),
      );
    }
  }

  const approverDetails = await prisma.user.findMany({
    where: { id: { in: Array.from(allApproverIds) } },
    select: {
      id: true,
      name: true,
      email: true,
      userAccesses: {
        select: { roleCode: true },
      },
    },
  });

  const approverMap = new Map(
    approverDetails.map((u) => {
      const isSaasAdmin = u.userAccesses.some(
        (a) => a.roleCode === 'SAAS_ADMIN',
      );
      return [
        u.id,
        {
          name: isSaasAdmin ? 'Teams' : u.name,
          email: isSaasAdmin ? 'Teams' : u.email,
        },
      ];
    }),
  );

  const resultList: any[] = [];
  const handledPendingReqs = new Set<string>();

  // 3. Inject "Pending Approval" entries for any active requests
  histories.forEach((h) => {
    const reqId = config.getReqId(h);
    if (reqId && !handledPendingReqs.has(reqId)) {
      const levels = workflowMap.get(reqId);
      if (levels) {
        const currentPending = levels.find((l) => l.status === 'PENDING');
        if (currentPending) {
          const approvers = (currentPending.approversList as string[])
            .map((id) => {
              const u = approverMap.get(id);
              return u ? { name: u.name, email: u.email } : null;
            })
            .filter(Boolean) as Array<{ name: string; email: string }>;

          resultList.push(
            config.buildPendingEntry(h, approvers, currentPending.level),
          );
        }
      }
      handledPendingReqs.add(reqId);
    }
  });

  // 4. Format history for easy display
  const formattedHistories = histories.map((h) => {
    const userAccesses = config.getUserAccesses(h);

    const isSaasAdmin = userAccesses.some(
      (a) => a.roleCode === 'SAAS_ADMIN',
    );
    const rawUser = config.getUser(h);
    const isTeams = isSaasAdmin || (!rawUser && config.getEventUserId(h) === null);

    const user = isTeams
      ? { name: 'Teams', email: 'Teams' }
      : {
        name: rawUser?.name || 'System',
        email: rawUser?.email || 'system@internal',
      };

    const reqId = config.getReqId(h);
    const levels = reqId ? workflowMap.get(reqId) : null;
    const workflowStatus = buildWorkflowStatus(levels, approverMap);

    return config.buildHistoryEntry(h, user, workflowStatus);
  });

  resultList.push(...formattedHistories);

  return resultList;
}

/**
 * Builds the workflowStatus object from a set of workflow levels.
 * Shared across all three history formatters with identical logic.
 */
export function buildWorkflowStatus(
  levels: any[] | null | undefined,
  approverMap: Map<string, { name: string; email: string }>,
): any | null {
  if (!levels || levels.length === 0) return null;

  const allApproved = levels.every((l: any) => l.status === 'APPROVED');
  const isRejected = levels.some((l: any) => l.status === 'REJECTED');
  const currentPending = levels.find(
    (l: any) => l.status === 'PENDING',
  );

  return {
    overallStatus: isRejected
      ? 'REJECTED'
      : allApproved
        ? 'APPROVED'
        : 'PENDING',
    currentLevel: currentPending
      ? currentPending.level
      : allApproved
        ? levels.length
        : null,
    totalLevels: levels.length,
    levels: levels
      .filter(
        (l: any) => l.level <= (currentPending?.level || levels.length),
      )
      .map((l: any) => ({
        level: l.level,
        status: l.status,
        eligibleapprovers: (l.approversList as string[])
          .map((id: string) => {
            const u = approverMap.get(id);
            return u ? { name: u.name, email: u.email } : null;
          })
          .filter(Boolean),
      })),
  };
}
