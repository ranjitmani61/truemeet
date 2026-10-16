// Lean-in whisper mix. Only while a whisper is active, remote audio is routed through Web Audio:
// whisper partners → right ear at 100%, the rest of the room → left ear at 25%. Outside a whisper,
// media elements play audio directly, which keeps Chrome's normal echo-cancellation path.
export const WHISPER_MIX = { partnerGain: 1, partnerPan: 1, roomGain: 0.25, roomPan: -1 };

export function createSpatialMixer(context) {
  const nodes = new Map(); // id → { track, src, gain, pan }
  return {
    get active() { return nodes.size > 0; },
    // list: [{ id, track, video }] for every remote participant; partners: Set of ids.
    apply(list, partners) {
      const ac = context(), t = ac.currentTime;
      for (const { id, track, video } of list) {
        if (!track) continue;
        let n = nodes.get(id);
        if (n?.track !== track) {
          n?.src.disconnect();
          const src = ac.createMediaStreamSource(new MediaStream([track]));
          const gain = ac.createGain(), pan = new StereoPannerNode(ac);
          gain.gain.value = 0;
          src.connect(gain).connect(pan).connect(ac.destination);
          nodes.set(id, (n = { track, src, gain, pan }));
        }
        const partner = partners.has(id);
        n.gain.gain.setTargetAtTime(partner ? WHISPER_MIX.partnerGain : WHISPER_MIX.roomGain, t, 0.03); // short ramps: no clicks
        n.pan.pan.setTargetAtTime(partner ? WHISPER_MIX.partnerPan : WHISPER_MIX.roomPan, t, 0.03);
        video.muted = true; // the element keeps the stream alive; Web Audio is the only output now
      }
      for (const [id, n] of nodes) if (!list.some((x) => x.id === id)) { n.src.disconnect(); nodes.delete(id); }
    },
    release(list) {
      for (const n of nodes.values()) n.src.disconnect();
      nodes.clear();
      for (const { video } of list) video.muted = false;
    },
  };
}
