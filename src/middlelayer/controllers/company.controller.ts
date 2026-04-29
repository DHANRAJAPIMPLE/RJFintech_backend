import { ZodError } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { AppError } from '../../shared/middlewares/error.middleware';
import { config } from '../config';
import { internalPost } from '../utils/internal-fetch.util';
import {
  companyOnboardingSchema,
  companyActionSchema,
} from '../validations/onboarding.validator';
import { CodeGenUtil } from '../utils/code-gen.util';

export class CompanyController {

  static async initiateCompanyOnboarding(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validatedData = companyOnboardingSchema.parse(req.body);
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
            // Verify if name matches too? For now, if code exists, use it.
            finalGroupCode = group.groupCode;
          } else {
            // Provided code doesn't exist, treat as new or error? 
            // User says "if both are present then check". Let's assume we use it if it doesn't conflict, 
            // but the safer bet is to use the provided one if it's new, or generate if requested.
            finalGroupCode = group.groupCode;
          }
        } else {
          // Name exists but code doesn't: Create new code
          finalGroupCode = await CodeGenUtil.generateUniqueGroupCode(group.name);
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
      // Note: Since it's a new company, we might pass a null/temp code or handle in backend
      const { data: globalAccessIds } = await internalPost<string[]>(
        `${config.backendUrl}/internal/onboarding/global-access-ids`,
        { companyCode: finalCompanyCode },
      );



     const emails = signatories.map((signatory) => signatory.email);
     const phoneNumbers = signatories.map((signatory) => signatory.phone);

     const uniqueEmail = [...new Set(emails)];
     const uniquePhoneNumbers = [...new Set(phoneNumbers)];
     
     
    let databaseEmailExists : String = "";
      for(const signatory of signatories) {
        const existingUserRes = await internalPost<any>(
      `${config.backendAuthUrl}/get-user`,
      { email: signatory.email },
    );
      if (existingUserRes.ok) {
        databaseEmailExists += signatory.email + ",";
      }
    }

    if(uniqueEmail.length !== emails.length || uniquePhoneNumbers.length !== phoneNumbers.length || databaseEmailExists !== "") {
      throw new AppError(`Following users are already exists in database : ${databaseEmailExists}`, 400);
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
          data.error || 'Failed to initiate onboarding',
          status,
        );
      }

      res.status(201).json({
        message: 'Onboarding initiated successfully',
        companyCode: finalCompanyCode,
        groupCode: finalGroupCode,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: error.errors });
      }
       next(error);
    }
  }

  static async actionCompanyOnboarding(
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    try {
      const validatedData = companyActionSchema.parse(req.body);
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
      console.log("Status : ",onboarding.status);
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

      // 4. Handle rejection

       const {data: updateStatusRes, ok: updateStatusOk, status: updateStatusStatus}  = await internalPost(
          `${config.backendUrl}/internal/company/action`,
          {  id,
            action,
            approverId,
            remark

          },
        );

      if (!updateStatusOk) {
        console.log(updateStatusRes,updateStatusOk,updateStatusStatus)
        throw new AppError(
          updateStatusRes.message || updateStatusRes.error || 'Failed to process onboarding approval',
          updateStatusStatus,
        );
      }

      res
        .status(200)
        .json({ message: 'Onboarding request approved and data populated' });
    } catch (error) {
      if (error instanceof ZodError) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: error.errors });
      }
      next(error);
    }
  }

 static async fetchCompanyHistory(
    req: Request ,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { companyCode } = req.body;

      if (!companyCode) {
        throw new AppError('Company code is required', 400);
      }

      // 1. Fetch onboarding record
      const { data, ok } = await internalPost<any>(
        `${config.backendUrl}/internal/company/history`,
        { companyCode },
      );

      if (!ok) {
        throw new AppError('Onboarding request not found', 404);
      }

    

      res
        .status(200)
        .json({ 
          message: 'Company history fetched successfully!', 
          code: 200,
          data 
        });
    } catch (error) {
      if (error instanceof ZodError) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: error.errors });
      }
      next(error);
    }
  }


}
