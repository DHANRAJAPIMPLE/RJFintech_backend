/**
 * AdminController:
 * This controller handles administrative tasks related to company management.
 * It provides functionality for:
 * - Fetching group-wise company lists (active, inactive, pending).
 * - Initiating new company onboarding processes.
 * - Approving or rejecting company onboarding requests.
 * - Retrieving history of actions performed on a specific company.
 * It interacts with the backend service through internal API calls.
 */
import type { AuthRequest } from '../../middlewares/auth.middleware';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../shared/middlewares/error.middleware';
import { config } from '../../config';
import { internalPost } from '../../utils/internal-fetch.util';
import { zodParse } from '../../utils/zod-parse.util';
import {
  companyOnboardingSchema,
  companyActionSchema,
  companyHistory,
} from '../../validations/company.validation';
import type {
  ActionCompanyOnboardingInternalResponse,
  ActionCompanyOnboardingResponse,
  ActionCompanyOnboardingResult,
  AdminApiErrorResponse,
  AdminBackendCompany,
  AdminBackendPendingOnboarding,
  AdminCompanyGroup,
  AdminPendingCompanyGroup,
  AdminPendingCompanyDetails,
  FetchAdminGroupsInternalResponse,
  FetchAdminGroupsInternalSuccess,
  FetchAdminGroupsResponse,
  FetchCompanyHistoryInternalResponse,
  FetchCompanyHistoryInternalSuccess,
  FetchCompanyHistoryResponse,
  InitiateCompanyOnboardingResponse,
} from './admin.type';

import { CodeGenUtil } from '../../utils/code-gen.util';

export class AdminController {
  static async getGroupCompanies(
    req: AuthRequest,
    res: Response<FetchAdminGroupsResponse>,
    next: NextFunction,
  ) {
    try {
      // 1. Fetch raw data from Backend (5001)
      const { data, ok, status } =
        await internalPost<FetchAdminGroupsInternalResponse>(
          `${config.backendCompanyUrl}/groups`,
          { userId: req.user?.id },
        );

      if (!ok) {
        const errorData = data as AdminApiErrorResponse;
        throw new AppError(
          errorData?.message || errorData?.error || 'Failed to fetch groups',
          status,
        );
      }

      const backendData = data as FetchAdminGroupsInternalSuccess;
      const { groups, soloCompanies, pendingOnboardings } = backendData;

      const active: AdminCompanyGroup[] = [];
      const inactive: AdminCompanyGroup[] = [];
      const pending: AdminPendingCompanyGroup[] = [];

      // 2. Process Groups
      groups.forEach((g) => {
        const processCompanies = (
          companies: AdminBackendCompany[],
        ): AdminCompanyGroup => {
          const signatoryMap = new Map();
          const companyDetails = companies.map((c) => ({
            companyCode: c.companyCode,
            name: c.legalName,
            gst: c.gstNumber,
            brand: c.brandName,
            ieCode: c.ieCode || '',
            registration: c.registrationDate,
            address: c.address || '',
            signatories: c.signatories || [],
          }));

          companies.forEach((c) => {
            if (c.signatories) {
              c.signatories.forEach((s) => {
                if (!signatoryMap.has(s.email)) {
                  signatoryMap.set(s.email, s);
                }
              });
            }
          });

          return {
            groupDetails: {
              groupCode: g.groupCode,
              groupName: g.name,
            },
            companyDetails: companyDetails,
          };
        };

        const mappedCompanies = g.companyMappings.map((cm) => cm.company);
        const activeGroupCompanies = mappedCompanies.filter(
          (c) => c.status === 'ACTIVE',
        );
        const inactiveGroupCompanies = mappedCompanies.filter(
          (c) => c.status === 'INACTIVE',
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
              companyDetails: [],
              signatories: [],
            });
          }
        }
      });

      // 3. Process Solo Companies
      soloCompanies.forEach((c) => {
        const soloEntry: AdminCompanyGroup = {
          groupDetails: null,
          companyDetails: [
            {
              companyCode: c.companyCode,
              name: c.legalName,
              gst: c.gstNumber,
              brand: c.brandName,
              ieCode: c.ieCode || '',
              registration: c.registrationDate,
              address: c.address || '',
              signatories: c.signatories || [],
            },
          ],
        };

        if (c.status === 'ACTIVE') {
          active.push(soloEntry);
        } else {
          inactive.push(soloEntry);
        }
      });

      // 4. Process Pending Onboardings
      const pendingGroups: Record<string, AdminPendingCompanyGroup> = {};
      pendingOnboardings.forEach((onb: AdminBackendPendingOnboarding) => {
        const onbData = onb.data || {};
        const group = onbData.group || {};
        const company = onbData.company || {};
        const signatories = onbData.signatories || [];
        const groupCode =
          onb.groupCode || `SOLO_PENDING_${onb.companyCode || onb.id}`;

        if (!pendingGroups[groupCode]) {
          pendingGroups[groupCode] = {
            groupDetails: onb.groupCode
              ? {
                  groupCode: onb.groupCode,
                  groupName: group.name || 'Pending Group',
                }
              : null,
            companyDetails: [],
          };
        }

        const companyDetails: AdminPendingCompanyDetails = {
          companyId: onb.id,
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
          signatories: signatories.map((s: any) => ({
            name: s.name || '',
            email: s.email || '',
            phone: s.phone || '',
            designation: s.designation || '',
            employeeId: s.employeeId || '',
          })),
        };

        pendingGroups[groupCode].companyDetails.push(companyDetails);
      });
      pending.push(...Object.values(pendingGroups));

      // 5. Final Response
      const response: FetchAdminGroupsResponse = {
        message: 'Companies fetched successfully!',
        companies: {
          active,
          pending,
          inactive,
        },
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async initiateCompanyOnboarding(
    req: Request & { user?: { id: string } },
    res: Response<InitiateCompanyOnboardingResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(companyOnboardingSchema, req.body);
      const initiatorId = req.user?.id;
      const { group, company, signatories } = validatedData;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Check if Company already exists (GST check in Master and Onboarding)
      const { data: companyCheck, ok: companyCheckOk } =
        await internalPost<any>(
          `${config.backendUrl}/internal/company/check-company`,
          { gstNumber: company.gst, ieCode: company.ieCode },
        );

      if (companyCheckOk && companyCheck.exists) {
        throw new AppError(
          companyCheck.message || 'Company with this GST already exists',
          400,
        );
      }

      // 2. Check if Signatories already exist in other pending company onboardings
      const { data: signatoryCheck, ok: signatoryCheckOk } =
        await internalPost<any>(
          `${config.backendUrl}/internal/company/check-signatories`,
          { emails: signatories.map((s) => s.email) },
        );

      if (signatoryCheckOk && signatoryCheck.exists) {
        throw new AppError(
          signatoryCheck.message ||
            'One or more signatories are already pending',
          400,
        );
      }

      // 2. Check if Signatories already exist
      const existingEmails: string[] = [];
      for (const signatory of signatories) {
        // Check in master user table
        const existingUserRes = await internalPost<any>(
          `${config.backendAuthUrl}/get-user`,
          { email: signatory.email },
        );

        // Check in pending user onboarding table
        const pendingUserRes = await internalPost<any>(
          `${config.backendUrl}/internal/user/get-pending-users`,
          { email: signatory.email },
        );

        if (existingUserRes.ok && existingUserRes.data) {
          existingEmails.push(signatory.email);
        } else if (pendingUserRes.ok && pendingUserRes.data) {
          existingEmails.push(signatory.email);
        }
      }

      if (existingEmails.length > 0) {
        throw new AppError(
          `Following signatory emails already exist in database or pending onboarding: ${existingEmails.join(', ')}`,
          400,
        );
      }

      // Logic: Handle Group Code
      let finalGroupCode = null;
      if (group && group.name) {
        if (group.groupCode) {
          // Both present: Check if they match/exist
          const { data: groupCheck } = await internalPost<any>(
            `${config.backendUrl}/internal/onboarding/group/check-code`,
            { code: group.groupCode },
          );

          if (groupCheck.exists) {
            finalGroupCode = group.groupCode;
          } else {
            throw new AppError('Provided group code does not exist', 400);
          }
        } else {
          // Name exists but code doesn't: Create new code
          finalGroupCode = await CodeGenUtil.generateUniqueGroupCode(
            group.name,
          );
        }
      } else {
        // Both null or no name: Independent company
        finalGroupCode = null;
      }

      // Logic: Handle Company Code (Always generate unique)
      const finalCompanyCode = await CodeGenUtil.generateUniqueCompanyCode(
        company.name,
      );

      // Logic: Get eligible approver IDs (Initiator's Company Global Access + SAAS_ADMINs)
      const initiatorMapping = (req.user as any)?.userMappings?.find(
        (m: any) => m.companyId === (req.user as any)?.companyId,
      );
      const initiatorCompanyCode = initiatorMapping?.company?.companyCode;

      if (!initiatorCompanyCode) {
        throw new AppError('Initiator company context not found', 400);
      }

      const { data: eligibleApprovers } = await internalPost<string[]>(
        `${config.backendUrl}/internal/onboarding/saas-admin-ids`,
        { companyCode: initiatorCompanyCode },
      );

      const emails = signatories.map((signatory) => signatory.email);
      const phoneNumbers = signatories.map((signatory) => signatory.phone);

      const uniqueEmail = [...new Set(emails)];
      const uniquePhoneNumbers = [...new Set(phoneNumbers)];

      if (
        uniqueEmail.length !== emails.length ||
        uniquePhoneNumbers.length !== phoneNumbers.length
      ) {
        throw new AppError(
          'Duplicate emails or phone numbers found in signatories list',
          400,
        );
      }

      // Call Backend to create the record
      const { data, ok, status } = await internalPost(
        `${config.backendUrl}/internal/company/create`,
        {
          initiatorId,
          notificationCompanyId: (req.user as any)?.companyId,
          companyCode: finalCompanyCode,
          groupCode: finalGroupCode,
          data: {
            group,
            company,
            signatories,
          },
          status: 'PENDING',
          eligibleApprovers: eligibleApprovers,
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to initiate onboarding',
          status,
        );
      }

      const response: InitiateCompanyOnboardingResponse = {
        message: 'Onboarding initiated successfully',
        companyCode: finalCompanyCode,
        groupCode: finalGroupCode,
      };

      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async actionCompanyOnboarding(
    req: Request & { user?: { id: string } },
    res: Response<ActionCompanyOnboardingResponse>,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(companyActionSchema, req.body);
      const approverId = req.user?.id;
      const { id, action, remark } = validatedData;

      if (!approverId) {
        throw new AppError('Unauthorized', 401);
      }

      // 1. Fetch onboarding record
      const { data: onboarding, ok: fetchOk } = await internalPost<any>(
        `${config.backendUrl}/internal/company/get`,
        { id },
      );

      if (!fetchOk || !onboarding) {
        throw new AppError('Onboarding request not found', 404);
      }

      // 2. Logic: Validate status
      if (onboarding.status !== 'PENDING') {
        throw new AppError('Onboarding request already processed', 400);
      }

      // // 3. Logic: Verify permissions
      if (!onboarding.eligibleApprovers.includes(approverId)) {
        throw new AppError(
          'Unauthorized: You do not have permission to process this request',
          403,
        );
      }

      const {
        data: updateStatusRes,
        ok: updateStatusOk,
        status: updateStatusStatus,
      } = await internalPost<ActionCompanyOnboardingInternalResponse>(
        `${config.backendUrl}/internal/company/action`,
        {
          id,
          action,
          approverId,
          remark,
          notificationCompanyId: (req.user as any)?.companyId,
        },
      );

      if (!updateStatusOk) {
        const errorData = updateStatusRes as AdminApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to process onboarding approval',
          updateStatusStatus,
        );
      }

      const actionResult = updateStatusRes as ActionCompanyOnboardingResult;
      const response: ActionCompanyOnboardingResponse = {
        message:
          actionResult.message ||
          `Onboarding request ${action === 'reject' ? 'rejected' : 'approved'}`,
        data: actionResult,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  static async fetchCompanyHistory(
    req: Request,
    res: Response<FetchCompanyHistoryResponse>,
    next: NextFunction,
  ) {
    try {
      const { companyCode } = zodParse(companyHistory, req.body);

      // 1. Fetch history record
      const { data, ok, status } =
        await internalPost<FetchCompanyHistoryInternalResponse>(
          `${config.backendUrl}/internal/company/history`,
          { companyCode, userId: (req as any).user?.id },
        );

      if (!ok) {
        const errorData = data as AdminApiErrorResponse;
        throw new AppError(
          errorData?.message ||
            errorData?.error ||
            'Failed to fetch company history',
          status || 404,
        );
      }

      const historyData = Array.isArray(data)
        ? data
        : (data as FetchCompanyHistoryInternalSuccess)?.data || [];
      const historyMessage = Array.isArray(data)
        ? historyData.length > 0
          ? 'Company history fetched successfully!'
          : 'Company history not found'
        : (data as FetchCompanyHistoryInternalSuccess)?.message ||
          'Company history fetched successfully!';
      const historyCode = Array.isArray(data)
        ? 200
        : (data as FetchCompanyHistoryInternalSuccess)?.code || 200;

      const response: FetchCompanyHistoryResponse = {
        message: historyMessage,
        code: historyCode,
        data: historyData,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
