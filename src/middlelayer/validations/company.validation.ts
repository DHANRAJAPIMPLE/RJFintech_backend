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
import {
  cursorPaginationFields,
  emailSchema,
  nameSchema,
  optionalCursorTokenSchema,
  paginationSchema,
  requiredActivePendingTypeSchema,
} from './common.validation';

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

const optionalDateStringSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    return value;
  },
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .optional(),
);

const yesNoSchema = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(['yes', 'no']).nullable().optional(),
  )
  .optional();

const companyDateRangeFilterSchema = z
  .object({
    dateRange: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.trim().toUpperCase() : value,
        z.enum(['7DAYS', '15DAYS', '1MONTH', 'CUSTOM']).nullable().optional(),
      )
      .optional(),
    fromDate: optionalDateStringSchema.nullable().optional(),
    toDate: optionalDateStringSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dateRange !== 'CUSTOM') return;

    if (!value.fromDate || !value.toDate) {
      context.addIssue({
        code: 'custom',
        message: 'fromDate and toDate are required when dateRange is CUSTOM',
        path: ['fromDate'],
      });
      return;
    }

    const fromDate = new Date(value.fromDate);
    const toDate = new Date(value.toDate);
    if (
      Number.isNaN(fromDate.getTime()) ||
      Number.isNaN(toDate.getTime()) ||
      fromDate.getTime() > toDate.getTime()
    ) {
      context.addIssue({
        code: 'custom',
        message: 'fromDate must be earlier than or equal to toDate',
        path: ['toDate'],
      });
    }
  });

const companyAppliedFilterSchema = z
  .object({
    incorporationDate: companyDateRangeFilterSchema.nullable().optional(),
    incorperationDate: companyDateRangeFilterSchema.nullable().optional(),
    gstcode: yesNoSchema,
    gstCode: yesNoSchema,
    isCode: yesNoSchema,
    ieCode: yesNoSchema,
    signatoryCount: z
      .preprocess(
        (value) => {
          if (value === undefined || value === null || value === '') {
            return undefined;
          }
          return value;
        },
        z
          .union([
            z.coerce.number().int().min(2).max(5),
            z.array(z.coerce.number().int().min(2).max(5)),
          ])
          .nullable()
          .optional(),
      )
      .optional(),
  })
  .strict();

const companyListPaginationSchema = z
  .object({
    statusType: requiredActivePendingTypeSchema,
    query: cursorPaginationFields.query,
    page: cursorPaginationFields.page,
    direction: cursorPaginationFields.direction,
    cursor: optionalCursorTokenSchema('Cursor').nullable().optional(),
    prevCursor: optionalCursorTokenSchema('Previous cursor')
      .nullable()
      .optional(),
    nextCursor: optionalCursorTokenSchema('Next cursor').nullable().optional(),
    cursorId: optionalCursorTokenSchema('Cursor').nullable().optional(),
    topCursor: optionalCursorTokenSchema('Top cursor').nullable().optional(),
    ...paginationSchema,
  })
  .strict();

export const companyOnboardingSchema = z.object({
  group: z
    .object({
      name: nameSchema('Group name')
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
      name: nameSchema('Company name')
        .min(2, 'Company name must be at least 2 characters')
        .toUpperCase()
        .max(150, 'Company name too long'),
      gst: z
        .string()
        .trim()
        .min(10, 'Gst too short')
        .max(15, 'Gst too long')
        .optional()
        .nullable(),
      brand: nameSchema('Brand name')
        .min(2, 'Brand name must be at least 2 characters')
        .max(100, 'Brand name too long')
        .optional()
        .nullable(),
      ieCode: z
        .string()
        .trim()
        .min(5, 'IE Code too short')
        .max(10, 'IE Code too long')
        .optional()
        .nullable(),
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
          name: nameSchema()
            .min(2, 'Name must be at least 2 characters')
            .max(100, 'Name too long'),
          email: emailSchema,
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

export const companyListSchema = z
  .object({
    statusType: requiredActivePendingTypeSchema.optional(),
    ...cursorPaginationFields,
    filter: z.boolean().optional(),
    pagination: companyListPaginationSchema.optional(),
    applied: companyAppliedFilterSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const statusType = value.pagination?.statusType ?? value.statusType;
    if (!statusType) {
      context.addIssue({
        code: 'custom',
        message: 'statusType is required',
        path: ['statusType'],
      });
    }
  });
