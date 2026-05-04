import { z } from 'zod';

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
    name: z
      .string()
      .trim()
      .min(2, 'Name must be at least 2 characters')
      .max(100, 'Name cannot exceed 100 characters'),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('Invalid email format')
      .max(150, 'Email is too long'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(64, 'Password cannot exceed 64 characters')
      .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Must contain at least one number')
      .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character'),
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
      email: z.string().trim().toLowerCase().email('Invalid email format'),

      password: z.string().min(8, 'Password is required'),

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
