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

  // Si tu veux, force un modèle explicitement dans Railway: OPENAI_MODEL
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

  // Queue si OpenAI pas encore OPEN
  const queue = [];
  const sendOpenAI = (obj) => {
    const s = JSON.stringify(obj);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(s);
    else queue.push(s);
  };

  // Lock réponse
  let responseLocked = false;

  // Audio delta counter (debug)
  let audioDeltaCount = 0;

  // log types (évite spam)
  let typeLogCount = 0;
  function logTypeOnce(msgType) {
    if (typeLogCount < 25) {
      console.log("📩 OpenAI evt:", msgType);
      typeLogCount++;
    }
  }

  openaiWs.on("open", () => {
    console.log("🧠 OpenAI Realtime connected");
    while (queue.length) openaiWs.send(queue.shift());

    // ✅ Session config la plus compatible (pas de session.type / output_modalities)
    sendOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },

        // Beaucoup de comptes acceptent "voice" ici. Si jamais ça errore, enlève juste cette ligne.
        voice: "alloy",

        instructions:
          "Tu es l’agent téléphonique de ABC Déneigement (fr-CA). " +
          "Réponds de façon humaine, polie, concise. " +
          "Heures: lun-ven 08:30-17:00, fermé samedi/dimanche. " +
          "Si RDV hors heures, propose un créneau valide. " +
          "Si info inconnue (ex: nombre de camions), dis-le et propose transfert superviseur.",
      },
    });

    sendOpenAI({ type: "input_audio_buffer.clear" });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg?.type) logTypeOnce(msg.type);

    if (msg.type === "error") {
      console.log("OpenAI error:", msg);
      // si active response, on garde lock jusqu'à done
      if (msg?.error?.code === "conversation_already_has_active_response") {
        responseLocked = true;
      }
      return;
    }

    // Barge-in
    if (msg.type === "input_audio_buffer.speech_started") {
      console.log("🎙️ speech_started");
      if (responseLocked) {
        sendOpenAI({ type: "response.cancel" });
        sendOpenAI({ type: "output_audio_buffer.clear" });
        responseLocked = false;
        console.log("🛑 response.cancel (barge-in)");
      }
      return;
    }

    if (msg.type === "input_audio_buffer.speech_stopped") {
      console.log("🎙️ speech_stopped -> response.create");
      if (!responseLocked) {
        responseLocked = true;
        sendOpenAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            // Beaucoup de comptes acceptent voice ici aussi (plus stable).
            voice: "alloy",
          },
        });
      }
      return;
    }

    // ✅ Attrape TOUS les noms d'events audio possibles
    const audioDelta =
      (msg.type === "response.output_audio.delta" && msg.delta) ? msg.delta :
      (msg.type === "response.audio.delta" && msg.delta) ? msg.delta :
      (msg.type === "response.audio.delta" && msg.audio) ? msg.audio :
      null;

    if (audioDelta && streamSid) {
      audioDeltaCount++;
      if (audioDeltaCount <= 3) {
        console.log("🔊 audio delta -> Twilio (sample)", audioDelta.slice(0, 16), "...");
      }
      // Pour confirmer que ça sort, toutes les 50 deltas:
      if (audioDeltaCount % 50 === 0) {
        console.log(`🔊 audio deltas sent: ${audioDeltaCount}`);
      }

      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: audioDelta },
      }));
      return;
    }

    if (msg.type === "response.done" || msg.type === "response.output_audio.done") {
      responseLocked = false;
      console.log("✅ response.done (unlock)");
      console.log("🔊 total audio deltas this call =", audioDeltaCount);
      sendOpenAI({ type: "input_audio_buffer.clear" });
      return;
    }
  });

  twilioWs.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

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






