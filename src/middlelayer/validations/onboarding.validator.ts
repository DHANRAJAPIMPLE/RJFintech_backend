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
  .regex(
    /^[A-Z0-9_-]+$/,
    'Group code must be alphanumeric (caps, numbers, _, -)',
  )
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
  company: z.object({
    name: z
      .string()
      .trim()
      .min(2, 'Company name must be at least 2 characters')
      .toUpperCase()
      .max(150, 'Company name too long'),
    gst: z.string().trim().max(15, 'Gst too long'),
    brand: z
      .string()
      .trim()
      .min(2, 'Brand name must be at least 2 characters')
      .max(100, 'Brand name too long'),
    ieCode: z.string().trim().max(10, 'IE Code too long'),
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
    .max(30, 'Too many permissions')
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
});

export const orgOnboardingAction = z.object({
  id: z.string().uuid('Invalid onboarding ID'),
  action: z.enum(['approve', 'reject']),
  remark: z.string().trim().max(500, 'Remark too long').optional(),
});

export const userHistory = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
  companyCode: z.string().trim().min(1, 'Company code is required'),
});

export const companyHistory = z.object({
  companyCode: z.string().trim().min(1, 'Company code is required'),
});

export const orgHistory = z.object({
  companyCode: z.string().trim().min(1, 'Company code is required'),
});

export const companyCodeOnly = z.object({
  companyCode: z.string().trim().min(1, 'Company code is required'),
});

export const userStatusUpdateSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
});

export const roleUpsertSchema = z.array(
  z.object({
    roleName: z.string().trim().min(1, 'Role name is required'),
    category: z.string().trim().min(1, 'Category is required'),
    subCategory: z.string().trim().min(1, 'Sub-category is required'),
    permissionLevel: z.number().int().min(0, 'Permission level must be >= 0'),
  }),
);
