import express from "express";
import bodyParser from "body-parser";
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (reason) => console.error("UNHANDLED REJECTION:", reason));

// --- Health ---
app.get("/ping", (req, res) => {
  process.stdout.write("🏓 /ping hit\n");
  res.status(200).send("pong");
});

// --- Twilio voice webhook ---
app.post("/voice", (req, res) => {
  process.stdout.write("📞 /voice hit\n");

  const wsUrl = (process.env.WEBSOCKET_URL || "").trim();
  process.stdout.write(`WEBSOCKET_URL=${wsUrl}\n`);

  // Bidirectional: Twilio can play audio sent back over WS
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

// --- Single server ---
const server = http.createServer(app);

// --- WS server on same port ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  process.stdout.write(`⬆️ UPGRADE hit url=${req.url}\n`);

  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    process.stdout.write("❌ UPGRADE rejected (not /ws)\n");
    socket.destroy();
  }
});

// --- Twilio <-> OpenAI Realtime bridge ---
wss.on("connection", (twilioWs) => {
  process.stdout.write("✅ Twilio WS connected\n");

  let streamSid = null;

  const openaiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!openaiKey) {
    process.stdout.write("❌ Missing OPENAI_API_KEY\n");
    twilioWs.close();
    return;
  }

  let openaiReady = false;
  let responseInProgress = false;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function requestAudioResponse() {
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    // Explicitly request AUDIO output
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
        },
      })
    );
  }

  openaiWs.on("open", () => {
    process.stdout.write("🧠 OpenAI Realtime connected\n");

    // Force audio modality + ulaw formats
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio"], // <= important
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          turn_detection: { type: "server_vad" },
          instructions: `
Tu es l'agent téléphonique de ABC Déneigement.

Règles :
- Heures: Lun-Ven 08:30-17:00. Fermé samedi/dimanche.
- RDV: si quelqu’un demande avant 08:30 ou après 17:00, propose le prochain créneau dispo.
- Si une info est inconnue (ex: nombre de camions), dis que tu n'as pas l'information et propose de transférer à un superviseur.
- Style: humain, poli, efficace, FR-CA.
`,
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

    // Optional: uncomment to see all event types
    // process.stdout.write(`OpenAI evt: ${evt.type}\n`);

    if (evt.type === "error") {
      console.log("OpenAI error:", evt);

      // If OpenAI says a response is already active, don't spam new creates.
      if (evt?.error?.code === "conversation_already_has_active_response") {
        responseInProgress = true;
        process.stdout.write("⚠️ active response already in progress -> keep lock\n");
      }
      return;
    }

    // When server_vad commits user audio, trigger ONE response at a time
    if (evt.type === "input_audio_buffer.committed") {
      if (!responseInProgress) {
        responseInProgress = true;
        process.stdout.write("🗣️ Commit -> response.create (audio)\n");
        requestAudioResponse();
      } else {
        process.stdout.write("⚠️ Commit ignored (response in progress)\n");
      }
      return;
    }

    // Audio delta from OpenAI -> Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      process.stdout.write("🔊 audio delta -> Twilio\n");
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        })
      );
      return;
    }

    // Unlock when the response is done
    if (evt.type === "response.done") {
      responseInProgress = false;
      process.stdout.write("✅ response.done (unlock)\n");
      return;
    }
  });

  openaiWs.on("error", (err) => console.log("OpenAI WS error:", err));
  openaiWs.on("close", () => process.stdout.write("🧠 OpenAI Realtime disconnected\n"));

  // Twilio -> OpenAI
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
      // While AI is speaking, ignore user audio (prevents new commits mid-response)
      if (responseInProgress) return;
      if (!openaiReady) return;

      if (openaiWs.readyState === WebSocket.OPEN) {
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

  twilioWs.on("error", (err) => console.log("Twilio WS error:", err));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));




