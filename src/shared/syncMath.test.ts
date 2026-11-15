import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areAllClientsReady,
  buildRoomInviteUrl,
  computeClockSample,
  computeTargetMediaTime,
  decideSyncCorrection,
  extractPlaylistFromAtomXml,
  extractPlaylistFromInitialData,
  extractRoomCodeFromInput,
  formatTime,
  getRttQuality,
  normalizeRoomCode,
  parseYouTubeId,
  parseYouTubePlaylistId,
  prepareBatchQueueTracks,
  reorderQueueItem,
  selectBestClockOffset,
  updateAdaptiveSeekLatency,
} from './syncMath';

test('parseYouTubeId handles standard, short, shorts, music, embed, and raw IDs', () => {
  assert.equal(parseYouTubeId('jfKfPfyJRdk'), 'jfKfPfyJRdk');
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=jfKfPfyJRdk&t=42s'), 'jfKfPfyJRdk');
  assert.equal(parseYouTubeId('https://youtu.be/jfKfPfyJRdk?si=abc'), 'jfKfPfyJRdk');
  assert.equal(parseYouTubeId('https://www.youtube.com/shorts/jfKfPfyJRdk'), 'jfKfPfyJRdk');
  assert.equal(parseYouTubeId('https://music.youtube.com/watch?v=jfKfPfyJRdk'), 'jfKfPfyJRdk');
  assert.equal(parseYouTubeId('youtube.com/embed/jfKfPfyJRdk'), 'jfKfPfyJRdk');
  assert.equal(parseYouTubeId('not-a-valid-id'), null);
  assert.equal(parseYouTubeId('https://example.com/watch?v=jfKfPfyJRdk'), null);
});

test('computeClockSample and selectBestClockOffset pick minimum RTT sample', () => {
  const s1 = computeClockSample(1000, 1520, 1040);
  const s2 = computeClockSample(2000, 2560, 2120);
  const s3 = computeClockSample(3000, 3505, 3010);

  assert.equal(s1.rttMs, 40);
  assert.equal(s1.offsetMs, 500);
  assert.equal(s3.rttMs, 10);

  const best = selectBestClockOffset([s1, s2, s3]);
  assert.equal(best.rttMs, 10);
  assert.equal(best.offsetMs, 500);
});

test('computeTargetMediaTime calculates exact position for paused and playing states', () => {
  const paused = {
    status: 'paused' as const,
    anchorMediaTime: 45.5,
    anchorServerTime: 10_000,
    playbackRate: 1,
  };
  assert.equal(computeTargetMediaTime(paused, 25_000), 45.5);

  const playing = {
    status: 'playing' as const,
    anchorMediaTime: 30,
    anchorServerTime: 10_000,
    playbackRate: 1,
  };
  assert.equal(computeTargetMediaTime(playing, 12_500), 32.5);
  assert.equal(computeTargetMediaTime({ ...playing, anchorMediaTime: 0 }, 9_500), 0);

  const buffering = {
    status: 'buffering' as const,
    anchorMediaTime: 18.2,
    anchorServerTime: 10_000,
    playbackRate: 1,
  };
  assert.equal(computeTargetMediaTime(buffering, 20_000), 18.2);
});

test('decideSyncCorrection applies tight unison, smooth rate nudge, adaptive seek, and cooldown', () => {
  const inSync = decideSyncCorrection({
    actualMediaTime: 10.05,
    targetMediaTime: 10.0,
    speakerOffsetMs: 0,
    nowMs: 5000,
    lastSeekMs: 0,
  });
  assert.equal(inSync.action, 'in_sync');
  assert.equal(inSync.driftMs, 50);

  // Medium drift (250ms behind) -> smooth 1.25x catch-up instead of harsh seek
  const nudgeBehind = decideSyncCorrection({
    actualMediaTime: 9.75,
    targetMediaTime: 10.0,
    speakerOffsetMs: 0,
    nowMs: 5000,
    lastSeekMs: 0,
  });
  assert.equal(nudgeBehind.action, 'rate_nudge');
  if (nudgeBehind.action === 'rate_nudge') {
    assert.equal(nudgeBehind.rate, 1.25);
  }

  // Medium drift (220ms ahead) -> smooth 0.75x slowdown
  const nudgeAhead = decideSyncCorrection({
    actualMediaTime: 10.22,
    targetMediaTime: 10.0,
    speakerOffsetMs: 0,
    nowMs: 5000,
    lastSeekMs: 0,
  });
  assert.equal(nudgeAhead.action, 'rate_nudge');
  if (nudgeAhead.action === 'rate_nudge') {
    assert.equal(nudgeAhead.rate, 0.75);
  }

  // Large drift (>650ms) -> latency-compensated seek
  const seekNeeded = decideSyncCorrection({
    actualMediaTime: 10.0,
    targetMediaTime: 10.9,
    speakerOffsetMs: 0,
    nowMs: 5000,
    lastSeekMs: 1000,
    adaptiveSeekLatencyMs: 300,
  });
  assert.equal(seekNeeded.action, 'seek');
  if (seekNeeded.action === 'seek') {
    assert.equal(Math.round(seekNeeded.seekToTime * 10) / 10, 11.2);
  }

  // Inside cooldown -> wait before correcting again
  const inCooldown = decideSyncCorrection({
    actualMediaTime: 10.0,
    targetMediaTime: 10.9,
    speakerOffsetMs: 0,
    nowMs: 2000,
    lastSeekMs: 1500,
  });
  assert.equal(inCooldown.action, 'cooldown');

  // Speaker offset shifts target by +200ms
  const withSpeakerOffset = decideSyncCorrection({
    actualMediaTime: 10.2,
    targetMediaTime: 10.0,
    speakerOffsetMs: 200,
    nowMs: 5000,
    lastSeekMs: 0,
  });
  assert.equal(withSpeakerOffset.action, 'in_sync');
  assert.equal(withSpeakerOffset.driftMs, 0);

  // Adaptive EMA clamps and smooths seek latency
  assert.equal(updateAdaptiveSeekLatency(200, 400), 280);
  assert.equal(updateAdaptiveSeekLatency(200, 5000), 720);
});

test('formatTime, normalizeRoomCode, and extractRoomCodeFromInput format cleanly', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(normalizeRoomCode(' ab-12c d9 '), 'AB12CD');
  assert.equal(
    extractRoomCodeFromInput('https://ais-pre-xyz.run.app/?room=k7m9p2'),
    'K7M9P2',
  );
  assert.equal(
    extractRoomCodeFromInput('https://example.com/room/ab12cd'),
    'AB12CD',
  );
  assert.equal(extractRoomCodeFromInput('k7m9p2'), 'K7M9P2');
});

test('getRttQuality classifies RTT thresholds and connection states accurately', () => {
  assert.equal(getRttQuality(18, 'connected'), 'good');
  assert.equal(getRttQuality(120, 'connected'), 'good');
  assert.equal(getRttQuality(121, 'connected'), 'fair');
  assert.equal(getRttQuality(300, 'connected'), 'fair');
  assert.equal(getRttQuality(301, 'connected'), 'poor');
  assert.equal(getRttQuality(45, 'connecting'), 'fair');
  assert.equal(getRttQuality(25, 'reconnecting'), 'poor');
  assert.equal(getRttQuality(null, 'disconnected'), 'poor');
  assert.equal(getRttQuality(null, 'connected'), 'fair');
});

test('buildRoomInviteUrl builds canonical share URL for room codes', () => {
  assert.equal(
    buildRoomInviteUrl('https://echosync.example/', 'k7m9p2'),
    'https://echosync.example/?room=K7M9P2',
  );
  assert.equal(buildRoomInviteUrl('', 'ab12cd'), '/?room=AB12CD');
});

test('reorderQueueItem moves tracks cleanly with clamping and immutability', () => {
  const initial = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const movedUp = reorderQueueItem(initial, 'c', 0);
  assert.deepEqual(
    movedUp.map((x) => x.id),
    ['c', 'a', 'b', 'd'],
  );
  // Original remains unmutated
  assert.deepEqual(
    initial.map((x) => x.id),
    ['a', 'b', 'c', 'd'],
  );

  const movedDown = reorderQueueItem(initial, 'a', 99);
  assert.deepEqual(
    movedDown.map((x) => x.id),
    ['b', 'c', 'd', 'a'],
  );

  const missing = reorderQueueItem(initial, 'unknown', 1);
  assert.deepEqual(
    missing.map((x) => x.id),
    ['a', 'b', 'c', 'd'],
  );
});

test('areAllClientsReady resolves true only when all connected clients are ready', () => {
  assert.equal(areAllClientsReady([], []), false);
  assert.equal(areAllClientsReady(['c1', 'c2'], ['c1']), false);
  assert.equal(areAllClientsReady(['c1', 'c2'], ['c2', 'c1']), true);
  assert.equal(areAllClientsReady(['c1'], ['c1', 'stale']), true);
});

test('parseYouTubePlaylistId extracts playlist IDs from URLs and raw IDs without matching single videos', () => {
  assert.equal(
    parseYouTubePlaylistId('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'),
    'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
  );
  assert.equal(
    parseYouTubePlaylistId('https://www.youtube.com/watch?v=jfKfPfyJRdk&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&index=2'),
    'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
  );
  assert.equal(
    parseYouTubePlaylistId('https://music.youtube.com/playlist?list=OLAK5uy_n9abc1234567890'),
    'OLAK5uy_n9abc1234567890',
  );
  assert.equal(
    parseYouTubePlaylistId('PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'),
    'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
  );
  // Must not treat a regular 11-char video ID or Watch Later (WL) as a playlist
  assert.equal(parseYouTubePlaylistId('jfKfPfyJRdk'), null);
  assert.equal(parseYouTubePlaylistId('https://www.youtube.com/playlist?list=WL'), null);
});

test('extractPlaylistFromInitialData and extractPlaylistFromAtomXml parse tracks cleanly and dedupe', () => {
  const initialData = {
    header: {
      playlistHeaderRenderer: {
        title: { simpleText: 'Late Night Lofi' },
      },
    },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      itemSectionRenderer: {
                        contents: [
                          {
                            playlistVideoListRenderer: {
                              contents: [
                                {
                                  playlistVideoRenderer: {
                                    videoId: 'n61ULEU7CO0',
                                    title: { runs: [{ text: 'Lofi Beat 1' }] },
                                    shortBylineText: { runs: [{ text: 'Lofi Girl' }] },
                                  },
                                },
                                {
                                  playlistVideoRenderer: {
                                    videoId: 'n61ULEU7CO0',
                                    title: { runs: [{ text: 'Duplicate Beat 1' }] },
                                    shortBylineText: { runs: [{ text: 'Lofi Girl' }] },
                                  },
                                },
                                {
                                  playlistVideoRenderer: {
                                    videoId: 'lTRiuFIWV54',
                                    title: { simpleText: '[Deleted video]' },
                                  },
                                },
                                {
                                  playlistVideoRenderer: {
                                    videoId: 'TURbeWK2wwg',
                                    title: { runs: [{ text: '4 AM Study' }] },
                                    longBylineText: { runs: [{ text: 'Lofi Channel' }] },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };

  const parsed = extractPlaylistFromInitialData(initialData);
  assert.equal(parsed.title, 'Late Night Lofi');
  assert.deepEqual(
    parsed.tracks.map((t) => t.videoId),
    ['n61ULEU7CO0', 'TURbeWK2wwg'],
  );
  assert.equal(parsed.tracks[0].title, 'Lofi Beat 1');
  assert.equal(parsed.tracks[1].author, 'Lofi Channel');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <feed>
    <title>Chill &amp; Study Mix</title>
    <entry>
      <yt:videoId>4xDzrJKXOOY</yt:videoId>
      <title>Synthwave &amp; Chill</title>
      <author><name>Lofi Synth</name></author>
    </entry>
    <entry>
      <yt:videoId>n61ULEU7CO0</yt:videoId>
      <title>Relax Beats</title>
      <author><name>Lofi Girl</name></author>
    </entry>
  </feed>`;
  const fromXml = extractPlaylistFromAtomXml(xml);
  assert.equal(fromXml.title, 'Chill & Study Mix');
  assert.equal(fromXml.tracks.length, 2);
  assert.equal(fromXml.tracks[0].title, 'Synthwave & Chill');
});

test('prepareBatchQueueTracks filters invalid video IDs and caps batch size', () => {
  const prepared = prepareBatchQueueTracks(
    [
      { videoId: 'invalid' },
      { videoId: 'n61ULEU7CO0', title: 'Track A', author: 'Artist A' },
      { videoId: 'https://youtu.be/lTRiuFIWV54' },
      { videoId: 'TURbeWK2wwg', title: 'Track C' },
    ],
    2,
  );
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].videoId, 'n61ULEU7CO0');
  assert.equal(prepared[1].videoId, 'lTRiuFIWV54');
  assert.equal(prepared[1].title, 'YouTube Track (lTRiuFIWV54)');
});
