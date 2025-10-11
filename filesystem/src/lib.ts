import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { normalizePath } from './path-utils.js';
import { glob } from 'glob';

// Global state for allowed directories
let allowedDirectories: string[] = [];

export function setAllowedDirectories(directories: string[]) {
  allowedDirectories = directories;
}

export function getAllowedDirectories(): string[] {
  return allowedDirectories;
}

/**
 * Format file size in human-readable format
 */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Validates that a path is within allowed directories
 */
export async function validatePath(requestedPath: string): Promise<string> {
  const absolute = path.resolve(requestedPath);
  const realPath = await fs.realpath(absolute).catch(() => absolute);
  const normalized = normalizePath(realPath);
  
  // Check if path is within any allowed directory
  const isAllowed = allowedDirectories.some(allowedDir => {
    const normalizedAllowed = normalizePath(allowedDir);
    return normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + '/');
  });
  
  if (!isAllowed) {
    throw new Error(`Access denied: ${requestedPath} is outside allowed directories`);
  }
  
  return realPath;
}

/**
 * Get file statistics
 */
export async function getFileStats(filePath: string) {
  const stats = await fs.stat(filePath);
  return {
    size: formatSize(stats.size),
    created: stats.birthtime.toISOString(),
    modified: stats.mtime.toISOString(),
    accessed: stats.atime.toISOString(),
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

/**
 * Read file content as text
 */
export async function readFileContent(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf-8');
}

/**
 * Write content to file
 */
export async function writeFileContent(filePath: string, content: string): Promise<void> {
  // Ensure parent directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Search files matching a pattern
 */
export async function searchFilesWithValidation(
  searchPath: string,
  pattern: string,
  allowedDirs: string[],
  options: { excludePatterns?: string[] } = {}
): Promise<string[]> {
  const results = await glob(pattern, {
    cwd: searchPath,
    absolute: true,
    ignore: options.excludePatterns || [],
    dot: true,
  });
  
  // Filter results to only include files within allowed directories
  const filtered = results.filter(result => {
    const normalized = normalizePath(result);
    return allowedDirs.some(allowedDir => {
      const normalizedAllowed = normalizePath(allowedDir);
      return normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + '/');
    });
  });
  
  return filtered;
}

/**
 * Apply edits to a file
 */
export async function applyFileEdits(
  filePath: string,
  edits: Array<{ oldText: string; newText: string }>,
  dryRun: boolean = false
): Promise<string> {
  let content = await readFileContent(filePath);
  let modifiedContent = content;
  const changes: string[] = [];
  
  for (const edit of edits) {
    if (!modifiedContent.includes(edit.oldText)) {
      throw new Error(`Text not found in file: ${edit.oldText.substring(0, 50)}...`);
    }
    
    const before = modifiedContent;
    modifiedContent = modifiedContent.replace(edit.oldText, edit.newText);
    
    if (before !== modifiedContent) {
      changes.push(`- ${edit.oldText.substring(0, 50)}...\n+ ${edit.newText.substring(0, 50)}...`);
    }
  }
  
  if (!dryRun) {
    await writeFileContent(filePath, modifiedContent);
    return `Successfully applied ${edits.length} edit(s) to ${filePath}\n\nChanges:\n${changes.join('\n\n')}`;
  } else {
    return `Dry run - changes that would be applied:\n\n${changes.join('\n\n')}`;
  }
}

/**
 * Read last N lines of a file efficiently
 */
export async function tailFile(filePath: string, lines: number): Promise<string> {
  const content = await readFileContent(filePath);
  const allLines = content.split('\n');
  const lastLines = allLines.slice(-lines);
  return lastLines.join('\n');
}

/**
 * Read first N lines of a file efficiently
 */
export async function headFile(filePath: string, maxLines: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    let buffer = '';
    let lineCount = 0;
    let result: string[] = [];
    
    stream.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (lineCount >= maxLines) {
          stream.destroy();
          resolve(result.join('\n'));
          return;
        }
        result.push(line);
        lineCount++;
      }
    });
    
    stream.on('end', () => {
      if (buffer && lineCount < maxLines) {
        result.push(buffer);
      }
      resolve(result.join('\n'));
    });
    
    stream.on('error', reject);
  });
}

