# Maker-Checker Modification Architecture

## Purpose

This document defines a database-first design for controlled modifications to existing `USER`, `ORG`, and `WORKFLOW` records in the RJFintech multi-tenant finance/ERP application.

It is a proposed implementation design only. It does not change the current Prisma schema or application code.

The central rule is:

> No production user, organization, workflow, or access record is changed because a frontend requested an edit. The backend first persists an immutable change request and approval path, and applies the approved delta only after every required approval and every final impact validation succeeds.

## Recommended Decision

Add a common modification subsystem based on these six tables:

1. `change_request`
2. `change_request_field`
3. `change_request_access`
4. `change_request_approval`
5. `change_request_approval_user`
6. `change_request_history`

Use this subsystem for modifications and inactivation of already active records:

| Module | Supported controlled changes |
| --- | --- |
| `USER` | name, phone, designation, employeeId, reportingManager, status, roles, node access |
| `ORG` | `ACTIVE -> INACTIVE` only |
| `WORKFLOW` | new version for level/approver/AND-OR/mandatory count changes; controlled inactivation |

Initially retain the current onboarding/create paths:

| Existing path | Initial treatment |
| --- | --- |
| `UserOnboarding` | Keep for new user creation; do not use for modifying an active user |
| `OrgStructureReq` | Keep for creating new nodes; do not use for node inactivation |
| `WorkflowReq` | Keep until workflow creation is migrated; use `ChangeRequest` for modifying an active workflow |
| `WorkflowApprover` | Keep for existing request rows; use normalized approval tables for new modification requests |

This additive approach is practical because it avoids rewriting active onboarding behavior while creating one safe modification engine.

---

## 1. Current Codebase Baseline

### 1.1 Present components that can be reused

The repository already has the important foundations:

| Existing capability | Current implementation |
| --- | --- |
| Middlelayer public API | `src/middlelayer/app.ts`, `src/middlelayer/routes/company-setting.routes.ts` |
| Backend internal API and Prisma access | `src/backend/app1.ts`, `src/backend/modules/*` |
| JWT session context | `src/middlelayer/middlewares/auth.middleware.ts` |
| Workflow definitions | `Workflow`, `WorkflowLevel` in `prisma/schema.prisma` |
| Materialized request approvers | `WorkflowApprover` and `src/backend/utils/workflow-approver.util.ts` |
| Notification delivery | `Notification`, `NotificationUser`, `NotificationService` |
| API tracing | `ApiSpan`, middlelayer/backend monitoring middleware |
| Multi-tenant authorization | `UserMapping`, `UserAccess`, org nodes, role permission checks |

### 1.2 Important current limitations for modification processing

The new modification system should correct these limitations in its new endpoints and later remove the older unsafe paths:

| Current behavior | Why it is not sufficient for modifications | Required direction |
| --- | --- | --- |
| `/internal/user/update-status` updates `UserMapping` directly | It bypasses maker-checker approval and does not scope the update by company in its current implementation | Remove public use of direct status updates; status changes become `USER` change requests |
| Middlelayer controllers resolve company IDs, nodes, managers, and approvers | Target architecture says business and DB lookup logic belongs in backend | New middlelayer controller validates shape/JWT/tracking only and forwards the proposed change |
| Some request bodies carry `companyId`, `userId`, or `initiatorId` internally | An identity supplied in a request body is easy to misuse | New backend change endpoints derive actor and tenant only from authenticated request context |
| Existing request data is commonly stored as a JSON payload | It does not produce field-by-field audit records for modifications | Store only changed fields in `change_request_field`, and access deltas in `change_request_access` |
| `WorkflowApprover.approversList` is JSON | It works for current onboarding, but is difficult to query for impact analysis such as "can this user's approval access be removed?" | Normalize modification candidates into `change_request_approval_user` |
| `UserAccess` has no active/inactive lifecycle | Hard deletion or overwrite would lose access audit meaning | Add `status`, `inactiveAt`, and `inactiveBy`; never delete approved access history |
| `OrgStructure` has no status/inactivation audit | It cannot safely represent an inactive node | Add lifecycle fields and block hard delete |
| `Workflow` is not versioned | Editing a used workflow can break pending approvals | Add immutable workflow versions and retain old versions |
| `OrgStructure.nodePath` is globally unique | Tenant isolation should not rely on every company choosing globally different paths | Replace with company-scoped uniqueness and query by `companyId + nodePath` |
| Login currently chooses a mapping and activity handling commonly looks up by `userId` alone | Company-specific inactivation/session invalidation must not be ambiguous in a multi-tenant user account | Require active selected mapping and handle activity/token invalidation by `userId + companyId` |
| Prisma contains `GLOBAL_APPROVER`, but the current workflow Zod validator permits only three approver types | A governed signatory/global level cannot be configured consistently through that validator | Extend workflow validation when modification workflows are added |

### 1.3 Boundary correction for new APIs

Existing internal APIs may be migrated separately. Every new `change-request` endpoint must follow this rule immediately:

```text
Frontend -> Middlelayer -> Backend -> PostgreSQL
            JWT/schema/       all authorization,
            tracking only     business rules and writes
```

The frontend must not submit `companyId`, logged-in `userId`, `initiatedBy`, or `approverId`.

For internal forwarding, use one of these controlled patterns:

1. Preferred: middlelayer forwards the authenticated JWT to an internal backend authentication middleware; backend extracts `userId` and `companyId` from that verified token.
2. Acceptable when services are separately trusted: middlelayer issues a short-lived signed internal assertion containing only verified JWT claims and `x-tracking-id`; backend validates the signature.

Do not trust identity from a JSON body or unsigned `x-user-id` / `x-company-id` headers.

---

## 2. Core Design Principles

| Principle | Design consequence |
| --- | --- |
| Tenant isolation first | Every request row contains `companyId`; every lookup and mutation uses authenticated `companyId` in its predicate |
| Business references outside the DB boundary | Public APIs use `requestNo`, `email`, `nodePath`, or `workflowCode`; never expose row UUIDs |
| Store deltas, not editable snapshots | Only changed fields and access operations are persisted |
| Maker cannot check own change | Initiator is excluded when approver candidates are materialized and is checked again on action |
| Approval configuration is frozen per request | Approval level and candidate rows are created when the request is submitted |
| Live authorization is still checked | A frozen candidate may act only while still active and authorized at action time |
| Approval does not guarantee applicability | Before the final commit, backend repeats dependency and stale-data checks |
| No destructive access/org/workflow update | Access and org are inactivated; workflow is versioned; audit rows are append-only |
| Fail closed for financial changes | If no approved workflow can govern a modification, creation is rejected; do not silently use a fallback approval |

---

## 3. Database-First Model

### 3.1 Table overview

| Table | One row represents | Why it exists |
| --- | --- | --- |
| `change_request` | One proposed modification against one business target in one company | Common request header, workflow binding, lifecycle state, concurrency and application state |
| `change_request_field` | One changed field or logical field path | Precise old/new audit without a full JSON document |
| `change_request_access` | One proposed user role/node-access operation | Access has specialized semantics and safety checks that do not belong in generic field data |
| `change_request_approval` | One frozen approval level for one request | Sequential levels, AND/OR policy, required approval count, level status |
| `change_request_approval_user` | One concrete eligible checker for a level | Queryable candidates, action decisions, and impact blocking before removing checker access |
| `change_request_history` | One immutable audit event | Full event timeline for initiation, approvals, rejection, application, and safety blocks |

### 3.2 Relationship map

```text
Company 1 ---- * ChangeRequest * ---- 1 Workflow (approval workflow version)
User    1 ---- * ChangeRequest                 (initiator)

ChangeRequest 1 ---- * ChangeRequestField
ChangeRequest 1 ---- * ChangeRequestAccess
ChangeRequest 1 ---- * ChangeRequestApproval 1 ---- * ChangeRequestApprovalUser ---- 1 User
ChangeRequest 1 ---- * ChangeRequestHistory ---- 0..1 User (actor)

Target business row is resolved only at runtime:
USER     targetCode = User.email
ORG      targetCode = OrgStructure.nodePath within authenticated company
WORKFLOW targetCode = Workflow.workflowCode within authenticated company
```

The header deliberately does not contain `targetId`. An internal update transaction resolves the target using `companyId` plus its business code.

### 3.3 Business target codes

| Module | `targetType` | `targetCode` | Reason |
| --- | --- | --- | --- |
| `USER` | `USER_PROFILE` | normalized lowercase email, e.g. `priya@acme.in` | Email is already the user business identifier and is not modifiable |
| `ORG` | `ORG_NODE` | node path, e.g. `ACME.ROOT.FINANCE` | Human-readable organization business key |
| `WORKFLOW` | `WORKFLOW_DEFINITION` | new stable `workflowCode`, e.g. `WF-SYSTEM_ACCESS-USER_ACC-ROOT` | `levelsHash` changes when levels change, so it cannot safely identify a workflow across versions |

For existing workflow rows without `workflowCode`, backfill it before supporting modification. `levelsHash` remains a content fingerprint and may be included in views, but it is not the update target key.

---

## 4. Proposed Prisma Schema

The following is an implementation-ready schema direction. It is not yet applied to `prisma/schema.prisma`.

### 4.1 New enums

```prisma
enum ChangeModule {
  USER
  ORG
  WORKFLOW
}

enum ChangeAction {
  MODIFY
  INACTIVATE
}

enum ChangeTargetType {
  USER_PROFILE
  ORG_NODE
  WORKFLOW_DEFINITION
}

enum ChangeRequestStatus {
  PENDING
  APPROVED
  APPLIED
  REJECTED
  CANCELLED
  APPLY_FAILED
}

enum ChangeFieldScope {
  USER
  USER_MAPPING
  ORG_STRUCTURE
  WORKFLOW
  WORKFLOW_LEVEL
}

enum FieldValueType {
  STRING
  BOOLEAN
  NUMBER
  ENUM
  JSON
}

enum AccessOperation {
  ADD
  REMOVE
  UPDATE
}

enum ChangeApprovalStatus {
  WAITING
  ACTIVE
  APPROVED
  REJECTED
  CANCELLED
}

enum ChangeApprovalUserStatus {
  WAITING
  ACTIVE
  APPROVED
  REJECTED
  NOT_REQUIRED
  INVALIDATED
}

enum ChangeHistoryEvent {
  INITIATED
  LEVEL_ACTIVATED
  APPROVED
  REJECTED
  APPLIED
  CANCELLED
  IMPACT_BLOCKED
  APPLY_FAILED
}

enum WorkflowStatus {
  ACTIVE
  INACTIVE
  SUPERSEDED
}
```

### 4.2 New common modification tables

```prisma
model ChangeRequest {
  id               String              @id @default(uuid())
  requestNo        String              @unique @map("request_no")
  companyId        String              @map("company_id")
  module           ChangeModule
  action           ChangeAction
  targetType       ChangeTargetType    @map("target_type")
  targetCode       String              @map("target_code")
  workflowId       String              @map("workflow_id")
  currentLevel     Int                 @default(1) @map("current_level")
  totalLevels      Int                 @map("total_levels")
  initiatedBy      String              @map("initiated_by")
  status           ChangeRequestStatus @default(PENDING)
  reason           String?
  baseSnapshotHash String              @map("base_snapshot_hash")
  impactSummary    Json?               @map("impact_summary")
  appliedBy        String?             @map("applied_by")
  submittedAt      DateTime            @default(now()) @map("submitted_at")
  approvedAt       DateTime?           @map("approved_at")
  appliedAt        DateTime?           @map("applied_at")
  rejectedAt       DateTime?           @map("rejected_at")
  createdAt        DateTime            @default(now()) @map("created_at")
  updatedAt        DateTime            @updatedAt @map("updated_at")

  company          Company                       @relation(fields: [companyId], references: [id])
  workflow         Workflow                      @relation("ChangeRequestApprovalWorkflow", fields: [workflowId], references: [id])
  initiator        User                          @relation("ChangeRequestInitiatedBy", fields: [initiatedBy], references: [id])
  applier          User?                         @relation("ChangeRequestAppliedBy", fields: [appliedBy], references: [id])
  fields           ChangeRequestField[]
  accessChanges    ChangeRequestAccess[]
  approvals        ChangeRequestApproval[]
  history          ChangeRequestHistory[]

  @@index([companyId, status, createdAt])
  @@index([companyId, module, targetCode, status])
  @@index([initiatedBy, status])
  @@index([workflowId, status])
  @@map("change_request")
}

model ChangeRequestField {
  id              String           @id @default(uuid())
  changeRequestId String           @map("change_request_id")
  scope           ChangeFieldScope
  fieldPath       String           @map("field_path")
  valueType       FieldValueType   @map("value_type")
  oldValue        Json?            @map("old_value")
  newValue        Json?            @map("new_value")
  createdAt       DateTime         @default(now()) @map("created_at")
  request         ChangeRequest    @relation(fields: [changeRequestId], references: [id], onDelete: Restrict)

  @@unique([changeRequestId, scope, fieldPath])
  @@index([changeRequestId])
  @@index([scope, fieldPath])
  @@map("change_request_field")
}

model ChangeRequestAccess {
  id                      String          @id @default(uuid())
  changeRequestId         String          @map("change_request_id")
  operation               AccessOperation
  roleName                String          @map("role_name")
  roleCategory            String          @map("role_category")
  roleSubCategory         String          @map("role_sub_category")
  nodePath                String          @map("node_path")
  accessType              AccessType?     @map("access_type")
  accessCategory          UserCategory    @map("access_category")
  isGlobalAccess          Boolean         @default(false) @map("is_global_access")
  previousRoleName        String?         @map("previous_role_name")
  previousRoleCategory    String?         @map("previous_role_category")
  previousRoleSubCategory String?         @map("previous_role_sub_category")
  previousNodePath        String?         @map("previous_node_path")
  previousAccessType      AccessType?     @map("previous_access_type")
  previousAccessCategory  UserCategory?   @map("previous_access_category")
  statusBefore            Status?         @map("status_before")
  statusAfter             Status          @map("status_after")
  createdAt               DateTime        @default(now()) @map("created_at")
  request                 ChangeRequest   @relation(fields: [changeRequestId], references: [id], onDelete: Restrict)

  @@index([changeRequestId, operation])
  @@index([nodePath])
  @@index([roleSubCategory])
  @@map("change_request_access")
}

model ChangeRequestApproval {
  id              String                @id @default(uuid())
  changeRequestId String                @map("change_request_id")
  level           Int
  approver1       ApproverType
  approver2       ApproverType?
  approvalType    ApprovalType          @map("approval_type")
  mandatoryCount  Int                   @map("mandatory_count")
  status          ChangeApprovalStatus  @default(WAITING)
  activatedAt     DateTime?             @map("activated_at")
  completedAt     DateTime?             @map("completed_at")
  createdAt       DateTime              @default(now()) @map("created_at")
  updatedAt       DateTime              @updatedAt @map("updated_at")
  request         ChangeRequest         @relation(fields: [changeRequestId], references: [id], onDelete: Restrict)
  users           ChangeRequestApprovalUser[]

  @@unique([changeRequestId, level])
  @@index([changeRequestId, status, level])
  @@map("change_request_approval")
}

model ChangeRequestApprovalUser {
  id              String                    @id @default(uuid())
  approvalId      String                    @map("approval_id")
  userId          String                    @map("user_id")
  sources         ApproverType[]            @default([]) @map("sources")
  status          ChangeApprovalUserStatus  @default(WAITING)
  remarks         String?
  actedAt         DateTime?                 @map("acted_at")
  createdAt       DateTime                  @default(now()) @map("created_at")
  updatedAt       DateTime                  @updatedAt @map("updated_at")
  approval        ChangeRequestApproval     @relation(fields: [approvalId], references: [id], onDelete: Restrict)
  user            User                      @relation("ChangeRequestApprovalCandidate", fields: [userId], references: [id])

  @@unique([approvalId, userId])
  @@index([userId, status])
  @@index([approvalId, status])
  @@map("change_request_approval_user")
}

model ChangeRequestHistory {
  id              String             @id @default(uuid())
  changeRequestId String             @map("change_request_id")
  companyId       String             @map("company_id")
  event           ChangeHistoryEvent
  level           Int?
  actorId         String?            @map("actor_id")
  remarks         String?
  metadata        Json?
  trackingId      String?            @map("tracking_id")
  createdAt       DateTime           @default(now()) @map("created_at")
  request         ChangeRequest      @relation(fields: [changeRequestId], references: [id], onDelete: Restrict)
  company         Company            @relation(fields: [companyId], references: [id])
  actor           User?              @relation("ChangeRequestHistoryActor", fields: [actorId], references: [id])

  @@index([changeRequestId, createdAt])
  @@index([companyId, createdAt])
  @@index([actorId, createdAt])
  @@index([trackingId])
  @@map("change_request_history")
}
```

`oldValue` and `newValue` are JSON scalar values or the smallest meaningful changed structure, not a whole entity payload. A cleared nullable value is stored as JSON `null` in a row whose presence proves it is an intentional change.

### 4.3 Required relation fields on existing models

Add the relation collections needed by the new models:

```prisma
model User {
  // existing fields remain
  initiatedChangeRequests ChangeRequest[]             @relation("ChangeRequestInitiatedBy")
  appliedChangeRequests   ChangeRequest[]             @relation("ChangeRequestAppliedBy")
  approvalAssignments     ChangeRequestApprovalUser[] @relation("ChangeRequestApprovalCandidate")
  changeHistoryActions    ChangeRequestHistory[]      @relation("ChangeRequestHistoryActor")
  inactivatedAccesses     UserAccess[]                @relation("UserAccessInactiveBy")
  inactivatedOrgNodes     OrgStructure[]              @relation("OrgStructureInactiveBy")
  inactivatedWorkflows    Workflow[]                  @relation("WorkflowInactiveBy")
}

model Company {
  // existing fields remain
  changeRequests         ChangeRequest[]
  changeRequestHistories ChangeRequestHistory[]
}
```

### 4.4 Existing table changes required for safe modification

#### `UserMapping`: tenant status and token invalidation

Status is company-specific in the existing model, so the security token version should also be company-specific.

```prisma
model UserMapping {
  // existing fields remain
  tokenVersion Int      @default(0) @map("token_version")
  inactiveAt   DateTime? @map("inactive_at")

  @@index([companyId, status])
}
```

Use `tokenVersion` in the JWT claim for this company membership:

```json
{
  "userId": "<from authenticated session>",
  "companyId": "<selected active company>",
  "tokenVersion": 4
}
```

The current application also has `UserActivity.version`, hashed into `versionHash` cookies. Keep it for session rotation, but increment `UserMapping.tokenVersion` whenever an approved access/security change must invalidate authorization immediately. On each protected request or refresh, compare the JWT claim with the active mapping row.

Because `UserActivity` is unique by `[userId, companyId]`, login, refresh, logout, and forced invalidation must select/update activity using both values once tenant-specific modification is enabled.

#### `UserAccess`: inactive lifecycle instead of delete

```prisma
model UserAccess {
  // existing fields remain
  status       Status    @default(ACTIVE)
  inactiveAt   DateTime? @map("inactive_at")
  inactiveById String?   @map("inactive_by")
  inactiveBy   User?     @relation("UserAccessInactiveBy", fields: [inactiveById], references: [id])

  @@index([companyId, userId, status])
  @@index([companyId, nodeId, status])
  @@index([companyId, roleCode, status])
}
```

Keep the existing unique tuple `[userId, roleCode, companyId, nodeId]`. An approved `ADD` can reactivate an inactive row rather than create a duplicate. An approved `REMOVE` sets the row to `INACTIVE`.

All access lookup utilities must add `status: ACTIVE` after this migration, including approver resolution and authorization.

#### `OrgStructure`: controlled node inactivity and tenant key correction

```prisma
model OrgStructure {
  // existing fields remain, except nodePath uniqueness below
  nodePath     String    @map("node_path")
  status       Status    @default(ACTIVE)
  inactiveAt   DateTime? @map("inactive_at")
  inactiveById String?   @map("inactive_by")
  updatedAt    DateTime  @updatedAt @map("updated_at")
  inactiveBy   User?     @relation("OrgStructureInactiveBy", fields: [inactiveById], references: [id])

  @@unique([companyId, nodePath])
  @@index([companyId, status])
  @@index([companyId, parentId, status])
}
```

Replace the current globally unique `nodePath` with `@@unique([companyId, nodePath])`. Every backend lookup currently using `findUnique({ nodePath })` must be changed to use the authenticated `companyId` compound key or a tenant-scoped query.

#### `Workflow` and `WorkflowLevel`: immutable versioned definitions

```prisma
model Workflow {
  // existing fields remain
  workflowCode       String         @map("workflow_code")
  version            Int            @default(1)
  status             WorkflowStatus @default(ACTIVE)
  parentLevelsHash   String?        @map("parent_levels_hash")
  isLatest           Boolean        @default(true) @map("is_latest")
  inactiveAt         DateTime?      @map("inactive_at")
  inactiveById       String?        @map("inactive_by")
  previousWorkflowId String?        @map("previous_workflow_id")
  inactiveBy         User?          @relation("WorkflowInactiveBy", fields: [inactiveById], references: [id])
  previousWorkflow   Workflow?      @relation("WorkflowVersionChain", fields: [previousWorkflowId], references: [id])
  nextVersions       Workflow[]     @relation("WorkflowVersionChain")
  changeRequests     ChangeRequest[] @relation("ChangeRequestApprovalWorkflow")

  @@unique([companyId, workflowCode, version])
  @@index([companyId, workflowCode, isLatest, status])
  @@index([companyId, nodeId, module, subModule, status, isLatest])
  @@index([levelsHash])
}

model WorkflowLevel {
  // existing fields remain
  mandatoryCount Int @default(1) @map("mandatory_count")
}
```

Remove the existing uniqueness rule `@@unique([companyId, nodeId, module, subModule, levelsHash])` as the primary identity rule for versioned workflows. It prevents legitimate return-to-previous-configuration versions and does not identify a stable business workflow.

Use a canonical ordered level representation and SHA-256 for new `levelsHash` values. Existing MD5 hashes may remain for historical rows; do not rewrite any request already bound to an existing hash.

### 4.5 PostgreSQL migration constraints not directly expressible in Prisma

Prisma indexes are useful, but two business constraints should be enforced with migration SQL:

```sql
-- Only one open modification for a target in a tenant.
CREATE UNIQUE INDEX uq_change_request_open_target
ON change_request (company_id, module, target_type, target_code)
WHERE status IN ('PENDING', 'APPROVED');

-- Only one latest workflow version per stable workflow code in a tenant.
CREATE UNIQUE INDEX uq_workflow_latest_version
ON workflow (company_id, workflow_code)
WHERE is_latest = true;

ALTER TABLE change_request_approval
ADD CONSTRAINT chk_change_approval_mandatory_count
CHECK (mandatory_count >= 1);
```

The application must also reject requests whose `currentLevel` or status transitions are invalid; check constraints do not replace transaction logic.

---

## 5. What Each Table Stores

### 5.1 `change_request`

This is the public-facing request identity and lifecycle header.

| Column | Purpose |
| --- | --- |
| `requestNo` | Public business reference returned to frontend, e.g. `CR-20260526-000042` |
| `companyId` | Tenant boundary from JWT context, never from frontend |
| `module`, `action` | Determines allowlist and final application handler |
| `targetCode`, `targetType` | Business target, never a DB ID |
| `workflowId` | Internal immutable workflow version used to approve this request |
| `currentLevel`, `totalLevels` | Efficient pending-work queue and progression state |
| `initiatedBy` | Actor derived from JWT |
| `status` | Request lifecycle |
| `baseSnapshotHash` | Hash of approved source values at creation; catches concurrent direct/stale changes at apply time |
| `impactSummary` | Reviewed impact counts/blockers, not the requested data mutation |
| application timestamps | Compliance reporting and operational diagnosis |

### 5.2 `change_request_field`

Store only changed values. The backend compares submitted new values to database values and inserts rows only where values differ.

| Request | Rows persisted |
| --- | --- |
| Phone only | `USER / phone / "9876500000" / "9876500001"` |
| Name and phone | Two rows: `name`, `phone` |
| Designation | `USER_MAPPING / designation / "Analyst" / "Manager"` |
| Employee ID | `USER_MAPPING / employeeId / "EMP018" / "EMP118"` |
| Reporting manager | `USER_MAPPING / reportingManager / "rm.old@acme.in" / "rm.new@acme.in"` |
| User status | `USER_MAPPING / status / "ACTIVE" / "INACTIVE"` |
| Org inactive | `ORG_STRUCTURE / status / "ACTIVE" / "INACTIVE"` |
| Workflow approval type change | `WORKFLOW_LEVEL / levels[2].approvalType / "OR" / "AND"` |
| Workflow mandatory count change | `WORKFLOW_LEVEL / levels[2].mandatoryCount / 1 / 2` |

Not allowed in `USER` modification fields:

| Field | Reason |
| --- | --- |
| `email` | It is the immutable business target code |
| `id` | Internal DB identifier |
| `companyId` | Tenant comes from JWT context |

### 5.3 `change_request_access`

Access modifications are separate because they require eligibility, primary-access, role, node, and logout analysis.

The unprefixed columns describe the requested access tuple. For `UPDATE`, `previous*` columns describe the tuple being replaced. For `REMOVE`, the unprefixed columns describe the existing tuple to inactivate.

| Operation | Storage example |
| --- | --- |
| Add role/node access | `ADD`, `Payment Approver`, `FINANCE`, `AP`, `ACME.ROOT.AP`, `SECONDARY`, `NODE`, `null -> ACTIVE` |
| Remove node access | `REMOVE`, `Payment Approver`, `FINANCE`, `AP`, `ACME.ROOT.AP`, `SECONDARY`, `NODE`, `ACTIVE -> INACTIVE` |
| Update role on node | `UPDATE`, new tuple in normal columns and old tuple in `previous*`; final apply inactivates old and activates/upserts new |

There is never a `DELETE FROM user_access` as a result of a change request.

For a user-status request changing `ACTIVE -> INACTIVE`, the backend expands preview/create into `REMOVE` rows for every active tenant access belonging to the user. This makes the full loss of access visible to checkers and prevents a later reactivation from silently restoring old permissions.

### 5.4 `change_request_approval`

One row is created for each configured level at request creation time. It is a snapshot of the approval rule, so later workflow changes cannot alter an already submitted request.

| Policy | `approvalType` | `mandatoryCount` | Complete when |
| --- | --- | --- | --- |
| Any one reporting manager may approve | `OR` | `1` | First valid approval |
| Two independent checkers required | `AND` | `2` | Two distinct valid users approve |
| Four levels | Four rows | per row | Rows complete sequentially from L1 to L4 |

### 5.5 `change_request_approval_user`

One row represents one concrete eligible user at one approval level. This table solves the important impact question:

```text
Is this user still needed to approve any open request?
```

A requested access removal or user inactivation is blocked if it would invalidate an `ACTIVE` or `WAITING` approval candidate and no safe approved reassignment exists.

The `sources` array records why a user qualified, for example `REPORTING_MANAGER`, `NODE_APPROVER`, or `GLOBAL_APPROVER`.

### 5.6 `change_request_history`

This table is append-only. It must be written in the same transaction as every accepted state transition.

| Event | Written when |
| --- | --- |
| `INITIATED` | Request, field/access rows, and approval path are committed |
| `LEVEL_ACTIVATED` | A first or next level becomes actionable |
| `APPROVED` | A user's approval is accepted |
| `REJECTED` | A rejection terminates the request |
| `IMPACT_BLOCKED` | A stored request cannot be applied because a dependency changed; usually stored when request is transitioned for manual handling |
| `APPLIED` | Final approved values are committed to production tables |
| `APPLY_FAILED` | An operational failure requires controlled retry/manual review, not a silent direct update |

`trackingId` correlates compliance events with `ApiSpan` records.

---

## 6. Request Status and Approval Status Handling

### 6.1 Request state machine

```text
Create request -> PENDING

PENDING --reject--> REJECTED
PENDING --cancel by authorized policy--> CANCELLED
PENDING --all approvals and successful atomic apply--> APPLIED

Optional controlled recovery only:
PENDING --all approvals accepted but controlled application cannot complete--> APPROVED or APPLY_FAILED
```

Preferred implementation applies the modification inside the final approval transaction and moves directly from `PENDING` to `APPLIED`. `APPROVED` and `APPLY_FAILED` exist for operational recovery if application is intentionally separated or a post-approval integration must be retried.

### 6.2 Approval level state machine

```text
Level 1: ACTIVE at creation
Later levels: WAITING at creation

ACTIVE --policy satisfied--> APPROVED
next WAITING level -> ACTIVE

ACTIVE --any accepted rejection--> REJECTED
all later WAITING rows -> CANCELLED
```

### 6.3 Approval user state machine

```text
Candidate in current level: ACTIVE
Candidate in future level: WAITING

ACTIVE --approve--> APPROVED
ACTIVE --reject--> REJECTED
ACTIVE/WAITING --another OR candidate completes level--> NOT_REQUIRED
ACTIVE/WAITING --lost eligibility before acting--> INVALIDATED
```

For `AND`, candidates not yet used remain `ACTIVE` until `mandatoryCount` distinct approvals is reached.

---

## 7. End-to-End Data Flow

### 7.1 Preview, with no database insert

1. Frontend submits the business target and proposed values only.
2. Middlelayer validates JWT, `x-tracking-id`, and request schema, then forwards the proposal and authenticated context.
3. Backend derives `actorUserId` and `companyId` from trusted context.
4. Backend verifies the maker has `modify/initiate` permission for the target node/module.
5. Backend resolves the target by business code under `companyId`.
6. Backend allowlists modifiable fields, fetches old values, removes unchanged fields, and prepares diffs.
7. Backend runs impact checks and resolves which active approval workflow would govern submission.
8. Backend returns diffs, blockers, warnings, and approval policy summary.
9. Nothing is persisted.

### 7.2 Create request

The backend must rerun preview validation; a create call must never trust a prior preview response.

Within one database transaction:

1. Re-resolve tenant target and lock or protect against another open target change.
2. Validate fields and access operations again.
3. Run creation-time impact controls.
4. Select an `ACTIVE`, `isLatest` approval workflow for the module/action.
5. Generate `requestNo`.
6. Insert `change_request` with `PENDING`, `currentLevel = 1`, and a source snapshot hash.
7. Insert only changed `change_request_field` rows.
8. Insert `change_request_access` rows, if applicable.
9. Copy workflow levels to `change_request_approval`.
10. Resolve each level's concrete eligible users and insert `change_request_approval_user`.
11. Fail creation if the approval path cannot satisfy mandatory counts after excluding the maker.
12. Mark level 1 and its candidates `ACTIVE`; leave future levels `WAITING`.
13. Insert `INITIATED` and `LEVEL_ACTIVATED` history rows.

After the commit:

14. Create notifications for current approvers and interested recipients.
15. Return `requestNo`, not internal IDs.

### 7.3 Approve or reject

Within one serializable transaction, or with an explicit `SELECT ... FOR UPDATE` lock on the request:

1. Resolve request by `requestNo` plus JWT `companyId`.
2. Require request `status = PENDING`.
3. Load the `ACTIVE` approval level equal to `currentLevel`.
4. Require an `ACTIVE` approval-user row for JWT `userId`.
5. Require actor is not the initiator and has not already acted successfully on this request.
6. Recheck actor mapping status, `UserAccess.status`, role approval privilege, node scope, and any signatory rule.
7. On reject, write the reject decision/history and terminate the request.
8. On approve, write the approval-user decision and `APPROVED` history row.
9. Evaluate `OR` or `AND` satisfaction.
10. If this level is incomplete, remain at the same level.
11. If the level is complete and more levels exist, activate exactly the next level and increment `currentLevel`.
12. If this is the final level, run final impact and stale-value validation and apply production changes in the same transaction.

After commit, notify the initiator and only the currently actionable next approvers, or final recipients.

### 7.4 Why final revalidation is mandatory

Between submission and final approval:

- A user may become an approver on another request.
- An org node may gain children or active workflows.
- A workflow may become the only valid active approval definition.
- A profile field may have been changed through a migration or emergency operation.

Therefore the backend compares current production values to `oldValue`/`baseSnapshotHash` and reruns impact checks. A mismatch returns a controlled conflict; it must never silently overwrite new production state.

---

## 8. Impact Control Engine

All impact checks run in backend code only. Preview communicates the impact; create and final apply enforce it.

### 8.1 Result format

```json
{
  "impact": {
    "canSubmit": false,
    "canApply": false,
    "blockers": [
      {
        "code": "USER_IS_PENDING_APPROVER",
        "message": "The access cannot be removed while this user is required on pending approvals.",
        "references": ["CR-20260520-000019"]
      }
    ],
    "warnings": []
  }
}
```

Do not return internal candidate IDs, workflow IDs, or database row IDs to the frontend.

### 8.2 USER impact checks

For every user modification, resolve user by `email` and an active/current `UserMapping` under JWT `companyId`.

| Requested change | Mandatory backend checks | Result |
| --- | --- | --- |
| Change `name` or `phone` | Detect whether the same `User` belongs to more than one company | Warn/block according to policy because these fields are currently global, not tenant-specific |
| Change `designation` or `employeeId` | Open request conflict for same target | Block competing open modification |
| Change `reportingManager` | New manager is active in same tenant; no reporting cycle; not being inactivated | Block invalid chain |
| Set user `INACTIVE` | Pending approval assignments, reporting-manager dependents, active sessions, open requests initiated by/for user; expand all active access into visible `REMOVE` deltas | Block until dependencies are reassigned/resolved; invalidate session and inactivate stored access at final apply |
| Remove role/node access | User is candidate in an open approval; role is needed for pending approval; remaining PRIMARY access rule | Block unsafe removal |
| Add/update access | Node and role active; no duplicate effective access; maker allowed to grant scope | Block invalid grant |
| Corp admin/signatory change | Initiator and final checker meet signatory governance | Block unless signatory policy succeeds |

Pending approver lookup for new modification requests:

```text
change_request_approval_user.userId = affected user
AND change_request_approval_user.status IN (ACTIVE, WAITING)
AND parent request.status = PENDING
```

During migration, the same check must also examine existing open `WorkflowApprover` JSON candidates for `UserOnboarding`, `OrgStructureReq`, and `WorkflowReq`, or those old request types must be drained before protected access removals are enabled.

#### Important profile ownership decision

`User.name` and `User.phone` are global in the current schema, while designation/status/manager are tenant-specific in `UserMapping`. If a person can belong to multiple companies, a company-scoped request changing `User.name` or `User.phone` changes what every tenant sees.

Choose one policy before implementation:

| Policy | Practical effect |
| --- | --- |
| Shared master identity | Allow global profile changes only through a privileged/global workflow and show all impacted tenant memberships in preview |
| Tenant-specific profile, recommended when companies own displayed employee data | Add tenant display name/phone fields to `UserMapping` and modify those through `USER` change requests |

Do not silently treat a global `User.phone` change as tenant-local.

### 8.3 ORG impact checks

Supported change:

```text
OrgStructure.status: ACTIVE -> INACTIVE
```

Not supported:

```text
INACTIVE -> ACTIVE
nodePath update
nodeName update
hard delete
```

| Condition at preview/create/final apply | Required outcome |
| --- | --- |
| Node already inactive | Reject as no longer actionable |
| Active child nodes exist | Block inactivation |
| Active `UserAccess` rows are attached | Block until separate approved user remapping/removal requests have applied |
| Active/latest workflows refer to node | Block until workflow replacement/inactivation requests have applied |
| Pending changes target this node or depend on it for approval | Block |
| Active PRIMARY users on node | Block; never silently move primary users |

#### Child node movement is not part of this inactivation request

The current `nodePath` represents hierarchy, for example `ROOT.FINANCE.AP`. Moving a child under another parent would require changing its `nodePath` and descendant paths. The requirement also prohibits node path updates. These rules cannot both support automatic child movement.

Therefore the safe initial implementation is:

1. Block node inactivation when children exist.
2. Require a separately designed organization-restructure workflow if node movement is later needed.
3. Do not automatically rewrite paths, children, access, or workflows during inactivation.

#### User access/remapping treatment

Do not bundle silent user remapping into an org inactivation. Require the affected user access or manager changes to be approved first through `USER` change requests. Once no active access, workflow, pending request, or child dependency remains, the org request may be applied.

This sequencing produces auditable requests per affected business target and avoids an unreviewable mass mutation.

### 8.4 WORKFLOW impact checks

Supported changes:

| Requested change | Apply behavior |
| --- | --- |
| Update approval levels or approvers | Create a new immutable workflow version |
| Change `AND` / `OR` | Create a new immutable workflow version |
| Change `mandatoryCount` | Create a new immutable workflow version |
| Inactivate workflow | Mark latest workflow inactive only under replacement/pending safety rules |

Never:

- Update `WorkflowLevel` rows already used by requests.
- Delete a workflow or workflow level.
- Rebind a pending request to a newer workflow.
- Allow an inactivation that leaves a controlled module without an approved active workflow.

| Condition | Required outcome |
| --- | --- |
| A pending request is already bound to old workflow version and has materialized approval rows | Keep old version; the pending request continues with its frozen approval path |
| Existing legacy pending requests still depend on `WorkflowApprover`/old workflow behavior | Retain old workflow and block destructive cleanup; do not delete or mutate it |
| New levels resolve to insufficient distinct active checkers | Reject preview/create |
| Proposed inactivation removes the only current workflow for a module/action/node | Block unless replacement version is approved first |
| Concurrent workflow modification already open for `workflowCode` | Block through open-target uniqueness |

---

## 9. Module-Specific Final Application

### 9.1 Common final transaction rules

The final approver action transaction must:

1. Lock the open `change_request`.
2. Recheck approval actor eligibility.
3. Re-read target rows by `companyId + targetCode`.
4. Compare current values against persisted `oldValue` and `baseSnapshotHash`.
5. Rerun module impact controls.
6. Write the final approval decision.
7. Apply only the stored approved deltas.
8. Write `APPLIED` history.
9. Set request to `APPLIED`, `approvedAt`, `appliedAt`, and `appliedBy`.

If steps 3 through 5 fail, no final approval and no production update commit.

### 9.2 USER final apply

Resolve:

```text
User.email = change_request.targetCode
UserMapping.userId = resolved User.id
UserMapping.companyId = JWT companyId
```

Apply generic fields by allowlisted scope:

| Scope | Allowed applied fields |
| --- | --- |
| `USER` | `name`, `phone`, subject to shared-profile policy |
| `USER_MAPPING` | `designation`, `employeeId`, `reportingManager`, `status` |

Apply access rows:

| Operation | Atomic update |
| --- | --- |
| `ADD` | Resolve active role and active node by business values, then create or reactivate `UserAccess` as `ACTIVE` |
| `REMOVE` | Resolve exact active tuple, set `status = INACTIVE`, `inactiveAt = now`, `inactiveById = checker` |
| `UPDATE` | Inactivate the previous tuple and activate/upsert the requested new tuple in the same transaction |

If the approved field delta sets the tenant user mapping to `INACTIVE`, apply the backend-generated `REMOVE` access rows in the same transaction. A later `ACTIVE` request is permitted only with explicitly reviewed `ADD` access rows, including exactly one required primary assignment where applicable.

After any user inactivation or permission-reducing access change:

```text
UserMapping.tokenVersion = tokenVersion + 1
UserActivity where (userId, companyId).refreshToken = null
UserActivity where (userId, companyId).version = null
UserActivity where (userId, companyId).forceLogToken = null
UserActivity where (userId, companyId).expiryAt = now
```

Authentication behavior:

- Login must reject a tenant mapping with `status = INACTIVE`.
- Protected requests must reject JWTs whose `tokenVersion` no longer equals the active mapping version.
- Permission checks must consider only `UserAccess.status = ACTIVE`.

### 9.3 ORG final apply

Resolve the node using:

```text
OrgStructure.companyId = JWT companyId
OrgStructure.nodePath = change_request.targetCode
OrgStructure.status = ACTIVE
```

After revalidating zero blocking dependencies, apply only:

```text
status       = INACTIVE
inactiveAt   = now
inactiveById = final checker userId
```

No node deletion, node name modification, path rewrite, child move, workflow move, or user access move is performed by this action.

### 9.4 WORKFLOW final apply

Resolve old latest version using `companyId + workflowCode` and compare it with the version/hash captured by the request.

For `MODIFY`:

1. Calculate canonical new levels and new `levelsHash`.
2. Mark old latest row `isLatest = false`, `status = SUPERSEDED`.
3. Insert new `Workflow` row with the same `workflowCode`, `version = old.version + 1`, `isLatest = true`, `status = ACTIVE`, `parentLevelsHash = old.levelsHash`, and `previousWorkflowId = old.id`.
4. Insert new immutable `WorkflowLevel` rows with the approved values and `mandatoryCount`.
5. Do not modify old workflow levels or any pending request approval rows.

For `INACTIVATE`:

1. Confirm a replacement active/latest workflow exists when the module must remain available, or require an approved replacement request first.
2. Set the target latest row to `status = INACTIVE`, `isLatest = false`, `inactiveAt`, and `inactiveById`.
3. Preserve all historical rows.

---

## 10. Approval Engine

### 10.1 Workflow selection for modifications

Define approved workflows for modification submodules, for example:

| Module | Suggested controlled submodule |
| --- | --- |
| User edit/access | `USER_MODIFY` |
| Org inactivation | `ORG_INACTIVATE` |
| Workflow change/inactivation | `WORKFLOW_MODIFY` |

These may use the existing `Workflow` and `WorkflowLevel` definitions once versioning fields are added. Unlike current onboarding fallback behavior, modifications must fail closed when no active approved workflow is configured.

### 10.2 Resolving concrete users

The backend can reuse the concepts already implemented in `WorkflowApproverUtil`:

| `ApproverType` | Resolution rule |
| --- | --- |
| `REPORTING_MANAGER` | Active manager chain for the affected user or maker, scoped to company and required approve-enabled role |
| `NODE_APPROVER` | Active approvers on the target node for the submodule |
| `HIERARCHY_APPROVER` | Active approvers on ancestor nodes |
| `GLOBAL_APPROVER` | Active signatory/global access checker for the company |

Additional modification rules:

- Resolve from `UserAccess.status = ACTIVE` only.
- Exclude maker from every level.
- Validate each candidate has `UserMapping.status = ACTIVE`.
- Persist one queryable `ChangeRequestApprovalUser` row per candidate.
- Require enough distinct candidates for all mandatory approvals.
- At action time, revalidate the acting candidate rather than assuming the snapshot still authorizes them.

### 10.3 OR and AND behavior

| Policy | User action behavior |
| --- | --- |
| `OR`, `mandatoryCount = 1` | First valid approval marks the level `APPROVED`; all remaining current-level candidate rows become `NOT_REQUIRED` |
| `AND`, `mandatoryCount = 2` | First approval leaves level `ACTIVE`; second distinct valid approval completes it |
| Any rejection | Current level becomes `REJECTED`, future levels `CANCELLED`, request `REJECTED`; no final modification occurs |

Existing code treats `AND` as a required count across the resolved candidate union. The normalized design keeps that behavior. If policy later requires one approval from each distinct source pool, add an explicit slot/source satisfaction rule before enabling that workflow type.

### 10.4 Four-level exact example

Request:

| Header field | Stored value |
| --- | --- |
| `requestNo` | `CR-20260526-000042` |
| `module` | `USER` |
| `action` | `MODIFY` |
| `targetCode` | `anita@acme.in` |
| `workflowId` | Internal ID of approved `USER_MODIFY_STD` version 3 |
| `currentLevel` / `totalLevels` | `1 / 4` |
| `status` | `PENDING` |

Changed field row:

| Scope | Field path | Old value | New value |
| --- | --- | --- | --- |
| `USER` | `phone` | `"9876500000"` | `"9876500001"` |

Approval rows inserted at create time:

| Level | `approver1` | Type | Required | Initial status |
| --- | --- | --- | --- | --- |
| 1 | `REPORTING_MANAGER` | `OR` | 1 | `ACTIVE` |
| 2 | `NODE_APPROVER` | `OR` | 1 | `WAITING` |
| 3 | `HIERARCHY_APPROVER` | `OR` | 1 | `WAITING` |
| 4 | `GLOBAL_APPROVER` | `OR` | 1 | `WAITING` |

Concrete candidate rows inserted:

| Level | User business display | Sources | Initial status |
| --- | --- | --- | --- |
| 1 | `rm.finance@acme.in` | `REPORTING_MANAGER` | `ACTIVE` |
| 2 | `node.checker@acme.in` | `NODE_APPROVER` | `WAITING` |
| 3 | `division.checker@acme.in` | `HIERARCHY_APPROVER` | `WAITING` |
| 4 | `signatory@acme.in` | `GLOBAL_APPROVER` | `WAITING` |

Progression:

| Action | Approval row changes | Header change | Notification |
| --- | --- | --- | --- |
| Maker submits | L1 `ACTIVE`; L2-L4 `WAITING` | `currentLevel = 1`, `PENDING` | Notify L1 checker |
| RM approves | L1 `APPROVED`, L2 `ACTIVE` | `currentLevel = 2` | Notify maker and L2 |
| Node approver approves | L2 `APPROVED`, L3 `ACTIVE` | `currentLevel = 3` | Notify maker and L3 |
| Hierarchy approver approves | L3 `APPROVED`, L4 `ACTIVE` | `currentLevel = 4` | Notify maker and L4 |
| Global approver approves | L4 `APPROVED`, production phone updated transactionally | `status = APPLIED` | Notify maker, affected user, signatory/SaaS recipients per policy |

### 10.5 AND example inside a level

| Level | Approvers | Type | `mandatoryCount` | Candidates |
| --- | --- | --- | --- | --- |
| 2 | `NODE_APPROVER` plus `HIERARCHY_APPROVER` | `AND` | `2` | `node.checker@acme.in`, `division.checker@acme.in` |

After the first valid approval, level 2 remains `ACTIVE` and `currentLevel` remains `2`. It changes to `APPROVED` only when the second distinct candidate approves.

---

## 11. Public API Contract: Frontend to Middlelayer

Use the existing public prefix:

```text
/api/v1/company-settings/change-requests
```

All endpoints require authenticated cookies or bearer JWT and support `x-tracking-id`. The frontend does not send logged-in identity or tenant IDs.

### 11.1 Endpoint list

| Purpose | Public endpoint | Middlelayer responsibility | Backend responsibility |
| --- | --- | --- | --- |
| Preview | `POST /change-requests/preview` | JWT, schema, tracking, forward | Diff, permissions, impacts, workflow preview; no DB insert |
| Create | `POST /change-requests` | JWT, schema, tracking, forward | Revalidate and store request/approvals/history |
| Act | `POST /change-requests/action` | JWT, schema, tracking, forward | Validate checker, advance/reject/apply |
| Detail | `POST /change-requests/detail` | JWT, schema, tracking, forward | Tenant-filtered request details |
| List | `POST /change-requests/list` | JWT, schema, tracking, forward | Tenant/user work queue and filters |
| History | `POST /change-requests/history` | JWT, schema, tracking, forward | Immutable event timeline |

Suggested internal equivalents:

```text
POST /internal/change-requests/preview
POST /internal/change-requests/create
POST /internal/change-requests/action
POST /internal/change-requests/detail
POST /internal/change-requests/list
POST /internal/change-requests/history
```

### 11.2 Preview: USER field and access change

Request:

```json
{
  "module": "USER",
  "action": "MODIFY",
  "targetCode": "anita@acme.in",
  "reason": "Updated contact and revised AP access",
  "changes": [
    { "field": "phone", "newValue": "9876500001" },
    { "field": "designation", "newValue": "Senior Finance Analyst" }
  ],
  "accessChanges": [
    {
      "operation": "REMOVE",
      "roleName": "Payment Approver",
      "roleCategory": "FINANCE",
      "roleSubCategory": "AP",
      "nodePath": "ACME.ROOT.AP",
      "accessType": "SECONDARY",
      "accessCategory": "NODE"
    }
  ]
}
```

Response when safe:

```json
{
  "module": "USER",
  "action": "MODIFY",
  "targetCode": "anita@acme.in",
  "diff": [
    {
      "scope": "USER",
      "field": "phone",
      "oldValue": "9876500000",
      "newValue": "9876500001"
    },
    {
      "scope": "USER_MAPPING",
      "field": "designation",
      "oldValue": "Finance Analyst",
      "newValue": "Senior Finance Analyst"
    }
  ],
  "accessDiff": [
    {
      "operation": "REMOVE",
      "roleName": "Payment Approver",
      "nodePath": "ACME.ROOT.AP",
      "oldStatus": "ACTIVE",
      "newStatus": "INACTIVE"
    }
  ],
  "impact": {
    "canSubmit": true,
    "blockers": [],
    "warnings": []
  },
  "approvalPolicy": {
    "workflowCode": "WF-USER-MODIFY",
    "version": 3,
    "levels": [
      { "level": 1, "type": "OR", "mandatoryCount": 1 },
      { "level": 2, "type": "OR", "mandatoryCount": 1 }
    ]
  }
}
```

Response when the removal would break an approval:

```json
{
  "module": "USER",
  "action": "MODIFY",
  "targetCode": "anita@acme.in",
  "impact": {
    "canSubmit": false,
    "blockers": [
      {
        "code": "USER_IS_PENDING_APPROVER",
        "message": "Payment Approver access at ACME.ROOT.AP is required for a pending request.",
        "references": ["CR-20260522-000031"]
      }
    ],
    "warnings": []
  }
}
```

### 11.3 Preview: ORG inactivation

Request:

```json
{
  "module": "ORG",
  "action": "INACTIVATE",
  "targetCode": "ACME.ROOT.FINANCE.AP",
  "reason": "AP team retired after restructuring",
  "changes": [
    { "field": "status", "newValue": "INACTIVE" }
  ]
}
```

Response with blocked impact:

```json
{
  "module": "ORG",
  "action": "INACTIVATE",
  "targetCode": "ACME.ROOT.FINANCE.AP",
  "diff": [
    {
      "scope": "ORG_STRUCTURE",
      "field": "status",
      "oldValue": "ACTIVE",
      "newValue": "INACTIVE"
    }
  ],
  "impact": {
    "canSubmit": false,
    "blockers": [
      { "code": "ACTIVE_PRIMARY_USERS_EXIST", "count": 2 },
      { "code": "ACTIVE_WORKFLOWS_EXIST", "count": 1 }
    ],
    "warnings": []
  }
}
```

### 11.4 Preview: WORKFLOW version modification

Frontend uses stable `workflowCode`, not an internal row ID and not a changing hash.

Request:

```json
{
  "module": "WORKFLOW",
  "action": "MODIFY",
  "targetCode": "WF-SYSTEM_ACCESS-USER_ACC-ROOT",
  "reason": "Require hierarchy check at level 2",
  "changes": [
    {
      "field": "levels",
      "newValue": [
        {
          "level": 1,
          "approver1": "REPORTING_MANAGER",
          "approvalType": "OR",
          "mandatoryCount": 1
        },
        {
          "level": 2,
          "approver1": "NODE_APPROVER",
          "approver2": "HIERARCHY_APPROVER",
          "approvalType": "AND",
          "mandatoryCount": 2
        }
      ]
    }
  ]
}
```

Backend comparison persists only actual changed paths, for example:

```json
{
  "diff": [
    {
      "scope": "WORKFLOW_LEVEL",
      "field": "levels[2].approver2",
      "oldValue": null,
      "newValue": "HIERARCHY_APPROVER"
    },
    {
      "scope": "WORKFLOW_LEVEL",
      "field": "levels[2].approvalType",
      "oldValue": "OR",
      "newValue": "AND"
    },
    {
      "scope": "WORKFLOW_LEVEL",
      "field": "levels[2].mandatoryCount",
      "oldValue": 1,
      "newValue": 2
    }
  ],
  "resultingVersion": 4,
  "impact": {
    "canSubmit": true,
    "blockers": [],
    "warnings": [
      {
        "code": "OLD_VERSION_RETAINED_FOR_PENDING_REQUESTS",
        "message": "Pending approvals remain bound to version 3."
      }
    ]
  }
}
```

### 11.5 Create request

Request body is the same approved proposal shape used for preview. The backend recomputes the diff and impact.

Success:

```json
{
  "message": "Change request submitted for approval",
  "requestNo": "CR-20260526-000042",
  "status": "PENDING",
  "currentLevel": 1,
  "totalLevels": 4,
  "targetCode": "anita@acme.in"
}
```

No internal `id`, `companyId`, `userId`, `workflowId`, or candidate user ID is returned.

### 11.6 Action: approve or reject

Request:

```json
{
  "requestNo": "CR-20260526-000042",
  "action": "APPROVE",
  "remarks": "Contact change verified against employee record"
}
```

Partial approval response:

```json
{
  "requestNo": "CR-20260526-000042",
  "status": "PENDING",
  "approvedLevel": 1,
  "currentLevel": 2,
  "message": "Approval recorded; next approval level is active."
}
```

Final approval response:

```json
{
  "requestNo": "CR-20260526-000042",
  "status": "APPLIED",
  "message": "Final approval recorded and approved changes applied."
}
```

Reject request:

```json
{
  "requestNo": "CR-20260526-000042",
  "action": "REJECT",
  "remarks": "Access removal conflicts with current approval responsibility"
}
```

Rejected response:

```json
{
  "requestNo": "CR-20260526-000042",
  "status": "REJECTED",
  "message": "Change request rejected; no production values were changed."
}
```

### 11.7 Detail, list, and history

Detail request:

```json
{ "requestNo": "CR-20260526-000042" }
```

List request:

```json
{
  "module": "USER",
  "status": "PENDING",
  "assignment": "MY_ACTIONABLE",
  "page": 1,
  "limit": 20
}
```

History request:

```json
{ "requestNo": "CR-20260526-000042" }
```

The backend tenant-filters each operation using JWT `companyId`. A checker list query joins the authenticated user to `change_request_approval_user` in `ACTIVE` status.

---

## 12. Notifications

Reuse `Notification` and `NotificationUser`; add notification content mappings for change requests and use `referenceId = requestNo` rather than exposing the change request UUID.

Recommended notification events:

| Event | Recipients |
| --- | --- |
| Request created | Current level approvers, initiator confirmation if desired, SaaS admin/signatory by policy |
| Intermediate approval | Initiator and newly active approvers |
| Rejected | Initiator, affected user for user requests, governance recipients |
| Applied user change | Initiator, affected user, reporting manager when relevant, SaaS admin/signatory for privileged access changes |
| Applied org inactivation | Initiator, governance recipients, affected operational owners |
| Applied workflow change | Initiator, SaaS admin/signatory, workflow governance owners |

Notification requirements:

- Filter normal recipients to active tenant memberships.
- Do not notify future approval levels until they are activated.
- Do not put sensitive old/new values such as phone numbers into notification text.
- `NotificationUser.status` continues to support `UNREAD`, `READ`, and `ARCHIVED`.

---

## 13. API Monitoring and Audit Correlation

The current `ApiSpan` model and tracking middleware already support:

- `x-tracking-id`
- `MIDDLELAYER` spans
- `BACKEND` spans
- request/response timing and status

Use them for all new endpoints:

| Request | Required spans |
| --- | --- |
| Preview | Middlelayer plus backend span; no change history row |
| Create | Middlelayer plus backend span; `INITIATED` history row stores `trackingId` |
| Approve/reject | Middlelayer plus backend span; decision history row stores `trackingId` |
| Final application | Same action span correlated with `APPLIED` history |

Security adjustment for new change APIs:

- Source `companyId` and `userId` in `ApiSpan` from authenticated context only.
- Do not let monitoring identity enrichment use frontend body fields for these endpoints.
- Sanitize tokens, cookies, and sensitive changed values in stored request/response bodies.

---

## 14. Backend Service Structure

A practical implementation shape consistent with the repository is:

```text
src/middlelayer/routes/company-setting.routes.ts
  -> add /change-requests/* routes

src/middlelayer/validations/change-request.validation.ts
  -> shape validation only; explicitly reject companyId/userId/initiatedBy/approverId

src/middlelayer/controllers/change-request/change-request.controller.ts
  -> forward validated payload and trusted auth context only

src/backend/routes/change-request.db.routes.ts
  -> internal endpoints

src/backend/modules/change-request/change-request.db.modules.ts
  -> preview/create/action/list/detail/history orchestration

src/backend/services/change-request/
  -> user-change.service.ts
  -> org-change.service.ts
  -> workflow-change.service.ts
  -> change-impact.service.ts
  -> change-approval.service.ts
```

Backend services may reuse resolver concepts in `WorkflowApproverUtil`, but modification approval persistence should use the normalized `ChangeRequestApproval` and `ChangeRequestApprovalUser` tables.

---

## 15. Transaction and Concurrency Requirements

| Risk | Protection |
| --- | --- |
| Two makers edit the same target | Partial unique open-target index and create-time conflict response |
| Two checkers act on the same level concurrently | Serializable transaction or row locking on request/active approval level |
| Direct/emergency edit occurred after initiation | Compare `oldValue` and `baseSnapshotHash` at final apply |
| Candidate lost permission after request creation | Revalidate live access at action; invalidate/block candidate if unsafe |
| Permission removal breaks another pending approval | Query normalized candidates and block at preview/create/final apply |
| Workflow edited while pending request uses it | Frozen approval rows and immutable workflow versions |

All final updates and audit status changes must be in one Prisma `$transaction`. Notifications and SSE emission should occur after commit so a notification never announces an update that rolled back.

---

## 16. Practical Migration Plan

### Phase 1: Database foundations

1. Add the six change-request tables and enums.
2. Add `UserAccess.status/inactiveAt/inactiveBy`, default existing access rows to `ACTIVE`.
3. Add `OrgStructure.status/inactiveAt/inactiveBy/updatedAt`, default existing nodes to `ACTIVE`.
4. Add `UserMapping.tokenVersion` and `inactiveAt`.
5. Add workflow version columns and `WorkflowLevel.mandatoryCount`; introduce `workflowCode` as nullable during migration, backfill existing workflows as version `1`, active, latest with generated stable codes, then make `workflowCode` required.
6. Replace global node path uniqueness with tenant-scoped uniqueness after checking for duplicates.
7. Create PostgreSQL partial unique indexes.

### Phase 2: New common modification APIs

1. Add middlelayer validation/forwarding routes and backend common endpoints.
2. Implement preview and create for `USER`, then action and final application.
3. Implement `ORG` inactivation with dependency blocking.
4. Implement `WORKFLOW` immutable version modifications.
5. Add notification templates and monitoring correlation.

### Phase 3: Close bypass paths

1. Remove or make internal-only any direct active-user status modification path such as current `update-status`.
2. Ensure all access changes use the common request system.
3. Require `status: ACTIVE` in all role/access/approver resolution queries.
4. Reject identity fields from frontend change schemas.
5. Protect backend internal auth context and stop using body identity for new authorization decisions.

### Phase 4: Optional convergence

After existing pending onboarding requests are drained, decide whether new user/org/workflow creation should also migrate from `UserOnboarding`, `OrgStructureReq`, `WorkflowReq`, and JSON `WorkflowApprover` rows into the common normalized request engine.

---

## 17. Acceptance Checklist

The modification system is ready for production only when all answers below are yes:

| Check | Required |
| --- | --- |
| Frontend payload never accepts logged-in `companyId` or `userId` | Yes |
| Backend derives actor/tenant from trusted authentication context | Yes |
| Public operations identify request by `requestNo`, not DB ID | Yes |
| Only changed fields are persisted | Yes |
| User access changes are persisted separately and never hard delete history | Yes |
| Maker is excluded from approvals and blocked again on action | Yes |
| AND/OR and mandatory counts are enforced using concrete candidate rows | Yes |
| A candidate losing access cannot still approve | Yes |
| Removing checker access is blocked while required on pending work | Yes |
| Org node inactivation is blocked while dependencies exist | Yes |
| Org nodes are never hard deleted or silently moved | Yes |
| Workflow updates create immutable versions and preserve pending approvals | Yes |
| Final apply repeats impact and stale-data validation | Yes |
| Production update plus audit state commits atomically | Yes |
| Security-affecting user change invalidates active sessions/tokens | Yes |
| Notifications occur only after committed state transitions | Yes |
| `x-tracking-id` correlates API spans and audit history | Yes |

## Final Recommendation

Implement modifications as a new normalized `ChangeRequest` subsystem and leave the current onboarding/create flow in place during the first rollout. This isolates risk, provides field-level and access-level auditing, makes approval candidates queryable for impact checks, and enables safe workflow versioning without breaking pending work.

The most important non-negotiable implementation decisions are:

1. Remove direct production update paths for controlled changes.
2. Derive tenant and actor only from authenticated context.
3. Persist approval-user rows rather than relying on JSON candidates for new modifications.
4. Apply the approved delta only in the final approval transaction after impact revalidation.
5. Block unsafe inactivation or access removal instead of silently moving dependent data.
