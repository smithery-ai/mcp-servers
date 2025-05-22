import { Response } from "express";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebClient } from "@slack/web-api";
import crypto from "crypto";
import { 
    InvalidTokenError,
    ServerError,
    InvalidRequestError,
    AccessDeniedError
  } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import dotenv from "dotenv";
import { encryptionService } from "./encryptionService.js";

dotenv.config();

// Type definitions for in-memory stores
interface SessionData {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    clientId: string;
    scopes: string[];
}

interface PendingAuthCode {
    mcpAccessToken: string;
    state: string;
}

export class SlackServerAuthProvider implements OAuthServerProvider {

    private _clientsStore: OAuthRegisteredClientsStore;

    // Temporary in-memory store to map our MCP auth codes to MCP accesstokens and state
    private _pendingAuthCodes = new Map<string, PendingAuthCode>();

    // Temporary in-memory store to map our state to session data
    private _sessionStore = new Map<string, SessionData>();


    constructor() {

        // This is a hardcoded client store using the Smithery client id and redirect uri
        // We do not support dynamic client registration. 
        // The web client that connects to initiate auth flow is configured to use this client id and redirect uri
        this._clientsStore = {
            getClient: async (clientId: string) => {
                return {
                    client_id: process.env.SLACK_CLIENT_ID!,
                    redirect_uris: [process.env.CLIENT_REDIRECT_URI!]
                }
            },

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
                scope: 'app_mentions:read,assistant:write,channels:read,chat:write,chat:write.public,im:history,im:write,reactions:read,reactions:write,channels:history,groups:read,groups:history,im:read,mpim:read,mpim:history,users:read,users.profile:read',
                redirect_uri: process.env.SLACK_REDIRECT_URI!,
                state
            });


            res.redirect(`${slackAuthUrl}?${authParams}`);
        } catch (error) {
            console.error(error);
            this._sessionStore.delete(state);
            throw new ServerError("Failed to authorize");

        }
    }

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
        const { state } = this._pendingAuthCodes.get(authorizationCode) || {};
        if (!state) {
            throw new Error("Invalid authorization code");
        }
        const codeChallenge = this._sessionStore.get(state)?.codeChallenge || '';
        this._sessionStore.delete(state);
        return codeChallenge;
    }

    async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
        const { mcpAccessToken } = this._pendingAuthCodes.get(authorizationCode) || {};
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
        try {
            // Decrypt the token to get the Slack token
            const slackToken = encryptionService.decryptToken(token);

            const authInfo = {
                token: token,
                clientId: process.env.SLACK_CLIENT_ID!,
                scopes: []
            }

            if (!authInfo) {
                throw new InvalidTokenError("Invalid MCP Access Token");
            }

            // Verify with Slack API
            const client = new WebClient(slackToken);
            const auth = await client.auth.test();

            if (!auth.ok) {
                throw new InvalidTokenError("Invalid Slack Access Token");
            }
            
            return authInfo;
        } catch (error) {
            throw new InvalidTokenError("Invalid token");
        }
    }

    async exchangeRefreshToken(): Promise<OAuthTokens> {
        throw new ServerError("Refresh token exchange not implemented");
    }

    // Modify handleOAuthCallback to use encryption
    async handleOAuthCallback(code: string, state: string): Promise<{ mcpAuthCode: string, redirectUrl: string }> {
        const sessionData = this._sessionStore.get(state);
        if (!sessionData) {
            throw new Error("Invalid state parameter");
        }

        const formData = new FormData();
        formData.append('code', code);
        formData.append('client_id', process.env.SLACK_CLIENT_ID!);
        formData.append('client_secret', process.env.SLACK_CLIENT_SECRET!);
        formData.append('redirect_uri', process.env.SLACK_REDIRECT_URI!);

        const response = await fetch('https://slack.com/api/oauth.v2.access', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (!data.ok) {
            throw new Error("Failed to exchange code");
        }

        // Generate MCP auth code
        const mcpAuthCode = crypto.randomBytes(32).toString('hex');
        
        // Instead of generating random token, encrypt the Slack token
        const mcpAccessToken = encryptionService.encryptToken(data.access_token);

        // Store mappings
        this._pendingAuthCodes.set(mcpAuthCode, {
            mcpAccessToken,
            state
        });

        return { mcpAuthCode, redirectUrl: sessionData.redirectUri };
    }
}