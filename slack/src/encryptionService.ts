import crypto from "node:crypto"
import dotenv from "dotenv"

dotenv.config()

const ALGO = "aes-256-gcm"
const IV_LENGTH = 12
const TAG_LENGTH = 16
const APP_SECRET = Buffer.from(
	process.env.TOKEN_ENCRYPTION_KEY as string, // 32-byte base64 string, e.g. "w1Kx…"
	"base64",
)

export const encryptionService = {
	// Helper methods for encryption/decryption
	encryptToken(token: string): string {
		const iv = crypto.randomBytes(IV_LENGTH)
		const cipher = crypto.createCipheriv(ALGO, APP_SECRET, iv)

		const ciphertext = Buffer.concat([
			cipher.update(token, "utf8"),
			cipher.final(),
		])
		const tag = cipher.getAuthTag() // integrity check

		// iv | tag | ciphertext  → base64-url
		return Buffer.concat([iv, tag, ciphertext]).toString("base64url")
	},

	decryptToken(encryptedToken: string): string {
		const data = Buffer.from(encryptedToken, "base64url")
		const iv = data.subarray(0, IV_LENGTH)
		const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
		const enc = data.subarray(IV_LENGTH + TAG_LENGTH)

		const decipher = crypto.createDecipheriv(ALGO, APP_SECRET, iv)
		decipher.setAuthTag(tag)

		return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
			"utf8",
		)
	},
}
