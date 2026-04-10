import { createClient, RealtimeChannel } from "@supabase/supabase-js";
import https from "node:https";

const SUPABASE_URL = "https://mclbbkmpovnvcfmwsoqt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbGJia21wb3ZudmNmbXdzb3F0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxMzYzNDAsImV4cCI6MjA4MzcxMjM0MH0.F52U5I7L4CYpIIR3IR9Khq0HVDJ1OeMSAtoRza8Dad0";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let channel: RealtimeChannel | null = null;
let currentRoom: string | null = null;
let onReceive: ((data: { text: string; translated: string; fromLang: string }) => void) | null = null;

// Generate 4-digit room code
const generateRoom = (): string => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

// Translate text via Groq LLM
export const translate = (text: string, fromLang: string, toLang: string, groqKey: string): Promise<string> =>
  new Promise((resolve) => {
    // Map language codes to full names for better LLM results
    const langNames: Record<string, string> = {
      en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese",
      it: "Italian", nl: "Dutch", ru: "Russian", zh: "Chinese", ja: "Japanese",
      ko: "Korean", ar: "Arabic", hi: "Hindi", tr: "Turkish", pl: "Polish",
      sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", auto: "the detected language"
    };
    const from = langNames[fromLang] || fromLang;
    const to = langNames[toLang] || toLang;

    const body = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Translate this ${from} text to ${to}. Return ONLY the translation, nothing else. No quotes, no explanation.\n\n${text}`
      }],
      temperature: 0.3,
      max_tokens: 500,
    });

    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const translated = json.choices?.[0]?.message?.content?.trim() || text;
          resolve(translated);
        } catch {
          resolve(text); // fallback to original
        }
      });
    });

    req.on("error", () => resolve(text));
    req.on("timeout", () => { req.destroy(); resolve(text); });
    req.write(body);
    req.end();
  });

// Create a room and start listening
export const createRoom = (myLang: string, groqKey: string, callback: (data: { text: string; translated: string; fromLang: string }) => void): string => {
  const room = generateRoom();
  joinRoom(room, myLang, groqKey, callback);
  return room;
};

// Join an existing room
export const joinRoom = (room: string, myLang: string, groqKey: string, callback: (data: { text: string; translated: string; fromLang: string }) => void): void => {
  // Leave existing room first
  if (channel) {
    leaveRoom();
  }

  currentRoom = room;
  onReceive = callback;

  channel = supabase.channel(`ambiverse-${room}`, {
    config: { broadcast: { self: false } }
  });

  channel.on("broadcast", { event: "transcript" }, async ({ payload }) => {
    const { text, lang } = payload as { text: string; lang: string };
    console.log("[AMBIVERSE] Received:", lang, text.slice(0, 50));

    // Translate if different language
    let translated = text;
    if (lang !== myLang && lang !== "auto") {
      translated = await translate(text, lang, myLang, groqKey);
      console.log("[AMBIVERSE] Translated:", translated.slice(0, 50));
    }

    if (onReceive) {
      onReceive({ text, translated, fromLang: lang });
    }
  });

  channel.subscribe((status) => {
    console.log("[AMBIVERSE] Channel status:", status);
  });
};

// Send transcript to paired device
export const sendTranscript = (text: string, lang: string): void => {
  if (!channel || !currentRoom) return;
  console.log("[AMBIVERSE] Sending:", lang, text.slice(0, 50));
  channel.send({
    type: "broadcast",
    event: "transcript",
    payload: { text, lang }
  });
};

// Leave room
export const leaveRoom = (): void => {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  currentRoom = null;
  onReceive = null;
  console.log("[AMBIVERSE] Left room");
};

// Get current room
export const getRoom = (): string | null => currentRoom;

export const isConnected = (): boolean => !!channel && !!currentRoom;
