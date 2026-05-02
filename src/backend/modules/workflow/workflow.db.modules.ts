import { PrismaClient, OnboardingStatus, EventType } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';

const prisma = new PrismaClient();

export class WorkflowDbController {
  static async initiateRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { initiatorId, companyId, data, status, eligibleApprovers } =
        req.body;

      const request = await prisma.$transaction(async (tx) => {
        const req = await tx.workflowReq.create({
          data: {
            companyId,
            workflowId: data.workflowId || '',
            data,
            status,
            eligibleApprovers,
            workflowId: data.workflowId || undefined, // This is tricky.
          },
        });

        // Record history
        await tx.workflowReqHistory.create({
          data: {
            workflowReqId: req.id,
            companyCode: data.companyCode,
            event: EventType.INITIATE,
            eventUserId: initiatorId,
          },
        });

        return req;
      });

      res.status(201).json(request);
    } catch (error) {
      next(error);
    }
  }

  // Since the user asked for "initiate", "action", "fetch", "fetch history"
  // and gave me a schema with Workflow and WorkflowReq,
  // I should probably implement the logic to create a NEW workflow via a WorkflowReq.

  static async handleWorkflowStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { id, action, approverId, remark } = req.body;

      const result = await prisma.$transaction(async (tx) => {
        const onboarding = await tx.workflowReq.findUnique({
          where: { id },
          include: { company: true },
        });

        if (!onboarding) throw new Error('Workflow request not found');

        // ✅ PERMISSION CHECK
        if (
          onboarding.eligibleApprovers &&
          onboarding.eligibleApprovers.length > 0 &&
          !onboarding.eligibleApprovers.includes(approverId)
        ) {
          throw new Error('Unauthorized to process this request');
        }

        const newStatus =
          action === 'approve'
            ? OnboardingStatus.APPROVED
            : OnboardingStatus.REJECTED;

        // Update request status
        const updatedReq = await tx.workflowReq.update({
          where: { id },
          data: {
            status: newStatus,
            approvalRemark: remark,
          },
        });

        // Record history
        await tx.workflowReqHistory.create({
          data: {
            workflowReqId: id,
            companyCode: onboarding.company.companyCode,
            event:
              action === 'approve' ? EventType.APPROVED : EventType.REJECTED,
            eventUserId: approverId,
          },
        });

        // If approved, create the actual Workflow record
        if (action === 'approve') {
          const onbData = onboarding.data as any;
          await tx.workflow.create({
            data: {
              name: onbData.name,
              alias: onbData.alias,
              module: onbData.module,
              subModule: onbData.subModule,
              companyId: onboarding.companyId,
              l1Approver1: onbData.levels.l1?.approver1,
              l1Type: onbData.levels.l1?.type,
              l1Approver2: onbData.levels.l1?.approver2,
              l2Approver1: onbData.levels.l2?.approver1,
              l2Type: onbData.levels.l2?.type,
              l2Approver2: onbData.levels.l2?.approver2,
              l3Approver1: onbData.levels.l3?.approver1,
              l3Type: onbData.levels.l3?.type,
              l3Approver2: onbData.levels.l3?.approver2,
              l4Approver1: onbData.levels.l4?.approver1,
              l4Type: onbData.levels.l4?.type,
              l4Approver2: onbData.levels.l4?.approver2,
              l5Approver1: onbData.levels.l5?.approver1,
              l5Type: onbData.levels.l5?.type,
              l5Approver2: onbData.levels.l5?.approver2,
            },
          });
        }

        return updatedReq;
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async fetchWorkflows(req: Request, res: Response, next: NextFunction) {
    try {
      const { companyCode } = req.body;
      const workflows = await prisma.workflow.findMany({
        where: { company: { companyCode } },
        orderBy: { createdAt: 'desc' },
      });

      const pendingRequests = await prisma.workflowReq.findMany({
        where: { company: { companyCode }, status: OnboardingStatus.PENDING },
        include: { workflowHistories: { include: { user: true } } },
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json({ workflows, pendingRequests });
    } catch (error) {
      next(error);
    }
  }

  static async fetchWorkflowHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { alias } = req.body;
      // History is tracked via WorkflowReqHistory linked to WorkflowReq
      // We find the approved request for this alias
      const histories = await prisma.workflowReqHistory.findMany({
        where: {
          workflowReq: {
            data: {
              path: ['alias'],
              equals: alias,
            },
          },
        },
        include: { user: true, workflowReq: true },
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json(histories);
    } catch (error) {
      next(error);
    }
  }
}
