import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import express, { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import http from "http";
import WebSocket, {WebSocketServer} from "ws"

// Create mcpServer instance
const mcpServer = new McpServer({
  name: "winccoa",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});


let webSocketConnected: boolean = false;
let activeConnection: WebSocket;
let pendingResponses: Map<string, (response: string) => void> = new Map();

function generateUniqueId(): string {
        return Math.random().toString(36).substr(2, 9);
    }

async function sendMessageAndWaitResponse(message: string): Promise<string> {
     if (webSocketConnected && activeConnection) {
            const messageId = generateUniqueId();
            const messageObject = { id: messageId, message };

            activeConnection.send(JSON.stringify(messageObject));

            return new Promise((resolve, reject) => {
                pendingResponses.set(messageId, resolve);
            });
        } else {
            throw new Error("WebSocket not connected");
        }
}

async function mainStdio() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("WinCC OA MCP mcpServer running on stdio");
}

async function mainSse()
{
	const app = express();
	// Attach WebSocket server to the HTTP server
	const wss = new WebSocketServer({ noServer:true });
	
	const PORT = process.env.PORT || 3001;

	const server = app.listen(PORT, () => {
	  console.log(`✅ Server is running at http://localhost:${PORT}`);
	});
	
	server.on('upgrade', (request, socket, head) => {
	console.log(request.headers.host);
	console.log(request.url);
	  const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;
	console.log(pathname);
	  if (pathname === '/ws') {
	    wss.handleUpgrade(request, socket, head, (ws) => {
	      wss.emit('connection', ws, request);
	    });
	  } else {
	    socket.destroy();
	  }
	});

	// to support multiple simultaneous connections we have a lookup object from
	// sessionId to transport
	const transports: { [sessionId: string]: SSEServerTransport } = {};

	app.get("/sse", async (req: Request, res: Response) => {
	  // Get the full URI from the request
	  const host = req.get("host");

	  const fullUri = `https://${host}/jokes`;
	  const transport = new SSEServerTransport(fullUri, res);

	  transports[transport.sessionId] = transport;
	  res.on("close", () => {
		delete transports[transport.sessionId];
	  });
	  await mcpServer.connect(transport);
	});

	app.post("/jokes", async (req: Request, res: Response) => {
	  const sessionId = req.query.sessionId as string;
	  const transport = transports[sessionId];
	  if (transport) {
		await transport.handlePostMessage(req, res);
	  } else {
		res.status(400).send("No transport found for sessionId");
	  }
	});

	app.get("/", (_req, res) => {
	  res.send("The WinCC OA MCP server is running!");
	});
	
	
	

	// Événement déclenché lorsque le serveur WebSocket reçoit une connexion
	wss.on('connection', (ws: WebSocket) => {
		//console.log('Client connecté');
		activeConnection = ws;
		webSocketConnected = true;
		
		// Événement déclenché lorsque le serveur reçoit un message du client
		ws.on('message', (data: WebSocket.Data) => {
			// Traitez les messages reçus du client ici
			const message = JSON.parse(data.toString());
	            const callback = pendingResponses.get(message.id);
	            if (callback) {
	                callback(message.response);
	                pendingResponses.delete(message.id);
	            }
		});

		// Événement déclenché lorsque la connexion est fermée
		ws.on('close', () => {
			//console.log('Client déconnecté');
			webSocketConnected = false;
		});

		// Événement déclenché en cas d'erreur
		ws.on('error', (error) => {
			//console.error('Erreur WebSocket :', error);
		});
	});

	
}


const WINCCOA_API_BASE = "http://localhost:3000";
const USER_AGENT = "winccoa-app/1.0";

// Helper function for making NWS API requests
async function makeWinCCOARequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };

  try {
	const response = await sendMessageAndWaitResponse(JSON.stringify({ type: "GET", url: url }));
    //const response = await fetch(url, { headers });
	/*
    if (!response.status) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }*/
	return response as T;
    //return (await JSON.parse(response)) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

interface DpResponse {
  datapoint?: string,
  value?: string
}

mcpServer.tool(
  "get-datapoint",
  "Get value for a datapoint",
  {
    datapointName: z.string().describe("Name of the datapoint"),
  },
  async ({ datapointName }) => {
    // Get grid point data

    const url = `${WINCCOA_API_BASE}/datapoint/${datapointName}`;
    const data = await makeWinCCOARequest<DpResponse>(url);

    if (!data) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve data point data for name: ${datapointName}. This datapoint may not be exists.`,
          },
        ],
      };
    }

    // Format value
    const formattedText = 
	  [`Name of the datapoint : ${data.datapoint}:`,
        `Value: ${data.value}`,
      ].join("\n");

        return {
      content: [
        {
          type: "text",
          text: formattedText,
        },
      ],
    };
  },
);


interface DpNameResponse {
  name?: string,
  description?: string
}

interface DpNamesResponse {
  datapoints: string[],
}

mcpServer.tool(
  "get-datapoints",
  "Get names of datapoints",
  {
  },
  async ({ }) => {
    // Get grid point data
    const url = `${WINCCOA_API_BASE}/datapoints`;
    const data = await makeWinCCOARequest<DpNamesResponse>(url);

    if (!data) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve data point names`,
          },
        ],
      };
    }

    // Format value
    const formattedText = data.datapoints.map(obj =>
		[
        `Datapoint name : ${obj}`,
        //`Description : ${obj.description}`,
        "---",
		].join("\n"));

        return {
      content: [
        {
          type: "text",
          text: formattedText.join("\n"),
        },
      ],
    };
  },
);


mainSse().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});