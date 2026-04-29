import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import { zodParse } from '../utils/zod-parse.util';
import {
  companyOnboardingSchema,
  companyActionSchema,
  companyHistory,
} from '../validations/onboarding.validator';
import { CodeGenUtil } from '../utils/code-gen.util';

export class CompanyController {
  static async initiateCompanyOnboarding(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validatedData = zodParse(companyOnboardingSchema, req.body);
      const initiatorId = req.user?.id;
      const { group, company, signatories } = validatedData;

      if (!initiatorId) {
        throw new AppError('Unauthorized', 401);
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
            finalGroupCode = group.groupCode;
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

      // Logic: Get global access user IDs
      const { data: globalAccessIds } = await internalPost<string[]>(
        `${config.backendUrl}/internal/onboarding/global-access-ids`,
        { companyCode: finalCompanyCode },
      );

      const emails = signatories.map((signatory) => signatory.email);
      const phoneNumbers = signatories.map((signatory) => signatory.phone);

      const uniqueEmail = [...new Set(emails)];
      const uniquePhoneNumbers = [...new Set(phoneNumbers)];

      let databaseEmailExists: string = '';
      for (const signatory of signatories) {
        const existingUserRes = await internalPost<any>(
          `${config.backendAuthUrl}/get-user`,
          { email: signatory.email },
        );
        if (existingUserRes.ok) {
          databaseEmailExists += signatory.email + ',';
        }
      }

      if (
        uniqueEmail.length !== emails.length ||
        uniquePhoneNumbers.length !== phoneNumbers.length ||
        databaseEmailExists !== ''
      ) {
        throw new AppError(
          `Following users already exist in database: ${databaseEmailExists}`,
          400,
        );
      }

      // Call Backend to create the record
      const { data, ok, status } = await internalPost(
        `${config.backendUrl}/internal/company/create`,
        {
          initiatorId,
          companyCode: finalCompanyCode,
          groupCode: finalGroupCode,
          data: {
            group,
            company,
            signatories,
          },
          status: 'PENDING',
          accessibleBy: globalAccessIds || [],
        },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to initiate onboarding',
          status,
        );
      }

      res.status(201).json({
        message: 'Onboarding initiated successfully',
        companyCode: finalCompanyCode,
        groupCode: finalGroupCode,
      });
    } catch (error) {
      next(error);
    }
  }

  static async actionCompanyOnboarding(
    req: Request & { user?: { id: string } },
    res: Response,
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

      // 3. Logic: Verify permissions
      if (!onboarding.accessibleBy.includes(approverId)) {
        throw new AppError(
          'Unauthorized: You do not have permission to process this request',
          403,
        );
      }

      const {
        data: updateStatusRes,
        ok: updateStatusOk,
        status: updateStatusStatus,
      } = await internalPost(`${config.backendUrl}/internal/company/action`, {
        id,
        action,
        approverId,
        remark,
      });

      if (!updateStatusOk) {
        throw new AppError(
          updateStatusRes?.message ||
            updateStatusRes?.error ||
            'Failed to process onboarding approval',
          updateStatusStatus,
        );
      }

      res
        .status(200)
        .json({ message: 'Onboarding request approved and data populated' });
    } catch (error) {
      next(error);
    }
  }

  static async fetchCompanyHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode } = zodParse(companyHistory, req.body);

      // 1. Fetch history record
      const { data, ok, status } = await internalPost<any>(
        `${config.backendUrl}/internal/company/history`,
        { companyCode },
      );

      if (!ok) {
        throw new AppError(
          data?.message || data?.error || 'Failed to fetch company history',
          status || 404,
        );
      }

      res.status(200).json({
        message: 'Company history fetched successfully!',
        code: 200,
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}
