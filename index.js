import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Webhook Twilio pour appel entrant
app.post("/voice", (req, res) => {
  const twiml = `<Response>
    <Start>
      <Stream url="${process.env.WEBSOCKET_URL}" />
    </Start>
    <Say voice="Polly.Joanna">
      Bienvenue chez ABC Déneigement, vous allez être connecté à notre agent AI.
    </Say>
  </Response>`;

  res.type("text/xml").send(twiml);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
