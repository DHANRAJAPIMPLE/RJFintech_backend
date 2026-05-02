import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\d{10,15}$/, 'Phone number must be between 10 and 15 digits');

export const userOnboardingSchema = z.object({
  basicDetails: z
    .object({
      name: z
        .string()
        .trim()
        .min(2, 'Name must be at least 2 characters')
        .max(20, 'Name too long'),
      email: z.string().trim().toLowerCase().email('Invalid email format'),
      phone: phoneSchema,
      designation: z
        .string()
        .trim()
        .min(2, 'Designation must be at least 2 characters')
        .max(100, 'Designation too long')
        .optional()
        .nullable(),
      employeeId: z
        .string()
        .trim()
        .min(2, 'Employee ID must be at least 2 characters')
        .max(50, 'Employee ID too long')
        .optional()
        .nullable(),
      reportingManager: z
        .string()
        .trim()
        .toLowerCase()
        .email('Invalid manager email format')
        .optional()
        .nullable(),
    })
    .strict(),
  permissions: z
    .array(
      z
        .object({
          accessType: z.enum(['PRIMARY', 'SECONDARY']),
          roleName: z.string().trim().min(1, 'Role name is required'),
          roleCategory: z.string().trim().min(1, 'Role category is required'),
          roleSubCategory: z
            .string()
            .trim()
            .min(1, 'Role sub-category is required'),
          nodeName: z.string().trim().min(1, 'Node name is required'),
          nodePath: z.string().trim().min(1, 'Node path is required'),
        })
        .strict(),
    )
    .min(1, 'At least one permission is required')
    .refine(
      (permissions) =>
        permissions.filter((p) => p.accessType === 'PRIMARY').length === 1,
      {
        message: 'Exactly one PRIMARY permission is required',
        path: ['permissions'],
      },
    ),
});

export const userActionSchema = z
  .object({
    id: z.string().uuid('Invalid onboarding ID'),
    action: z.enum(['approve', 'reject']),
    remark: z
      .string()
      .trim()
      .min(2, 'Remark is too short')
      .max(500, 'Remark too long'),
  })
  .strict();

export const userStatusUpdateSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Invalid email format'),
  })
  .strict();

export const userHistory = z
  .object({
    email: z.string().trim().toLowerCase().email('Invalid email format'),
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();
