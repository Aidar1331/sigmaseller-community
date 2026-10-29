/**
 * Helper for importing modules with tsx/compiled fallback
 * 
 * Handles the case where we run with tsx (dev) or compiled JS (prod).
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import pino from 'pino';

const logger = pino({ level: 'warn' });

interface ImportResult<T> {
  module: T;
  source: 'js' | 'ts';
}

/**
 * Import a module with fallback from .js to .ts
 * 
 * @param jsPath - Path to compiled .js file (e.g., './plugins/auth.js')
 * @param baseUrl - import.meta.url of the calling module (for correct path resolution)
 * @returns The imported module
 * @throws If both imports fail
 */
export async function importModule<T = any>(
  jsPath: string,
  baseUrl: string
): Promise<ImportResult<T>> {
  const baseDir = dirname(fileURLToPath(baseUrl));
  const tsPath = jsPath.replace(/\.js$/, '.ts');
  
  const fullJsPath = resolve(baseDir, jsPath);
  const fullTsPath = resolve(baseDir, tsPath);
  
  // Convert to file:// URLs for cross-platform compatibility
  const jsUrl = pathToFileURL(fullJsPath).href;
  const tsUrl = pathToFileURL(fullTsPath).href;

  try {
    const module = await import(jsUrl);
    return { module, source: 'js' };
  } catch (jsError) {
    const isModuleNotFound = 
      jsError instanceof Error && 
      'code' in jsError && 
      (jsError as any).code === 'ERR_MODULE_NOT_FOUND';

    if (!isModuleNotFound) {
      logger.error({ path: jsPath, error: jsError }, 'Failed to import module');
      throw jsError;
    }

    try {
      const module = await import(tsUrl);
      return { module, source: 'ts' };
    } catch (tsError) {
      logger.error(
        { jsPath: fullJsPath, tsPath: fullTsPath, jsError, tsError },
        'Failed to import module from both .js and .ts'
      );
      throw tsError;
    }
  }
}

/**
 * Import default export from a module
 */
export async function importDefault<T = any>(
  jsPath: string,
  baseUrl: string
): Promise<T> {
  const { module } = await importModule<{ default: T }>(jsPath, baseUrl);
  return module.default;
}

/**
 * Import named exports from a module
 */
export async function importNamed<T = any>(
  jsPath: string,
  exportName: string,
  baseUrl: string
): Promise<T> {
  const { module } = await importModule<Record<string, T>>(jsPath, baseUrl);
  return module[exportName];
}
