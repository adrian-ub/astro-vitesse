import type { AstroIntegration, HookParameters } from 'astro'
import type { UserI18nSchema } from './translations'
import { AstroError } from 'astro/errors'
import { z } from 'astro/zod'
import { parseWithFriendlyErrors } from '../utils/error-map'
import { VitesseConfigSchema, type VitesseUserConfig } from '../utils/user-config'

const astroIntegrationSchema = z.object({
  name: z.string(),
  hooks: z.object({}).passthrough().default({}),
}) as z.Schema<AstroIntegration>

const baseVitessePluginSchema = z.object({
  /** Name of the Vitesse plugin. */
  name: z.string(),
})

/**
 * A plugin `config` and `updateConfig` argument are purposely not validated using the Vitesse
 * user config schema but properly typed for user convenience because we do not want to run any of
 * the Zod `transform`s used in the user config schema when running plugins.
 */
const vitessePluginSchema = baseVitessePluginSchema.extend({
  /** The different hooks available to the plugin. */
  hooks: z.object({
    /**
     * Plugin setup function called with an object containing various values that can be used by
     * the plugin to interact with Vitesse.
     */
    setup: z.function(
      z.tuple([
        z.object({
          /**
           * A read-only copy of the user-supplied Vitesse configuration.
           *
           * Note that this configuration may have been updated by other plugins configured
           * before this one.
           */
          config: z.any() as z.Schema<
            // The configuration passed to plugins should contains the list of plugins.
            VitesseUserConfig & { plugins?: z.input<typeof baseVitessePluginSchema>[] }
          >,
          /**
           * A callback function to update the user-supplied Vitesse configuration.
           *
           * You only need to provide the configuration values that you want to update but no deep
           * merge is performed.
           *
           * @example
           * {
           *  name: 'My Vitesse Plugin',
           *  hooks: {
           *    setup({ updateConfig }) {
           *      updateConfig({
           *        description: 'Custom description',
           *      });
           *    }
           *  }
           * }
           */
          updateConfig: z.function(
            z.tuple([z.record(z.any()) as z.Schema<Partial<VitesseUserConfig>>]),
            z.void(),
          ),
          /**
           * A callback function to add an Astro integration required by this plugin.
           *
           * @see https://docs.astro.build/en/reference/integrations-reference/
           *
           * @example
           * {
           *  name: 'My Vitesse Plugin',
           *  hooks: {
           *    setup({ addIntegration }) {
           *      addIntegration({
           *        name: 'My Plugin Astro Integration',
           *        hooks: {
           *          'astro:config:setup': () => {
           *            // …
           *          },
           *        },
           *      });
           *    }
           *  }
           * }
           */
          addIntegration: z.function(z.tuple([astroIntegrationSchema]), z.void()),
          /**
           * A read-only copy of the user-supplied Astro configuration.
           *
           * Note that this configuration is resolved before any other integrations have run.
           *
           * @see https://docs.astro.build/en/reference/integrations-reference/#config-option
           */
          astroConfig: z.any() as z.Schema<VitessePluginContext['config']>,
          /**
           * The command used to run Vitesse.
           *
           * @see https://docs.astro.build/en/reference/integrations-reference/#command-option
           */
          command: z.any() as z.Schema<VitessePluginContext['command']>,
          /**
           * `false` when the dev server starts, `true` when a reload is triggered.
           *
           * @see https://docs.astro.build/en/reference/integrations-reference/#isrestart-option
           */
          isRestart: z.any() as z.Schema<VitessePluginContext['isRestart']>,
          /**
           * An instance of the Astro integration logger with all logged messages prefixed with the
           * plugin name.
           *
           * @see https://docs.astro.build/en/reference/integrations-reference/#astrointegrationlogger
           */
          logger: z.any() as z.Schema<VitessePluginContext['logger']>,
          /**
           * A callback function to add or update translations strings.
           *
           * @see https://vitesse.astro.build/guides/i18n/#extend-translation-schema
           *
           * @example
           * {
           *  name: 'My Vitesse Plugin',
           *  hooks: {
           *    setup({ injectTranslations }) {
           *      injectTranslations({
           *        en: {
           *          'myPlugin.doThing': 'Do the thing',
           *        },
           *        fr: {
           *          'myPlugin.doThing': 'Faire le truc',
           *        },
           *      });
           *    }
           *  }
           * }
           */
          injectTranslations: z.function(
            z.tuple([z.record(z.string(), z.record(z.string(), z.string()))]),
            z.void(),
          ),
        }),
      ]),
      z.union([z.void(), z.promise(z.void())]),
    ),
  }),
})

const vitessePluginsConfigSchema = z.array(vitessePluginSchema).default([])

/**
 * Runs Vitesse plugins in the order that they are configured after validating the user-provided
 * configuration and returns the final validated user config that may have been updated by the
 * plugins and a list of any integrations added by the plugins.
 */
// eslint-disable-next-line ts/explicit-function-return-type
export async function runPlugins(
  vitesseUserConfig: VitesseUserConfig,
  pluginsUserConfig: VitessePluginsUserConfig,
  context: VitessePluginContext,
) {
  // Validate the user-provided configuration.
  let userConfig = vitesseUserConfig

  let vitesseConfig = parseWithFriendlyErrors(
    VitesseConfigSchema,
    userConfig,
    'Invalid config passed to vitesse integration',
  )

  // Validate the user-provided plugins configuration.
  const pluginsConfig = parseWithFriendlyErrors(
    vitessePluginsConfigSchema,
    pluginsUserConfig,
    'Invalid plugins config passed to vitesse integration',
  )

  // A list of Astro integrations added by the various plugins.
  const integrations: AstroIntegration[] = []
  // A list of translations injected by the various plugins keyed by locale.
  const pluginTranslations: PluginTranslations = {}

  for (const {
    name,
    hooks: { setup },
  } of pluginsConfig) {
    await setup({
      config: pluginsUserConfig ? { ...userConfig, plugins: pluginsUserConfig } : userConfig,
      updateConfig(newConfig) {
        // Ensure that plugins do not update the `plugins` config key.
        if ('plugins' in newConfig) {
          throw new Error(
            `The '${name}' plugin tried to update the 'plugins' config key which is not supported.`,
          )
        }

        // If the plugin is updating the user config, re-validate it.
        const mergedUserConfig = { ...userConfig, ...newConfig }
        const mergedConfig = parseWithFriendlyErrors(
          VitesseConfigSchema,
          mergedUserConfig,
          `Invalid config update provided by the '${name}' plugin`,
        )

        // If the updated config is valid, keep track of both the user config and parsed config.
        userConfig = mergedUserConfig
        vitesseConfig = mergedConfig
      },
      addIntegration(integration) {
        // Collect any Astro integrations added by the plugin.
        integrations.push(integration)
      },
      astroConfig: {
        ...context.config,
        integrations: [...context.config.integrations, ...integrations],
      },
      command: context.command,
      isRestart: context.isRestart,
      logger: context.logger.fork(name),
      injectTranslations(translations) {
        // Merge the translations injected by the plugin.
        for (const [locale, localeTranslations] of Object.entries(translations)) {
          pluginTranslations[locale] ??= {}
          Object.assign(pluginTranslations[locale]!, localeTranslations)
        }
      },
    })
  }

  if (context.config.output === 'static' && !vitesseConfig.prerender) {
    throw new AstroError(
      'Vitesse’s `prerender: false` option requires `output: "hybrid"` or `"server"` in your Astro config.',
      'Either set `output` in your Astro config or set `prerender: true` in the Vitesse options.\n\n'
      + 'Learn more about rendering modes in the Astro docs: https://docs.astro.build/en/basics/rendering-modes/',
    )
  }

  return { integrations, vitesseConfig, pluginTranslations }
}

export function injectPluginTranslationsTypes(
  translations: PluginTranslations,
  injectTypes: HookParameters<'astro:config:done'>['injectTypes'],
): void {
  const allKeys = new Set<string>()

  for (const localeTranslations of Object.values(translations)) {
    for (const key of Object.keys(localeTranslations)) {
      allKeys.add(key)
    }
  }

  // If there are no translations to inject, we don't need to generate any types or cleanup
  // previous ones as they will not be referenced anymore.
  if (allKeys.size === 0)
    return

  injectTypes({
    filename: 'i18n-plugins.d.ts',
    content: `declare namespace VitesseApp {
  type PluginUIStringKeys = {
    ${[...allKeys].map(key => `'${key}': string;`).join('\n\t\t')}
  };
  interface I18n extends PluginUIStringKeys {}
}`,
  })
}

type VitessePluginsUserConfig = z.input<typeof vitessePluginsConfigSchema>

export type VitessePlugin = z.input<typeof vitessePluginSchema>

export type VitesseUserConfigWithPlugins = VitesseUserConfig & {
  /**
   * A list of plugins to extend Vitesse with.
   *
   * @example
   * // Add Vitesse Algolia plugin.
   * vitesse({
   *  plugins: [vitesseAlgolia({ … })],
   * })
   */
  plugins?: VitessePluginsUserConfig
}

export type VitessePluginContext = Pick<
  Parameters<NonNullable<AstroIntegration['hooks']['astro:config:setup']>>[0],
  'command' | 'config' | 'isRestart' | 'logger'
>

export type PluginTranslations = Record<string, UserI18nSchema & Record<string, string>>