/**
 * Tool definitions for the Filesystem MCP Server
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { minimatch } from "minimatch";
import {
  formatSize,
  validatePath,
  getFileStats,
  readFileContent,
  writeFileContent,
  searchFilesWithValidation,
  applyFileEdits,
  tailFile,
  headFile,
  getAllowedDirectories,
} from './lib.js';

/**
 * Helper function to read file as base64
 */
async function readFileAsBase64Stream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(chunk as Buffer);
    });
    stream.on("end", () => {
      const finalBuffer = Buffer.concat(chunks);
      resolve(finalBuffer.toString("base64"));
    });
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Register all filesystem tools on the server
 */
export function registerTools(server: McpServer) {
  // Schema definitions for tool inputs
  const ReadFileArgsSchema = z.object({
    path: z.string().optional().describe("Path to a single file to read (use this OR paths, not both)"),
    paths: z.array(z.string()).optional().describe("Array of file paths to read multiple files (use this OR path, not both)"),
    mode: z.enum(["text", "media"]).default("text").describe("Read mode: 'text' for text files, 'media' for images/audio"),
    tail: z.number().optional().describe("If provided, returns only the last N lines (text mode only)"),
    head: z.number().optional().describe("If provided, returns only the first N lines (text mode only)"),
  });

  const WriteFileArgsSchema = z.object({
    path: z.string().describe("Path where the file should be written"),
    content: z.string().describe("Content to write to the file"),
  });

  const EditOperation = z.object({
    oldText: z.string().describe("Text to search for - must match exactly"),
    newText: z.string().describe("Text to replace with"),
  });

  const EditFileArgsSchema = z.object({
    path: z.string().describe("Path to the file to edit"),
    edits: z.array(EditOperation).describe("Array of edit operations to apply"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Preview changes without applying them"),
  });

  const CreateDirectoryArgsSchema = z.object({
    path: z.string().describe("Path of the directory to create"),
  });

  const ListDirectoryArgsSchema = z.object({
    path: z.string().describe("Path of the directory to list"),
    recursive: z.boolean().default(false).describe("If true, returns a recursive tree structure"),
    includeSizes: z.boolean().default(false).describe("If true, includes file sizes in the output"),
    sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort entries by name or size (when includeSizes is true)"),
    excludePatterns: z.array(z.string()).optional().default([]).describe("Glob patterns to exclude from listing"),
  });

  const MoveFileArgsSchema = z.object({
    source: z.string().describe("Source path"),
    destination: z.string().describe("Destination path"),
  });

  const SearchFilesArgsSchema = z.object({
    path: z.string().describe("Directory to search in"),
    pattern: z.string().describe("Glob pattern to match files"),
    excludePatterns: z.array(z.string()).optional().default([]).describe("Glob patterns to exclude from search"),
  });

  const SearchContentArgsSchema = z.object({
    path: z.string().describe("Directory to search in"),
    pattern: z.string().describe("Text pattern to search for (supports regex)"),
    filePattern: z.string().optional().default("**/*").describe("Glob pattern to filter which files to search in"),
    caseSensitive: z.boolean().default(true).describe("Whether the search should be case-sensitive"),
    includeLineNumbers: z.boolean().default(true).describe("Include line numbers in results"),
    contextLines: z.number().optional().describe("Number of context lines to show around matches"),
  });

  const GetFileInfoArgsSchema = z.object({
    path: z.string().describe("Path to the file or directory"),
  });

  // Tool 1: read_file (consolidated: text, media, single, multiple)
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description:
        "Read file contents. Supports reading single or multiple files, text or media (images/audio). " +
        "For text files, optionally read only first N lines (head) or last N lines (tail). " +
        "For media files, returns base64-encoded data with MIME type. " +
        "Only works within allowed directories.",
      inputSchema: ReadFileArgsSchema.shape,
    },
    async ({ path: filePath, paths, mode, tail, head }) => {
      // Validate that either path or paths is provided, not both
      if (!filePath && !paths) {
        throw new Error("Must provide either 'path' or 'paths' parameter");
      }
      if (filePath && paths) {
        throw new Error("Cannot specify both 'path' and 'paths' parameters");
      }

      // Multiple files mode
      if (paths) {
        const results = await Promise.all(
          paths.map(async (fp: string) => {
            try {
              const validPath = await validatePath(fp);
              if (mode === "media") {
                const extension = path.extname(validPath).toLowerCase();
                const mimeTypes: Record<string, string> = {
                  ".png": "image/png",
                  ".jpg": "image/jpeg",
                  ".jpeg": "image/jpeg",
                  ".gif": "image/gif",
                  ".webp": "image/webp",
                  ".bmp": "image/bmp",
                  ".svg": "image/svg+xml",
                  ".mp3": "audio/mpeg",
                  ".wav": "audio/wav",
                  ".ogg": "audio/ogg",
                  ".flac": "audio/flac",
                };
                const mimeType = mimeTypes[extension] || "application/octet-stream";
                const data = await readFileAsBase64Stream(validPath);
                return `${fp}: [${mimeType}] ${data.substring(0, 50)}... (base64 data)`;
              } else {
                const content = await readFileContent(validPath);
                return `${fp}:\n${content}\n`;
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `${fp}: Error - ${errorMessage}`;
            }
          })
        );
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }

      // Single file mode
      const validPath = await validatePath(filePath!);

      if (mode === "media") {
        if (head || tail) {
          throw new Error("head/tail parameters are only supported in text mode");
        }
        const extension = path.extname(validPath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".bmp": "image/bmp",
          ".svg": "image/svg+xml",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".ogg": "audio/ogg",
          ".flac": "audio/flac",
        };
        const mimeType = mimeTypes[extension] || "application/octet-stream";
        const data = await readFileAsBase64Stream(validPath);
        const type = mimeType.startsWith("image/")
          ? "image"
          : mimeType.startsWith("audio/")
            ? "audio"
            : "blob";
        return {
          content: [{ type, data, mimeType } as any],
        };
      }

      // Text mode
      if (head && tail) {
        throw new Error("Cannot specify both head and tail parameters simultaneously");
      }

      if (tail) {
        const tailContent = await tailFile(validPath, tail);
        return {
          content: [{ type: "text", text: tailContent }],
        };
      }

      if (head) {
        const headContent = await headFile(validPath, head);
        return {
          content: [{ type: "text", text: headContent }],
        };
      }

      const content = await readFileContent(validPath);
      return {
        content: [{ type: "text", text: content }],
      };
    }
  );

  // Tool 2: write_file
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description:
        "Create a new file or completely overwrite an existing file with new content. " +
        "Use with caution as it will overwrite existing files without warning. " +
        "Handles text content with proper encoding. Only works within allowed directories.",
      inputSchema: WriteFileArgsSchema.shape,
    },
    async ({ path: filePath, content }) => {
      const validPath = await validatePath(filePath);
      await writeFileContent(validPath, content);
      return {
        content: [
          { type: "text", text: `Successfully wrote to ${filePath}` },
        ],
      };
    }
  );

  // Tool 3: edit_file
  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description:
        "Make line-based edits to a text file. Each edit replaces exact line sequences " +
        "with new content. Returns a git-style diff showing the changes made. " +
        "Only works within allowed directories.",
      inputSchema: EditFileArgsSchema.shape,
    },
    async ({ path: filePath, edits, dryRun }) => {
      const validPath = await validatePath(filePath);
      const result = await applyFileEdits(validPath, edits, dryRun);
      return {
        content: [{ type: "text", text: result }],
      };
    }
  );

  // Tool 4: create_directory
  server.registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description:
        "Create a new directory or ensure a directory exists. Can create multiple " +
        "nested directories in one operation. If the directory already exists, " +
        "this operation will succeed silently. Perfect for setting up directory " +
        "structures for projects. Only works within allowed directories.",
      inputSchema: CreateDirectoryArgsSchema.shape,
    },
    async ({ path: dirPath }) => {
      const validPath = await validatePath(dirPath);
      await fs.mkdir(validPath, { recursive: true });
      return {
        content: [
          { type: "text", text: `Successfully created directory ${dirPath}` },
        ],
      };
    }
  );

  // Tool 5: list_directory (consolidated: flat, recursive, with/without sizes)
  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description:
        "List directory contents. Can show flat listing or recursive tree, with or without file sizes. " +
        "Supports sorting and exclude patterns. Only works within allowed directories.",
      inputSchema: ListDirectoryArgsSchema.shape,
    },
    async ({ path: dirPath, recursive, includeSizes, sortBy, excludePatterns }) => {
      const validPath = await validatePath(dirPath);

      // Recursive tree mode
      if (recursive) {
        interface TreeEntry {
          name: string;
          type: "file" | "directory";
          size?: string;
          children?: TreeEntry[];
        }

        const rootPath = dirPath;

        async function buildTree(
          currentPath: string,
          excludePatterns: string[] = []
        ): Promise<TreeEntry[]> {
          const validPath = await validatePath(currentPath);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const result: TreeEntry[] = [];

          for (const entry of entries) {
            const relativePath = path.relative(
              rootPath,
              path.join(currentPath, entry.name)
            );
            const shouldExclude = excludePatterns.some((pattern) => {
              if (pattern.includes("*")) {
                return minimatch(relativePath, pattern, { dot: true });
              }
              return (
                minimatch(relativePath, pattern, { dot: true }) ||
                minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
                minimatch(relativePath, `**/${pattern}/**`, { dot: true })
              );
            });
            if (shouldExclude) continue;

            const entryPath = path.join(currentPath, entry.name);
            const entryData: TreeEntry = {
              name: entry.name,
              type: entry.isDirectory() ? "directory" : "file",
            };

            if (includeSizes && !entry.isDirectory()) {
              try {
                const stats = await fs.stat(entryPath);
                entryData.size = formatSize(stats.size);
              } catch (error) {
                entryData.size = "unknown";
              }
            }

            if (entry.isDirectory()) {
              const subPath = path.join(currentPath, entry.name);
              entryData.children = await buildTree(subPath, excludePatterns);
            }

            result.push(entryData);
          }

          return result;
        }

        const treeData = await buildTree(rootPath, excludePatterns);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(treeData, null, 2),
            },
          ],
        };
      }

      // Flat listing mode
      const entries = await fs.readdir(validPath, { withFileTypes: true });

      // Filter by exclude patterns
      const filteredEntries = entries.filter((entry) => {
        return !excludePatterns.some((pattern) => {
          if (pattern.includes("*")) {
            return minimatch(entry.name, pattern, { dot: true });
          }
          return entry.name === pattern;
        });
      });

      if (!includeSizes) {
        // Simple listing without sizes
        const formatted = filteredEntries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      // Listing with sizes
      const detailedEntries = await Promise.all(
        filteredEntries.map(async (entry) => {
          const entryPath = path.join(validPath, entry.name);
          try {
            const stats = await fs.stat(entryPath);
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              mtime: stats.mtime,
            };
          } catch (error) {
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: 0,
              mtime: new Date(0),
            };
          }
        })
      );

      const sortedEntries = [...detailedEntries].sort((a, b) => {
        if (sortBy === "size") {
          return b.size - a.size;
        }
        return a.name.localeCompare(b.name);
      });

      const formattedEntries = sortedEntries.map(
        (entry) =>
          `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${
            entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
          }`
      );

      const totalFiles = detailedEntries.filter((e) => !e.isDirectory).length;
      const totalDirs = detailedEntries.filter((e) => e.isDirectory).length;
      const totalSize = detailedEntries.reduce(
        (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
        0
      );

      const summary = [
        "",
        `Total: ${totalFiles} files, ${totalDirs} directories`,
        `Combined size: ${formatSize(totalSize)}`,
      ];

      return {
        content: [
          {
            type: "text",
            text: [...formattedEntries, ...summary].join("\n"),
          },
        ],
      };
    }
  );

  // Tool 6: move_file
  server.registerTool(
    "move_file",
    {
      title: "Move File",
      description:
        "Move or rename files and directories. Can move files between directories " +
        "and rename them in a single operation. Both source and destination must be " +
        "within allowed directories.",
      inputSchema: MoveFileArgsSchema.shape,
    },
    async ({ source, destination }) => {
      const validSourcePath = await validatePath(source);
      const validDestPath = await validatePath(destination);
      await fs.rename(validSourcePath, validDestPath);
      return {
        content: [
          {
            type: "text",
            text: `Successfully moved ${source} to ${destination}`,
          },
        ],
      };
    }
  );

  // Tool 7: search_files
  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description:
        "Recursively search for files and directories matching a glob pattern. " +
        "Use this to find files by name/path. Only searches within allowed directories.",
      inputSchema: SearchFilesArgsSchema.shape,
    },
    async ({ path: searchPath, pattern, excludePatterns }) => {
      const validPath = await validatePath(searchPath);
      const results = await searchFilesWithValidation(
        validPath,
        pattern,
        getAllowedDirectories(),
        { excludePatterns }
      );
      return {
        content: [
          {
            type: "text",
            text: results.length > 0 ? results.join("\n") : "No matches found",
          },
        ],
      };
    }
  );

  // Tool 8: search_content (grep-style content search)
  server.registerTool(
    "search_content",
    {
      title: "Search Content",
      description:
        "Search for text content within files (like grep). Supports regex patterns, " +
        "case-sensitive/insensitive search, and context lines. Use this to find files " +
        "containing specific text. Only searches within allowed directories.",
      inputSchema: SearchContentArgsSchema.shape,
    },
    async ({ path: searchPath, pattern, filePattern, caseSensitive, includeLineNumbers, contextLines }) => {
      const validPath = await validatePath(searchPath);
      
      // Find all files matching the file pattern
      const files = await searchFilesWithValidation(
        validPath,
        filePattern,
        getAllowedDirectories(),
        {}
      );

      const results: string[] = [];
      const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");

      for (const filePath of files) {
        try {
          // Skip binary files by checking extension
          const ext = path.extname(filePath).toLowerCase();
          const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.exe', '.bin', '.mp3', '.mp4'];
          if (binaryExtensions.includes(ext)) {
            continue;
          }

          const content = await readFileContent(filePath);
          const lines = content.split('\n');
          const matches: { lineNum: number; line: string; context?: string[] }[] = [];

          lines.forEach((line, index) => {
            if (regex.test(line)) {
              const match: { lineNum: number; line: string; context?: string[] } = {
                lineNum: index + 1,
                line: line,
              };

              if (contextLines) {
                const start = Math.max(0, index - contextLines);
                const end = Math.min(lines.length, index + contextLines + 1);
                match.context = lines.slice(start, end);
              }

              matches.push(match);
            }
          });

          if (matches.length > 0) {
            const fileResult = [`\n${filePath}:`];
            matches.forEach(match => {
              if (includeLineNumbers) {
                if (match.context) {
                  fileResult.push(match.context.join('\n'));
                } else {
                  fileResult.push(`  ${match.lineNum}: ${match.line}`);
                }
              } else {
                fileResult.push(`  ${match.line}`);
              }
            });
            results.push(fileResult.join('\n'));
          }
        } catch (error) {
          // Skip files that can't be read
          continue;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: results.length > 0 
              ? `Found ${results.length} file(s) with matches:\n${results.join('\n')}` 
              : "No matches found",
          },
        ],
      };
    }
  );

  // Tool 9: get_file_info
  server.registerTool(
    "get_file_info",
    {
      title: "Get File Info",
      description:
        "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
        "information including size, creation time, last modified time, permissions, " +
        "and type. Only works within allowed directories.",
      inputSchema: GetFileInfoArgsSchema.shape,
    },
    async ({ path: filePath }) => {
      const validPath = await validatePath(filePath);
      const info = await getFileStats(filePath);
      return {
        content: [
          {
            type: "text",
            text: Object.entries(info)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n"),
          },
        ],
      };
    }
  );

  // Tool 10: list_allowed_directories
  server.registerTool(
    "list_allowed_directories",
    {
      title: "List Allowed Directories",
      description:
        "Returns the list of directories that this server has access to. " +
        "Use this to discover which directories you can read from and write to.",
      inputSchema: {},
    },
    async () => {
      const dirs = getAllowedDirectories();
      return {
        content: [
          {
            type: "text",
            text: dirs.length > 0
              ? `Allowed directories:\n${dirs.map(d => `  - ${d}`).join('\n')}`
              : "No allowed directories configured",
          },
        ],
      };
    }
  );
}

