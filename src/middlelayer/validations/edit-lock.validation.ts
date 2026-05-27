import { z } from 'zod';
import { emailSchema } from './common.validation';

const targetKeySchema = (fieldName: string) =>
  z.string().trim().min(1, `${fieldName} is required`).max(255);

export const editLockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('USER'),
      target: z
        .object({
          email: emailSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ORG'),
      target: z
        .object({
          nodePath: targetKeySchema('Node path'),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('WORKFLOW'),
      target: z
        .object({
          nodePath: targetKeySchema('Node path'),
          module: targetKeySchema('Module'),
          subModule: targetKeySchema('Sub-module'),
          levelsHash: targetKeySchema('Levels hash'),
        })
        .strict(),
    })
    .strict(),
]);
