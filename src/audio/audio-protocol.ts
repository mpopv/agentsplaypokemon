export const GAME_AUDIO_SAMPLE_RATE = 48_000;
export const GAME_AUDIO_CHANNELS = 2;
export const GAME_AUDIO_FORMAT = "s8";
export const GAME_AUDIO_PACKET_HEADER_BYTES = 4;

export interface GameAudioPacket {
  sequence: number;
  pcm: ArrayBuffer;
}

export function isGameAudioConfig(message: string): boolean {
  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    return (
      value.type === "audio.config" &&
      value.sampleRate === GAME_AUDIO_SAMPLE_RATE &&
      value.channels === GAME_AUDIO_CHANNELS &&
      value.format === GAME_AUDIO_FORMAT &&
      value.packetHeaderBytes === GAME_AUDIO_PACKET_HEADER_BYTES
    );
  } catch {
    return false;
  }
}

export function parseGameAudioPacket(
  data: ArrayBuffer,
  lastSequence: number
): GameAudioPacket | null {
  if (data.byteLength <= GAME_AUDIO_PACKET_HEADER_BYTES) return null;
  const view = new DataView(data);
  const sequence = view.getUint32(0, false);
  if (sequence <= lastSequence) return null;
  const pcm = data.slice(GAME_AUDIO_PACKET_HEADER_BYTES);
  if (pcm.byteLength % GAME_AUDIO_CHANNELS !== 0) return null;
  return { sequence, pcm };
}
