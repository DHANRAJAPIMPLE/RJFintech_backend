import { z } from 'zod';

/**
 * AUTH VALIDATION LOGIC:
 * Defines strict Zod schemas to clean and validate incoming request data.
 */

// Logic: Schema for user registration — ensures all required profile fields are present and valid
export const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email format'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    phone: z.string().min(10, 'Phone number must be at least 10 digits'),
  }),
});

// Logic: Schema for login — includes 'action' flag for force-login logic
export const loginSchema = z.object({
  body: z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email format"),

    password: z
      .string(),
      // .min(8, "Password must be at least 8 characters")
      // .regex(/[A-Z]/, "Must contain at least one uppercase letter")
      // .regex(/[a-z]/, "Must contain at least one lowercase letter")
      // .regex(/[0-9]/, "Must contain at least one number")
      // .regex(/[^A-Za-z0-9]/, "Must contain at least one special character"),

    // only 0 or 1
    action: z
      .number()
      .int()
      .refine((val) => val === 0 || val === 1, {
        message: "action must be 0 (normal) or 1 (force login)",
      })
      .default(0),

    force_log_token: z.string().optional(),
  })
  .refine(
    (data) => {
      // if action = 1 → token is required
      if (data.action === 1) {
        return !!data.force_log_token;
      }
      return true;
    },
    {
      message: "force_log_token is required when action = 1",
      path: ["force_log_token"],
    }
  ),
});

