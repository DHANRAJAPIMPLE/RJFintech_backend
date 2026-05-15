# Reuse Refactor Report

## Summary

Extracted **4 shared helpers** from repeated logic across the codebase, removing ~500 lines of duplicated code while preserving identical API output, status codes, error messages, and DB queries.

---

## 1. Helpers Created

| # | File | Purpose |
|---|------|---------|
| 1 | `src/backend/shared/resolveCompanyId.ts` | Resolves `companyId` from `companyCode`/`companyId` pairs with 3 variants: throwing, safe (JSON error response), and nullable |
| 2 | `src/backend/shared/historyFormatter.ts` | Shared history formatting pipeline — workflow approver enrichment, pending-level injection, approver detail resolution, SAAS_ADMIN masking, `workflowStatus` computation |
| 3 | `src/middlelayer/utils/mergeEligibleApprovers.ts` | Merges and deduplicates global + manager approver ID arrays |
| 4 | `src/middlelayer/utils/internalPostOrThrow.ts` | Wraps `internalPost` with automatic error unwrapping; two variants: `internalPostOrThrow` (checks `!ok`) and `internalPostOrThrowNotNull` (checks `!ok || !data`) |

---

## 2. Files Changed

### Backend DB Modules

| File | Functions Refactored | Changes |
|------|---------------------|---------|
| `src/backend/modules/user/user.db.modules.ts` | `fetchAllUsers`, `createUserOnboarding`, `getUserHistory` | Replaced 3x company resolve blocks with `resolveCompanyId()`; replaced ~200-line history pipeline with `formatHistoryPipeline()` |
| `src/backend/modules/org/org.db.modules.ts` | `initiateRequest`, `validateInitiation`, `fetchOrgHistory`, `fetchStructure` | Replaced 4x company resolve blocks (2 throwing, 2 safe-return); replaced ~195-line history pipeline with `formatHistoryPipeline()` |
| `src/backend/modules/workflow/workflow.db.modules.ts` | `initiateWorkflowRequest`, `fetchWorkflowHistory`, `fetchWorkflows` | Replaced 3x company resolve blocks (1 throwing, 1 nullable, 1 throwing); replaced ~200-line history pipeline with `formatHistoryPipeline()` |

### Middlelayer Controllers

| File | Functions Refactored | Changes |
|------|---------------------|---------|
| `src/middlelayer/controllers/org.controller.ts` | `initiateOrgRequest`, `approveOrgRequest`, `fetchOrgStructure`, `fetchOrgHistory` | Replaced approver merge with `mergeEligibleApprovers()`; replaced 8x internalPost error unwrap with `internalPostOrThrow`/`internalPostOrThrowNotNull` |
| `src/middlelayer/controllers/user.controller.ts` | `fetchAllUsers`, `initiateUserOnboarding`, `actionUserOnboarding`, `getUserHistory`, `fetchCompanyNodes`, `fetchUsersByNodePathCount` | Replaced approver merge; replaced 8x internalPost error unwrap |
| `src/middlelayer/controllers/workflow.controller.ts` | `initiateWorkflow`, `actionWorkflow`, `fetchAllWorkflows`, `fetchWorkflowHistory` | Replaced approver merge; replaced 7x internalPost error unwrap |
| `src/middlelayer/controllers/admin.controller.ts` | `getGroupCompanies`, `initiateCompanyOnboarding`, `actionCompanyOnboarding`, `fetchCompanyHistory` | Replaced 5x internalPost error unwrap |

---

## 3. Exact Duplicate Logic Removed

### 3.1 Company ID Resolution (~10 occurrences -> 1 helper with 3 variants)

**Before:** Each function had 6-14 lines of:
```typescript
let resolvedCompanyId = companyId;
if (!resolvedCompanyId) {
  if (!companyCode) throw new AppError('...', 400);
  const company = await prisma.company.findUnique({ where: { companyCode } });
  if (!company) throw new AppError('Company not found', 404);
  resolvedCompanyId = company.id;
}
```

**After:** Single call:
```typescript
const resolvedCompanyId = await resolveCompanyId({ companyId, companyCode });
```

Three variants preserve the exact error behavior of each call site:
- `resolveCompanyId()` — throws `AppError` (used by 7 functions)
- `resolveCompanyIdSafe()` — returns error object for `res.status().json()` pattern (used by `validateInitiation`, `fetchStructure`)
- `resolveCompanyIdOrNull()` — returns `null` if neither provided (used by `fetchWorkflowHistory`)

### 3.2 History Formatting Pipeline (~3 x 150-200 lines -> 1 shared pipeline)

**Before:** Each history function repeated identical logic for:
1. Collecting reqIds -> fetching `WorkflowApprover` rows
2. Grouping levels by reqId
3. Building initiator/approvedUser maps
4. Enriching approver lists via `getEnrichedApproverIds`
5. Resolving approver details with SAAS_ADMIN -> "Teams" masking
6. Injecting synthetic "L{n} Pending Approval" entries
7. Computing `workflowStatus` (overallStatus, currentLevel, totalLevels, levels array)
8. Formatting user info with SAAS_ADMIN/Teams masking

**After:** Config-based `formatHistoryPipeline()` accepts callbacks for module-specific differences (field names, pending entry shape) while running the identical shared pipeline.

### 3.3 Eligible Approver Merge (~3 occurrences -> 1 helper)

**Before:**
```typescript
let eligibleApprovers = Array.from(
  new Set([...(globalRes.data || []), ...(mgrRes.data || [])]),
);
```

**After:**
```typescript
let eligibleApprovers = mergeEligibleApprovers(globalRes.data, mgrRes.data);
```

### 3.4 InternalPost Error Unwrapping (~28 occurrences -> 1 helper with 2 variants)

**Before:**
```typescript
const { data, ok, status } = await internalPost(url, body);
if (!ok) {
  throw new AppError(data?.message || data?.error || 'Fallback', status);
}
```

**After:**
```typescript
const data = await internalPostOrThrow(url, body, 'Fallback');
```

---

## 4. Behavior-Safety Notes

All changes are **behavior-preserving by design**. No DB queries, validations, response shapes, status codes, or error messages were modified.

| Area | Safety Detail |
|------|---------------|
| `resolveCompanyId` | Each variant exactly matches the original error pattern (throw vs return JSON vs return null). Error messages and status codes are identical. |
| `resolveCompanyIdSafe` | Returns `{ success: false, message: '...' }` body shape matching original `res.status().json()` calls in `validateInitiation` and `fetchStructure`. |
| `formatHistoryPipeline` | Config callbacks produce identical output objects. The pipeline runs the same Prisma queries in the same order. User history's rejected-request filtering is preserved as a pre-processing step before the shared pipeline. |
| `mergeEligibleApprovers` | Uses identical `new Set([...global, ...manager])` logic. Initiator exclusion still happens downstream in DB modules (not in this helper). |
| `internalPostOrThrow` | Extracts `data?.message \|\| data?.error \|\| fallback` in the same priority order. Status code passthrough is identical. |
| Workflow `subModule` | Workflow history uses per-request subModules (dynamic function), while user/org use static strings — both paths are supported by the config interface. |
| Workflow `userAccesses` filter | Workflow history filters `userAccesses` by `companyId` before checking SAAS_ADMIN — this is preserved via the `getUserAccesses` callback. |

---

## 5. Risky Areas That Need Manual Testing

1. **User History — Rejected Request Filtering**: The pre-processing step that filters out rejected requests before passing to the shared pipeline. Verify that rejected onboarding requests still don't appear in the history output.

2. **Workflow History — Dynamic SubModule**: The workflow formatter uses a per-request `subModule` function instead of a static string. Verify that approver enrichment uses the correct subModule for each request.

3. **Workflow History — Company-scoped UserAccess Filter**: Workflow history filters `userAccesses` by `companyId` before SAAS_ADMIN detection, while user/org history does not. Verify the `getUserAccesses` callback preserves this.

4. **Org `validateInitiation` & `fetchStructure`**: These two functions used `res.status().json()` error responses instead of throwing. Verify the `resolveCompanyIdSafe` variant produces identical response bodies.

5. **`internalPostOrThrow` status code propagation**: When the original code used custom `fallbackStatus` (e.g., `status || 404`), verify the helper propagates correctly.

---

## 6. Manual Testing Checklist

| # | Test Case | Endpoint/Function | Expected |
|---|-----------|-------------------|----------|
| 1 | User history API output before/after | `getUserHistory` | Identical JSON response |
| 2 | Org history API output before/after | `fetchOrgHistory` | Identical JSON response |
| 3 | Workflow history API output before/after | `fetchWorkflowHistory` | Identical JSON response |
| 4 | `fetchAllUsers` with `companyId` only | `fetchAllUsers` | Works, returns users |
| 5 | `fetchAllUsers` with `companyCode` only | `fetchAllUsers` | Works, resolves company first |
| 6 | `fetchAllUsers` with neither | `fetchAllUsers` | Returns 400 error |
| 7 | `fetchStructure` with `companyId` only | `fetchStructure` | Works |
| 8 | `fetchStructure` with `companyCode` only | `fetchStructure` | Works |
| 9 | `fetchStructure` with neither | `fetchStructure` | Returns `{ success: false, message: '...' }` 400 |
| 10 | Initiate org request — approver list | `initiateOrgRequest` | Same merged approver list |
| 11 | Initiate user onboarding — approver list | `initiateUserOnboarding` | Same merged approver list |
| 12 | Initiate workflow — approver list | `initiateWorkflow` | Same merged approver list |
| 13 | `internalPost` success path | Any controller | Returns data normally |
| 14 | `internalPost` error path (backend 500) | Any controller | Throws AppError with message from backend |
| 15 | `internalPost` error path (backend unreachable) | Any controller | Throws 503 "Backend service unreachable" |

---

## 7. Suggested Tests to Run

```bash
# 1. TypeScript compilation (already passing)
npx tsc --noEmit

# 2. If you have existing test suites:
npm test

# 3. API regression tests (if using Postman/Newman):
# Run the full collection against a seeded database
# Compare response snapshots before/after refactor

# 4. Specific API calls to verify:
# POST /api/user/history       — with email + companyCode
# POST /api/org/history        — with companyCode + nodeName
# POST /api/workflow/history   — with companyId
# POST /api/user/fetch-all     — with companyCode only
# POST /api/user/fetch-all     — with companyId only
# POST /api/org/fetch          — with companyCode only
# POST /api/org/fetch          — with neither (expect 400)
```

---

## 8. Files Summary

### New Files (4)
- `src/backend/shared/resolveCompanyId.ts`
- `src/backend/shared/historyFormatter.ts`
- `src/middlelayer/utils/mergeEligibleApprovers.ts`
- `src/middlelayer/utils/internalPostOrThrow.ts`

### Modified Files (7)
- `src/backend/modules/user/user.db.modules.ts`
- `src/backend/modules/org/org.db.modules.ts`
- `src/backend/modules/workflow/workflow.db.modules.ts`
- `src/middlelayer/controllers/org.controller.ts`
- `src/middlelayer/controllers/user.controller.ts`
- `src/middlelayer/controllers/workflow.controller.ts`
- `src/middlelayer/controllers/admin.controller.ts`
