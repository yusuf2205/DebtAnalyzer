import { BadRequestException } from '@nestjs/common';
import type { ZodType, z } from 'zod';

/** Строки с NUL-байтом PostgreSQL не принимает; такой ввод всегда враждебный или ошибочный — отклоняем до обращения к БД. */
function hasNul(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (depth > 8 || v === null || typeof v !== 'object') return false;
  return (Array.isArray(v) ? v : Object.values(v as object)).some((x) => hasNul(x, depth + 1));
}

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  if (hasNul(data)) throw new BadRequestException('Некорректные данные: недопустимые символы');
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException({ message: 'Некорректные данные', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}
