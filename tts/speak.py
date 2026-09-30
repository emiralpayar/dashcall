# Neural TTS via edge-tts. argv: voice (e.g. en-US-AvaNeural, tr-TR-EmelNeural), rate (e.g. +0%).
# stdin: text. stdout: JSON {audio: base64 mp3, words: [{t, d, w}]} (seconds).
import asyncio, base64, json, sys
import edge_tts

async def main():
    text = sys.stdin.read().strip()
    voice = sys.argv[1] if len(sys.argv) > 1 else "en-US-AvaNeural"
    rate = sys.argv[2] if len(sys.argv) > 2 else "+0%"
    c = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    audio, words = bytearray(), []
    async for ch in c.stream():
        if ch["type"] == "audio":
            audio += ch["data"]
        elif ch["type"] == "WordBoundary":
            words.append({"t": ch["offset"] / 1e7, "d": ch["duration"] / 1e7, "w": ch["text"]})
    json.dump({"audio": base64.b64encode(bytes(audio)).decode(), "words": words}, sys.stdout)

asyncio.run(main())
