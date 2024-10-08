import type { AstroConfig, ViteUserConfig } from 'astro'
import type { PluginTranslations } from '../utils/plugins'
import type { VitesseConfig } from '../utils/user-config'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function resolveVirtualModuleId<T extends string>(id: T): `\0${T}` {
  return `\0${id}`
}

/** Vite plugin that exposes Vitesse user config and project context via virtual modules. */
export function vitePluginVitesseUserConfig(
  opts: VitesseConfig,
  {
    build,
    root,
    srcDir,
    trailingSlash,
  }: Pick<AstroConfig, 'root' | 'srcDir' | 'trailingSlash'> & {
    build: Pick<AstroConfig['build'], 'format'>
  },
  pluginTranslations: PluginTranslations,
): NonNullable<ViteUserConfig['plugins']>[number] {
  /**
   * Resolves module IDs to a usable format:
   * - Relative paths (e.g. `'./module.js'`) are resolved against `base` and formatted as an absolute path.
   * - Package identifiers (e.g. `'module'`) are returned unchanged.
   *
   * By default, `base` is the project root directory.
   */
  const resolveId = (id: string, base = root): string =>
    JSON.stringify(id.startsWith('.') ? resolve(fileURLToPath(base), id) : id)

  const virtualComponentModules = Object.fromEntries(
    Object.entries(opts.components).map(([name, path]) => [
      `virtual:vitesse/components/${name}`,
      `export { default } from ${resolveId(path)};`,
    ]),
  )

  /** Map of virtual module names to their code contents as strings. */
  const modules = {
    'virtual:vitesse/user-config': `export default ${JSON.stringify(opts)}`,
    'virtual:vitesse/project-context': `export default ${JSON.stringify({
      build: { format: build.format },
      root,
      srcDir,
      trailingSlash,
    })}`,
    'virtual:vitesse/user-css': opts.customCss.map(id => `import ${resolveId(id)};`).join(''),
    'virtual:vitesse/user-images': opts.logo
      ? 'src' in opts.logo
        ? `import src from ${resolveId(
          opts.logo.src,
        )}; export const logos = { dark: src, light: src };`
        : `import dark from ${resolveId(opts.logo.dark)}; import light from ${resolveId(
          opts.logo.light,
        )}; export const logos = { dark, light };`
      : 'export const logos = {};',
    'virtual:vitesse/collection-config': `let userCollections;
      try {
        userCollections = (await import(${resolveId('./content/config.ts', srcDir)})).collections;
      } catch {}
      export const collections = userCollections;`,
    'virtual:vitesse/plugin-translations': `export default ${JSON.stringify(pluginTranslations)}`,
    ...virtualComponentModules,
  } satisfies Record<string, string>

  /** Mapping names prefixed with `\0` to their original form. */
  const resolutionMap = Object.fromEntries(
    (Object.keys(modules) as (keyof typeof modules)[]).map(key => [
      resolveVirtualModuleId(key),
      key,
    ]),
  )

  return {
    name: 'vite-plugin-vitesse-user-config',
    resolveId(id): string | void {
      if (id in modules)
        return resolveVirtualModuleId(id)
    },
    load(id): string | void {
      const resolution = resolutionMap[id]
      if (resolution)
        return modules[resolution]
    },
  }
}
