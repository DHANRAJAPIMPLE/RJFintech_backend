import { z } from 'zod';

export const companyOnboardingSchema = z.object({
  group: z.object({
    name: z.string().min(1, 'Group name is required'),
    groupCode: z.string().nullable().optional(),
    remarks: z.string().nullable().optional(),
  }),
  company: z.object({
    companyCode: z.string().nullable().optional(),
    name: z.string().min(1, 'Company name is required'),
    gst: z.string().min(1, 'GST is required'),
    brand: z.string().min(1, 'Brand name is required'),
    ieCode: z.string().min(1, 'IE Code is required'),
    registeredAt: z.string().min(1, 'Registration date is required'),
    address: z.string().min(1, 'Address is required'),
  }),
  signatories: z.array(z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Invalid email format'),
    phone: z.string().min(10, 'Phone must be at least 10 characters'),
    designation: z.string().min(1, 'Designation is required'),
    employeeId: z.string().optional(),
  })).min(1, 'At least one signatory is required'),
});

export const companyActionSchema = z.object({
  id: z.string().uuid('Invalid onboarding ID'),
  action: z.enum(['approve', 'reject']),
  remark: z.string().optional(),
});

export const userOnboardingSchema = z.object({
  basicDetails: z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Invalid email format'),
    phone: z.string().min(10, 'Phone must be at least 10 characters'),
    incorporationDate: z.string().optional(),
    designation: z.string().min(1, 'Designation is required'),
    employeeId: z.string().min(1, 'Employee ID is required'),
    reportingManager: z.string().email('Invalid manager email format'),
  }),
  permissions: z.array(z.object({
    accessType: z.string().min(1, 'Access type is required'),
    roleName: z.string().min(1, 'Role name is required'),
    roleCategory: z.string().min(1, 'Role category is required'),
    roleSubCategory: z.string().min(1, 'Role sub-category is required'),
    nodeName: z.string().min(1, 'Node name is required'),
    nodePath: z.string().min(1, 'Node path is required'),
  })).optional(),
});

export const userActionSchema = z.object({
  id: z.string().uuid('Invalid onboarding ID'),
  action: z.enum(['approve', 'reject']),
  remark: z.string().optional(),
});
