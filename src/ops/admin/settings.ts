// admin_settings_get / admin_settings_update: tenant settings editable by the owner.
// For now one setting: guide_text, the "What this is" section of start_here (≤ 1500 chars).
import { z } from 'zod';
import { DEFAULT_GUIDE, GUIDE_MAX, guideIsDefault, guideText, setGuideText } from '../../core/orient.js';
import { defineOp, type OpContext } from '../define.js';
import { ADMIN, ADMIN_ISOLATION, RequestId } from './common.js';

const Out = z.object({
  settings: z.object({
    guide_text: z.string(),
    guide_text_is_default: z.boolean(),
    guide_text_default: z.string(),
    guide_text_max: z.number().int(),
  }),
});

function settingsOf(ctx: OpContext): z.input<typeof Out> {
  return {
    settings: {
      guide_text: guideText(ctx.core),
      guide_text_is_default: guideIsDefault(ctx.core),
      guide_text_default: DEFAULT_GUIDE,
      guide_text_max: GUIDE_MAX,
    },
  };
}

export const adminSettingsGetOp = defineOp({
  name: 'admin_settings_get',
  summary: 'Read the settings of this Brain (admin).',
  description: 'Returns the tenant settings: guide_text, the "What this is" text that start_here shows to every agent.',
  input: z.object({}).strict(),
  output: Out,
  ...ADMIN,
  idempotent: false,
  handler: (ctx) => settingsOf(ctx),
  isolation: ADMIN_ISOLATION,
});

export const adminSettingsUpdateOp = defineOp({
  name: 'admin_settings_update',
  summary: 'Change the settings of this Brain (admin).',
  description:
    `Updates tenant settings. guide_text (at most ${GUIDE_MAX} characters) is the "What this is" text that start_here ` +
    'shows to every agent; null or an empty string restores the default. Do not put secrets in it.',
  input: z.object({ guide_text: z.string().max(GUIDE_MAX * 2).nullable().optional(), ...RequestId }).strict(),
  output: Out,
  ...ADMIN,
  idempotent: true,
  handler: (ctx, i) => {
    if (i.guide_text !== undefined) setGuideText(ctx.core, i.guide_text);
    return settingsOf(ctx);
  },
  isolation: ADMIN_ISOLATION,
});
