import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';

export class AdminController {
  private static formatDate(date: Date | string): string {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  static async getGroupCompanies(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      // 1. Fetch raw data from Backend (5001)
      const { data, ok, status } = await internalPost<any>(
        `${config.backendCompanyUrl}/groups`,
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch groups',
          status,
        );
      }

      const { groups, soloCompanies, pendingOnboardings } = data;

      const active: any[] = [];
      const inactive: any[] = [];
      const pending: any[] = [];

      // 2. Process Groups
      groups.forEach((g: any) => {
        const processCompanies = (companies: any[]) => {
          const signatoryMap = new Map();
          const companyDetails = companies.map((c: any) => ({
            companyCode: c.companyCode,
            name: c.legalName,
            gst: c.gstNumber,
            brand: c.brandName,
            iecode: c.iecode || '',
            registration: c.registrationDate,
            address: c.address || '',
          }));

          companies.forEach((c: any) => {
            if (c.userMappings) {
              c.userMappings.forEach((um: any) => {
                if (um.user && !signatoryMap.has(um.user.email)) {
                  signatoryMap.set(um.user.email, {
                    name: um.user.name,
                    email: um.user.email,
                    phone: um.user.phone,
                    designation: um.designation,
                    employeeId: um.employeeId,
                  });
                }
              });
            }
          });

          return {
            groupDetails: {
              groupCode: g.groupCode,
              groupName: g.name,
            },
            comapnyDetails: companyDetails,
            signatories: Array.from(signatoryMap.values()),
          };
        };

        const mappedCompanies = g.companyMappings.map((cm: any) => cm.company);
        const activeGroupCompanies = mappedCompanies.filter(
          (c: any) => c.status === 'ACTIVE',
        );
        const inactiveGroupCompanies = mappedCompanies.filter(
          (c: any) => c.status === 'INACTIVE',
        );

        if (g.status === 'ACTIVE') {
          if (activeGroupCompanies.length > 0) {
            active.push(processCompanies(activeGroupCompanies));
          }
          if (inactiveGroupCompanies.length > 0) {
            inactive.push(processCompanies(inactiveGroupCompanies));
          }
        } else {
          // If the group itself is inactive, all companies go to the inactive list
          if (mappedCompanies.length > 0) {
            inactive.push(processCompanies(mappedCompanies));
          } else {
            // Even if no companies, still show the inactive group if it's inactive?
            // The original code did this. Let's keep it.
            inactive.push({
              groupDetails: {
                groupCode: g.groupCode,
                groupName: g.name,
              },
              comapnyDetails: [],
              signatories: [],
            });
          }
        }
      });

      // 3. Process Solo Companies
      soloCompanies.forEach((c: any) => {
        const soloEntry = {
          groupDetails: null,
          comapnyDetails: [
            {
              companyCode: c.companyCode,
              name: c.legalName,
              gst: c.gstNumber,
              brand: c.brandName,
              iecode: c.iecode || '',
              registration: c.registrationDate,
              address: c.address || '',
            },
          ],
          signatories: (c.userMappings || []).map((um: any) => ({
            name: um.user.name,
            email: um.user.email,
            phone: um.user.phone,
            designation: um.designation,
            employeeId: um.employeeId,
          })),
        };

        if (c.status === 'ACTIVE') {
          active.push(soloEntry);
        } else {
          inactive.push(soloEntry);
        }
      });

      // 4. Process Pending Onboardings
      const pendingGroups: Record<string, any> = {};
      pendingOnboardings.forEach((onb: any) => {
        const onbData = onb.data || {};
        const group = onbData.group || {};
        const company = onbData.company || {};
        const signatories = onbData.signatories || [];
        const groupCode = onb.groupCode || `SOLO_PENDING_${onb.companyCode || onb.id}`;

        if (!pendingGroups[groupCode]) {
          pendingGroups[groupCode] = {
            groupDetails: onb.groupCode
              ? {
                groupCode: onb.groupCode,
                groupName: group.name || 'Pending Group',
              }
              : null,
            comapnyDetails: [],
            signatories: [],
          };
        }

        pendingGroups[groupCode].comapnyDetails.push({
          companyCode: onb.companyCode,
          name: company.name || '',
          gst: company.gst || '',
          brand: company.brand || '',
          iecode: company.ieCode || '',
          registration: company.registeredAt ? company.registeredAt : '',
          address: company.address || '',
          initiatorName: onb.initiator?.name || null,
          initiatorEmail: onb.initiator?.email || null,
          initiatedDate: onb.createdAt,
        });

        // Add signatories if not already there
        signatories.forEach((s: any) => {
          if (
            !pendingGroups[groupCode].signatories.some(
              (existing: any) => existing.email === s.email,
            )
          ) {
            pendingGroups[groupCode].signatories.push({
              name: s.name || '',
              email: s.email || '',
              phone: s.phone || '',
              designation: s.designation || '',
              employeeId: s.employeeId || '',
            });
          }
        });
      });
      pending.push(...Object.values(pendingGroups));

      // 5. Final Response
      res.status(200).json({
        message: 'Companies fetched successfully!',
        companies: {
          active,
          pending,
          inactive,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
