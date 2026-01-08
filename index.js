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

// ============ TWILIO WEBHOOK: /voice ============
app.post("/voice", (req, res) => {
  const raw = (process.env.WEBSOCKET_URL || "").trim();
  if (!raw) {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Erreur: WEBSOCKET_URL manquant.</Say>
</Response>`);
    return;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">
    ${xmlEscape("Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.")}
  </Say>
  <Connect>
    <Stream url="${xmlEscape(raw)}" />
  </Connect>
</Response>`;

  process.stdout.write("📞 /voice hit\n");
  process.stdout.write(`WEBSOCKET_URL=${raw}\n`);
  process.stdout.write("TwiML sent:\n" + twiml + "\n");

  res.type("text/xml").send(twiml);
});

// ============ HEALTHCHECK ============
app.get("/ping", (req, res) => res.status(200).send("pong"));

// ============ UPGRADE -> /ws ============
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ============ MAIN WS HANDLER (Twilio <-> OpenAI Realtime) ============
wss.on("connection", (twilioWs) => {
  process.stdout.write("✅ Twilio WS connected\n");

  let streamSid = null;
  let openaiWs = null;

  let locked = false;        // empêche response.create en boucle
  let playing = false;       // AI est en train de parler (audio en cours)
  let totalAudioDeltas = 0;  // debug

  function twilioSend(obj) {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify(obj));
    }
  }

  function twilioClear() {
    if (!streamSid) return;
    twilioSend({ event: "clear", streamSid }); // coupe le buffer Twilio :contentReference[oaicite:2]{index=2}
  }

  function openaiSend(obj) {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  }

  function openaiCancel() {
    // stoppe une réponse en cours côté OpenAI
    openaiSend({ type: "response.cancel" });
  }

  function connectOpenAI() {
    const key = (process.env.OPENAI_API_KEY || "").trim();
    if (!key) {
      process.stdout.write("❌ Missing OPENAI_API_KEY\n");
      return;
    }

    // IMPORTANT: modèle realtime GA (audio + text)
    // Si tu veux plus cheap: gpt-4o-mini-realtime-preview
    // (les 2 existent dans la doc modèles) :contentReference[oaicite:3]{index=3}
    const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

    openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    openaiWs.on("open", () => {
      process.stdout.write("🧠 OpenAI Realtime connected\n");

      // Session config (GA): output_modalities + formats + VAD + voice :contentReference[oaicite:4]{index=4}
      openaiSend({
        type: "session.update",
        session: {
          type: "realtime",
          model,
          output_modalities: ["audio", "text"],
          audio: {
            input: {
              format: { type: "audio/pcmu" }, // Twilio = mulaw/8000 :contentReference[oaicite:5]{index=5}
              turn_detection: { type: "semantic_vad" },
            },
            output: {
              format: { type: "audio/pcmu" }, // renvoyer direct à Twilio :contentReference[oaicite:6]{index=6}
              voice: "marin", // top qualité (ou cedar) :contentReference[oaicite:7]{index=7}
            },
          },
          instructions:
            "Tu es l'agent service client d'ABC Déneigement (Montréal). " +
            "Converse naturellement en français (Québec). " +
            "Heures: Lun-Ven 8h30-17h00. Fermé Sam-Dim. " +
            "Si on te demande un rendez-vous avant 8h30 ou le weekend: refuse poliment et propose un créneau en semaine. " +
            "Si tu n'as pas l'info (ex: nombre exact de camions): dis-le et propose de transférer à un superviseur. " +
            "Sois bref, clair, et pro.",
        },
      });
    });

    openaiWs.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const t = evt.type;

      // Debug minimal utile
      if (t === "error") {
        process.stdout.write("OpenAI error: " + JSON.stringify(evt, null, 2) + "\n");
      }

      // Barge-in: si l’utilisateur parle pendant que l’AI parle, on coupe l’audio en cours
      if (t === "input_audio_buffer.speech_started") {
        process.stdout.write("🎙️ speech_started (barge-in)\n");
        if (playing) {
          openaiCancel();
          twilioClear();
          playing = false;
          locked = false;
        }
      }

      // Quand OpenAI a “committed” le tour (VAD), on lance une réponse si pas déjà en cours
      if (t === "input_audio_buffer.committed") {
        process.stdout.write("✅ committed (VAD)\n");

        if (!locked) {
          locked = true;
          totalAudioDeltas = 0;
          openaiSend({ type: "response.create" });
          process.stdout.write("🗣️ response.create sent\n");
        } else {
          process.stdout.write("⚠️ locked -> skip response.create\n");
        }
      }

      // Audio chunks -> renvoyer à Twilio (sinon tu n’entends rien)
      if (t === "response.output_audio.delta") {
        const b64 = evt.delta; // base64 audio (pcmu)
        if (b64 && streamSid) {
          totalAudioDeltas++;
          playing = true;
          twilioSend({
            event: "media",
            streamSid,
            media: { payload: b64 }, // Twilio attend mulaw/8000 base64 :contentReference[oaicite:8]{index=8}
          });
        }
      }

      // Fin audio
      if (t === "response.output_audio.done") {
        process.stdout.write(`🔊 output_audio.done | audio deltas=${totalAudioDeltas}\n`);
        playing = false;
      }

      // Fin response -> unlock
      if (t === "response.done") {
        process.stdout.write("✅ response.done (unlock)\n");
        locked = false;
      }
    });

    openaiWs.on("close", () => {
      process.stdout.write("🧠 OpenAI Realtime disconnected\n");
      openaiWs = null;
      locked = false;
      playing = false;
    });

    openaiWs.on("error", (e) => {
      process.stdout.write("🧠 OpenAI WS error: " + (e?.message || String(e)) + "\n");
    });
  }

  // ==== TWILIO -> SERVER EVENTS ====
  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid;
      process.stdout.write(`▶️ Twilio stream start sid=${streamSid}\n`);
      connectOpenAI();
      return;
    }

    if (msg.event === "media") {
      const payload = msg?.media?.payload;
      if (payload && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        // envoyer audio inbound à OpenAI
        openaiSend({
          type: "input_audio_buffer.append",
          audio: payload,
        });
      }
      return;
    }

    if (msg.event === "stop") {
      process.stdout.write("⏹️ Twilio stream stop\n");
      try { openaiCancel(); } catch {}
      try { openaiWs?.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    process.stdout.write("❌ Twilio WS disconnected\n");
    try { openaiCancel(); } catch {}
    try { openaiWs?.close(); } catch {}
  });
});

// ============ START SERVER ============
server.listen(PORT, () => {
  process.stdout.write(`🚀 Server listening on ${PORT}\n`);
});

