import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import pg from "pg"

// Predefined database roles following standard permission patterns
const databaseRoles = {
	read: ["SELECT"],
	insert: ["SELECT", "INSERT"],
	write: ["SELECT", "INSERT", "UPDATE", "DELETE"],
	admin: [
		"SELECT",
		"INSERT",
		"UPDATE",
		"DELETE",
		"TRUNCATE",
		"CREATE",
		"ALTER",
		"DROP",
	],
} as const

export const configSchema = z.object({
	postgresConnectionString: z
		.string()
		.describe(
			"The connection string for the PostgreSQL database, including the host, port, and database name, e.g., 'postgresql://user:password@host:port/db-name'.",
		),
	role: z
		.enum(["read", "insert", "write", "admin"])
		.default("read")
		.describe(
			"Database permission role: 'read' (SELECT only), 'insert' (SELECT + INSERT, append-only), 'write' (SELECT, INSERT, UPDATE, DELETE), 'admin' (all privileges including DDL).",
		),
})

// Helper function to check if SQL command is allowed based on granted privileges
function checkPermissions(
	sql: string,
	grantedPrivileges: readonly string[],
): void {
	const command = sql.trim().toUpperCase().split(/[\s;]/)[0]

	// Map command to required privilege
	const readCommands = ["SELECT", "WITH", "SHOW", "EXPLAIN"]
	let requiredPrivilege = command

	if (readCommands.includes(command)) {
		requiredPrivilege = "SELECT"
	} else if (command === "RENAME") {
		requiredPrivilege = "ALTER"
	}

	// Check if the required privilege has been granted
	if (!grantedPrivileges.includes(requiredPrivilege)) {
		throw new Error(
			`Permission denied: ${command} requires ${requiredPrivilege} privilege. Granted privileges: ${grantedPrivileges.join(", ")}`,
		)
	}
}

export default function createServer({
	config,
	logger,
}: {
	config: z.infer<typeof configSchema>
	logger: { info: Function; error: Function; warn: Function; debug: Function }
}) {
	const server = new McpServer({
		name: "PostgreSQL Server",
		version: "1.0.0",
	})

	// Get privileges for the configured role
	const grantedPrivileges = databaseRoles[config.role]

	// Create connection pool for better performance
	const pool = new pg.Pool({
		connectionString: config.postgresConnectionString,
	})

	// Static resource: list of all database tables
	server.registerResource(
		"tables",
		"postgres://tables",
		{
			title: "Database Tables",
			description: "List of all tables in the database",
			mimeType: "text/plain",
		},
		async uri => {
			const client = await pool.connect()
			try {
				const result = await client.query(
					"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
				)
				const tableList = result.rows.map(row => row.table_name).join("\n")
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: "text/plain",
							text: tableList,
						},
					],
				}
			} finally {
				client.release()
			}
		},
	)

	// Dynamic resource: individual table schemas with parameters
	server.registerResource(
		"table-schema",
		new ResourceTemplate("postgres://tables/{tableName}/schema", {
			list: undefined,
		}),
		{
			title: "Table Schema",
			description: "Schema information for a specific database table",
			mimeType: "text/plain",
		},
		async (uri, { tableName }) => {
			const client = await pool.connect()
			try {
				const result = await client.query(
					"SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
					[tableName],
				)

				const schemaText = result.rows
					.map(
						row =>
							`${row.column_name}: ${row.data_type}${row.is_nullable === "NO" ? " NOT NULL" : ""}${row.column_default ? ` DEFAULT ${row.column_default}` : ""}`,
					)
					.join("\n")

				return {
					contents: [
						{
							uri: uri.href,
							mimeType: "text/plain",
							text: `Table: ${tableName}\n\n${schemaText}`,
						},
					],
				}
			} finally {
				client.release()
			}
		},
	)

	// Checkpoint mode state management
	let sessionClient: pg.PoolClient | null = null
	let checkpointMode = false
	let checkpointHistory: Array<{
		id: number
		query: string
		timestamp: string
	}> = []
	let checkpointCounter = 0

	// Unified checkpoint management tool
	server.registerTool(
		"checkpoint",
		{
			title: "Checkpoint Management",
			description:
				"Manage database checkpoints for safe experimentation. Start checkpoint mode to enable undo/redo capabilities.",
			inputSchema: {
				action: z
					.enum(["start", "list", "rollback", "commit", "discard"])
					.describe(
						"Action to perform: 'start' (begin checkpoint mode), 'list' (show checkpoints), 'rollback' (undo to checkpoint), 'commit' (save changes), 'discard' (throw away all changes)",
					),
				checkpointId: z
					.number()
					.optional()
					.describe(
						"Checkpoint ID to rollback to (only used with 'rollback' action)",
					),
			},
		},
		async ({ action, checkpointId }) => {
			if (action === "start") {
				if (checkpointMode) {
					return {
						content: [{ type: "text", text: "Checkpoint mode already active" }],
					}
				}
				sessionClient = await pool.connect()
				await sessionClient.query("BEGIN")
				checkpointMode = true
				checkpointHistory = []
				checkpointCounter = 0
				return {
					content: [
						{
							type: "text",
							text: "Checkpoint mode started. All write queries will be automatically checkpointed. Use checkpoint({ action: 'commit' }) to save or checkpoint({ action: 'discard' }) to rollback.",
						},
					],
				}
			}

			if (action === "list") {
				if (!checkpointMode) {
					return {
						content: [
							{
								type: "text",
								text: "No active checkpoint session. Use checkpoint({ action: 'start' }) to begin.",
							},
						],
					}
				}
				if (checkpointHistory.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No checkpoints yet. Execute some write queries to create checkpoints.",
							},
						],
					}
				}
				const list = checkpointHistory
					.map(cp => `${cp.id}. ${cp.query} (${cp.timestamp})`)
					.join("\n")
				return {
					content: [{ type: "text", text: `Checkpoints:\n${list}` }],
				}
			}

			if (action === "rollback") {
				if (!checkpointMode || !sessionClient) {
					throw new Error("No active checkpoint session")
				}
				if (!checkpointId) {
					throw new Error("checkpointId required for rollback action")
				}
				const checkpoint = checkpointHistory.find(cp => cp.id === checkpointId)
				if (!checkpoint) {
					throw new Error(`Checkpoint ${checkpointId} not found`)
				}
				await sessionClient.query(
					`ROLLBACK TO SAVEPOINT checkpoint_${checkpointId}`,
				)
				// Remove checkpoints after this one
				checkpointHistory = checkpointHistory.filter(
					cp => cp.id <= checkpointId,
				)
				return {
					content: [
						{
							type: "text",
							text: `Rolled back to checkpoint ${checkpointId}: ${checkpoint.query}`,
						},
					],
				}
			}

			if (action === "commit") {
				if (!checkpointMode || !sessionClient) {
					throw new Error("No active checkpoint session")
				}
				await sessionClient.query("COMMIT")
				sessionClient.release()
				sessionClient = null
				checkpointMode = false
				const count = checkpointHistory.length
				checkpointHistory = []
				checkpointCounter = 0
				return {
					content: [
						{
							type: "text",
							text: `Changes committed successfully. ${count} checkpoints finalized.`,
						},
					],
				}
			}

			if (action === "discard") {
				if (!checkpointMode || !sessionClient) {
					throw new Error("No active checkpoint session")
				}
				await sessionClient.query("ROLLBACK")
				sessionClient.release()
				sessionClient = null
				checkpointMode = false
				const count = checkpointHistory.length
				checkpointHistory = []
				checkpointCounter = 0
				return {
					content: [
						{
							type: "text",
							text: `All changes discarded. ${count} checkpoints rolled back.`,
						},
					],
				}
			}

			throw new Error(`Unknown action: ${action}`)
		},
	)

	// Register the query tool with role-based privileges
	const isReadOnly = config.role === "read"
	const roleDescriptions = {
		read: "Run read-only SQL queries (SELECT privilege)",
		insert:
			"Run append-only queries (SELECT, INSERT privileges - no modifications to existing data)",
		write:
			"Run data modification queries (SELECT, INSERT, UPDATE, DELETE privileges)",
		admin: "Run any SQL queries including DDL (all privileges)",
	}
	const description = `${roleDescriptions[config.role]} - Role: ${config.role}`

	server.registerTool(
		"query",
		{
			title: "Execute PostgreSQL Query",
			description,
			inputSchema: {
				sql: z.string().describe("The SQL query to execute"),
			},
		},
		async ({ sql }) => {
			logger.info({ sql, role: config.role }, 'Executing SQL query')
			
			// Check if command is allowed with granted privileges
			checkPermissions(sql, grantedPrivileges)

			// Determine if this is a write operation
			const command = sql.trim().toUpperCase().split(/[\s;]/)[0]
			const writeCommands = [
				"INSERT",
				"UPDATE",
				"DELETE",
				"TRUNCATE",
				"CREATE",
				"ALTER",
				"DROP",
				"RENAME",
			]
			const isWrite = writeCommands.includes(command)

			// If in checkpoint mode, use session client and auto-checkpoint writes
			if (checkpointMode && sessionClient) {
				const result = await sessionClient.query(sql)

				if (isWrite) {
					// Create checkpoint after successful write
					checkpointCounter++
					const checkpointId = checkpointCounter
					await sessionClient.query(`SAVEPOINT checkpoint_${checkpointId}`)
					checkpointHistory.push({
						id: checkpointId,
						query: sql,
						timestamp: new Date().toISOString(),
					})
				}

				// Format response based on whether rows were returned
				const responseText =
					result.rows.length > 0
						? JSON.stringify(result.rows, null, 2)
						: `${command} successful. ${result.rowCount || 0} row(s) affected.`

				return {
					content: [
						{
							type: "text",
							text: responseText,
						},
					],
				}
			}

			// Normal mode: auto-commit each query
			const client = await pool.connect()
			try {
				// Use read-only transaction for SELECT-only, regular transaction otherwise
				if (isReadOnly) {
					await client.query("BEGIN TRANSACTION READ ONLY")
				} else {
					await client.query("BEGIN")
				}
			const result = await client.query(sql)
			await client.query("COMMIT")

			// Format response based on whether rows were returned
			const responseText =
				result.rows.length > 0
					? JSON.stringify(result.rows, null, 2)
					: `${command} successful. ${result.rowCount || 0} row(s) affected.`

			logger.info({ rowCount: result.rows.length, command }, 'Query completed successfully')

			return {
					content: [
						{
							type: "text",
							text: responseText,
						},
					],
				}
		} catch (error) {
			await client
				.query("ROLLBACK")
				.catch(rollbackError =>
					console.warn("Could not roll back transaction:", rollbackError),
				)
			logger.error({ error, sql }, 'Query failed')
			throw error
			} finally {
				client.release()
			}
		},
	)

	return server.server
}
