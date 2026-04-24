import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';

export class UserDbController {
  static async fetchAllUsers(req: Request, res: Response, next: NextFunction) {
    try {
      // Logic: Fetch all users with their related mappings, company, and manager details
      const users = await prisma.user.findMany({
        include: {
          userMappings: {
            include: {
              company: {
                select: {
                  brandName: true,
                },
              },
              manager: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      });

      // Helper to format date as DD-MM-YYYY
      const formatDate = (date: Date) => {
        const d = new Date(date);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}-${month}-${year}`;
      };

      // Logic: Group users into active and inactive categories
      const result = {
        activeUsers: [] as Record<string, unknown>[],
        inactiveUsers: [] as Record<string, unknown>[],
        pendingUsers: [] as Record<string, unknown>[],
      };

      users.forEach((u) => {
        // If user has no mapping, add them as inactive with default values
        if (u.userMappings.length === 0) {
          result.inactiveUsers.push({
            basicDetails: {
              name: u.name,
              email: u.email,
              phone: u.phone,
              companyOnboardingDate: formatDate(u.createdAt),
              designation: 'N/A',
              employeeId: 'N/A',
              reportingManager: 'N/A',
            },
            permissions: [{}],
          });
        } else {
          // If user has mappings, add a record for each mapping
          u.userMappings.forEach((m) => {
            const userData = {
              basicDetails: {
                name: u.name,
                email: u.email,
                phone: u.phone,
                companyOnboardingDate: formatDate(m.createdAt),
                designation: m.designation,
                employeeId: m.employeeId,
                reportingManager: m.manager?.email || 'N/A',
              },
              permissions: [{}],
            };

            if (m.status === 'active') {
              result.activeUsers.push(userData);
            } else {
              result.inactiveUsers.push(userData);
            }
          });
        }
      });

      // Logic: Fetch pending user onboardings
      const pendingOnboardings = await prisma.userOnboarding.findMany({
        where: { status: 'pending' },
      });

      pendingOnboardings.forEach((onb) => {
        const data = onb.data as {
          basicDetails?: {
            name?: string;
            email?: string;
            phone?: string;
            designation?: string;
            employeeId?: string;
            reportingManager?: string;
          };
          permissions?: Record<string, unknown>[];
        };
        const basic = data?.basicDetails || {};

        result.pendingUsers.push({
          id: onb.id,
          basicDetails: {
            name: basic.name || 'N/A',
            email: basic.email || 'N/A',
            phone: basic.phone || 'N/A',
            companyOnboardingDate: onb.createdAt ? formatDate(onb.createdAt) : 'N/A',
            designation: basic.designation || 'N/A',
            employeeId: basic.employeeId || 'N/A',
            reportingManager: basic.reportingManager || 'N/A',
          },
          permissions: data?.permissions || [{}],
        });
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
