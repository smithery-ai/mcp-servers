import { randomUUID } from "node:crypto"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import express from "express"

import { parseExpressRequestConfig } from "@smithery/sdk/shared/config.js"


import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { type SessionStore, createLRUStore } from "@smithery/sdk/server/session.js"


/**
 * Arguments when we create a new instance of your server
 */
export interface CreateServerArg<T = Record<string, unknown>> {
	sessionId: string
	config: T
}

export type CreateServerFn<T = Record<string, unknown>> = (
	arg: CreateServerArg<T>,
) => Server

/**
 * Configuration options for the stateful server
 */
export interface StatefulServerOptions {
	/**
	 * Session store to use for managing active sessions
	 */
	sessionStore?: SessionStore<StreamableHTTPServerTransport>
}


/**
 * Configures an Express application to include a stateful server for handling MCP requests.
 * For every new session, we invoke createMcpServer to create a new instance of the server.
 * @param app Express application to configure
 * @param createMcpServer Function to create an MCP server
 * @param options Configuration options for the stateful server
 */
export function createStatefulServer<T = Record<string, unknown>>(
    app: express.Application,
	createMcpServer: CreateServerFn<T>,
	options?: StatefulServerOptions,
) {

	const sessionStore = options?.sessionStore ?? createLRUStore()
	// Handle POST requests for client-to-server communication
	app.post("/mcp", async (req, res) => {
		// Check for existing session ID
		const sessionId = req.headers["mcp-session-id"] as string | undefined
        console.log("sessionId", sessionId);
		let transport: StreamableHTTPServerTransport

		if (sessionId && sessionStore.get(sessionId)) {
			// Reuse existing transport
			// biome-ignore lint/style/noNonNullAssertion: Not possible
            console.log("reusing existing transport", sessionStore.get(sessionId));
			transport = sessionStore.get(sessionId)!
            console.log("transport", transport);
		} else if (!sessionId && isInitializeRequest(req.body)) {

            console.log("new initialization request", req.body);

			// New initialization request
			const newSessionId = randomUUID()
            console.log("newSessionId for transport created in initialize request", newSessionId);
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => newSessionId,
				onsessioninitialized: (sessionId) => {
					// Store the transport by session ID
					sessionStore.set(sessionId, transport)
				},
			})

			// Clean up transport when closed
			transport.onclose = () => {
				if (transport.sessionId) {
					sessionStore.delete?.(transport.sessionId)
				}
			}

			let config: ReturnType<typeof parseExpressRequestConfig>
			try {
				config = parseExpressRequestConfig(req)

			} catch (error) {
                console.log("error parsing config", error);
				res.status(400).json({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Bad Request: Invalid configuration",
					},
					id: null,
				})
				return
			}
			try {
				const server = createMcpServer({
					sessionId: newSessionId,
					config: config as T,
				})

				// Connect to the MCP server
				await server.connect(transport)

			} catch (error) {
				console.error("Error initializing server:", error)
				res.status(500).json({
					jsonrpc: "2.0",
					error: {
						code: -32603,
						message: "Error initializing server.",
					},
					id: null,
				})
				return
			}
		} else {
			// Invalid request
			res.status(400).json({
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message:
						"Bad Request: No valid session ID provided. Session may have expired.",
				},
				id: null,
			})
			return
		}

		// Handle the request
		await transport.handleRequest(req, res, req.body)
	})

	// Reusable handler for GET and DELETE requests
	const handleSessionRequest = async (
		req: express.Request,
		res: express.Response,
	) => {
		const sessionId = req.headers["mcp-session-id"] as string | undefined
		if (!sessionId || !sessionStore.get(sessionId)) {
			res.status(400).send("Invalid or expired session ID")
			return
		}

		// biome-ignore lint/style/noNonNullAssertion: Not possible
		const transport = sessionStore.get(sessionId)!

		await transport.handleRequest(req, res)
	}

	// Handle GET requests for server-to-client notifications via SSE
	app.get("/mcp", handleSessionRequest)

	// Handle DELETE requests for session termination
	app.delete("/mcp", handleSessionRequest)
}
