import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { HashUtil } from '../../../shared/utils/hash.util';

export class OnboardingDbController {
  private static normalizeCodeNamePart(value: string): string {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return normalized.slice(0, 8).padEnd(8, 'X');
  }

  private static formatCodeDatePart(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    return `${day}${month}${year}`;
  }

  private static async generateUniqueCompanyCode(
    companyName: string,
  ): Promise<string> {
    const namePart = this.normalizeCodeNamePart(companyName);
    const datePart = this.formatCodeDatePart(new Date());
    const baseCode = `${namePart}${datePart}`;
    let code = baseCode;
    let counter = 1;
    let isUnique = false;

    while (!isUnique) {
      const existing = await prisma.company.findUnique({
        where: { company_code: code },
      });
      const existingOnboarding = await prisma.company_onboarding.findUnique({
        where: { company_code: code },
      });
      if (!existing && !existingOnboarding) {
        isUnique = true;
      } else {
        code = `${baseCode}${counter}`;
        counter++;
      }
    }
    return code;
  }

  private static async generateUniqueGroupCode(
    groupName: string,
  ): Promise<string> {
    const namePart = this.normalizeCodeNamePart(groupName);
    const datePart = this.formatCodeDatePart(new Date());
    const baseCode = `${namePart}${datePart}`;
    let code = baseCode;
    let counter = 1;
    let isUnique = false;

    while (!isUnique) {
      const existing = await prisma.group_company.findUnique({
        where: { group_code: code },
      });
      if (!existing) {
        isUnique = true;
      } else {
        code = `${baseCode}${counter}`;
        counter++;
      }
    }
    return code;
  }

  static async initiate(req: Request, res: Response, next: NextFunction) {
    try {
      const { group, company, signatories, initiator_id } = req.body;

      // 1. Handle Group Code
      let finalGroupCode = group.groupCode;
      if (!finalGroupCode && group.name) {
        finalGroupCode = await OnboardingDbController.generateUniqueGroupCode(
          group.name,
        );
      }

      // 2. Handle Company Code
      let finalCompanyCode = company.companyCode;
      // Check if provided code already exists in master or pending onboarding
      if (finalCompanyCode) {
        const existingInMaster = await prisma.company.findUnique({
          where: { company_code: finalCompanyCode },
        });
        const existingInOnboarding = await prisma.company_onboarding.findUnique(
          { where: { company_code: finalCompanyCode } },
        );

        if (existingInMaster || existingInOnboarding) {
          // If it exists, generate a new unique one to avoid conflicts
          finalCompanyCode =
            await OnboardingDbController.generateUniqueCompanyCode(
              company.name,
            );
        }
      } else {
        // No code provided, generate one
        finalCompanyCode =
          await OnboardingDbController.generateUniqueCompanyCode(company.name);
      }

      const onboarding = await prisma.company_onboarding.create({
        data: {
          initiator_id,
          company_code: finalCompanyCode,
          group_code: finalGroupCode,
          data: {
            group,
            company,
            signatories,
          },
          status: 'pending',
        },
      });

      res.status(201).json({
        message: 'Onboarding initiated successfully',
        company_code: finalCompanyCode,
        group_code: finalGroupCode,
      });
    } catch (error) {
      next(error);
    }
  }

  static async action(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, action, remark, approver_id } = req.body;

      const onboarding = await prisma.company_onboarding.findUnique({
        where: { id },
      });

      if (!onboarding) {
        return res.status(404).json({ error: 'Onboarding request not found' });
      }

      if (onboarding.status !== 'pending') {
        return res
          .status(400)
          .json({ error: 'Onboarding request already processed' });
      }

      if (action === 'reject') {
        await prisma.company_onboarding.update({
          where: { id },
          data: {
            status: 'rejected',
            approver_id,
            approved_at: new Date(),
            approval_remark: remark,
          },
        });
        return res.status(200).json({ message: 'Onboarding request rejected' });
      }

      // APPROVE LOGIC
      const data = onboarding.data as any;
      const { group, company, signatories } = data;
      const group_code = onboarding.group_code;

      // Use transaction to ensure atomicity
      await prisma.$transaction(async (tx) => {
        let groupId = '';

        // 1. Handle Group
        if (group_code) {
          let groupObj = await tx.group_company.findUnique({
            where: { group_code },
          });
          if (!groupObj && group) {
            groupObj = await tx.group_company.create({
              data: {
                name: group.name,
                group_code: group_code,
                remarks: group.remarks || '',
              },
            });
          }
          if (groupObj) groupId = groupObj.id;
        }

        // 2. Create Company
        const newCompany = await tx.company.create({
          data: {
            legal_name: company.name,
            gst_number: company.gst,
            address: company.address,
            brand_name: company.brand,
            iecode: company.ieCode,
            company_code: onboarding.company_code,
            registration_date: company.registeredAt
              ? new Date(company.registeredAt)
              : new Date(),
          },
        });

        // 3. Map Company to Group (if group exists)
        if (groupId) {
          await tx.company_mapping.create({
            data: {
              company_id: newCompany.id,
              group_id: groupId,
            },
          });
        }

        // 4. Create Root Org Structure Node
        const nodePath = onboarding.company_code
          .replace(/[^a-zA-Z0-9]/g, '')
          .toUpperCase();
        const rootNode = await tx.org_structure.create({
          data: {
            company_id: newCompany.id,
            nodepath: nodePath,
            nodename: company.name,
            nodetype: 'ROOT',
            parent_id: null,
          },
        });

        // 5. Create Signatories (Users), Mappings, and Access
        for (const sig of signatories) {
          let user = await tx.user.findUnique({ where: { email: sig.email } });

          if (!user) {
            // Create a default password for new users (they should reset it)
            const defaultPassword = await HashUtil.hash('Welcome@123');
            user = await tx.user.create({
              data: {
                email: sig.email,
                name: sig.name,
                phone: sig.phone,
                password: defaultPassword,
              },
            });
          }

          // Create User Mapping
          await tx.user_mapping.create({
            data: {
              user_id: user.id,
              company_id: newCompany.id,
              status: 'active',
              designation: sig.designation,
              employee_id: sig.employeeId || '',
            },
          });

          // Create User Access (Permissions) - Set as Global for Company Signatories
          await tx.user_access.create({
            data: {
              user_id: user.id,
              role_code: null, // Default role for initial company users
              node_id: rootNode.id,
              access_type: null,
              company_id: newCompany.id,
              isglobalAccess: true,
            },
          });
        }

        // 6. Update Onboarding Status
        await tx.company_onboarding.update({
          where: { id },
          data: {
            status: 'approved',
            approver_id,
            approved_at: new Date(),
            approval_remark: remark,
          },
        });
      });

      res
        .status(200)
        .json({ message: 'Onboarding request approved and data populated' });
    } catch (error) {
      next(error);
    }
  }

  static async initiateUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { basicDetails, permissions, initiator_id } = req.body;
      const { name, email, phone, reportingManager } = basicDetails;

      // 1. Validate reporting manager exists and get their company info
      const manager = await prisma.user.findUnique({
        where: { email: reportingManager },
        include: {
          user_mappings: {
            include: {
              company: {
                include: {
                  company_mappings: {
                    include: { group: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!manager) {
        return res
          .status(400)
          .json({ error: 'Reporting manager email not found' });
      }

      // 2. Check if user already exists in master table
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return res
          .status(400)
          .json({ error: 'User already exists in master table' });
      }

      // 3. Determine Company and Group Code
      let companyCode: string | undefined;
      let groupCode: string | undefined;

      // Priority 1: Use manager's company/group
      const managerMapping = manager.user_mappings[0];
      if (managerMapping && managerMapping.company) {
        companyCode = managerMapping.company.company_code;
        // Check if company has mappings to get group code
        const compMapping = managerMapping.company.company_mappings?.[0];
        if (compMapping && compMapping.group) {
          groupCode = compMapping.group.group_code;
        }
      }

      // Priority 2: If manager mapping not found, use initiator's company/group
      if (!companyCode) {
        const initiatorMapping = await prisma.user_mapping.findFirst({
          where: { user_id: initiator_id },
          include: {
            company: {
              include: {
                company_mappings: {
                  include: { group: true },
                },
              },
            },
          },
        });

        if (initiatorMapping && initiatorMapping.company) {
          companyCode = initiatorMapping.company.company_code;
          const compMapping = initiatorMapping.company.company_mappings?.[0];
          if (compMapping && compMapping.group) {
            groupCode = compMapping.group.group_code;
          }
        }
      }

      const onboarding = await prisma.user_onboarding.create({
        data: {
          initiator_id,
          company_code: companyCode,
          group_code: groupCode,
          data: {
            basicDetails,
            permissions,
          },
          status: 'pending',
        },
      });

      res.status(201).json({
        message: 'User onboarding initiated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async actionUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, action, remark, approver_id } = req.body;

      const onboarding = await prisma.user_onboarding.findUnique({
        where: { id },
      });

      if (!onboarding) {
        return res
          .status(404)
          .json({ error: 'User onboarding request not found' });
      }

      if (onboarding.status !== 'pending') {
        return res.status(400).json({ error: 'Request already processed' });
      }

      if (action === 'reject') {
        await prisma.user_onboarding.update({
          where: { id },
          data: {
            status: 'rejected',
            approver_id,
            approved_at: new Date(),
            approval_remark: remark,
          },
        });
        return res.status(200).json({ message: 'User onboarding rejected' });
      }

      // APPROVE LOGIC
      const data = onboarding.data as any;
      const { basicDetails, permissions } = data;
      const { name, email, phone, reportingManager, designation, employeeId } =
        basicDetails;

      await prisma.$transaction(async (tx) => {
        // 1. Get Manager ID
        const manager = await tx.user.findUnique({
          where: { email: reportingManager },
          include: {
            user_mappings: {
              include: { company: true },
            },
          },
        });
        if (!manager) throw new Error('Manager not found');

        // 2. Get Company ID from code or manager's mapping
        let company;
        if (onboarding.company_code) {
          company = await tx.company.findUnique({
            where: { company_code: onboarding.company_code },
          });
        }

        // Fallback: If company_code was null in onboarding record, get it from manager
        if (!company && manager.user_mappings[0]) {
          company = manager.user_mappings[0].company;
        }

        if (!company) throw new Error('Company not found');

        // 3. Create/Update User
        let user = await tx.user.findUnique({ where: { email } });
        if (!user) {
          const defaultPassword = await HashUtil.hash('Welcome@123');
          user = await tx.user.create({
            data: {
              email,
              name,
              phone,
              password: defaultPassword,
            },
          });
        }

        // 4. Create User Mapping
        await tx.user_mapping.create({
          data: {
            user_id: user.id,
            company_id: company.id,
            reporting_manager: manager.id,
            status: 'active',
            designation: designation,
            employee_id: employeeId,
          },
        });

        // 5. Create User Access (Permissions)
        if (Array.isArray(permissions)) {
          for (const perm of permissions) {
            const { accessType, roleName, nodePath } = perm;

            // Find role by name
            const role = await tx.roles.findUnique({
              where: { role_name: roleName },
            });

            // Find node by path
            const node = await tx.org_structure.findUnique({
              where: { nodepath: nodePath },
            });

            if (role && node) {
              await tx.user_access.create({
                data: {
                  user_id: user.id,
                  role_code: role.role_code,
                  node_id: node.id,
                  access_type: accessType,
                  company_id: company.id,
                  isglobalAccess: false,
                },
              });
            } else {
              console.warn(
                `Could not create access for role ${roleName} or node ${nodePath}: Role found: ${!!role}, Node found: ${!!node}`,
              );
            }
          }
        }

        // 6. Update Onboarding
        await tx.user_onboarding.update({
          where: { id },
          data: {
            status: 'approved',
            approver_id,
            approved_at: new Date(),
            approval_remark: remark,
          },
        });
      });

      res.status(200).json({ message: 'User approved and onboarded' });
    } catch (error) {
      next(error);
    }
  }
}
