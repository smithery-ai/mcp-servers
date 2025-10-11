/**
 * Resource templates for the Filesystem MCP Server
 * Provides URI templates for accessing files and directories
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import {
  validatePath,
  readFileContent,
  getAllowedDirectories,
} from './lib.js';

/**
 * Get MIME type based on file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.html': 'text/html',
    '.css': 'text/css',
    '.xml': 'text/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.sh': 'text/x-shellscript',
    '.rs': 'text/x-rust',
    '.go': 'text/x-go',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-c',
  };
  return mimeTypes[ext] || 'text/plain';
}

/**
 * Register filesystem resource templates
 */
export function registerResources(server: McpServer) {
  
  // Resource template: file:///{+path} - Read any file or directory
  server.registerResource(
    "file",
    new ResourceTemplate("file:///{+path}", {
      list: undefined,
      complete: {
        // Provide path completion based on current directory
        path: async (value) => {
          try {
            // If value is empty, suggest allowed directories
            if (!value) {
              return getAllowedDirectories();
            }

            // Get the directory to search in
            const dirPath = path.dirname(value);
            const searchTerm = path.basename(value);
            
            // Try to validate and read the directory
            const validPath = await validatePath(dirPath);
            const entries = await fs.readdir(validPath, { withFileTypes: true });
            
            // Filter and return matching entries
            const matches = entries
              .filter(entry => {
                // Skip hidden files
                if (entry.name.startsWith('.')) return false;
                // Match against search term
                return entry.name.toLowerCase().startsWith(searchTerm.toLowerCase());
              })
              .map(entry => {
                const fullPath = path.join(dirPath, entry.name);
                // Add trailing slash for directories
                return entry.isDirectory() ? `${fullPath}/` : fullPath;
              })
              .slice(0, 10); // Limit to 10 suggestions
            
            return matches;
          } catch (error) {
            // If we can't read the directory, return empty array
            return [];
          }
        }
      }
    }),
    {
      title: "File or Directory",
      description: "Read file contents or list directory contents. Use file:///absolute/path/to/file.txt",
      mimeType: "text/plain",
    },
    async (uri, { path: filePath }) => {
      try {
        const validPath = await validatePath(filePath as string);
        const stats = await fs.stat(validPath);

        if (stats.isDirectory()) {
          // Return directory listing as JSON
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const listing = await Promise.all(
            entries.map(async (entry) => {
              const entryPath = path.join(filePath as string, entry.name);
              try {
                const entryStats = await fs.stat(entryPath);
                return {
                  name: entry.name,
                  type: entry.isDirectory() ? "directory" : "file",
                  size: entry.isDirectory() ? undefined : entryStats.size,
                  modified: entryStats.mtime.toISOString(),
                };
              } catch {
                return {
                  name: entry.name,
                  type: entry.isDirectory() ? "directory" : "file",
                };
              }
            })
          );

          return {
            contents: [
              {
                uri: uri.href,
                name: path.basename(filePath as string),
                title: path.basename(filePath as string),
                mimeType: "application/json",
                text: JSON.stringify({
                  path: filePath,
                  type: "directory",
                  entries: listing,
                  count: listing.length,
                }, null, 2),
              },
            ],
          };
        } else {
          // Return file contents
          const content = await readFileContent(validPath);
          const mimeType = getMimeType(filePath as string);

          return {
            contents: [
              {
                uri: uri.href,
                name: path.basename(filePath as string),
                title: path.basename(filePath as string),
                mimeType: mimeType,
                text: content,
              },
            ],
          };
        }
      } catch (error) {
        throw new Error(`Failed to read resource: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

