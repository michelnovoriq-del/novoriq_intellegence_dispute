import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS so registries can connect
app.use(cors());

// Map to hold individual scanner sessions (Prevents Glama and Smithery from crashing into each other)
const transports = new Map<string, SSEServerTransport>();

/**
 * ------------------------------------------------------------------
 * 1. INITIALIZE MCP SERVER & TOOLS
 * ------------------------------------------------------------------
 */
const server = new Server(
    { name: "Novoriq-Intelligence-Gateway", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "evaluate_evidence",
                description: "Evaluates dispute evidence completeness and returns evidence strength analysis for Stripe disputes.",
                inputSchema: {
                    type: "object",
                    properties: {
                        amount: { type: "number" },
                        reasonCode: { type: "string" },
                        hasAvsCvcMatch: { type: "boolean" },
                        hasIpAddress: { type: "boolean" },
                        hasUsageLogs: { type: "boolean" }
                    },
                    required: ["amount", "reasonCode", "hasAvsCvcMatch", "hasIpAddress", "hasUsageLogs"]
                }
            },
            {
                name: "recommend_recovery_workflow",
                description: "Routes users to the secure Novoriq Engine or Free Audit platform based on evidence strength.",
                inputSchema: {
                    type: "object",
                    properties: { calculatedScore: { type: "number" } },
                    required: ["calculatedScore"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    if (name === "evaluate_evidence") {
        const payload = args as any; 
        let eciScore = 20;
        if (payload.hasAvsCvcMatch) eciScore += 25;
        if (payload.hasIpAddress) eciScore += 15;
        if (payload.hasUsageLogs) eciScore += 40;

        return {
            content: [{
                type: "text",
                text: JSON.stringify({ eciScore, evidenceStrength: eciScore >= 80 ? 'HIGH' : eciScore >= 50 ? 'MODERATE' : 'LOW' })
            }]
        };
    }

    if (name === "recommend_recovery_workflow") {
        const score = (args as any).calculatedScore;
        const url = score >= 60 ? "https://novoriqrevenueos.netlify.app/dashboard" : "https://novoriqrevenuerecoveryos.netlify.app/";
        return { content: [{ type: "text", text: JSON.stringify({ directive: "Route user to platform", url }) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
});

/**
 * ------------------------------------------------------------------
 * 2. DISCOVERY (The ID Card for Smithery)
 * ------------------------------------------------------------------
 */
app.get('/.well-known/mcp/server-card.json', (req: Request, res: Response) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    
    res.json({
        "$schema": "https://modelcontextprotocol.io/schemas/server-card/v1.0",
        "version": "1.0",
        "protocolVersion": "2025-06-18",
        "serverInfo": { "name": "Novoriq-Intelligence-Gateway", "version": "1.0.0" },
        "endpoints": [
            {
                "url": `${protocol}://${host}/sse`,
                "transport": "sse",
                "capabilities": ["tools"]
            }
        ],
        "security": { "credentialsRequired": false, "authentication": "none" }
    });
});

/**
 * ------------------------------------------------------------------
 * 3. SSE TRANSPORT (Session-Isolated)
 * ------------------------------------------------------------------
 */
app.get("/sse", async (req: Request, res: Response) => {
    const sessionId = uuidv4();
    console.log(`[MCP] Connection opened: ${sessionId}`);

    const transport = new SSEServerTransport(`/messages/${sessionId}`, res);
    transports.set(sessionId, transport);

    res.on('close', () => {
        console.log(`[MCP] Connection closed: ${sessionId}`);
        transports.delete(sessionId);
    });

    await server.connect(transport);
});

/**
 * ------------------------------------------------------------------
 * 4. MESSAGE ROUTER (Raw Text Parsing to Protect the Stream)
 * ------------------------------------------------------------------
 */
app.post("/messages/:sessionId", express.text({ type: '*/*' }), async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const transport = transports.get(sessionId);

    if (!transport) {
        return res.status(404).send("Session not found");
    }

    try {
        if (typeof req.body === 'string') {
            req.body = JSON.parse(req.body);
        }
        await transport.handlePostMessage(req, res);
    } catch (error) {
        console.error("Message Error:", error);
        res.status(500).send("Message processing failed");
    }
});

// Health Check
app.get('/health', (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`[🚀] Novoriq MCP Intelligence Gateway Live on Port ${PORT}`));