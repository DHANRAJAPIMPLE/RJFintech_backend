import { prisma } from '../lib/prisma';
import { AppError } from '../middlewares/error.middleware';

/**
 * Resolves a companyId from a companyId/companyCode pair.
 * 
 * Priority: companyId is used directly if provided; otherwise companyCode is used
 * to look up the company. Throws AppError if neither is provided or if the company
 * is not found.
 *
 * This helper extracts the repeated resolve pattern found across:
 * - fetchAllUsers, getUserHistory, createUserOnboarding (user.db.modules)
 * - fetchStructure, fetchOrgHistory, initiateRequest, validateInitiation (org.db.modules)
 * - initiateWorkflowRequest, fetchWorkflowHistory, fetchWorkflows (workflow.db.modules)
 */

interface ResolveCompanyIdOptions {
  companyId?: string | null;
  companyCode?: string | null;
}

/**
 * Standard resolution: throws AppError on missing input or not found.
 * Used by: fetchAllUsers, getUserHistory, createUserOnboarding, fetchOrgHistory,
 *          initiateRequest, initiateWorkflowRequest, fetchWorkflows
 */
export async function resolveCompanyId(
  options: ResolveCompanyIdOptions,
): Promise<string> {
  const { companyId, companyCode } = options;

  if (companyId) return companyId;

  if (!companyCode) {
    throw new AppError('companyCode or companyId is required', 400);
  }

  const company = await prisma.company.findUnique({
    where: { companyCode },
  });

  if (!company) throw new AppError('Company not found', 404);

  return company.id;
}

/**
 * Resolution variant that returns JSON error responses instead of throwing.
 * Used by: validateInitiation, fetchStructure (org.db.modules)
 * 
 * Returns { companyId, error } — if error is set, the caller should return early
 * with the provided response payload.
 */
export async function resolveCompanyIdSafe(
  options: ResolveCompanyIdOptions,
): Promise<{ companyId: string | null; error: { status: number; body: any } | null }> {
  const { companyId, companyCode } = options;

  if (companyId) return { companyId, error: null };

  if (!companyCode) {
    return {
      companyId: null,
      error: {
        status: 400,
        body: { success: false, message: 'companyCode or companyId is required' },
      },
    };
  }

  const company = await prisma.company.findUnique({
    where: { companyCode },
  });

  if (!company) {
    return {
      companyId: null,
      error: {
        status: 404,
        body: { success: false, message: 'Company not found' },
      },
    };
  }

  return { companyId: company.id, error: null };
}

/**
 * Workflow history variant: does not throw on missing both — returns null.
 * Used by: fetchWorkflowHistory (workflow.db.modules)
 * 
 * Throws only if company code is provided but not found.
 * Returns null if neither companyId nor companyCode is provided.
 */
export async function resolveCompanyIdOrNull(
  options: ResolveCompanyIdOptions,
): Promise<string | null> {
  const { companyId, companyCode } = options;

  if (companyId) return companyId;

  if (!companyCode) return null;

  const company = await prisma.company.findUnique({
    where: { companyCode },
  });

  if (!company) throw new AppError('Company not found', 404);

  return company.id;
}
