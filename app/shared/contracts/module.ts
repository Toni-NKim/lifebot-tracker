import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { AppError, UUID, DateSchema, validate } from './index.js';
export type ModuleName = 'habit' | 'todo' | 'timebox';
export type NewModuleName = Exclude<ModuleName, 'habit'>;

const object = <T extends Record<string, TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
export const ModuleInstant = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$',
});
export const ModuleHash = Type.String({ pattern: '^[0-9a-f]{64}$' });
export const ModuleSchema = object({
  schema_version: Type.Literal(1),
  kind: Type.Literal('module'),
  module: Type.Union([Type.Literal('todo'), Type.Literal('timebox')]),
  id: UUID,
  habit_tracker_id: UUID,
  created_at: ModuleInstant,
  timezone: Type.String(),
  week_starts_on: Type.Literal('monday'),
  activated_on: DateSchema,
});
export type ModuleSettings = Static<typeof ModuleSchema>;
export const ModuleCommitSchema = object({
  schema_version: Type.Literal(1),
  kind: Type.Literal('module_commit'),
  module_id: UUID,
  id: UUID,
  recorded_at: ModuleInstant,
  request_sha256: ModuleHash,
  files: Type.Array(Type.String({ pattern: '^[A-Z][A-Za-z]+/[0-9a-f-]{36}/[0-9]{6,}\\.md$' }), {
    minItems: 1,
    uniqueItems: true,
  }),
});
export type ModuleCommit = Static<typeof ModuleCommitSchema>;
export interface ModuleRecord {
  schema_version: number;
  kind: string;
  module_id: string;
  id: string;
  revision: number;
  command_id: string;
  created_at: string;
  recorded_at: string;
  data: unknown;
}
export interface RecordInput {
  kind: string;
  id: string;
  data: unknown;
}
export interface RecordContract {
  directory: string;
  version: number;
  schema: TSchema;
}
export interface ModuleContract {
  name: NewModuleName;
  records: Record<string, RecordContract>;
  validate?: (records: readonly ModuleRecord[], settings: ModuleSettings) => void;
}
export function recordSchema(kind: string, contract: RecordContract) {
  return object({
    schema_version: Type.Literal(contract.version),
    kind: Type.Literal(kind),
    module_id: UUID,
    id: UUID,
    revision: Type.Integer({ minimum: 1 }),
    command_id: UUID,
    created_at: ModuleInstant,
    recorded_at: ModuleInstant,
    data: contract.schema,
  });
}
export function parseModuleRecord(value: unknown, contract: ModuleContract): ModuleRecord {
  const kind = (value as ModuleRecord)?.kind;
  const type = Object.hasOwn(contract.records, kind) ? contract.records[kind] : undefined;
  if (!type)
    throw new AppError('INVALID_VAULT', `Unsupported ${contract.name} record kind: ${kind}`);
  return validate<ModuleRecord>(recordSchema(kind, type), value);
}
