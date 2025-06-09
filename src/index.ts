import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import express, { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import WebSocket, {WebSocketServer} from "ws"

// Create mcpServer instance
const mcpServer = new McpServer({
  name: "winccoa-mcp-streamable-http",
  version: "1.0.0"
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
	app.use(express.json());
	
	const transport: StreamableHTTPServerTransport =
	  new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined, // set to undefined for stateless servers
	  });

	// Setup routes for the mcp server
	const setupServer = async () => {
	  await mcpServer.connect(transport);
	};

	app.post("/mcp", async (req: Request, res: Response) => {
	  console.log("Received MCP request:", req.body);
	  try {
		await transport.handleRequest(req, res, req.body);
	  } catch (error) {
		console.error("Error handling MCP request:", error);
		if (!res.headersSent) {
		  res.status(500).json({
			jsonrpc: "2.0",
			error: {
			  code: -32603,
			  message: "Internal server error",
			},
			id: null,
		  });
		}
	  }
	});

	app.get("/mcp", async (req: Request, res: Response) => {
	  console.log("Received GET MCP request");
	  res.writeHead(405).end(
		JSON.stringify({
		  jsonrpc: "2.0",
		  error: {
			code: -32000,
			message: "Method not allowed.",
		  },
		  id: null,
		})
	  );
	});

	app.delete("/mcp", async (req: Request, res: Response) => {
	  console.log("Received DELETE MCP request");
	  res.writeHead(405).end(
		JSON.stringify({
		  jsonrpc: "2.0",
		  error: {
			code: -32000,
			message: "Method not allowed.",
		  },
		  id: null,
		})
	  );
	});
	
	// Create HTTP server with websocket support
	const serverHttp = http.createServer(app);
	serverHttp.on("upgrade", (request, socket, head) => {
	  if (request.url === "/ws") {
	    wss.handleUpgrade(request, socket, head, (ws) => {
	      wss.emit("connection", ws, request);
	    });
	  } else {
	    socket.destroy();
	  }
	});

	// WebSocket server setup
	const wss = new WebSocketServer({ server: serverHttp });

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

	// Start the server
	const PORT = process.env.PORT || 3001;
	setupServer()
	  .then(() => {
		serverHttp.listen(PORT, () => {
		  console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
		});
	  })
	  .catch((error) => {
		console.error("Failed to set up the server:", error);
		process.exit(1);
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