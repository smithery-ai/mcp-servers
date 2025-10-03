#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as cheerio from "cheerio"
import { z } from "zod"

/**
 * Fetch Server - A general-purpose MCP server for making HTTP requests and extracting elements from web pages.
 *
 * Features:
 * - Make HTTP requests to any URL
 * - Extract specific HTML elements using CSS selectors
 * - Get page metadata (title, description, Open Graph, etc.)
 * - Parse and return structured data instead of raw HTML dumps
 */

// Configuration schema
export const configSchema = z.object({
	userAgent: z
		.string()
		.default("Fetch-MCP-Server/1.0 (https://smithery.ai)")
		.describe("Custom User-Agent header for HTTP requests"),
	timeout: z
		.number()
		.default(10000)
		.describe("Request timeout in milliseconds"),
	followRedirects: z.boolean().default(true).describe("Follow HTTP redirects"),
})

export const stateless = true

type Config = z.infer<typeof configSchema>

interface RequestOptions {
	userAgent: string
	timeout: number
	followRedirects: boolean
}

// Helper function to make HTTP requests
async function makeRequest(
	url: string,
	options: RequestOptions,
): Promise<Response> {
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), options.timeout)

	try {
		const response = await fetch(url, {
			headers: {
				"User-Agent": options.userAgent,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
				"Accept-Encoding": "gzip, deflate",
				Connection: "keep-alive",
			},
			signal: controller.signal,
			redirect: options.followRedirects ? "follow" : "manual",
		})

		clearTimeout(timeoutId)

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`)
		}

		return response
	} catch (error) {
		clearTimeout(timeoutId)
		if (error instanceof Error) {
			if (error.name === "AbortError") {
				throw new Error("Request timeout")
			}
			throw error
		}
		throw new Error("Unknown error occurred")
	}
}

// Helper to convert relative URLs to absolute
function resolveUrl(baseUrl: string, relativeUrl: string): string {
	try {
		return new URL(relativeUrl, baseUrl).href
	} catch {
		return relativeUrl
	}
}

export default function createServer({ config }: { config: Config }) {
	const server = new McpServer({
		name: "Fetch Server",
		version: "1.0.0",
	})

	const requestOptions: RequestOptions = {
		userAgent: config.userAgent,
		timeout: config.timeout,
		followRedirects: config.followRedirects,
	}

	// Tool: Fetch URL
	server.tool(
		"fetch_url",
		"Fetch a URL and return basic information about the page.",
		{
			url: z.string().describe("The URL to fetch"),
		},
		async ({ url }) => {
			try {
				const response = await makeRequest(url, requestOptions)
				const content = await response.text()

				// Parse content type
				const contentType =
					response.headers.get("content-type")?.split(";")[0] || "unknown"

				// Basic content info
				const contentInfo: Record<string, any> = {
					content_type: contentType,
					content_length: content.length,
					encoding: "utf-8", // Default for modern web
				}

				// If it's HTML, add some basic parsed info
				if (contentType.includes("text/html")) {
					const $ = cheerio.load(content)
					const title = $("title").text().trim()
					const metaDescription = $('meta[name="description"]')
						.attr("content")
						?.trim()

					contentInfo.title = title || null
					contentInfo.description = metaDescription || null
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status_code: response.status,
									final_url: response.url,
									headers: Object.fromEntries(response.headers.entries()),
									content_info: contentInfo,
								},
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
								},
								null,
								2,
							),
						},
					],
				}
			}
		},
	)

	// Tool: Extract Elements
	server.tool(
		"extract_elements",
		"Extract specific elements from a web page using CSS selectors.",
		{
			url: z.string().describe("The URL to fetch"),
			selector: z
				.string()
				.describe(
					"CSS selector to find elements (e.g., 'img', '.class', '#id', 'link[rel*=\"icon\"]')",
				),
			attribute: z
				.string()
				.optional()
				.describe(
					"Optional attribute to extract from elements (e.g., 'href', 'src', 'alt')",
				),
			limit: z
				.number()
				.default(10)
				.describe("Maximum number of elements to return"),
		},
		async ({ url, selector, attribute, limit }) => {
			try {
				const response = await makeRequest(url, requestOptions)
				const content = await response.text()
				const $ = cheerio.load(content)

				const elements = $(selector).slice(0, limit)

				if (elements.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										url: response.url,
										selector,
										elements: [],
										count: 0,
										message: `No elements found matching selector: ${selector}`,
									},
									null,
									2,
								),
							},
						],
					}
				}

				const extracted: any[] = []

				elements.each((_, element) => {
					const $el = $(element)

					if (attribute) {
						// Extract specific attribute
						let value = $el.attr(attribute)
						if (value) {
							// Convert relative URLs to absolute
							if (
								(attribute === "href" || attribute === "src") &&
								(value.startsWith("/") ||
									value.startsWith("./") ||
									value.startsWith("../"))
							) {
								value = resolveUrl(response.url, value)
							}
							extracted.push({
								attribute,
								value,
								tag: (element as any).tagName?.toLowerCase(),
							})
						}
					} else {
						// Extract element text and key attributes
						const elemData: any = {
							tag: (element as any).tagName?.toLowerCase(),
							text: $el.text().trim().substring(0, 200), // Limit text length
							attributes: {},
						}

						// Get all attributes and convert relative URLs
						const attrs = (element as any).attribs || {}
						for (const [attrName, attrValue] of Object.entries(attrs)) {
							let processedValue = attrValue
							if (
								(attrName === "href" || attrName === "src") &&
								typeof attrValue === "string" &&
								(attrValue.startsWith("/") ||
									attrValue.startsWith("./") ||
									attrValue.startsWith("../"))
							) {
								processedValue = resolveUrl(response.url, attrValue)
							}
							elemData.attributes[attrName] = processedValue
						}

						extracted.push(elemData)
					}
				})

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									url: response.url,
									selector,
									elements: extracted,
									count: extracted.length,
									total_found: $(selector).length,
								},
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
								},
								null,
								2,
							),
						},
					],
				}
			}
		},
	)

	// Tool: Get Page Metadata
	server.tool(
		"get_page_metadata",
		"Extract comprehensive metadata from a web page including title, description, Open Graph tags, Twitter cards, and other meta information.",
		{
			url: z.string().describe("The URL to analyze"),
		},
		async ({ url }) => {
			try {
				const response = await makeRequest(url, requestOptions)
				const content = await response.text()
				const $ = cheerio.load(content)

				const metadata: Record<string, any> = {
					url: response.url,
					title: "",
					description: "",
					open_graph: {},
					twitter_card: {},
					meta_tags: [],
					canonical: "",
					lang: "",
				}

				// Basic title
				metadata.title = $("title").text().trim()

				// Language
				metadata.lang = $("html").attr("lang") || ""

				// Meta tags
				$("meta").each((_, element) => {
					const $meta = $(element)
					const name = $meta.attr("name")?.toLowerCase() || ""
					const property = $meta.attr("property")?.toLowerCase() || ""
					const content = $meta.attr("content") || ""

					if (!content) return

					// Standard meta tags
					if (name === "description") {
						metadata.description = content
					} else if (
						["keywords", "author", "viewport", "robots"].includes(name)
					) {
						metadata.meta_tags.push({ name, content })
					}

					// Open Graph tags
					if (property.startsWith("og:")) {
						const ogKey = property.substring(3) // Remove 'og:' prefix
						metadata.open_graph[ogKey] = content
					}

					// Twitter Card tags
					if (name.startsWith("twitter:")) {
						const twitterKey = name.substring(8) // Remove 'twitter:' prefix
						metadata.twitter_card[twitterKey] = content
					}
				})

				// Canonical URL
				const canonical = $('link[rel="canonical"]').attr("href")
				if (canonical) {
					metadata.canonical = resolveUrl(response.url, canonical)
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(metadata, null, 2),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
								},
								null,
								2,
							),
						},
					],
				}
			}
		},
	)

	return server.server
}
