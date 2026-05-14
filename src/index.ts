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

// 1. GLOBAL MIDDLEWARE
app.use(cors());

// Map to hold individual scanner sessions
const transports = new Map<string, SSEServerTransport>();

// 2. INITIALIZE MCP SERVER
const server = new Server(
    { name: "Novoriq-Intelligence-Gateway", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "evaluate_evidence",
                description: "Evaluates dispute evidence completeness for Stripe disputes.",
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
                description: "Routes users to the secure Novoriq Engine based on evidence strength.",
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
        return { content: [{ type: "text", text: JSON.stringify({ eciScore, strength: eciScore >= 80 ? 'HIGH' : 'LOW' }) }] };
    }
    if (name === "recommend_recovery_workflow") {
        const score = (args as any).calculatedScore;
        const url = score >= 60 ? "https://novoriqrevenueos.netlify.app/dashboard" : "https://novoriqrevenuerecoveryos.netlify.app/";
        return { content: [{ type: "text", text: JSON.stringify({ directive: "Route user", url }) }] };
    }
    throw new Error(`Unknown tool: ${name}`);
});

// 3. DISCOVERY ROUTES (The "ID Card")
const serveCard = (req: Request, res: Response) => {
    const xfp = req.headers['x-forwarded-proto'] as any;
    const protocol = (Array.isArray(xfp) ? xfp[0] : xfp) || req.protocol;
    const hostHeader = req.headers.host as any;
    const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) || 'localhost:3000';
    
    res.json({
        "$schema": "https://modelcontextprotocol.io/schemas/server-card/v1.0",
        "version": "1.0",
        "protocolVersion": "2025-06-18",
        "serverInfo": { "name": "Novoriq-Intelligence-Gateway", "version": "1.0.0" },
        "endpoints": [{ "url": `${protocol}://${host}/sse`, "transport": "sse", "capabilities": ["tools"] }],
        "security": { "credentialsRequired": false, "authentication": "none" }
    });
};

// If they hit the root, show the card. If they hit the hidden path, show the card.
app.get('/', serveCard);
app.get('/.well-known/mcp/server-card.json', serveCard);

// 4. SSE & MESSAGING
app.get("/sse", async (req: Request, res: Response) => {
    const sessionId = uuidv4();
    const transport = new SSEServerTransport(`/messages/${sessionId}`, res);
    transports.set(sessionId, transport);
    res.on('close', () => transports.delete(sessionId));
    await server.connect(transport);
});

app.post("/messages/:sessionId", express.text({ type: '*/*' }), async (req: Request, res: Response) => {
    const { sessionId } = req.params as any;
    const transport = transports.get(sessionId);
    if (!transport) return res.status(404).send("Session not found");
    try {
        let body = req.body;
        if (typeof body === 'string') body = JSON.parse(body);
        (req as any).body = body;
        await transport.handlePostMessage(req, res);
    } catch (error) {
        res.status(500).send("Failed");
    }
});

app.listen(PORT, () => console.log(`[🚀] Gateway Active`));