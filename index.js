import express from "express";
import bodyParser from "body-parser";
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

// --- HTTP route: health ---
app.get("/ping", (req, res) => {
  process.stdout.write("🏓 /ping hit\n");
  res.status(200).send("pong");
});

// --- Twilio voice webhook ---
app.post("/voice", (req, res) => {
  process.stdout.write("📞 /voice hit\n");

  const wsUrl = (process.env.WEBSOCKET_URL || "").trim();
  process.stdout.write(`WEBSOCKET_URL=${wsUrl}\n`);

  // ✅ FIX 1: use <Connect><Stream> so Twilio can play audio we send back on the WS
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  process.stdout.write("TwiML sent:\n" + twiml + "\n");
  res.type("text/xml").send(twiml);
});

// --- Create single HTTP server (Railway) ---
const server = http.createServer(app);

// --- WebSocket server attached to same port ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  process.stdout.write(`⬆️ UPGRADE hit url=${req.url}\n`);

  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    process.stdout.write("❌ UPGRADE rejected (not /ws)\n");
    socket.destroy();
  }
});

// --- Twilio Media Stream WS -> OpenAI Realtime bridge ---
wss.on("connection", (twilioWs) => {
  process.stdout.write("✅ Twilio WS connected\n");

  let streamSid = null;
  let openaiReady = false;

  const openaiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!openaiKey) {
    process.stdout.write("❌ Missing OPENAI_API_KEY\n");
    twilioWs.close();
    return;
  }

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    process.stdout.write("🧠 OpenAI Realtime connected\n");

    // Configure session (Twilio = g711_ulaw 8k)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `
Tu es l'agent téléphonique de ABC Déneigement.

Règles :
- Heures: Lun-Ven 08:30-17:00. Fermé samedi/dimanche.
- RDV: si quelqu’un demande avant 08:30 ou après 17:00, propose le prochain créneau dispo.
- Si une info est inconnue (ex: nombre de camions), dis que tu n'as pas l'information et propose de transférer à un superviseur.
- Style: humain, poli, efficace, FR-CA.
`,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          // ✅ OpenAI does VAD server-side; when it commits, we'll trigger response.create
          turn_detection: { type: "server_vad" },
        },
      })
    );

    openaiReady = true;
  });

  openaiWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.type === "error") {
      console.log("OpenAI error:", evt);
      return;
    }

    // ✅ FIX 2: when OpenAI commits the user's audio (server_vad), ask it to respond
    if (evt.type === "input_audio_buffer.committed") {
      process.stdout.write("🗣️ OpenAI committed user audio -> response.create\n");
      openaiWs.send(JSON.stringify({ type: "response.create" }));
      return;
    }

    // OpenAI audio -> Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        })
      );
      return;
    }
  });

  openaiWs.on("close", () => {
    process.stdout.write("🧠 OpenAI Realtime disconnected\n");
  });

  openaiWs.on("error", (err) => {
    console.log("OpenAI WS error:", err);
  });

  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      process.stdout.write(`▶️ Twilio stream start sid=${streamSid}\n`);
      return;
    }

    if (data.event === "media") {
      // Forward audio to OpenAI
      if (openaiWs.readyState === WebSocket.OPEN && openaiReady) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media?.payload,
          })
        );
      }
      return;
    }

    if (data.event === "stop") {
      process.stdout.write("⏹️ Twilio stream stop\n");
      // With <Connect><Stream>, stop generally happens at hangup; we close OpenAI then.
      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    process.stdout.write("❌ Twilio WS disconnected\n");
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    console.log("Twilio WS error:", err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));


