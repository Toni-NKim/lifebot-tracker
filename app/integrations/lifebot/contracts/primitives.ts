import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

export const id = z.string().uuid();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    try {
      Temporal.PlainDate.from(s);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid calendar date');
export const instant = z.string().datetime({ offset: true });
export const zone = z.string().refine((s) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: s });
    return true;
  } catch {
    return false;
  }
});
export const count = z.number().int().nonnegative();
export const token = z.string().min(1);
export const versions = z
  .object({ habit: token.optional(), todo: token.optional(), timebox: token.optional() })
  .strict();
export const pageInput = {
  offset: count.max(100000).default(0),
  limit: z.number().int().min(1).max(200).default(50),
};
export const target = z
  .object({ todo_id: id, occurrence_id: id, anchor_date: date.nullable() })
  .strict();
export const page = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item).max(200),
      total: count,
      offset: count,
      limit: z.number().int().min(1).max(200),
    })
    .strict();
