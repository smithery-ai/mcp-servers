#!/usr/bin/env node
import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import { ServerNotification, ServerRequest, SubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import blot from "@slack/bolt"
import { WebClient } from "@slack/web-api"
import { createStatefulServer } from "./stateful.js"
import { z } from "zod"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { SlackServerAuthProvider } from "./provider.js"
import express, { RequestHandler } from 'express';
import cors from "cors";
import { encryptionService } from "./encryptionService.js"
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
// import { requireBearerAuth } from "./bearerAuth.js"

let slackClient: WebClient | null = null

function setupResources(
	config: {
		token: string
		signingSecret?: string
		appToken?: string
	},
	server: McpServer,
) {

	const app = new blot.App({
		token: config.token,
		signingSecret: config.signingSecret,
		appToken: config.appToken,
		socketMode: true,
	})
	;(async () => {
		await app.start()
		console.log("⚡️ Bolt app started")
	})()
	

	server.server.onclose = () => {
		app.stop()
		console.log("⚡️ Server terminated")
	}
	// Define type for event data to avoid using 'any'
	interface EventData {
		event: Record<string, unknown>
		context: Record<string, unknown>
	}

	// Map to store event buffers for each event type
	const eventBuffers: Record<string, EventData[]> = {}

	// Helper to get or create an event buffer for a specific event type
	const getEventBuffer = (eventName: string): EventData[] => {
		if (!eventBuffers[eventName]) {
			eventBuffers[eventName] = []
		}
		return eventBuffers[eventName]
	}

	// Register the events resource
	server.resource(
		"events",
		// Define the resource template for events
		new ResourceTemplate("events://{eventName}", { list: undefined }),
		async (uri, params) => {
			// Extract eventName from params
			const eventName = (params as { eventName: string }).eventName
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(getEventBuffer(eventName)),
					},
				],
			}
		},
	)

	// Map to track which events we've already registered listeners for
	const registeredEvents = new Set<string>()

	// Handle subscription requests for any event type
	server.server.setRequestHandler(
		SubscribeRequestSchema,
		async ({ params }) => {
			// Parse the event name from the URI safely using optional chaining
			const match = params.uri?.match(/^events:\/\/(.+)$/)
			if (match?.[1]) {
				const eventName = match[1]

				// Only register the event listener once
				if (!registeredEvents.has(eventName)) {
					console.log(`Registering listener for Slack event: ${eventName}`)

					// Using proper types for the Slack event handler
					// The eventName could be a string or string[] so ensure it's a string
					const eventType = Array.isArray(eventName) ? eventName[0] : eventName
					app.event(eventType, async ({ event, context, client }) => {
						console.log(`Received Slack event: ${eventType}`)
						getEventBuffer(eventType).push({
							event: event as unknown as Record<string, unknown>,
							context: context as unknown as Record<string, unknown>,
						})
						server.server.sendResourceUpdated({
							uri: `events://${eventType}`,
						})
					})

					registeredEvents.add(eventType)
				}
			}
			return {}
		},
	)
}

function initializeSlackClient(server: McpServer, token: string, signingSecret?: string, appToken?: string) {
	if (slackClient) {
		console.log("Slack Client already initialized", slackClient)
		return
	}
	slackClient = new WebClient(token)

	const socketMode = !!appToken && !!signingSecret
	if (socketMode) {
		setupResources({ token: token, signingSecret, appToken }, server)
	}
	return
}

const provider = new SlackServerAuthProvider

// Create the main Express app first
const app = express();
app.use(express.json())

// Add CORS middleware to main app BEFORE anything else
app.use(cors({
	//  add smithery url ?
    origin: ['http://localhost:5173', 'http://127.0.0.1:6274', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Origin', 
        'X-Requested-With', 
        'Content-Type', 
        'Accept', 
        'Authorization',
        'mcp-session-id',
		'mcp-protocol-version'
    ],
	exposedHeaders: ["mcp-session-id"],
    credentials: true
}));

app.use(mcpAuthRouter({
	provider: provider,
	// TODO: Change when deployed to smithery url
	issuerUrl: new URL(process.env.SERVER_BASE_URL!),
}))

app.get("/oauth/callback", async(req, res) => {
	const { code, state } = req.query;
	if (!code || !state) {
		res.status(400).send("Invalid request parameters");
		return;
	}

	try {
		const result = await provider.handleOAuthCallback(code as string, state as string);

		console.log("Redirecting to:", result.redirectUrl, "with code:", result.mcpAuthCode)
		res.redirect(`${result.redirectUrl}?code=${result.mcpAuthCode}`);
	} catch (error) {
		console.error("Error in callback handler:", error);
		res.status(400).send("Server error during authentication callback");
	}
});

app.use('/mcp', requireBearerAuth({ provider: provider }))

// Create stateful server with Slack client configuration
createStatefulServer<{}>(
	app,
	({ config }) => {
		try {
			console.log("Starting Slack MCP Server...")

			// Create a new MCP server with the higher-level API
			const server = new McpServer({
				name: "Slack MCP Server",
				version: "1.0.0",
			})
		

			function getSlackClient(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): WebClient {
				if (!slackClient) {
					const mcpToken = extra.authInfo?.token;
					if (!mcpToken) {
						throw new Error("No token found in auth info");
					}
					const slackToken  = encryptionService.decryptToken(mcpToken);
					if (!slackToken) {
						throw new Error("Failed to decrypt token");
					}
					console.log("Initializing Slack Client", slackToken)
					initializeSlackClient(server, slackToken, process.env.SLACK_SIGNING_SECRET, process.env.SLACK_APP_TOKEN);
				}
		
				return slackClient!;
			}
			

			// List channels tool
			server.tool(
				"slack_list_channels",
				"List public or pre-defined channels in the workspace with pagination",
				{
					limit: z
						.number()
						.optional()
						.default(100)
						.describe(
							"Maximum number of channels to return (default 100, max 200)",
						),
					cursor: z
						.string()
						.optional()
						.describe("Pagination cursor for next page of results"),
				},
				async ( args, extra ) => {
					const response = await getSlackClient(extra).conversations.list({
						limit: args.limit,
						cursor: args.cursor,
					})
					return {
						content: [{ type: "text", text: JSON.stringify(response) }],
					}
				},
			)

			// Post message tool (with optional thread reply capability)
			server.tool(
				"slack_post_message",
				"Post a new message to a Slack channel or reply to a thread",
				{
					channel_id: z.string().describe("The ID of the channel to post to"),
					text: z.string().describe("The message text to post"),
					thread_ts: z
						.string()
						.optional()
						.describe(
							"Optional. The timestamp of the parent message to reply to in the format '1234567890.123456'. When provided, the message will be posted as a reply to the thread.",
						),
				},
				async ( args, extra) => {
					const response = await getSlackClient(extra).chat.postMessage({
						channel: args.channel_id,
						// @ts-ignore
						blocks: [{ type: "markdown", text: args.text }],
						...(args.thread_ts && { thread_ts: args.thread_ts }),
						mrkdwn: true,
					})
					return {
						content: [{ type: "text", text: JSON.stringify(response) }],
					}
				},
			)

			// Add reaction tool
			server.tool(
				"slack_add_reaction",
				"Add a reaction emoji to a message",
				{
					channel_id: z
						.string()
						.describe("The ID of the channel containing the message"),
					timestamp: z
						.string()
						.describe("The timestamp of the message to react to"),
					reaction: z
						.string()
						.describe("The name of the emoji reaction (without ::)"),
				},
				async ( args, extra) => {
					const response = await getSlackClient(extra).reactions.add({
						channel: args.channel_id,
						timestamp: args.timestamp,
						name: args.reaction,
					})
					return {
						content: [{ type: "text", text: JSON.stringify(response) }],
					}
				},
			)

			// Get channel history tool
			server.tool(
				"slack_get_channel_history",
				"Get recent messages from a channel",
				{
					channel_id: z.string().describe("The ID of the channel"),
					limit: z
						.number()
						.optional()
						.default(10)
						.describe("Number of messages to retrieve (default 10)"),
				},
				async ( args, extra) => {
					const response = await getSlackClient(extra).conversations.history({
						channel: args.channel_id,
						limit: args.limit,
					})
					return {
						content: [{ type: "text", text: JSON.stringify(response) }],
					}
				},
			)

			// Get thread replies tool
			server.tool(
				"slack_get_thread_replies",
				"Get all replies in a message thread",
				{
					channel_id: z
						.string()
						.describe("The ID of the channel containing the thread"),
					thread_ts: z
						.string()
						.describe(
							"The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
						),
				},
				async ( args, extra) => {
					const response = await getSlackClient(extra).conversations.replies({
						channel: args.channel_id,
						ts: args.thread_ts, // Note: Slack API uses 'ts' not 'thread_ts' for the replies method
					})
					return {
						content: [{ type: "text", text: JSON.stringify(response) }],
					}
				},
			)

			// Get users tool
			server.tool(
				"slack_get_users",
				"Get a list of all users in the workspace with their basic profile information",
				{
					cursor: z
						.string()
						.optional()
						.describe("Pagination cursor for next page of results"),
					limit: z
						.number()
						.optional()
						.default(100)
						.describe("Maximum number of users to return (default 100, max 200)"),
				},
				async ( args, extra) => {
					const response = await getSlackClient(extra).users.list({
						limit: args.limit,
						cursor: args.cursor,
					})
					return {
						content: [{ type: "text", text: JSON.stringify(response) }],
					}
				},
			)

			// Get user profile tool
			server.tool(
				"slack_get_user_profile",
				"Get detailed profile information for a specific user",
				{
					user_id: z.string().describe("The ID of the user"),
				},
				async ( args, extra) => {
					const response = await getSlackClient(extra).users.profile.get({
						user: args.user_id,
					})
					return {
						content: [{ type: "text", text: JSON.stringify(response) }],
					}
				},
			)

			return server.server
		} catch (e) {
			console.error(e)
			throw e
		}
	}
)

// Start the server with mainApp
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
	console.log(`MCP server running on port ${PORT}`);
})
