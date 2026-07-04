export interface PhoneCommandParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  example?: string | number | boolean;
}

export interface PhoneCommand {
  command: string;
  description: string;
  params: PhoneCommandParam[];
}

export const PHONE_COMMANDS: PhoneCommand[] = [
  {
    command: "command_dnd",
    description: "Set Do Not Disturb mode on the phone.",
    params: [
      {
        name: "state",
        type: "string",
        required: true,
        description: "DND state: 'priority_only', 'alarms_only', 'off', or 'total_silence'",
        example: "priority_only",
      },
    ],
  },
  {
    command: "command_ringer_mode",
    description: "Set the ringer mode of the phone.",
    params: [
      {
        name: "ringer_mode",
        type: "string",
        required: true,
        description: "One of: 'normal', 'silent', 'vibrate'",
        example: "vibrate",
      },
    ],
  },
  {
    command: "command_volume_level",
    description: "Set a volume stream to a specific level (0–15).",
    params: [
      {
        name: "media_stream",
        type: "string",
        required: true,
        description: "Stream to adjust: 'music_stream', 'ring_stream', 'call_stream', 'alarm_stream', 'notification_stream'",
        example: "music_stream",
      },
      {
        name: "volume_level",
        type: "number",
        required: true,
        description: "Volume level from 0 to 15",
        example: 8,
      },
    ],
  },
  {
    command: "command_flashlight",
    description: "Turn the phone flashlight on or off.",
    params: [
      {
        name: "state",
        type: "string",
        required: true,
        description: "'on' or 'off'",
        example: "on",
      },
    ],
  },
  {
    command: "command_screen_brightness_level",
    description: "Set the screen brightness level.",
    params: [
      {
        name: "screen_brightness_level",
        type: "number",
        required: true,
        description: "Brightness from 0 to 255",
        example: 128,
      },
    ],
  },
  {
    command: "command_screen_on",
    description: "Turn the phone screen on.",
    params: [],
  },
  {
    command: "command_screen_off",
    description: "Turn the phone screen off.",
    params: [],
  },
  {
    command: "command_activity",
    description: "Launch a specific Activity (Android intent) on the phone.",
    params: [
      {
        name: "intent_action",
        type: "string",
        required: true,
        description: "Android intent action string, e.g. 'android.intent.action.VIEW'",
        example: "android.intent.action.VIEW",
      },
      {
        name: "intent_uri",
        type: "string",
        required: false,
        description: "URI to pass to the intent",
        example: "https://example.com",
      },
    ],
  },
  {
    command: "command_media",
    description: "Control media playback on the phone.",
    params: [
      {
        name: "media_command",
        type: "string",
        required: true,
        description: "One of: 'pause', 'play', 'stop', 'next', 'previous', 'volume_up', 'volume_down'",
        example: "pause",
      },
    ],
  },
  {
    command: "command_stop_tts",
    description: "Stop any current text-to-speech playback on the phone.",
    params: [],
  },
];
