import { z } from 'zod';

/**
 * ONBOARDING VALIDATION LOGIC:
 * Comprehensive schemas for company and user onboarding processes.
 */

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\d{10,15}$/, 'Phone number must be between 10 and 15 digits');

const companyCodeSchema = z
  .string()
  .trim()
  .min(3, 'Company code must be at least 3 characters')
  .max(20, 'Company code too long')
  .regex(
    /^[A-Z0-9_-]+$/,
    'Company code must be alphanumeric (caps, numbers, _, -)',
  )
  .nullable()
  .optional();

const groupCodeSchema = z
  .string()
  .trim()
  .min(3, 'Group code must be at least 3 characters')
  .max(20, 'Group code too long')
  .regex(
    /^[A-Z0-9_-]+$/,
    'Group code must be alphanumeric (caps, numbers, _, -)',
  )
  .nullable()
  .optional();

export const companyOnboardingSchema = z.object({
  group: z.object({
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
  }).optional().nullable(),
  company: z.object({
    companyCode: companyCodeSchema.optional().nullable(),
    name: z
      .string()
      .trim()
      .min(2, 'Company name must be at least 2 characters')
      .toUpperCase()
      .max(150, 'Company name too long'),
    gst: z
      .string()
      .trim()
      .regex(
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
        'Invalid GST format (Example: 27AAAAA0000A1Z5)',
      ),
    brand: z
      .string()
      .trim()
      .min(2, 'Brand name must be at least 2 characters')
      .max(100, 'Brand name too long'),
    ieCode: z
      .string()
      .trim()
      .regex(/^\d{10}$/, 'IE Code must be exactly 10 digits'),
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
  }),
  signatories: z
    .array(
      z.object({
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
          .max(100, 'Designation too long'),
        employeeId: z
          .string()
          .trim()
          .max(50, 'Employee ID too long')
          .optional(),
      }),
    )
    .min(2, 'At least one signatory is required')
    .max(3, 'Maximum 2 signatories allowed'),
});

export const companyActionSchema = z.object({
  id: z.string().uuid('Invalid onboarding ID'),
  action: z.enum(['approve', 'reject']),
  remark: z.string().trim().max(500, 'Remark too long').optional(),
});

export const userOnboardingSchema = z.object({
  basicDetails: z.object({
    name: z
      .string()
      .trim()
      .min(2, 'Name must be at least 2 characters')
      .max(20, 'Name too long'),
    email: z.string().trim().toLowerCase().email('Invalid email format'),
    phone: phoneSchema,
    incorporationDate: z
      .string()
      .trim()
      .refine((val) => !isNaN(Date.parse(val)), {
        message: 'Invalid date format',
      })
      .optional(),
    designation: z
      .string()
      .trim()
      .min(2, 'Designation must be at least 2 characters')
      .max(100, 'Designation too long'),
    employeeId: z
      .string()
      .trim()
      .min(2, 'Employee ID must be at least 2 characters')
      .max(50, 'Employee ID too long'),
    reportingManager: z
      .string()
      .trim()
      .toLowerCase()
      .email('Invalid manager email format'),
  }),
  permissions: z
    .array(
      z.object({
        accessType: z.string().trim().min(1, 'Access type is required'),
        roleName: z.string().trim().min(1, 'Role name is required'),
        roleCategory: z.string().trim().min(1, 'Role category is required'),
        roleSubCategory: z
          .string()
          .trim()
          .min(1, 'Role sub-category is required'),
        nodeName: z.string().trim().min(1, 'Node name is required'),
        nodePath: z.string().trim().min(1, 'Node path is required'),
      }),
    )
    .max(50, 'Too many permissions')
    .optional(),
});

export const userActionSchema = z.object({
  id: z.string().uuid('Invalid onboarding ID'),
  action: z.enum(['approve', 'reject']),
  remark: z.string().trim().max(500, 'Remark too long').optional(),
});


export const orgOnboardingSchema = z.object({
  companyCode: z.string().trim().min(1, 'Company code is required'),
  newNodeName: z.string().trim().min(1, 'New node name is required'),
  nodeType: z.enum(['ROOT', 'DEPARTMENT', 'TEAM', 'PLANT', 'LOCATION']),
  parentNode: z.object({
    nodeName: z.string().trim().min(1, 'Node name is required'),
    nodePath: z.string().trim().min(1, 'Node path is required'),
  }),
})


