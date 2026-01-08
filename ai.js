import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function handleAIResponse(userText, context = []) {
  // context = historique de la conversation
  const messages = [...context, { role: "user", content: userText }];
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: messages,
    temperature: 0.5
  });

  const response = completion.choices[0].message.content;
  return response;
}
