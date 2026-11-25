import { BadRequestException } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException({ message: 'Некорректные данные', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}
