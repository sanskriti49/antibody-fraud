import { z } from 'zod';

const secret = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());
const datapack = z.preprocess((value) => value === '' ? undefined : value, z.uuid().optional());

export const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  RISK_CHALLENGE_THRESHOLD: z.coerce.number().int().min(1).max(99).default(25),
  RISK_BLOCK_THRESHOLD: z.coerce.number().int().min(2).max(100).default(72),
  INVESTIGATION_MODE: z.enum(['rules', 'agents', 'meko']).default('rules'),
  MEKO_API_KEY: secret,
  MEKO_DATAPACK_ID: datapack,
  MEKO_RISK_SIGNALS_DATAPACK_ID: datapack,
  INVESTIGATION_TEAM: z.enum(['single', 'collective']).default('collective'),
  MEKO_AUTO_PUBLISH: z.enum(['on', 'off']).default('on'),
  INVESTIGATION_PROFILE: z.enum(['extended', 'legacy']).default('extended'),
  MEMORY_POLICY: z.enum(['off', 'shadow', 'enforce']).default('off'),
  // local is an in-process stand-in for demos without Meko keys. It is not hosted Meko.
  MEMORY_STORE: z.enum(['meko', 'local']).default('meko'),
  MEKO_TIMEOUT_MS: z.coerce.number().int().min(100).max(15_000).default(12_000),
  LLM_PROVIDER: z.enum(['none', 'gemini', 'groq', 'ollama']).default('none'),
  GEMINI_API_KEY: secret,
  GEMINI_MODEL: z.string().regex(/^[a-z0-9.-]+$/).default('gemini-3.1-flash-lite'),
  GROQ_API_KEY: secret,
  GROQ_MODEL: z.string().regex(/^[a-zA-Z0-9._/-]+$/).default('openai/gpt-oss-20b'),
  GROQ_INVESTIGATOR_MODEL: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^[a-zA-Z0-9._/-]+$/).optional()),
  GROQ_JSON_MODE: z.enum(['strict', 'best_effort', 'json_object']).default('strict'),
  LLM_OLLAMA_FALLBACK: z.enum(['off', 'on']).default('off'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5:3b'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8000),
}).superRefine((env, ctx) => {
  if (env.MEKO_DATAPACK_ID && env.MEKO_DATAPACK_ID.toLowerCase() === env.MEKO_RISK_SIGNALS_DATAPACK_ID?.toLowerCase()) {
    ctx.addIssue({ code: 'custom', path: ['MEKO_RISK_SIGNALS_DATAPACK_ID'], message: 'Use a separate datapack' });
  }
  if (env.MEMORY_STORE === 'local' && env.INVESTIGATION_MODE === 'meko') {
    ctx.addIssue({ code: 'custom', path: ['MEMORY_STORE'], message: 'Meko mode needs the hosted store' });
  }
  if (env.RISK_CHALLENGE_THRESHOLD >= env.RISK_BLOCK_THRESHOLD) {
    ctx.addIssue({ code: 'custom', path: ['RISK_BLOCK_THRESHOLD'], message: 'Must exceed the challenge threshold' });
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error('Check the following environment variables: ' + fields);
  }
  return parsed.data;
}
