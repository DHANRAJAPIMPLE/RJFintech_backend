/**
 * Company Validation:
 * Centralizes validation logic for company-related requests.
 *
 * Why we use it:
 * - To ensure company onboarding data (GST, IE Code, Address) meets legal and system requirements.
 * - To validate signatory details and enforce business rules (e.g., min/max number of signatories).
 * - To provide strict typing for company actions (approve/reject) and history lookups.
 */
import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\d{10,15}$/, 'Phone number must be between 10 and 15 digits');

const groupCodeSchema = z
  .string()
  .trim()
  .min(3, 'Group code must be at least 3 characters')
  .max(20, 'Group code too long')
  .nullable()
  .optional();

export const companyOnboardingSchema = z.object({
  group: z
    .object({
      name: z
        .string()
        .trim()
        .min(2, 'Group name must be at least 2 characters')
        .max(100, 'Group name too long')
        .toUpperCase()
        .optional()
        .nullable(),
      groupCode: groupCodeSchema.optional().nullable(),
      remarks: z
        .string()
        .trim()
        .max(500, 'Remarks too long')
        .nullable()
        .optional(),
    })
    .optional()
    .nullable(),
  company: z
    .object({
      name: z
        .string()
        .trim()
        .min(2, 'Company name must be at least 2 characters')
        .toUpperCase()
        .max(150, 'Company name too long'),
      gst: z.string().trim().min(10, 'Gst too short').max(15, 'Gst too long'),
      brand: z
        .string()
        .trim()
        .min(2, 'Brand name must be at least 2 characters')
        .max(100, 'Brand name too long'),
      ieCode: z
        .string()
        .trim()
        .min(5, 'IE Code too short')
        .max(10, 'IE Code too long'),
      registeredAt: z
        .string()
        .trim()
        .refine((val) => !isNaN(Date.parse(val)), {
          message: 'Invalid registration date format',
        }),
      address: z
        .string()
        .trim()
        .min(10, 'Full address is required (min 10 characters)')
        .max(500, 'Address too long'),
    })
    .strict(),
  signatories: z
    .array(
      z
        .object({
          name: z
            .string()
            .trim()
            .min(2, 'Name must be at least 2 characters')
            .max(100, 'Name too long'),
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
            .max(50, 'Employee ID too long')
            .optional()
            .nullable(),
        })
        .strict(),
    )
    .min(2, 'At least one signatory is required')
    .max(3, 'Maximum 2 signatories allowed'),
});

export const companyActionSchema = z
  .object({
    id: z.string().uuid('Invalid onboarding ID'),
    action: z.enum(['approve', 'reject']),
    remark: z
      .string()
      .trim()
      .min(2, 'Remark too short')
      .max(500, 'Remark too long'),
  })
  .strict();

export const companyHistory = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();

export const companyCodeOnly = z
  .object({
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();
