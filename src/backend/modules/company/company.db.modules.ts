import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

export class CompanyDbController {
  private static formatDate(date: Date | string): string {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  static async getMyCompanies(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.body;

      const userMappings = await prisma.userMapping.findMany({
        where: { userId: userId },
        include: {
          company: {
            select: {
              companyCode: true,
              brandName: true,
            },
          },
        },
      });

      const companies = userMappings.map((m) => ({
        companyCode: m.company.companyCode,
        brandName: m.company.brandName,
      }));

      res.status(200).json(companies);
    } catch (error) {
      next(error);
    }
  }

  static async getGroupCompanies(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      // 1. Fetch groups and their companies (Active)
      const groups = await prisma.groupCompany.findMany({
        include: {
          companyMappings: {
            include: {
              company: true,
            },
          },
        },
      });

      // 2. Fetch companies NOT in any group (Inactive/Solo)
      const allCompanies = await prisma.company.findMany({
        include: {
          companyMappings: true,
        },
      });
      const soloCompanies = allCompanies.filter(
        (c) => c.companyMappings.length === 0,
      );

      // 3. Fetch pending onboarding records
      const pendingOnboardings = await prisma.companyOnboarding.findMany({
        where: { status: 'pending' },
      });

      const responseBody = {
        message: 'Companies fetched successfully!',
        companies: {
          active: groups.map((g) => ({
            groupDetails: {
              groupCode: g.groupCode,
              groupName: g.name,
            },
            companyDetails: g.companyMappings.map((cm) => ({
              companyCode: cm.company.companyCode,
              name: cm.company.legalName,
              gst: cm.company.gstNumber,
              brand: cm.company.brandName,
              ieCode: cm.company.iecode || '',
              registration: CompanyDbController.formatDate(
                cm.company.registrationDate,
              ),
              address: cm.company.address || '',
            })),
          })),
          pending: [] as Record<string, unknown>[],
          inactive: [
            {
              groupDetails: {
                groupCode: '',
                groupName: '',
              },
              companyDetails: soloCompanies.map((c) => ({
                companyCode: c.companyCode,
                name: c.legalName,
                gst: c.gstNumber,
                brand: c.brandName,
                ieCode: c.iecode || '',
                registration: CompanyDbController.formatDate(
                  c.registrationDate,
                ),
                address: c.address || '',
              })),
            },
          ],
        },
      };

      // Group pending onboardings by groupCode
      const pendingGroups: Record<string, Record<string, unknown>> = {};
      pendingOnboardings.forEach((onb) => {
        const data = onb.data as {
          group?: { name?: string };
          company?: {
            name?: string;
            gst?: string;
            brand?: string;
            ieCode?: string;
            registeredAt?: string | Date;
            address?: string;
          };
        };
        const group = data?.group || {};
        const company = data?.company || {};
        const groupCode = onb.groupCode || 'PENDING_SOLO';

        if (!pendingGroups[groupCode]) {
          pendingGroups[groupCode] = {
            groupDetails: {
              groupCode: onb.groupCode || '',
              groupName: group.name || 'Pending Group',
            },
            companyDetails: [],
          };
        }

        const details = pendingGroups[groupCode].companyDetails as Record<
          string,
          unknown
        >[];

        details.push({
          id: onb.id,
          companyCode: onb.companyCode,
          name: company.name || '',
          gst: company.gst || '',
          brand: company.brand || '',
          ieCode: company.ieCode || '',
          registration: company.registeredAt
            ? CompanyDbController.formatDate(company.registeredAt)
            : '',
          address: company.address || '',
        });
      });

      responseBody.companies.pending = Object.values(pendingGroups);

      res.status(200).json(responseBody);
    } catch (error) {
      next(error);
    }
  }
}
