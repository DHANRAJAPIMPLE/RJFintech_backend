# Notification Event Matrix

This document lists the exact `notifications.type` and `notifications.reference_type`
values written by the current codebase.

## 1. Notification table schema

Source: [prisma/schema.prisma](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/prisma/schema.prisma:202)

`notifications` stores:

| Column | Meaning |
| --- | --- |
| `type` | Final normalized notification type stored in DB |
| `reference_type` | Business area: `USER`, `ORG`, `WORKFLOW`, `COMPANY`, or `null` |
| `reference_id` | Request/entity id used by the notification |
| `is_pending` | Whether the notification is still pending action |
| `created_by` | Actor user id |

## 2. Supported stored notification types

Source: [src/backend/modules/notifications/notification.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/notifications/notification.db.modules.ts:7)

| Stored `notifications.type` | Meaning in current code |
| --- | --- |
| `INITIATE` | New request raised and waiting for approval |
| `APPROVE` | Level approval / partial approval |
| `REJECT` | Request rejected |
| `ONBOARDED` | Final successful onboarding or approved create flow |
| `MODIFICATION` | Update/modification event or failure/block message |
| `ACTIVE` | Activation event |
| `INACTIVE` | Inactivation/removal event |
| `ARCHIVE` | Archive/delete event |
| `AUTO_DELETE` | System-driven deletion/cleanup event |

Important mapping rules:

| Business action | Stored `notifications.type` |
| --- | --- |
| `UPDATE` request | `MODIFICATION` |
| `INITIATE` request approved finally | `ONBOARDED` |
| Any request partially approved at a level | `APPROVE` |
| Request rejected | `REJECT` |
| Org inactivation approval | `INACTIVE` |
| Workflow or user archive approval | `ARCHIVE` |

## 3. Exact event matrix

### User notifications

| Business event | Stored `type` | `reference_type` | Where sent from |
| --- | --- | --- | --- |
| New user initiation | `INITIATE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:8426) |
| User update initiation | `MODIFICATION` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:7902) via `getUserNotificationType()` |
| User activation initiation | `ACTIVE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:7902) via `getUserNotificationType()` |
| User inactivation initiation | `INACTIVE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:7902) via `getUserNotificationType()` |
| User archive initiation | `ARCHIVE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:7902) via `getUserNotificationType()` |
| User request level approval | `APPROVE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:9157) |
| New user fully approved / onboarded | `ONBOARDED` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:9185) via `getUserNotificationType()` |
| User update fully approved | `MODIFICATION` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:9185) via `getUserNotificationType()` |
| User activation fully approved | `ACTIVE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:9185) via `getUserNotificationType()` |
| User inactivation fully approved | `INACTIVE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:9185) via `getUserNotificationType()` |
| User archive fully approved | `ARCHIVE` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:9185) via `getUserNotificationType()` |
| Any user request rejected | `REJECT` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:9185) via `getUserNotificationType()` |
| User modification blocked/failed | `MODIFICATION` | `USER` | [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:322), [user.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/user/user.db.modules.ts:10325) |

### Organization notifications

| Business event | Stored `type` | `reference_type` | Where sent from |
| --- | --- | --- | --- |
| New org initiation | `INITIATE` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:3900) |
| Org update initiation | `MODIFICATION` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:2744) via `getOrgNotificationType()` |
| Org request level approval | `APPROVE` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:3575) |
| New org fully approved / onboarded | `ONBOARDED` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:3575) via `getOrgNotificationType()` |
| Org update fully approved | `MODIFICATION` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:3575) via `getOrgNotificationType()` |
| Org request rejected | `REJECT` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:3575) via `getOrgNotificationType()` |
| Org inactivation approved | `INACTIVE` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:3575) special branch |
| Organization modification failed | `MODIFICATION` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:801) |
| New org caused workflow auto-generation | `ONBOARDED` | `WORKFLOW` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:1392) |
| Org inactivation auto-deleted workflows | `AUTO_DELETE` | `WORKFLOW` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:1452) |
| New org caused inherited access creation | `MODIFICATION` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:1920) |
| Org inactivation removed existing access | `INACTIVE` | `ORG` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:1947) |
| Org inactivation cleaned pending user request access | `MODIFICATION` | `USER` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:1990) |
| Org inactivation deleted pending workflow request | `AUTO_DELETE` | `WORKFLOW` | [org.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/org/org.db.modules.ts:2030) |

### Workflow notifications

| Business event | Stored `type` | `reference_type` | Where sent from |
| --- | --- | --- | --- |
| New workflow initiation | `INITIATE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:3842) |
| Workflow update initiation | `MODIFICATION` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:3233) via `getWorkflowNotificationType()` |
| Workflow activation initiation | `ACTIVE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:3233) via `getWorkflowNotificationType()` |
| Workflow inactivation initiation | `INACTIVE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:3233) via `getWorkflowNotificationType()` |
| Workflow archive initiation | `ARCHIVE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:3233) via `getWorkflowNotificationType()` |
| Workflow request level approval | `APPROVE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4372) |
| New workflow fully approved / onboarded | `ONBOARDED` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4372) via `getWorkflowNotificationType()` |
| Workflow update fully approved | `MODIFICATION` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4372) via `getWorkflowNotificationType()` |
| Workflow activation fully approved | `ACTIVE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4372) via `getWorkflowNotificationType()` |
| Workflow inactivation fully approved | `INACTIVE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4372) via `getWorkflowNotificationType()` |
| Workflow archive fully approved | `ARCHIVE` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4372) via `getWorkflowNotificationType()` |
| Workflow request rejected | `REJECT` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4372) via `getWorkflowNotificationType()` |
| Workflow auto-generated for child nodes | `ONBOARDED` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:2738) |
| Workflow modification blocked | `MODIFICATION` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:3669) |
| Workflow request failed | `MODIFICATION` | `WORKFLOW` | [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:1108), [workflow.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/workflow/workflow.db.modules.ts:4438) |

### Company notifications

| Business event | Stored `type` | `reference_type` | Where sent from |
| --- | --- | --- | --- |
| Company onboarding initiation | `INITIATE` | `COMPANY` | [company.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/company/company.db.modules.ts:1055) |
| Company onboarding approved | `ONBOARDED` | `COMPANY` | [company.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/company/company.db.modules.ts:1548) |
| Company onboarding rejected | `REJECT` | `COMPANY` | [company.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/company/company.db.modules.ts:1548) |
| Post-approval company user creation | `ONBOARDED` | `null` | [company.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/company/company.db.modules.ts:350) |
| Post-approval root org creation | `ONBOARDED` | `ORG` | [company.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/company/company.db.modules.ts:363) |
| Post-approval workflow creation | `ONBOARDED` | `WORKFLOW` | [company.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/company/company.db.modules.ts:379) |

## 4. Auto-generate and auto-delete notes

These records exist in request/history tables but do not always create the same
raw type in `notifications`.

| Raw request/history event | Where stored | Notification actually written |
| --- | --- | --- |
| `user_onboarding.type = AUTO_GENERATE` / `AUTO_DELETE` | User audit rows created during org access propagation/cleanup | No direct `AUTO_GENERATE` or `AUTO_DELETE` notification from user module |
| `workflow_req.type = AUTO_GENERATE` | Auto-created child workflow request | Usually surfaced as `ONBOARDED` summary notification, not `AUTO_GENERATE` |
| `workflow_req_history.event = AUTO_DELETE` | Workflow history when deleted by system | Surfaced to notifications as `AUTO_DELETE` only in org cleanup notifications |

## 5. Important correctness notes

1. `UPDATE` is never stored directly in `notifications.type`.
   It is normalized to `MODIFICATION`.

2. Final approval of a create/initiate request is stored as `ONBOARDED`, not `APPROVE`.
   `APPROVE` is used for partial or level approval only.

3. `COMPANY` notifications are not covered by `NotificationModule`.
   Current settings only support `USER`, `WORKFLOW`, and `ORG` in
   [schema.prisma](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/prisma/schema.prisma:608),
   and `getNotificationModuleForReferenceType()` also excludes `COMPANY` in
   [notification.db.modules.ts](C:/Dhanraj%20Pimple/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53%20(1)/RJFintech_backend-18054219e9ad907eb97fa42a6c477078f189fb53/src/backend/modules/notifications/notification.db.modules.ts:739).

4. Notifications with `reference_type = null` also bypass module-based
   notification settings.
   Example: `Company user added`.
