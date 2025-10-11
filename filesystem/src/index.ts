/**
 * Secure Filesystem MCP Server
 * Provides filesystem operations with path validation and security controls
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setAllowedDirectories } from './lib.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

// Configuration schema
export const configSchema = z.object({
  allowedDirectories: z
    .array(z.string())
    .min(1, "At least one allowed directory is required")
    .describe("List of directories that the server is allowed to access"),
});

export default function createServer({
  config,
}: {
  config: z.infer<typeof configSchema>;
}) {
  const server = new McpServer({
    name: "Filesystem",
    version: "0.3.0",
  });

  // Initialize with config directories
  setAllowedDirectories(config.allowedDirectories);
  console.error(`[Filesystem] Initialized with ${config.allowedDirectories.length} allowed directories`);

  // Register all tools
  registerTools(server);

  // Register all resources
  registerResources(server);

  return server.server;
}
