import { Type, type TSchema } from '@sinclair/typebox';
export const strict = <T extends Record<string, TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const Title = Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' });
