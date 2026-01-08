// index.js
import express from "express";
import http from "http";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 8080;

function getWsUrl(req) {
  const base =
    (process.env.PUBLIC_BASE_URL || "").trim() ||
    `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  return base.replace(/^http/i, "ws") + "/ws";
}

app.get("/ping", (_req, res) => res.status(200).send("pong"));

app.post("/voice", (req, res) => {
  const wsUrl = getWsUrl(req);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.</Say>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track" />
  </Connect>
</Response>`;

  console.log("📞 /voice hit");
  console.log("WEBSOCKET_URL=", wsUrl);
  console.log("TwiML sent:\n", twiml);

  res.type("text/xml").send(twiml);
});

server.listen(PORT, () => console.log("🚀 Server listening on", PORT));

server.on("upgrade", (req, socket, head) => {
  console.log("⬆️ UPGRADE hit url=", req.url);
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
  if (!OPENAI_API_KEY) {
    console.log("❌ Missing OPENAI_API_KEY");
    try {
      twilioWs.close();
    } catch {}
    return;
  }

  const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-realtime").trim();

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let streamSid = null;

  // Queue tant que OpenAI pas ouvert
  const queue = [];
  const sendOpenAI = (obj) => {
    const s = JSON.stringify(obj);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(s);
    else queue.push(s);
  };

  // LOCK: 1 réponse à la fois
  let responseLocked = false;

  // Debug audio
  let audioDeltaCount = 0;

  openaiWs.on("open", () => {
    console.log("🧠 OpenAI Realtime connected");
    while (queue.length) openaiWs.send(queue.shift());

    // Session config stable
    sendOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        voice: "alloy",
        instructions:
          "Tu es l’agent téléphonique de ABC Déneigement (fr-CA). " +
          "Réponds de façon humaine, pro, concise. " +
          "Heures: lun-ven 08:30-17:00, fermé samedi/dimanche. " +
          "RDV: jamais avant 08:30. " +
          "Si info inconnue (ex: nombre de camions), dis-le et propose transfert superviseur.",
      },
    });

    sendOpenAI({ type: "input_audio_buffer.clear" });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Debug: log les events response.*
    if (msg.type && msg.type.startsWith("response.")) {
      console.log("📩", msg.type);
    }

    // Erreurs
    if (msg.type === "error") {
      console.log("OpenAI error:", msg);
      if (msg?.error?.code === "conversation_already_has_active_response") {
        // On reste lock jusqu'à response.done
        responseLocked = true;
      }
      return;
    }

    // Texte streaming (debug)
    if (msg.type === "response.text.delta" && msg.delta) {
      console.log("📝 text delta:", msg.delta);
    }
    if (msg.type === "response.text.done" && msg.text) {
      console.log("📝 text done:", msg.text);
    }

    // ✅ Event clé: committed -> cancel + response.create
    if (msg.type === "input_audio_buffer.committed") {
      console.log("✅ committed (VAD) -> cancel + response.create");

      if (responseLocked) {
        console.log("⚠️ already locked, skip");
        return;
      }
      responseLocked = true;

      // IMPORTANT: ta config n'autorise PAS output_audio_buffer.clear
      sendOpenAI({ type: "response.cancel" });

      setTimeout(() => {
        sendOpenAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            voice: "alloy",
            instructions:
              "Réponds naturellement en français canadien. Commence par: « Bonjour! Comment puis-je vous aider? »",
          },
        });
        console.log("🗣️ response.create sent");
      }, 120);

      return;
    }

    // Audio delta (OpenAI -> Twilio)
    const delta =
      msg.type === "response.audio.delta" && msg.delta
        ? msg.delta
        : msg.type === "response.output_audio.delta" && msg.delta
        ? msg.delta
        : null;

    if (delta && streamSid) {
      audioDeltaCount++;
      if (audioDeltaCount === 1) console.log("🔊 first audio delta received");

      // Envoi à Twilio Media Stream
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: delta },
        })
      );
      return;
    }

    // Fin de réponse -> unlock
    if (msg.type === "response.done" || msg.type === "response.output_audio.done") {
      console.log("✅ response.done (unlock) | audio deltas=", audioDeltaCount);
      responseLocked = false;
      audioDeltaCount = 0;
      sendOpenAI({ type: "input_audio_buffer.clear" });
      return;
    }
  });

  // Twilio -> OpenAI (audio entrant)
  twilioWs.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "connected") return;

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      console.log("▶️ Twilio stream start sid=", streamSid);
      return;
    }

    if (data.event === "media" && data.media?.payload) {
      sendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
      return;
    }

    if (data.event === "stop") {
      console.log("⏹️ Twilio stream stop");
      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WS disconnected");
    try {
      openaiWs.close();
    } catch {}
  });

  openaiWs.on("close", () => console.log("🧠 OpenAI Realtime disconnected"));
});
