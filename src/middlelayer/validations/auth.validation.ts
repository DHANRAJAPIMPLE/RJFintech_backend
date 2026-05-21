import { z } from 'zod';
import { emailSchema, nameSchema, passwordSchema } from './common.validation';

/**
 * Auth Validation:
 * Defines strict Zod schemas for user registration and login.
 *
 * Why we use it:
 * - To enforce complex password policies (length, case, numbers, special characters).
 * - To ensure email and phone formats are valid before hitting the database.
 * - To handle conditional logic, such as requiring a 'forceLogToken' only when 'action' is set to force login.
 * - It provides early rejection of invalid data, reducing load on the backend.
 */

// Logic: Schema for user registration — ensures all required profile fields are present and valid
export const registerSchema = z.object({
  body: z.object({
    name: nameSchema()
      .min(2, 'Name must be at least 2 characters')
      .max(100, 'Name cannot exceed 100 characters'),
    email: emailSchema,
    password: passwordSchema,
    phone: z
      .string()
      .trim()
      .regex(/^\d{10,15}$/, 'Phone number must be between 10 and 15 digits'),
  }),
});

// Logic: Schema for login — includes 'action' flag for force-login logic
export const loginSchema = z.object({
  body: z
    .object({
      email: emailSchema,

      password: passwordSchema,

      companyCode: z.string().trim().optional(),

      // action: 0 for normal login, 1 for force login
      action: z
        .number()
        .int()
        .refine((val) => val === 0 || val === 1, {
          message: 'action must be 0 (normal) or 1 (force login)',
        })
        .default(0),

      forceLogToken: z.string().trim().optional(),
    })
    .refine(
      (data) => {
        // if action = 1 → forceLogToken is required
        if (data.action === 1) {
          return !!data.forceLogToken;
        }
        return true;
      },
      {
        message: 'forceLogToken is required when action = 1',
        path: ['forceLogToken'],
      },
    )
    .strict(),
});

export const accessRightsSchema = z
  .object({
    email: emailSchema,
    companyCode: z.string().trim().min(1, 'Company code is required'),
  })
  .strict();
