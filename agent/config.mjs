// All agent settings, read once from the environment. Documented in .env.example and docs/CONFIGURATION.md.
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HOME = homedir();

const env = name => process.env[name] || undefined; // empty counts as unset
// Relative paths are relative to the repo root; bare command names are looked up on PATH.
const fromRoot = p => path.resolve(ROOT, p);
const command = c => (c.includes('/') ? fromRoot(c) : c);

export const LANGUAGES = ['en', 'tr'];

export const config = {
  token: env('DASHCALL_TOKEN'),
  bind: env('DASHCALL_BIND') || '127.0.0.1',
  port: Number(env('DASHCALL_PORT') || 7420),
  dispatchModel: env('DASHCALL_DISPATCH_MODEL') || 'sonnet',
  // UNSAFE escape hatch: run the dispatcher with --dangerously-skip-permissions instead of "dashcall commands only".
  dispatchUnrestricted: env('DASHCALL_DISPATCH_UNRESTRICTED') === '1',
  // Used when a request doesn't say which language the user speaks.
  defaultLanguage: LANGUAGES.includes(env('DASHCALL_DEFAULT_LANGUAGE')) ? env('DASHCALL_DEFAULT_LANGUAGE') : 'en',
  // Typed into a new herdr pane to start a Claude Code session.
  sessionCommand: env('DASHCALL_SESSION_COMMAND') || 'claude',
  // New sessions may only be started in folders under this directory.
  workspaceRoot: path.resolve(env('DASHCALL_WORKSPACE_ROOT') || HOME),
  // Log transcripts and questions (off by default: they are private).
  logContent: env('DASHCALL_LOG_CONTENT') === '1',
  // Voices for the local macOS `say` fallback, per language.
  sayVoices: {
    tr: env('DASHCALL_SAY_VOICE_TR') || 'Yelda',
    en: env('DASHCALL_SAY_VOICE_EN') || 'Samantha',
  },
  brainFile: fromRoot(env('DASHCALL_BRAIN_FILE') || 'dispatcher/brain/brain.json'),
  stateDir: fromRoot(env('DASHCALL_STATE_DIR') || 'state'),
  whisperModel: fromRoot(env('DASHCALL_WHISPER_MODEL') || 'models/ggml-large-v3-turbo-q5_0.bin'),
  bin: {
    claude: command(env('DASHCALL_CLAUDE_BIN') || 'claude'),
    herdr: command(env('DASHCALL_HERDR_BIN') || 'herdr'),
    ffmpeg: command(env('DASHCALL_FFMPEG_BIN') || 'ffmpeg'),
    whisper: command(env('DASHCALL_WHISPER_BIN') || 'whisper-cli'),
    python: command(env('DASHCALL_TTS_PYTHON') || 'tts/.venv/bin/python'),
  },
};
