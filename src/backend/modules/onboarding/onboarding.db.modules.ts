import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AccessUtil } from '../../utils/access.util';

export class OnboardingDbController {
  // --- Internal Atomic Operations ---

  static async checkCompanyCode(req: Request, res: Response) {
    const { code } = req.body;
    const existingInMaster = await prisma.company.findUnique({
      where: { companyCode: code },
    });
    const existingInOnboarding = await prisma.companyOnboarding.findUnique({
      where: { companyCode: code },
    });
    res.json({ exists: !!existingInMaster || !!existingInOnboarding });
  }

  static async checkGroupCode(req: Request, res: Response) {
    const { code } = req.body;
    const existing = await prisma.groupCompany.findUnique({
      where: { groupCode: code },
    });
    res.json({ exists: !!existing, groupCode: existing?.groupCode || null });
  }

  static async checkGroupName(req: Request, res: Response) {
    const { name } = req.body;
    const existing = await prisma.groupCompany.findFirst({
      where: { name },
    });
    res.json({ exists: !!existing, groupCode: existing?.groupCode || null });
  }

  static async getManagerInfo(req: Request, res: Response) {
    const { email } = req.body;
    const manager = await prisma.user.findUnique({
      where: { email },
      include: {
        userMappings: {
          include: {
            company: {
              include: {
                companyMappings: {
                  include: { group: true },
                },
              },
            },
          },
        },
      },
    });
    res.json(manager);
  }

  static async getUserByEmail(req: Request, res: Response) {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    res.json(user);
  }

  static async getGlobalAccessUserIds(req: Request, res: Response) {
    const { companyCode } = req.body;
    const userIds = await AccessUtil.getGlobalAccessUserIds(companyCode);
    res.json(userIds);
  }

  static async getGlobalAccessUsers(req: Request, res: Response) {
    const { companyCode } = req.body;
    const users = await AccessUtil.getGlobalAccessUsers(companyCode);
    res.json(users);
  }

  static async getUserAccMgrIds(req: Request, res: Response) {
    const { companyCode } = req.body;
    const userIds = await AccessUtil.getUsersByRoleAndAction(
      companyCode,
      'USER_ACC_MGR',
      'approve',
    );
    res.json(userIds);
  }

  static async getOrgStrMgrIds(req: Request, res: Response) {
    const { companyCode } = req.body;
    const userIds = await AccessUtil.getUsersByRoleAndAction(
      companyCode,
      'ORG_STR_MGR',
      'approve',
    );
    res.json(userIds);
  }

  static async getWorkFlowMgrIds(req: Request, res: Response) {
    const { companyCode } = req.body;
    const userIds = await AccessUtil.getUsersByRoleAndAction(
      companyCode,
      'WORK_FLOW_MGR',
      'approve',
    );
    res.json(userIds);
  }

  static async getSaasAdminIds(req: Request, res: Response) {
    const { companyCode } = req.body;
    const userIds = await AccessUtil.getUsersByRole(companyCode, 'SAAS_ADMIN');
    res.json(userIds);
  }
}
