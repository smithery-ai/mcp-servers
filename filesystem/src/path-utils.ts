import path from "path";
import os from "os";

/**
 * Normalizes a file path to use forward slashes
 */
export function normalizePath(filepath: string): string {
  return filepath.split(path.sep).join('/');
}

/**
 * Expands ~ to home directory
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

