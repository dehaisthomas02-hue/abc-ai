import express from "express";
import http from "http";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 8080;

function xmlEscape(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ---------- HTTP ----------
app.get("/ping", (_req, res) => res.status(200).send("pong"));

app.post("/voice", (req, res) => {
  const wsUrl = (process.env.WEBSOCKET_URL || "").trim();

  if (!wsUrl) {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Erreur: WEBSOCKET_URL manquant.</Say></Response>`);
    return;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">
    ${xmlEscape("Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.")}
  </Say>
  <Connect>
    <Stream url="${xmlEscape(wsUrl)}" />
  </Connect>
</Response>`;

  console.log("📞 /voice hit");
  console.log("WEBSOCKET_URL=", wsUrl);
  console.log("TwiML sent:\n", twiml);

  res.type("text/xml").send(twiml);
});

// ---------- WS upgrade ----------
server.on("upgrade", (req, socket, head) => {
  console.log("⬆️ UPGRADE hit url=", req.url);
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ---------- Twilio WS <-> OpenAI Realtime ----------
wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  let streamSid = null;
  let openaiWs = null;

  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    console.log("❌ Missing OPENAI_API_KEY");
    try { twilioWs.close(); } catch {}
    return;
  }

  const model = (process.env.OPENAI_REALTIME_MODEL || "gpt-realtime").trim();

  const twilioSend = (obj) => {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify(obj));
    }
  };

  const openaiSend = (obj) => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  };

  let locked = false;
  let audioDeltaCount = 0;

  function connectOpenAI() {
    openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );

    openaiWs.on("open", () => {
      console.log("🧠 OpenAI Realtime connected");

      openaiSend({
        type: "session.update",
        session: {
          // garde simple et compatible
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          voice: "alloy",
          instructions:
            "Tu es l'agent service client d'ABC Déneigement (Montréal). " +
            "Réponds naturellement en français québécois. " +
            "Heures: Lun-Ven 8h30-17h00. Fermé Sam-Dim. " +
            "Si RDV hors heures: propose un créneau en semaine. " +
            "Si info inconnue: propose transfert superviseur.",
        },
      });

      openaiSend({ type: "input_audio_buffer.clear" });
    });

    openaiWs.on("message", (raw) => {
      let evt;
      try { evt = JSON.parse(raw.toString()); } catch { return; }

      if (evt.type === "error") {
        console.log("OpenAI error:", evt);
        return;
      }

      // Quand VAD commit -> create response (une fois)
      if (evt.type === "input_audio_buffer.committed") {
        console.log("✅ committed");
        if (!locked) {
          locked = true;
          audioDeltaCount = 0;
          openaiSend({ type: "response.create", response: { modalities: ["audio", "text"], voice: "alloy" } });
          console.log("🗣️ response.create sent");
        }
      }

      // Audio delta -> Twilio
      if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta && streamSid) {
        audioDeltaCount++;
        if (audioDeltaCount === 1) console.log("🔊 first audio delta received");

        twilioSend({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        });
      }

      // Fin réponse -> unlock
      if (evt.type === "response.done") {
        console.log("✅ response.done | audio deltas=", audioDeltaCount);
        locked = false;
        openaiSend({ type: "input_audio_buffer.clear" });
      }
    });

    openaiWs.on("close", () => console.log("🧠 OpenAI Realtime disconnected"));
    openaiWs.on("error", (e) => console.log("🧠 OpenAI WS error:", e?.message || e));
  }

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid;
      console.log("▶️ Twilio stream start sid=", streamSid);
      connectOpenAI();
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      openaiSend({ type: "input_audio_buffer.append", audio: msg.media.payload });
      return;
    }

    if (msg.event === "stop") {
      console.log("⏹️ Twilio stream stop");
      try { openaiWs?.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WS disconnected");
    try { openaiWs?.close(); } catch {}
  });
});

// ✅ UN SEUL listen ici
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
