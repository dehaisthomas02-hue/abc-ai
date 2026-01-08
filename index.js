import http from "http";
import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
if (!OPENAI_API_KEY) console.error("❌ Missing OPENAI_API_KEY");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/ping", (req, res) => res.status(200).send("pong"));

app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/ws`;

  console.log("📞 /voice hit");
  console.log("WEBSOCKET_URL=", wsUrl);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">
    Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.
  </Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  console.log("TwiML sent:\n", twiml);
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
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

  let streamSid = null;

  // Queue des audio chunks Twilio tant que OpenAI n'est pas ready
  const audioQueue = [];
  let openaiIsOpen = false;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const safeSendOpenAI = (obj) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
      return true;
    }
    return false;
  };

  const flushQueueToOpenAI = () => {
    if (!openaiIsOpen) return;
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    // On envoie en rafale les chunks accumulés
    while (audioQueue.length > 0) {
      const payload = audioQueue.shift();
      safeSendOpenAI({ type: "input_audio_buffer.append", audio: payload });
    }
  };

  openaiWs.on("open", () => {
    console.log("🧠 OpenAI Realtime connected");
    openaiIsOpen = true;

    // Session config VALID
    safeSendOpenAI({
      type: "session.update",
      session: {
        output_modalities: ["audio", "text"],
        instructions: `
Tu es l’agent téléphonique de ABC Déneigement.
Langue : français canadien (fr-CA).
Heures : lundi à vendredi 08h30–17h00. Fermé samedi et dimanche.
Sois naturel, poli, humain.
Si tu ne sais pas une information, dis-le et propose de transférer à un superviseur.
        `,
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              silence_duration_ms: 500,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "marin",
          },
        },
      },
    });

    // Dès que c'est prêt, on flush les chunks déjà reçus
    flushQueueToOpenAI();
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.error("OpenAI error:", msg);
      return;
    }

    // 🔊 Audio OpenAI -> Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
    }

    if (msg.type === "response.done") {
      console.log("✅ response.done");
    }
  });

  openaiWs.on("close", () => {
    console.log("🧠 OpenAI Realtime disconnected");
  });

  openaiWs.on("error", (e) => {
    console.error("OpenAI WS error:", e);
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("▶️ Twilio stream start sid=", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      const payload = msg.media.payload;

      // Si OpenAI pas encore OPEN: on queue
      if (openaiWs.readyState !== WebSocket.OPEN) {
        audioQueue.push(payload);

        // Evite que ça grossisse trop si OpenAI met du temps
        if (audioQueue.length > 200) audioQueue.shift();
        return;
      }

      // Sinon on envoie direct
      safeSendOpenAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (msg.event === "stop") {
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

  twilioWs.on("error", (e) => console.error("Twilio WS error:", e));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("🚀 Server listening on", PORT));

