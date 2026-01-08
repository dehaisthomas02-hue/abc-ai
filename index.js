
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

import WebSocket from "ws";
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

  const wsUrl = (process.env.WEBSOCKET_URL || "").trim();


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

  process.stdout.write("TwiML sent:\n" + twiml + "\n");
  res.type("text/xml").send(twiml);
});

// --- 2) HTTP server (unique port Railway) ---
const server = http.createServer(app);

// --- 3) WebSocket server attaché au même serveur ---
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


// --- 4) Réception Twilio Media Streams ---
wss.on("connection", (twilioWs) => {
  process.stdout.write("✅ Twilio WS connected\n");

  let streamSid = null;

  // 🔌 Connexion OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    process.stdout.write("🧠 OpenAI Realtime connected\n");

    // 🎛️ Configuration de la session AI
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `
Tu es l'agent téléphonique de ABC Déneigement.

Règles importantes :
- Heures d'ouverture : lundi à vendredi, 08:30 à 17:00
- Fermé samedi et dimanche
- Si quelqu’un demande un rendez-vous avant 08:30 ou après 17:00, propose le prochain créneau disponible
- Si une information n’est pas disponible (ex: nombre de camions), dis-le honnêtement et propose de transférer à un superviseur
- Ton ton est humain, naturel, professionnel, en français canadien
`,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          turn_detection: { type: "server_vad" },
        },
      })
    );

    // Lancer la première réponse (AI prête à parler)
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  });

  // 🗣️ Audio OpenAI → Twilio
  openaiWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        })
      );
    }
  });

  // 🎧 Audio Twilio → OpenAI
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      process.stdout.write("▶️ Twilio stream start\n");
      return;
    }

    if (data.event === "media") {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        })
      );
      return;
    }

    if (data.event === "stop") {
      process.stdout.write("⏹️ Twilio stream stop\n");
      openaiWs.close();
    }
  });

  twilioWs.on("close", () => {
    process.stdout.write("❌ Twilio WS disconnected\n");
    try {
      openaiWs.close();
    } catch {}
  });
});


