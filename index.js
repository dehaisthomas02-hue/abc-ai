import express from "express";
import bodyParser from "body-parser";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- 1) Webhook Twilio: quand un appel arrive ---
app.post("/voice", (req, res) => {
  process.stdout.write("📞 /voice hit\n");
process.stdout.write(`WEBSOCKET_URL=${process.env.WEBSOCKET_URL}\n`);

  const wsUrl = process.env.WEBSOCKET_URL;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Say voice="Polly.Chantal" language="fr-CA">
    Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.
  </Say>
  <Pause length="600"/>
</Response>`;

  res.type("text/xml").send(twiml);
});


// --- 2) HTTP server (unique port Railway) ---
const server = http.createServer(app);

// --- 3) WebSocket server attaché au même serveur ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // On accepte seulement /ws
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// --- 4) Réception Twilio Media Streams ---
wss.on("connection", (ws) => {
  console.log("✅ Twilio WS connected");

  ws.on("message", (msg) => {
    // Twilio envoie JSON: start / media / stop
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        console.log("▶️ stream start", data.start?.streamSid);
      }

      if (data.event === "media") {
        // IMPORTANT: data.media.payload = base64 audio mulaw 8khz
        // Ici on branchera STT + AI + TTS (prochaine étape)
        // Pour l’instant on log juste la réception
        // console.log("🎧 media chunk", data.media?.payload?.length);
      }

      if (data.event === "stop") {
        console.log("⏹️ stream stop");
      }
    } catch (e) {
      console.log("WS message non-JSON:", msg.toString());
    }
  });

  ws.on("close", () => console.log("❌ Twilio WS disconnected"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));

app.get("/ping", (req, res) => {
  process.stdout.write("🏓 /ping hit\n");
  res.status(200).send("pong");
});

