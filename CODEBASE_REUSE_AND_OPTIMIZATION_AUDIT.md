# CODEBASE REUSE & OPTIMIZATION AUDIT

## 1. Executive Summary

- Architecture: good separation between `src/middlelayer` and `src/backend`, but high duplication in orchestration logic.
- Important truth: **No one can guarantee 100% non-break without regression testing**.  
  This plan is rewritten to keep behavior stable, especially:
  - SAAS admin-only routes
  - role-based and node-based access checks
  - existing workflow approval behavior
- Focus: safe reuse, safe performance wins, safe security hardening (no Prisma schema changes).

## 2. Safe Duplicate Logic Findings (Behavior-Preserving)

| File | Function | Duplicate Logic | Safe Reuse (No Behavior Change) |
|---|---|---|---|
| `src/backend/modules/user/user.db.modules.ts` | `getUserHistory` | history + pending-level formatting | extract formatter helper, keep same DB calls/output |
| `src/backend/modules/org/org.db.modules.ts` | `fetchOrgHistory` | same history pipeline | shared helper with module parameter |
| `src/backend/modules/workflow/workflow.db.modules.ts` | `fetchWorkflowHistory` | same history pipeline | shared helper with req-table mapping |
| `src/backend/modules/user/user.db.modules.ts` | `fetchAllUsers`, `getUserHistory` | repeated `companyCode/companyId` resolve | shared `resolveCompanyId` util |
| `src/backend/modules/org/org.db.modules.ts` | `fetchStructure`, `fetchOrgHistory`, `validateInitiation` | repeated `companyCode/companyId` resolve | same shared util |
| `src/backend/modules/workflow/workflow.db.modules.ts` | `initiateWorkflowRequest`, `fetchWorkflowHistory`, `fetchWorkflows` | repeated `companyCode/companyId` resolve | same shared util |
| `src/middlelayer/controllers/org.controller.ts` | `initiateOrgRequest` | eligible approver merge (global + mgr) | shared merge helper only |
| `src/middlelayer/controllers/user.controller.ts` | `initiateUserOnboarding` | eligible approver merge (global + mgr) | shared merge helper only |
| `src/middlelayer/controllers/workflow.controller.ts` | `initiateWorkflow` | eligible approver merge (global + mgr) | shared merge helper only |
| `src/middlelayer/controllers/*.ts` | multiple | repeated `internalPost` error unwrapping | `internalPostOrThrow` wrapper |

## 3. Access-Safety Review (SAAS Admin and Role Checks)

### Do NOT change now (high break risk)

1. `src/middlelayer/middlewares/access.middleware.ts` (`authorize`)
2. `src/backend/modules/auth/auth.db.modules.ts` (`getUserAccess`)
3. `src/backend/utils/node-access.util.ts` (`verifyInitiationAccess`)
4. `src/backend/utils/workflow-approver.util.ts` (approval-level eligibility engine)

These are core access-control paths. Refactor around them, not inside them first.

### Safe now

- Remove only duplicate controller-level checks that are already covered by middleware, **after route-by-route verification**.
- Keep `adminMiddleware` + `authorize` + backend checks intact during phase 1.

## 4. Validation Duplication (Safe Consolidation)

Safe to consolidate without policy change:

- Shared zod fragments:
  - `companyCode`
  - `id + action + remark`
  - `email`
- Target files:
  - `src/middlelayer/validations/company.validation.ts`
  - `src/middlelayer/validations/org.validation.ts`
  - `src/middlelayer/validations/user.validation.ts`
  - `src/middlelayer/validations/workflow.validation.ts`

Rule: keep same messages and same required/optional semantics.

## 5. Performance Findings (No Schema Change)

### Confirmed hotspots

1. `src/middlelayer/controllers/admin.controller.ts`  
   `initiateCompanyOnboarding`: per-signatory sequential calls.
2. `src/backend/modules/company/company.db.modules.ts`  
   onboarding reject/create flows: repeated company fetch in loops.
3. `src/backend/modules/user/user.db.modules.ts`  
   `handleUserOnboardingStatus`: role/node lookups inside permission loop.

### Safe optimization only

- Batch prefetch `roles` and `orgStructure` before loop.
- Fetch company once per transaction.
- Replace sequential internal calls with `Promise.all` where independent.

No Prisma schema migration required.

## 6. Security Improvements (No Behavior Change)

1. Keep existing auth logic unchanged.
2. Add service-to-service protection on `/internal/*`:
   - HMAC/JWT/mTLS between middlelayer and backend.
3. Remove insecure defaults in prod config only:
   - `JWT_ACCESS_SECRET` must be mandatory
   - `HASH_SECRET` must be mandatory
   - `cookieOptions.secure = true` in production

Files:
- `src/middlelayer/config/index.ts`
- `src/middlelayer/utils/token.util.ts`
- `src/shared/utils/hash.util.ts`

## 7. Schema-Locked Verification

Verified against:
- `prisma/schema.prisma`
- `prisma/seed.ts`

Constraint respected: **no DB schema changes**.

So this audit excludes:
- adding indexes
- generated columns
- table shape changes

## 8. Exact High-Risk Areas (Do Later, Not Now)

Do not refactor deeply in first pass:

1. `WorkflowApproverUtil` (`src/backend/utils/workflow-approver.util.ts`)
2. approval action methods:
   - `UserDbController.handleUserOnboardingStatus`
   - `OrgStructureDbController.updateOrgRequestStatus`
   - `WorkflowDbController.actionWorkflowRequest`
3. `AuthDbController.getUserAccess`

Reason: these directly govern eligibility and maker-checker behavior.

## 9. Safe Refactor Plan (Break-Minimized)

### Phase 1 (safe, immediate)

1. Utility dedupe only:
   - company resolver helper
   - error wrapper helper
   - date formatting helper
2. Batch internal/API/db calls in known loops.
3. Remove dead/unused files/imports only:
   - `src/middlelayer/middlewares/error.middleware.ts` (not used)
   - `import console from 'console'` in `auth.controller.ts`

### Phase 2 (safe structural)

1. Extract shared history formatter used by:
   - `getUserHistory`
   - `fetchOrgHistory`
   - `fetchWorkflowHistory`
2. Keep output contract unchanged.

### Phase 3 (guarded access refactor)

1. Route-by-route verification matrix:
   - SAAS admin routes
   - global-access routes
   - role/node-scoped routes
2. Only then remove duplicated controller auth checks.

## 10. Test Gate Required Before Merge

Because you asked for non-break confidence, require these checks:

1. SAAS admin can access `/api/v1/admin/*`; non-admin cannot.
2. Global-access user vs non-global user visibility stays unchanged.
3. `authorize('initiate'|'approve'|'view', module)` decisions unchanged for:
   - `USER_ACC`
   - `ORG_STR`
   - `WORK_FLOW`
4. Approval chains (single-level and multi-level) produce same statuses/messages.
5. Existing response JSON shapes are unchanged for frontend.

Without these checks, 100% safety cannot be claimed.

## 11. Final “What You Should Do Now”

If your priority is **safe + fast + scalable without breaking access**, do this in order:

1. Keep access engines untouched (`authorize`, `getUserAccess`, `WorkflowApproverUtil`).
2. Implement only duplicate-helper extraction and batching optimizations.
3. Add `/internal/*` service auth between middlelayer and backend.
4. Run regression tests for SAAS admin and role/node access matrix.
5. After clean test pass, proceed to deeper modularization.

This is the safest path under your constraints.
