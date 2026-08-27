import { describe, expect, it } from "vitest";

import { isGameAudioConfig, parseGameAudioPacket } from "./audio-protocol";

describe("game audio protocol", () => {
  it("accepts the exact signed stereo stream configuration", () => {
    expect(
      isGameAudioConfig(
        JSON.stringify({
          type: "audio.config",
          sampleRate: 48_000,
          channels: 2,
          format: "s8",
          packetHeaderBytes: 4
        })
      )
    ).toBe(true);
    expect(isGameAudioConfig('{"type":"audio.config","sampleRate":44100}')).toBe(false);
  });

  it("reads a new sequence and rejects stale or malformed packets", () => {
    const data = new Uint8Array([0, 0, 0, 7, 240, 16, 248, 8]).buffer;

    expect(parseGameAudioPacket(data, 6)).toEqual({
      sequence: 7,
      pcm: new Uint8Array([240, 16, 248, 8]).buffer
    });
    expect(parseGameAudioPacket(data, 7)).toBeNull();
    expect(parseGameAudioPacket(new Uint8Array([0, 0, 0, 8, 1]).buffer, 7)).toBeNull();
  });
});
