export type PlaybackStatus = 'playing' | 'paused' | 'buffering';
export type ControlMode = 'everyone' | 'host-only';
export type DeviceType = 'desktop' | 'mobile' | 'tablet';
export type Language = 'hi' | 'en';

export interface TrackItem {
  id: string;
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  addedBy: string;
}

export interface PlaybackState {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  status: PlaybackStatus;
  anchorMediaTime: number;
  anchorServerTime: number;
  playbackRate: number;
  revision: number;
  readyClientIds?: string[];
  readyWaitUntil?: number;
}

export interface RoomParticipant {
  clientId: string;
  name: string;
  deviceType: DeviceType;
  isHost: boolean;
  rttMs: number;
  driftMs: number;
  audioUnlocked: boolean;
  joinedAt: number;
}

export interface RoomSnapshot {
  code: string;
  hostId: string;
  controlMode: ControlMode;
  playback: PlaybackState;
  queue: TrackItem[];
  participants: RoomParticipant[];
  serverNow: number;
}

export type ClientMessage =
  | {
      type: 'room:join';
      roomCode?: string;
      name: string;
      deviceType: DeviceType;
      initialVideoId?: string;
      initialTrack?: Partial<TrackItem>;
      restoreIfMissing?: boolean;
      restorePlayback?: Partial<PlaybackState>;
    }
  | { type: 'sync:ping'; t0: number }
  | { type: 'playback:play'; mediaTime?: number; scheduleDelayMs?: number }
  | { type: 'playback:pause'; mediaTime: number }
  | { type: 'playback:seek'; mediaTime: number }
  | { type: 'playback:resync_all'; mediaTime: number }
  | { type: 'playback:ready'; revision: number }
  | { type: 'playback:force_start' }
  | {
      type: 'track:load';
      videoId: string;
      title?: string;
      author?: string;
      thumbnail?: string;
      autoplay?: boolean;
    }
  | {
      type: 'queue:add';
      videoId: string;
      title?: string;
      author?: string;
      thumbnail?: string;
    }
  | {
      type: 'queue:add_batch';
      tracks: Array<{
        videoId: string;
        title?: string;
        author?: string;
        thumbnail?: string;
      }>;
      playFirst?: boolean;
    }
  | { type: 'queue:remove'; itemId: string }
  | { type: 'queue:reorder'; itemId: string; toIndex: number }
  | { type: 'queue:play_item'; itemId: string }
  | { type: 'queue:clear' }
  | { type: 'track:ended'; currentVideoId: string }
  | { type: 'room:set_control_mode'; controlMode: ControlMode }
  | { type: 'room:transfer_host'; targetClientId: string }
  | {
      type: 'client:telemetry';
      rttMs: number;
      driftMs: number;
      audioUnlocked: boolean;
    };

export type ServerMessage =
  | {
      type: 'room:joined';
      clientId: string;
      room: RoomSnapshot;
    }
  | {
      type: 'room:state';
      room: RoomSnapshot;
    }
  | {
      type: 'room:participants';
      hostId: string;
      controlMode: ControlMode;
      participants: RoomParticipant[];
    }
  | {
      type: 'sync:pong';
      t0: number;
      serverTime: number;
    }
  | {
      type: 'room:error';
      code: string;
      message: string;
    };
