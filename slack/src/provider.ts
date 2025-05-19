import { Response } from "express";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebClient } from "@slack/web-api";
import crypto from "crypto";
import { 
    InvalidTokenError,
    InvalidGrantError, 
    ServerError,
    InvalidRequestError,
    AccessDeniedError
  } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import dotenv from "dotenv";

dotenv.config();

export class SlackServerAuthProvider implements OAuthServerProvider {
    private _clients: Record<string, OAuthClientInformationFull> = {};
    private _clientsStore: OAuthRegisteredClientsStore;

    // Temporary in-memory store to map our MCP access tokens to Slack access tokens
    private _accessTokenMap = new Map<string, string>();
    // Temporary in-memory store to map our MCP auth codes to MCP access tokens
    private _pendingAuthCodes = new Map<string, string>();
    // Temporary in-memory store to map out MCP access tokens to Auth user info
    private _accessTokenUserMap = new Map<string, AuthInfo>();

    private _sessionStore = new Map<string, {
        state: string,
        codeChallenge: string,
        redirectUri: string,
        // Auth info
        clientId: string,
        scopes: string[],
    }>();

    constructor() {

        this._clientsStore = {
            getClient: async (clientId: string) => {
                console.log("in get client", clientId);
                console.log("this._clients", this._clients);
                return this._clients[clientId];
            },

            registerClient: async (client: OAuthClientInformationFull) => {
                console.log("in register client", client);
                this._clients[client.client_id] = client;
                return client;
            }
        };
    }

    get clientsStore(): OAuthRegisteredClientsStore {
        return this._clientsStore;
    }

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
        const state = params.state || crypto.randomBytes(32).toString('hex');

        try {
            // Store session data
            this._sessionStore.set(state, {
                state,
                codeChallenge: params.codeChallenge,
                redirectUri: params.redirectUri,
                clientId: client.client_id,
                scopes: params.scopes || []
            });

            const slackAuthUrl = new URL('https://slack.com/oauth/v2/authorize');
            const authParams = new URLSearchParams({
                client_id: process.env.SLACK_CLIENT_ID!,
                scope: 'app_mentions:read,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,chat:write,chat:write.public,reactions:write,users:read,users.profile:read',
                // redirect_uri: 'https://localhost:8081/oauth/callback',
                redirect_uri: 'https://0f74-108-85-108-59.ngrok-free.app/oauth/callback',
                state
            });

            console.log("Redirecting to:", slackAuthUrl, "with params:", authParams);

            res.redirect(`${slackAuthUrl}?${authParams}`);
        } catch (error) {
            console.error(error);
            this._sessionStore.delete(state);
            throw new ServerError("Failed to authorize");

        }
    }

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
        const mcpAccessToken = this._pendingAuthCodes.get(authorizationCode);
        if (!mcpAccessToken) {
            throw new Error("Invalid authorization code");
        }
        // Return the stored code challenge
        return this._sessionStore.get(mcpAccessToken)?.codeChallenge || '';
    }

    async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
        const mcpAccessToken = this._pendingAuthCodes.get(authorizationCode);
        if (!mcpAccessToken) {
            throw new Error("Invalid authorization code");
        }

        this._pendingAuthCodes.delete(authorizationCode);

        return {
            access_token: mcpAccessToken,
            token_type: "Bearer"
        };
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const slackToken = this._accessTokenMap.get(token);
        if (!slackToken) {
            throw new Error("Invalid token");
        }

        const authInfo = this._accessTokenUserMap.get(token);
        if (!authInfo) {
            throw new InvalidTokenError("Invalid token");
        }

        // Verify with Slack API
        try {
            const client = new WebClient(slackToken);
            const auth = await client.auth.test();
        } catch (error) {
            this._accessTokenMap.delete(token);
            this._accessTokenUserMap.delete(token);
            throw new InvalidTokenError("Invalid token");
        }

        return authInfo;
    }

    async exchangeRefreshToken(): Promise<OAuthTokens> {
        throw new ServerError("Refresh token exchange not implemented");
    }

    // Helper method to handle the Slack OAuth callback
    async handleOAuthCallback(code: string, state: string): Promise<{ mcpAuthCode: string, redirectUrl: string }> {

        const sessionData = this._sessionStore.get(state);
        if (!sessionData) {
            throw new Error("Invalid state parameter");
        }

        const formData = new FormData();
        formData.append('code', code);
        formData.append('client_id', process.env.SLACK_CLIENT_ID!);
        formData.append('client_secret', process.env.SLACK_CLIENT_SECRET!);
        // formData.append('redirect_uri', 'https://localhost:8081/oauth/callback');
        formData.append('redirect_uri', 'https://0f74-108-85-108-59.ngrok-free.app/oauth/callback');

        const response = await fetch('https://slack.com/api/oauth.v2.access', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (!data.ok) {
            throw new Error("Failed to exchange code");
        }

        // Generate MCP auth code and token
        const mcpAuthCode = crypto.randomBytes(32).toString('hex');
        const mcpAccessToken = crypto.randomBytes(32).toString('hex');

        // Store mappings
        this._pendingAuthCodes.set(mcpAuthCode, mcpAccessToken);
        this._accessTokenMap.set(mcpAccessToken, data.access_token);
        this._accessTokenUserMap.set(mcpAccessToken, {
            token: mcpAccessToken,
            clientId: sessionData.clientId,
            scopes: sessionData.scopes
        });

        // Clean up session data
        this._sessionStore.delete(state);

        return { mcpAuthCode, redirectUrl: sessionData.redirectUri };
    }
}