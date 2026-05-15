/**
 * Merges eligible approvers from global access and manager access sources.
 *
 * Extracts the repeated pattern found in:
 * - org.controller.ts → initiateOrgRequest
 * - user.controller.ts → initiateUserOnboarding
 * - workflow.controller.ts → initiateWorkflow
 *
 * The merge logic:
 * 1. Combines global approvers and manager approvers into a single array.
 * 2. Removes duplicates using a Set (preserves insertion order — globals first, then managers).
 * 3. Returns a plain string array of unique approver IDs.
 *
 * Note: The initiator exclusion is NOT done here — it happens downstream in the
 * backend db modules (createUserOnboarding, initiateRequest, initiateWorkflowRequest)
 * via the `masterEligible` / `filteredApprovers` logic. This helper only handles
 * the merge that occurs in the middlelayer controllers.
 */
export function mergeEligibleApprovers(
  globalApprovers: string[] | null | undefined,
  managerApprovers: string[] | null | undefined,
): string[] {
  return Array.from(
    new Set([...(globalApprovers || []), ...(managerApprovers || [])]),
  );
}
