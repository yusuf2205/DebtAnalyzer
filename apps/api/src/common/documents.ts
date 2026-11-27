import { BadRequestException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DOC_TYPES: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  pdf: { mime: 'application/pdf', magic: (b) => b.subarray(0, 4).toString() === '%PDF' },
  png: { mime: 'image/png', magic: (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG' },
  jpg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  jpeg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
};

/** Проверяет тип по расширению и содержимому и сохраняет файл под случайным именем (имя пользователя в путь не попадает). */
export async function storeDocument(file: Express.Multer.File, uploadDir: string) {
  const filename = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
  const ext = filename.split('.').pop()!.toLowerCase();
  const type = DOC_TYPES[ext];
  if (!type) throw new BadRequestException('Допустимые форматы: PDF, PNG, JPG, DOCX, XLSX');
  if (!type.magic(file.buffer)) throw new BadRequestException('Содержимое файла не соответствует расширению');
  const dir = join(uploadDir, 'docs');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${ext}`);
  await writeFile(path, file.buffer);
  return { filename, mime: type.mime, size: file.size, sha256: createHash('sha256').update(file.buffer).digest('hex'), path };
}
