import type { AstroConfig } from 'astro'
import type { i18nSchemaOutput } from '../schemas/i18n'
import type { I18nT } from './create-translation-system'
import type { VitesseConfig } from './user-config'
import fs from 'node:fs'
import { createTranslationSystem } from './create-translation-system'

/**
 * Loads and creates a translation system from the file system.
 * Only for use in integration code.
 * In modules loaded by Vite/Astro, import [`useTranslations`](./translations.ts) instead.
 *
 * @see [`./translations.ts`](./translations.ts)
 */
export function createTranslationSystemFromFs<T extends i18nSchemaOutput>(
  opts: Pick<VitesseConfig, 'defaultLocale' | 'locales'>,
  { srcDir }: Pick<AstroConfig, 'srcDir'>,
  pluginTranslations: Record<string, T> = {},
): (locale: string | undefined) => I18nT {
  /** All translation data from the i18n collection, keyed by `id`, which matches locale. */
  let userTranslations: Record<string, i18nSchemaOutput> = {}
  try {
    const i18nDir = new URL('content/i18n/', srcDir)
    // Load the user’s i18n directory
    const files = fs.readdirSync(i18nDir, 'utf-8')
    // Load the user’s i18n collection and ignore the error if it doesn’t exist.
    userTranslations = Object.fromEntries(
      files
        .filter(file => file.endsWith('.json'))
        .map((file) => {
          const id = file.slice(0, -5)
          const data = JSON.parse(fs.readFileSync(new URL(file, i18nDir), 'utf-8'))
          return [id, data] as const
        }),
    )
  }
  catch (e: unknown) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      // i18nDir doesn’t exist, so we ignore the error.
    }
    else {
      // Other errors may be meaningful, e.g. JSON syntax errors, so should be thrown.
      throw e
    }
  }

  return createTranslationSystem(opts, userTranslations, pluginTranslations)
}
