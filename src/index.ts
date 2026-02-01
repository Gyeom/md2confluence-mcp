#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConfluenceClient } from "./confluence.js";
import { convertMarkdownToConfluence } from "./converter.js";

// Environment variables
const CONFLUENCE_URL = process.env.CONFLUENCE_URL || "";
const CONFLUENCE_EMAIL = process.env.CONFLUENCE_EMAIL || "";
const CONFLUENCE_TOKEN = process.env.CONFLUENCE_TOKEN || "";

// Validate config
function validateConfig() {
  if (!CONFLUENCE_URL || !CONFLUENCE_EMAIL || !CONFLUENCE_TOKEN) {
    console.error("Missing required environment variables:");
    console.error("  CONFLUENCE_URL - e.g., https://your-domain.atlassian.net/wiki");
    console.error("  CONFLUENCE_EMAIL - your Atlassian email");
    console.error("  CONFLUENCE_TOKEN - API token from https://id.atlassian.com/manage/api-tokens");
    process.exit(1);
  }
}

// Tool schemas
const UploadPageSchema = z.object({
  content: z.string().describe("Markdown content to upload"),
  title: z.string().describe("Page title"),
  space: z.string().describe("Confluence space key, space URL, or page URL. If page URL is provided with a valid page ID, it will update the existing page instead of creating a new one."),
  parentId: z.string().optional().describe("Parent page ID (optional)"),
});

/**
 * Parse Confluence URL to extract space key and optionally page ID
 * URL formats:
 * - Space URL: https://xxx.atlassian.net/wiki/spaces/SPACEKEY/...
 * - Page URL: https://xxx.atlassian.net/wiki/spaces/SPACEKEY/pages/PAGEID/...
 * - Edit URL: https://xxx.atlassian.net/wiki/spaces/SPACEKEY/pages/edit-v2/PAGEID?...
 */
interface ParsedConfluenceUrl {
  spaceKey: string;
  pageId?: string;
}

function parseConfluenceUrl(input: string): ParsedConfluenceUrl {
  // If it looks like a URL, extract space key and optionally page ID
  if (input.startsWith("http")) {
    const spaceMatch = input.match(/\/spaces\/([^\/]+)/);
    if (!spaceMatch) {
      throw new Error(`Could not extract space key from URL: ${input}`);
    }
    const spaceKey = spaceMatch[1];

    // Try to extract page ID from various URL formats
    // Format 1: /pages/PAGEID/... or /pages/PAGEID?...
    // Format 2: /pages/edit-v2/PAGEID?...
    let pageId: string | undefined;

    const editPageMatch = input.match(/\/pages\/edit-v2\/(\d+)/);
    if (editPageMatch) {
      pageId = editPageMatch[1];
    } else {
      const pageMatch = input.match(/\/pages\/(\d+)/);
      if (pageMatch) {
        pageId = pageMatch[1];
      }
    }

    return { spaceKey, pageId };
  }
  // Otherwise, assume it's already a space key
  return { spaceKey: input };
}

const UpdatePageSchema = z.object({
  content: z.string().describe("Markdown content to upload"),
  pageId: z.string().describe("Existing page ID to update"),
  title: z.string().optional().describe("New title (optional)"),
});

const ListSpacesSchema = z.object({
  limit: z.number().optional().default(25).describe("Max spaces to return"),
  type: z.enum(["global", "personal", "all"]).optional().default("all").describe("Space type filter"),
});

const SearchPagesSchema = z.object({
  query: z.string().describe("Search query"),
  spaceKey: z.string().optional().describe("Limit to specific space"),
  limit: z.number().optional().default(10).describe("Max results"),
});

// Create server
const server = new Server(
  {
    name: "md2confluence-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "upload_page",
        description: "Upload Markdown to Confluence. IMPORTANT: Do NOT call list_spaces first. Instead, directly ask the user for: (1) space key (e.g., 'SPE'), (2) space URL, or (3) existing page URL to update. If a page URL with page ID is provided, it automatically updates that page (must be published, not draft). Mermaid diagrams are auto-converted to images.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Markdown content to upload" },
            title: { type: "string", description: "Page title" },
            space: { type: "string", description: "Space key, space URL, or page URL. If page URL contains a page ID, it will update that page. Ask user directly without listing spaces first." },
            parentId: { type: "string", description: "Parent page ID (optional)" },
          },
          required: ["content", "title", "space"],
        },
      },
      {
        name: "update_page",
        description: "Update an existing Confluence page with Markdown content",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Markdown content" },
            pageId: { type: "string", description: "Existing page ID" },
            title: { type: "string", description: "New title (optional)" },
          },
          required: ["content", "pageId"],
        },
      },
      {
        name: "list_spaces",
        description: "List available Confluence spaces. NOTE: Do NOT use this before upload_page. Only use when user explicitly asks to browse/list spaces. For uploads, ask user directly for space key or URL.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max spaces to return", default: 25 },
            type: { type: "string", enum: ["global", "personal", "all"], description: "Space type: global, personal, or all (default)", default: "all" },
          },
        },
      },
      {
        name: "search_pages",
        description: "Search for Confluence pages",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            spaceKey: { type: "string", description: "Limit to specific space" },
            limit: { type: "number", description: "Max results", default: 10 },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const client = new ConfluenceClient(CONFLUENCE_URL, CONFLUENCE_EMAIL, CONFLUENCE_TOKEN);

  try {
    switch (name) {
      case "upload_page": {
        const { content, title, space, parentId } = UploadPageSchema.parse(args);

        // Parse space key and optionally page ID from URL
        const { spaceKey, pageId } = parseConfluenceUrl(space);

        // Convert Markdown to Confluence format
        const { html, attachments } = await convertMarkdownToConfluence(content);

        // If page ID is provided, update existing page instead of creating new one
        if (pageId) {
          try {
            const currentPage = await client.getPage(pageId);
            const newTitle = title || currentPage.title;

            const page = await client.updatePage(pageId, newTitle, html, currentPage.version + 1);

            for (const attachment of attachments) {
              await client.uploadAttachment(pageId, attachment.filename, attachment.data);
            }

            return {
              content: [
                {
                  type: "text",
                  text: `✅ Page updated (auto-detected from URL): ${page.url}\n\nTitle: ${newTitle}\nVersion: ${page.version}\nAttachments: ${attachments.length}`,
                },
              ],
            };
          } catch (error: any) {
            // If page not found (draft or deleted), fall through to create new page
            if (error.message?.includes("404") || error.message?.includes("not found")) {
              console.error(`Page ${pageId} not found (may be draft or deleted), creating new page instead`);
            } else {
              throw error;
            }
          }
        }

        // Create new page
        const page = await client.createPage(spaceKey, title, html, parentId);

        // Upload attachments (Mermaid images)
        for (const attachment of attachments) {
          await client.uploadAttachment(page.id, attachment.filename, attachment.data);
        }

        return {
          content: [
            {
              type: "text",
              text: `✅ Page created: ${page.url}\n\nTitle: ${title}\nSpace: ${spaceKey}\nAttachments: ${attachments.length}`,
            },
          ],
        };
      }

      case "update_page": {
        const { content, pageId, title } = UpdatePageSchema.parse(args);

        // Get current page info
        const currentPage = await client.getPage(pageId);
        const newTitle = title || currentPage.title;

        // Convert Markdown
        const { html, attachments } = await convertMarkdownToConfluence(content);

        // Update page
        const page = await client.updatePage(pageId, newTitle, html, currentPage.version + 1);

        // Upload new attachments
        for (const attachment of attachments) {
          await client.uploadAttachment(pageId, attachment.filename, attachment.data);
        }

        return {
          content: [
            {
              type: "text",
              text: `✅ Page updated: ${page.url}\n\nTitle: ${newTitle}\nVersion: ${page.version}\nAttachments: ${attachments.length}`,
            },
          ],
        };
      }

      case "list_spaces": {
        const { limit, type } = ListSpacesSchema.parse(args);
        const spaces = await client.listSpaces(limit, type);

        const spaceList = spaces
          .map((s: any) => {
            const spaceType = s.type === "personal" ? " (personal)" : "";
            return `- ${s.key}: ${s.name}${spaceType}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${spaces.length} spaces (type: ${type}):\n\n${spaceList}`,
            },
          ],
        };
      }

      case "search_pages": {
        const { query, spaceKey, limit } = SearchPagesSchema.parse(args);
        const pages = await client.searchPages(query, spaceKey, limit);

        const pageList = pages
          .map((p: any) => `- [${p.title}](${p.url}) (${p.spaceKey})`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${pages.length} pages:\n\n${pageList}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `❌ Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Main
async function main() {
  validateConfig();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("md2confluence MCP server running");
}

main().catch(console.error);
