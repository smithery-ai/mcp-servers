import crypto from "node:crypto"
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js"
import {
	InvalidTokenError,
	ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type {
	AuthorizationParams,
	OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import type {
	OAuthClientInformationFull,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { Response } from "express"
import {
	decrypt as pasetoDecrypt,
	encrypt as pasetoEncrypt,
} from "paseto-ts/v4"

export class SlackServerAuthProvider implements OAuthServerProvider {
	private _clients: Record<string, OAuthClientInformationFull> = {}
	private _clientsStore: OAuthRegisteredClientsStore

	// PASETO v4.local key in PASERK string form (k4.local.*)
	private _localKey: string

	// Map auth code -> { mcpAccessToken, codeChallenge }
	private _pendingAuthCodes = new Map<
		string,
		{
			mcpAccessToken: string
			codeChallenge?: string
		}
	>()

	private _sessionStore = new Map<
		string,
		{
			state?: string // not used externally
			codeChallenge?: string
			redirectUri: string
			clientId: string
			scopes: string[]
		}
	>()

	constructor() {
		this._localKey = process.env.GLOBAL_SECRET!

		this._clientsStore = {
			getClient: async (clientId: string) => {
				return this._clients[clientId]
			},

			registerClient: async (client: OAuthClientInformationFull) => {
				this._clients[client.client_id] = client
				return client
			},
		}
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		return this._clientsStore
	}

	async authorize(
		client: OAuthClientInformationFull,
		params: AuthorizationParams,
		res: Response,
	): Promise<void> {
		const state = params.state || crypto.randomBytes(32).toString("hex")

		try {
			// Store session data
			this._sessionStore.set(state, {
				state,
				codeChallenge: params.codeChallenge,
				redirectUri: params.redirectUri,
				clientId: client.client_id,
				scopes: params.scopes || [],
			})

			const host = res.req.get("host") || "localhost:8081"
			const protocol = host.startsWith("localhost") ? "http" : "https"
			const redirectUri = `${protocol}://${host}/oauth/callback`

			const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize")
			const authParams = new URLSearchParams({
				client_id: process.env.SLACK_CLIENT_ID!,
				scope:
					"app_mentions:read,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,chat:write,chat:write.public,reactions:write,users:read,users.profile:read",
				redirect_uri: redirectUri,
				state,
			})

			// console.log("Redirecting to:", slackAuthUrl, "with params:", authParams);

			res.redirect(`${slackAuthUrl}?${authParams}`)
		} catch (error) {
			console.error(error)
			this._sessionStore.delete(state)
			throw new ServerError("Failed to authorize")
		}
	}

	async challengeForAuthorizationCode(
		client: OAuthClientInformationFull,
		authorizationCode: string,
	): Promise<string> {
		// Look up pending entry for this auth code
		const pending = this._pendingAuthCodes.get(authorizationCode)
		if (!pending) {
			throw new Error("Invalid authorization code")
		}

		return pending.codeChallenge ?? ""
	}

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		authorizationCode: string,
	): Promise<OAuthTokens> {
		const mcpAccessToken =
			this._pendingAuthCodes.get(authorizationCode)?.mcpAccessToken
		if (!mcpAccessToken) {
			throw new Error("Invalid authorization code")
		}

		// Clean up the stored data because the auth code is single-use
		this._pendingAuthCodes.delete(authorizationCode)

		return {
			access_token: mcpAccessToken,
			token_type: "Bearer",
		}
	}

	/**
	 * Verifies that the MCP access token is genuine and belongs to the server.
	 * @param token
	 * @returns
	 */
	async verifyAccessToken(token: string): Promise<AuthInfo> {
		try {
			const { payload } = pasetoDecrypt<{
				slackToken: string
				clientId: string
				scopes: string[]
			}>(this._localKey, token, { validatePayload: false })

			const { slackToken, clientId, scopes } = payload

			return {
				token,
				clientId,
				scopes,
				extra: { slackToken },
			}
		} catch (err) {
			throw new InvalidTokenError("Invalid token")
		}
	}

	async exchangeRefreshToken(): Promise<OAuthTokens> {
		throw new ServerError("Refresh token exchange not implemented")
	}

	// Helper method to handle the Slack OAuth callback
	async handleOAuthCallback(
		code: string,
		state: string,
		host?: string,
	): Promise<{ mcpAuthCode: string; redirectUrl: string }> {
		const sessionData = this._sessionStore.get(state)
		if (!sessionData) {
			throw new Error("Invalid state parameter")
		}

		// TODO: Is this slack specific or standardized?
		const redirectHost = host || "localhost:8081"
		const protocol = redirectHost.startsWith("localhost") ? "http" : "https"
		const redirectUri = `${protocol}://${redirectHost}/oauth/callback`

		const formData = new FormData()
		formData.append("code", code)
		formData.append("client_id", process.env.SLACK_CLIENT_ID!)
		formData.append("client_secret", process.env.SLACK_CLIENT_SECRET!)
		formData.append("redirect_uri", redirectUri)
		// console.log("fetching...", formData);

		const response = await fetch("https://slack.com/api/oauth.v2.access", {
			method: "POST",
			body: formData,
		})

		const data = await response.json()
		if (!data.ok) {
			throw new Error("Failed to exchange code")
		}

		// Generate MCP auth code
		const mcpAuthCode = crypto.randomBytes(32).toString("hex")

		// Build token payload
		const payload = {
			slackToken: data.access_token,
			clientId: sessionData.clientId,
			scopes: sessionData.scopes,
		}

		// Encrypt with PASETO v4.local (adds iat & exp by default 1h)
		const mcpAccessToken = pasetoEncrypt(this._localKey, payload)

		// Store mapping for later exchange
		this._pendingAuthCodes.set(mcpAuthCode, {
			mcpAccessToken,
			codeChallenge: sessionData.codeChallenge,
		})

		// Clean up session data
		this._sessionStore.delete(state)

		return { mcpAuthCode, redirectUrl: sessionData.redirectUri }
	}
}
