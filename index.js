import http from "http";
import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
}

const app = express();

// Twilio envoie du x-www-form-urlencoded pour /voice (pas JSON)
app.use(express.urlencoded({ extended: false }));

app.get("/ping", (req, res) => res.status(200).send("pong"));

/**
 * Twilio webhook: quand quelqu'un appelle ton numéro
 * On renvoie du TwiML pour connecter l'appel au WebSocket /ws
 */
app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/ws`;

  process.stdout.write(`📞 /voice hit\nWEBSOCKET_URL=${wsUrl}\n`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Chantal" language="fr-CA">
    Bienvenue chez ABC Déneigement. Dites-moi comment je peux vous aider.
  </Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  process.stdout.write(`TwiML sent:\n${twiml}\n`);
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);

/**
 * WebSocket server (même port que Express) -> /ws
 */
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  process.stdout.write(`⬆️ UPGRADE hit url=${req.url}\n`);
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  process.stdout.write("✅ Twilio WS connected\n");

  let streamSid = null;

  // Connexion OpenAI Realtime (WebSocket)
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let responseInProgress = false;
  let lastCommitAt = 0;

  function safeSendOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  }

  openaiWs.on("open", () => {
    process.stdout.write("🧠 OpenAI Realtime connected\n");

    // ✅ Session config: output_modalities + audio formats (pcmu = G.711 μ-law)
    // + VAD en mode conversation (create_response/interrupt_response)
    safeSendOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["audio", "text"],
        instructions:
          "Tu es l'agent téléphonique d'ABC Déneigement. Tu parles français canadien (fr-CA), ton style est naturel et poli. " +
          "Si tu n'as pas l'info, dis-le et propose de transférer à un superviseur. " +
          "Heures: Lun-Ven 8h30-17h. Fermé samedi/dimanche. " +
          "Tu peux proposer de prendre un rendez-vous. Pose des questions courtes et confirme les détails.",
        audio: {
          input: {
            format: { type: "audio/pcmu" }, // Twilio Media Streams = pcmu (mulaw) 8k
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" }, // on renvoie direct à Twilio sans conversion
            // voix OpenAI (pas Twilio Polly) — la voix exacte dépend du modèle/compte
            voice: "marin",
          },
        },
      },
    });
  });

  openaiWs.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    // Debug utile
    if (msg.type === "error") {
      console.log("OpenAI error:", msg);
      return;
    }

    // Quand OpenAI produit de l'audio -> renvoyer à Twilio
    if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
      const twilioMsg = {
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      };
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify(twilioMsg));
      }
      return;
    }

    // Quand une réponse est terminée -> unlock
    if (msg.type === "response.done") {
      responseInProgress = false;
      process.stdout.write("✅ response.done\n");
      return;
    }

    // Quand OpenAI détecte que l'utilisateur parle -> couper l'AI (interruption)
    if (msg.type === "input_audio_buffer.speech_started") {
      // Si l'AI parlait déjà, on annule
      safeSendOpenAI({ type: "response.cancel" });
      safeSendOpenAI({ type: "output_audio_buffer.clear" });
      return;
    }
  });

  twilioWs.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid;
      process.stdout.write(`▶️ Twilio stream start sid=${streamSid}\n`);
      return;
    }

    if (data.event === "media") {
      // audio entrant Twilio (pcmu base64)
      const payload = data.media?.payload;
      if (payload) {
        safeSendOpenAI({ type: "input_audio_buffer.append", audio: payload });
      }
      return;
    }

    if (data.event === "stop") {
      process.stdout.write("⏹️ Twilio stream stop\n");
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  // IMPORTANT: si OpenAI auto-commit très souvent, on évite de spam response.create.
  // Normalement avec server_vad + create_response:true, OpenAI crée la réponse tout seul.
  // Si tu veux forcer (optionnel), décommente ci-dessous et assure-toi de pas spam.
  //
  // openaiWs.on("message", (buf) => {
  //   ...
  //   if (msg.type === "input_audio_buffer.committed") {
  //     const now = Date.now();
  //     if (!responseInProgress && now - lastCommitAt > 600) {
  //       responseInProgress = true;
  //       lastCommitAt = now;
  //       safeSendOpenAI({ type: "response.create" });
  //     }
  //   }
  // });

  twilioWs.on("close", () => {
    process.stdout.write("❌ Twilio WS disconnected\n");
    try { openaiWs.close(); } catch {}
  });

  openaiWs.on("close", () => {
    process.stdout.write("🧠 OpenAI Realtime disconnected\n");
    try { twilioWs.close(); } catch {}
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  process.stdout.write(`🚀 Server listening on ${PORT}\n`);
});







