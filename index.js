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
  console.log("📞 /voice hit");
  console.log("WEBSOCKET_URL=", wsUrl);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

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
    try { twilioWs.close(); } catch {}
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

  // Queue messages tant que OpenAI pas open
  const queue = [];
  const sendOpenAI = (obj) => {
    const s = JSON.stringify(obj);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(s);
    else queue.push(s);
  };

  // --- Silence timer (déclenche réponse après 800ms sans audio entrant) ---
  let silenceTimer = null;
  const SILENCE_MS = 800;

  // --- Lock réponse (évite active_response) ---
  let responseLocked = false;

  function scheduleResponseCreate() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (responseLocked) return;
      responseLocked = true;
      console.log("🗣️ Silence -> response.create");
      sendOpenAI({
        type: "response.create",
        response: { modalities: ["audio", "text"] },
      });
    }, SILENCE_MS);
  }

  openaiWs.on("open", () => {
    console.log("🧠 OpenAI Realtime connected");
    while (queue.length) openaiWs.send(queue.shift());

    // ✅ IMPORTANT: turn_detection NONE => on contrôle nous-mêmes le tour
    sendOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "none" },
        instructions:
          "Tu es l’agent téléphonique de ABC Déneigement. FR-CA naturel et pro. " +
          "Heures: lun-ven 08:30-17:00, fermé samedi/dimanche. " +
          "Si RDV hors heures, propose un créneau valide. " +
          "Si info inconnue, propose transfert superviseur.",
      },
    });

    // Optionnel: vider buffer au début
    sendOpenAI({ type: "input_audio_buffer.clear" });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "error") {
      console.log("OpenAI error:", msg);
      // Si jamais encore active_response: on garde locked, et on attend done
      if (msg?.error?.code === "conversation_already_has_active_response") {
        responseLocked = true;
      }
      return;
    }

    // 🔊 Audio OpenAI -> Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      }));
      return;
    }

    // Unlock quand fini
    if (msg.type === "response.done" || msg.type === "response.output_audio.done") {
      responseLocked = false;
      console.log("✅ response.done (unlock)");
      // Clear l’input buffer pour repartir clean
      sendOpenAI({ type: "input_audio_buffer.clear" });
      return;
    }
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      console.log("▶️ Twilio stream start sid=", streamSid);
      return;
    }

    if (data.event === "media" && data.media?.payload) {
      // Si l’AI est en train de répondre et l’humain parle, on coupe la réponse
      if (responseLocked) {
        console.log("🎙️ user barged-in -> response.cancel");
        sendOpenAI({ type: "response.cancel" });
        responseLocked = false;
        // clear output côté AI (évite overlap)
        sendOpenAI({ type: "output_audio_buffer.clear" });
      }

      // append audio
      sendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });

      // chaque chunk reçu repousse le timer => on répond après silence
      scheduleResponseCreate();
      return;
    }

    if (data.event === "stop") {
      console.log("⏹️ Twilio stream stop");
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WS disconnected");
    try { openaiWs.close(); } catch {}
  });

  openaiWs.on("close", () => console.log("🧠 OpenAI Realtime disconnected"));
});




