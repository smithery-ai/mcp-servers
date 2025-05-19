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
    
    // Encryption key for tokens - should be 32 bytes for AES-256
    private readonly _encryptionKey: Buffer;

    // Temporary in-memory store to map our MCP auth codes to MCP accesstokens and state
    private _pendingAuthCodes = new Map<string, {
        mcpAccessToken: string,
        state: string
    }>();
    
    // Temporary in-memory store to map out MCP access tokens to Auth user info
    private _accessTokenUserMap = new Map<string, AuthInfo>();

    private _sessionStore = new Map<string, {
        state: string,
        codeChallenge: string,
        redirectUri: string,
        clientId: string,
        scopes: string[],
    }>();

    constructor() {
        // Initialize encryption key from environment variable or generate one
        const key = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
        this._encryptionKey = Buffer.from(key, 'hex');

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

            console.log("sessionStore", this._sessionStore);

            const slackAuthUrl = new URL('https://slack.com/oauth/v2/authorize');
            const authParams = new URLSearchParams({
                client_id: process.env.SLACK_CLIENT_ID!,
                scope: 'app_mentions:read,assistant:write,channels:read,chat:write,chat:write.public,im:history,im:write,reactions:read,reactions:write,channels:history,groups:read,groups:history,im:read,mpim:read,mpim:history,users:read,users.profile:read',
                // scope: 'app_mentions:read,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,chat:write,chat:write.public,reactions:write,users:read,users.profile:read',
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
        const { state } = this._pendingAuthCodes.get(authorizationCode) || {};
        if (!state) {
            throw new Error("Invalid authorization code");
        }
        // log the state and the code challenge
        const codeChallenge = this._sessionStore.get(state)?.codeChallenge || '';
        console.log('sessionStore in challengeForAuthorizationCode', this._sessionStore);
        console.log('challengeForAuthorizationCode', state, codeChallenge);

          // Clean up session data
        console.log("deleting state from sessionStore", state);
        this._sessionStore.delete(state);
        return codeChallenge;
    }

    async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
        const { mcpAccessToken } = this._pendingAuthCodes.get(authorizationCode) || {};
        if (!mcpAccessToken) {
            throw new Error("Invalid authorization code");
        }

        this._pendingAuthCodes.delete(authorizationCode);

        console.log('exchangeAuthorizationCode', mcpAccessToken);
        return {
            access_token: mcpAccessToken,
            token_type: "Bearer"
        };
    }

    // Add helper methods for encryption/decryption
    private encryptToken(token: string): string {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', this._encryptionKey, iv);
        let encrypted = cipher.update(token, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    }

    private decryptToken(encryptedToken: string): string {
        const [ivHex, encrypted] = encryptedToken.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', this._encryptionKey, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        try {
            // Decrypt the token to get the Slack token
            const slackToken = this.decryptToken(token);

            const authInfo = this._accessTokenUserMap.get(token);
            if (!authInfo) {
                throw new InvalidTokenError("Invalid token");
            }

            // Verify with Slack API
            const client = new WebClient(slackToken);
            const auth = await client.auth.test();

            console.log("auth in verifyAccessToken", auth);

            if (!auth.ok) {
                throw new InvalidTokenError("Invalid token");
            }
            
            return authInfo;
        } catch (error) {
            this._accessTokenUserMap.delete(token);
            throw new InvalidTokenError("Invalid token");
        }
    }

    async exchangeRefreshToken(): Promise<OAuthTokens> {
        throw new ServerError("Refresh token exchange not implemented");
    }

    // Modify handleOAuthCallback to use encryption
    async handleOAuthCallback(code: string, state: string): Promise<{ mcpAuthCode: string, redirectUrl: string }> {
        console.log('in handleOAuthCallback', code, state);
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

        // Generate MCP auth code
        const mcpAuthCode = crypto.randomBytes(32).toString('hex');
        
        // Instead of generating random token, encrypt the Slack token
        const mcpAccessToken = this.encryptToken(data.access_token);

        // Store mappings
        this._pendingAuthCodes.set(mcpAuthCode, {
            mcpAccessToken,
            state
        });
        
        this._accessTokenUserMap.set(mcpAccessToken, {
            token: mcpAccessToken,
            clientId: sessionData.clientId,
            scopes: sessionData.scopes
        });

        return { mcpAuthCode, redirectUrl: sessionData.redirectUri };
    }
}