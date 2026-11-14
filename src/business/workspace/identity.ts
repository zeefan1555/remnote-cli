import { z } from 'zod';

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const keySchema = z.string().regex(/^(?:[A-Za-z0-9_-]{1,256}|new:[A-Za-z0-9_-]{1,100})$/);
export const blockSchema = z.string().regex(/^[A-Za-z0-9-]{1,600}$/);

/** Once assigned this is retained, including when a local key receives a native Rem ID. */
export function nativeBlockId(id: string): string {
  return `rn-${Buffer.from(idSchema.parse(id), 'utf8').toString('hex')}`;
}

export function recordPath(id: string): string {
  return `.remnote/records/${idSchema.parse(id)}.json`;
}

export function originalPath(kind: 'rems' | 'public', id: string): string {
  return `.remnote/originals/${kind}/${idSchema.parse(id)}.json`;
}
