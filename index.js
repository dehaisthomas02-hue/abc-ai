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

// ✅ Mets ça dans Railway en variable (sans slash à la fin):
// PUBLIC_BASE_URL = https://abc-ai-production.up.railway.app
function getWebsocketUrl(req) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  // Convertit https->wss
  return base.replace(/^http/i, "ws") + "/ws";
}

// --- 1) Twilio webhook: renvoie du TwiML qui connecte le stream bidirectionnel ---
app.post("/voice", (req, res) => {
  const wsUrl = getWebsocketUrl(req);

  process.stdout.write(`📞 /voice hit\nWEBSOCKET_URL=${wsUrl}\n`);

  // IMPORTANT: <Connect><Stream> permet le bidirectionnel (on renvoie l'audio à l'appelant)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  process.stdout.write(`TwiML sent:\n${twiml}\n`);
  res.type("text/xml").send(twiml);
});

// ping simple
app.get("/ping", (_req, res) => res.status(200).send("pong"));

server.listen(PORT, () => {
  process.stdout.write(`🚀 Server listening on ${PORT}\n`);
});

// --- 2) Upgrade HTTP -> WebSocket pour /ws ---
server.on("upgrade", (req, socket, head) => {
  process.stdout.write(`⬆️ UPGRADE hit url=${req.url}\n`);
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    process.stdout.write("❌ UPGRADE rejected (not /ws)\n");
    socket.destroy();
  }
});

// --- 3) Bridge Twilio <-> OpenAI Realtime ---
wss.on("connection", (twilioWs) => {
  process.stdout.write("✅ Twilio WS connected\n");

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    process.stdout.write("❌ Missing OPENAI_API_KEY\n");
    try { twilioWs.close(); } catch {}
    return;
  }

  // ⚠️ Reco: gpt-realtime (plus “prod-ready” que les vieux preview)
  // (Tu peux aussi laisser gpt-4o-realtime-preview, mais il est annoncé déprécié en 2026-03-24)
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";

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
  const toOpenAIQueue = [];
  const sendToOpenAI = (obj) => {
    const msg = JSON.stringify(obj);
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(msg);
    } else {
      toOpenAIQueue.push(msg);
    }
  };

  // Lock pour éviter "conversation_already_has_active_response"
  let responseLocked = false;

  openaiWs.on("open", () => {
    process.stdout.write("🧠 OpenAI Realtime connected\n");

    // flush queue
    while (toOpenAIQueue.length) openaiWs.send(toOpenAIQueue.shift());

    // ✅ session.update (champs valides)
    // modalities doit être ["audio","text"] (pas ["audio"] tout seul)
    // Et on set input/output en g711_ulaw pour matcher Twilio.
    sendToOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        modalities: ["audio", "text"],
        instructions:
          "Tu es un agent de service à la clientèle pour ABC Déneigement (Montréal). " +
          "Tu parles en français (Québec) de façon naturelle, pro, concise. " +
          "Heures: lun-ven 08:30-17:00. Fermé samedi/dimanche. " +
          "Si on demande un rendez-vous avant 08:30 ou pendant la fin de semaine, refuse et propose un créneau valide. " +
          "Si tu n'as pas une info (ex: nombre de camions), dis-le et propose de transférer à un superviseur. " +
          "Objectif: comprendre la demande, poser 1-2 questions, proposer une solution.",
        // audio formats pour Twilio Media Streams
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // Si ta version de modèle supporte voice ici, tu peux essayer une voix plus naturelle.
        // Si ça cause une erreur, enlève la ligne "voice".
        // voice: "verse",
        turn_detection: { type: "server_vad" },
      },
    });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Debug minimal
    if (msg.type === "error") {
      console.log("OpenAI error:", msg);
      return;
    }

    // Barge-in: si l'utilisateur recommence à parler, on coupe la réponse en cours
    if (msg.type === "input_audio_buffer.speech_started") {
      process.stdout.write("🎙️ speech_started (cancel AI if speaking)\n");
      if (responseLocked) {
        sendToOpenAI({ type: "response.cancel" });
        responseLocked = false;
      }
    }

    // OpenAI a détecté une fin de tour et a "committed" l'audio
    if (msg.type === "input_audio_buffer.committed") {
      process.stdout.write("✅ input_audio_buffer.committed (server_vad)\n");
      if (!responseLocked) {
        responseLocked = true;
        process.stdout.write("🗣️ Commit -> response.create\n");
        sendToOpenAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
          },
        });
      } else {
        process.stdout.write("⚠️ active response in progress -> keep lock\n");
      }
    }

    // 🔊 Audio AI -> Twilio (c’est ÇA qui te manquait pour entendre l’AI)
    if (msg.type === "response.output_audio.delta") {
      if (!streamSid) return;
      const payloadB64 = msg.delta; // base64 g711_ulaw
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: payloadB64 },
        })
      );
    }

    if (msg.type === "response.output_audio.done" || msg.type === "response.done") {
      responseLocked = false;
      process.stdout.write("✅ response.done (unlock)\n");
    }
  });

  openaiWs.on("close", () => {
    process.stdout.write("🧠 OpenAI Realtime disconnected\n");
    try { twilioWs.close(); } catch {}
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      process.stdout.write(`▶️ Twilio stream start sid=${streamSid}\n`);
      return;
    }

    if (data.event === "media") {
      // Twilio envoie déjà du base64 g711_ulaw
      const audioB64 = data.media?.payload;
      if (!audioB64) return;

      sendToOpenAI({
        type: "input_audio_buffer.append",
        audio: audioB64,
      });
      return;
    }

    if (data.event === "stop") {
      process.stdout.write("⏹️ Twilio stream stop\n");
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    process.stdout.write("❌ Twilio WS disconnected\n");
    try { openaiWs.close(); } catch {}
  });
});


