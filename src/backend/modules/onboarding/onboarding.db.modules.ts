import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AccessUtil } from '../../utils/access.util';

/**
 * Controller for handling internal onboarding-related database operations.
 * Provides validation checks and utility methods for fetching authorization context
 * during the onboarding of companies, organizations, and users.
 */
export class OnboardingDbController {
  // --- Internal Atomic Operations ---

  /**
   * Checks if a company code is already in use.
   * Scans both the production 'Company' table and the 'CompanyOnboarding' table
   * to prevent duplicate codes even for requests that are still pending.
   */
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

  /**
   * Checks if a group company code already exists in the master records.
   */
  static async checkGroupCode(req: Request, res: Response) {
    const { code } = req.body;
    const existing = await prisma.groupCompany.findUnique({
      where: { groupCode: code },
    });
    res.json({ exists: !!existing, groupCode: existing?.groupCode || null });
  }

  /**
   * Checks if a group company name is already taken.
   */
  static async checkGroupName(req: Request, res: Response) {
    const { name } = req.body;
    const existing = await prisma.groupCompany.findFirst({
      where: { name },
    });
    res.json({ exists: !!existing, groupCode: existing?.groupCode || null });
  }

  /**
   * Fetches comprehensive information about a manager by their email.
   * Includes their company mappings, company details, and group associations.
   * This is used to determine the organizational context for new user onboarding.
   */
  static async getManagerInfo(req: Request, res: Response) {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
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

  /**
   * Fetches basic user information by email.
   */
  static async getUserByEmail(req: Request, res: Response) {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    res.json(user);
  }

  /**
   * Internal endpoint to fetch user IDs with 'Global Access' for a company.
   * Used by the middle-layer to populate 'eligibleApprovers' lists.
   */
  static async getGlobalAccessUserIds(req: Request, res: Response) {
    const { companyCode } = req.body;
    const userIds = await AccessUtil.getGlobalAccessUserIds(companyCode);
    res.json(userIds);
  }

  /**
   * Internal endpoint to fetch user IDs who have a specific role and the 'approve' permission.
   * Used to identify authorized managers for various modules (e.g., ORG_STR_MGR).
   */
  static async getApproverIdsByRole(req: Request, res: Response) {
    const { companyCode, roleCode } = req.body;
    const userIds = await AccessUtil.getUsersByRoleAndAction(
      companyCode,
      roleCode,
      'approve',
    );
    res.json(userIds);
  }

  /**
   * Internal endpoint to fetch all 'SAAS_ADMIN' user IDs for a company.
   * Administrators are often automatically included as eligible approvers.
   */
  static async getSaasAdminIds(req: Request, res: Response) {
    const { companyCode } = req.body;
    const userIds = await AccessUtil.getUsersByRole(companyCode, 'SAAS_ADMIN');
    res.json(userIds);
  }
}
