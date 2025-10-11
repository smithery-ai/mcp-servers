import type { Root } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { normalizePath, expandHome } from './path-utils.js';

/**
 * Validates and normalizes root directories from MCP client
 */
export async function getValidRootDirectories(requestedRoots: Root[]): Promise<string[]> {
  const validatedDirs: string[] = [];
  
  for (const root of requestedRoots) {
    try {
      // Extract path from URI (file:// protocol)
      let dirPath = root.uri;
      if (dirPath.startsWith('file://')) {
        dirPath = dirPath.slice(7);
      }
      
      // Expand home and resolve to absolute path
      const expanded = expandHome(dirPath);
      const absolute = path.resolve(expanded);
      
      // Resolve symlinks
      const resolved = await fs.realpath(absolute);
      const normalized = normalizePath(resolved);
      
      // Verify it's a directory
      const stats = await fs.stat(normalized);
      if (stats.isDirectory()) {
        validatedDirs.push(normalized);
      }
    } catch (error) {
      console.error(`Failed to validate root directory ${root.uri}:`, error);
    }
  }
  
  return validatedDirs;
}

