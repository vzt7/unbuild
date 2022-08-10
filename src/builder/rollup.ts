import { writeFile, mkdir } from 'fs/promises'
import { promises as fsp } from 'fs'
import { pathToFileURL } from 'url'
import type { RollupOptions, OutputOptions, OutputChunk } from 'rollup'
import { rollup } from 'rollup'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import alias from '@rollup/plugin-alias'
import _esbuild from 'rollup-plugin-esbuild'
import dts from 'rollup-plugin-dts'
import replace from '@rollup/plugin-replace'
import { resolve, dirname, normalize, extname } from 'pathe'
import { resolvePath, resolveModuleExportNames } from 'mlly'
import { getpkg, tryResolve, warn } from '../utils'
import type { BuildContext } from '../types'
import { JSONPlugin } from './plugins/json'
import { rawPlugin } from './plugins/raw'
import { cjsPlugin } from './plugins/cjs'
import { shebangPlugin, makeExecutable, getShebang } from './plugins/shebang'

// @ts-ignore https://github.com/unjs/unbuild/issues/23
const esbuild = _esbuild.default || _esbuild

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.json']

export async function rollupBuild (ctx: BuildContext) {
  if (ctx.options.stub) {
    const jitiPath = await resolvePath('jiti', { url: import.meta.url })

    for (const entry of ctx.options.entries.filter(entry => entry.builder === 'rollup')) {
      const output = resolve(ctx.options.rootDir, ctx.options.outDir, entry.name!)

      const resolvedEntry = normalize(tryResolve(entry.input, ctx.options.rootDir) || entry.input)
      const resolvedEntryWithoutExt = resolvedEntry.substring(0, resolvedEntry.length - extname(resolvedEntry).length)
      const code = await fsp.readFile(resolvedEntry, 'utf8')
      const shebang = getShebang(code)

      await mkdir(dirname(output), { recursive: true })

      // CJS Stub
      if (ctx.options.rollup.emitCJS) {
        await writeFile(output + '.cjs', `${shebang}module.exports = require(${JSON.stringify(jitiPath)})(null, { interopDefault: true, esmResolve: true })(${JSON.stringify(resolvedEntry)})`)
      }

      // MJS Stub
      // Try to analyze exports
      const namedExports: string[] = await resolveModuleExportNames(resolvedEntry, {
        extensions: DEFAULT_EXTENSIONS
      }).catch((err) => {
        warn(ctx, `Cannot analyze ${resolvedEntry} for exports:` + err)
        return []
      })
      const hasDefaultExport = namedExports.includes('default') || !namedExports.length

      await writeFile(output + '.mjs', shebang + [
        `import jiti from ${JSON.stringify(pathToFileURL(jitiPath).href)};`,
        '',
        `/** @type {import(${JSON.stringify(resolvedEntryWithoutExt)})} */`,
        `const _module = jiti(null, { interopDefault: true, esmResolve: true })(${JSON.stringify(resolvedEntry)});`,
        hasDefaultExport ? '\nexport default _module;' : '',
        ...namedExports.filter(name => name !== 'default').map(name => `export const ${name} = _module.${name};`)
      ].join('\n'))

      // DTS Stub
      await writeFile(output + '.d.ts', [
        `export * from ${JSON.stringify(resolvedEntryWithoutExt)};`,
        hasDefaultExport ? `export { default } from ${JSON.stringify(resolvedEntryWithoutExt)};` : ''
      ].join('\n'))

      if (shebang) {
        await makeExecutable(output + '.cjs')
        await makeExecutable(output + '.mjs')
      }
    }
    await ctx.hooks.callHook('rollup:done', ctx)
    return
  }

  const rollupOptions = getRollupOptions(ctx)
  await ctx.hooks.callHook('rollup:options', ctx, rollupOptions)

  if (!Object.keys(rollupOptions.input as any).length) {
    return
  }

  const buildResult = await rollup(rollupOptions)
  await ctx.hooks.callHook('rollup:build', ctx, buildResult)

  const allOutputOptions = rollupOptions.output! as OutputOptions[]
  for (const outputOptions of allOutputOptions) {
    const { output } = await buildResult.write(outputOptions)
    const chunkFileNames = new Set<string>()
    const outputChunks = output.filter(e => e.type === 'chunk') as OutputChunk[]
    for (const entry of outputChunks) {
      chunkFileNames.add(entry.fileName)
      for (const id of entry.imports) {
        ctx.usedImports.add(id)
      }
      ctx.buildEntries.push({
        chunk: !entry.isEntry,
        chunks: entry.imports.filter(i => outputChunks.find(c => c.fileName === i)),
        path: entry.fileName,
        bytes: Buffer.byteLength(entry.code, 'utf8'),
        exports: entry.isEntry ? entry.exports : []
      })
    }
    for (const chunkFileName of chunkFileNames) {
      ctx.usedImports.delete(chunkFileName)
    }
  }

  // Types
  if (ctx.options.declaration) {
    rollupOptions.plugins = rollupOptions.plugins || []
    // TODO: Use fresh rollup options
    const shebangPlugin: any = rollupOptions.plugins.find(p => p && p.name === 'unbuild-shebang')
    shebangPlugin._options.preserve = false
    rollupOptions.plugins.push(dts(ctx.options.rollup.dts))
    await ctx.hooks.callHook('rollup:dts:options', ctx, rollupOptions)
    const typesBuild = await rollup(rollupOptions)
    await ctx.hooks.callHook('rollup:dts:build', ctx, typesBuild)
    await typesBuild.write({
      dir: resolve(ctx.options.rootDir, ctx.options.outDir),
      format: 'esm'
    })
  }

  await ctx.hooks.callHook('rollup:done', ctx)
}

export function getRollupOptions (ctx: BuildContext): RollupOptions {
  return {
    context: ctx.options.rootDir,

    input: Object.fromEntries(ctx.options.entries
      .filter(entry => entry.builder === 'rollup')
      .map(entry => [entry.name, resolve(ctx.options.rootDir, entry.input)])
    ),

    output: [
      ctx.options.rollup.emitCJS && {
        dir: resolve(ctx.options.rootDir, ctx.options.outDir),
        entryFileNames: '[name].cjs',
        chunkFileNames: `${ctx.options.name}.[hash].cjs`,
        format: 'cjs',
        exports: 'auto',
        preferConst: true,
        externalLiveBindings: false,
        freeze: false
      },
      {
        dir: resolve(ctx.options.rootDir, ctx.options.outDir),
        entryFileNames: '[name].mjs',
        chunkFileNames: `${ctx.options.name}.[hash].mjs`,
        format: 'esm',
        exports: 'auto',
        preferConst: true,
        externalLiveBindings: false,
        freeze: false
      }
    ].filter(Boolean),

    external (id) {
      const pkg = getpkg(id)
      const isExplicitExternal = ctx.options.externals.includes(pkg)
      if (isExplicitExternal) {
        return true
      }
      if (ctx.options.rollup.inlineDependencies || id[0] === '.' || id[0] === '/' || id.match(/src[\\/]/) || id.startsWith(ctx.pkg.name!)) {
        return false
      }
      if (!isExplicitExternal) {
        warn(ctx, `Inlined implicit external ${id}`)
      }
      return isExplicitExternal
    },

    onwarn (warning, rollupWarn) {
      if (!warning.code || !['CIRCULAR_DEPENDENCY'].includes(warning.code)) {
        rollupWarn(warning)
      }
    },

    plugins: [
      ctx.options.rollup.replace && replace({
        ...ctx.options.rollup.replace,
        values: {
          ...ctx.options.replace,
          ...ctx.options.rollup.replace.values
        }
      }),

      ctx.options.rollup.alias && alias({
        ...ctx.options.rollup.alias,
        entries: {
          [ctx.pkg.name!]: ctx.options.rootDir,
          ...ctx.options.alias,
          ...ctx.options.rollup.alias.entries
        }
      }),

      ctx.options.rollup.resolve && nodeResolve({
        extensions: DEFAULT_EXTENSIONS,
        ...ctx.options.rollup.resolve
      }),

      ctx.options.rollup.json && JSONPlugin({
        ...ctx.options.rollup.json
      }),

      shebangPlugin(),

      ctx.options.rollup.esbuild && esbuild({
        ...ctx.options.rollup.esbuild
      }),

      ctx.options.rollup.commonjs && commonjs({
        extensions: DEFAULT_EXTENSIONS,
        ...ctx.options.rollup.commonjs
      }),

      // Preserve dynamic imports for CommonJS
      { renderDynamicImport () { return { left: 'import(', right: ')' } } },

      ctx.options.rollup.cjsBridge && cjsPlugin({}),

      rawPlugin()

    ].filter(Boolean)
  } as RollupOptions
}
