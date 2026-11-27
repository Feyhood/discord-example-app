import { ButtonStyleTypes, MessageComponentTypes } from 'discord-interactions';
import { DiscordRequest } from './utils.js';

const STATUS_URL = process.env.STATUS_URL || 'http://57.128.191.109:8080/status.json';
const JOIN_URL = process.env.JOIN_URL || 'http://57.128.191.109:8080/join/';
const HUB_ADDRESS = process.env.HUB_ADDRESS || '57.128.191.109:27015';
const POLL_INTERVAL_MS = Number(process.env.STATUS_INTERVAL_MS) || 60_000;
const EMBED_TITLE = 'Distrust Online — Server Status';

const DEFAULT_SERVERS = [
  { id: 'hub', name: 'Hub' },
  { id: 'game1', name: 'Game 1' },
  { id: 'game2', name: 'Game 2' },
  { id: 'game3', name: 'Game 3' },
  { id: 'game4', name: 'Game 4' },
  { id: 'game5', name: 'Game 5' },
];

function formatServerName(id) {
  const known = DEFAULT_SERVERS.find((s) => s.id === id);
  if (known) return known.name;
  const gameMatch = /^game(\d+)$/i.exec(id);
  if (gameMatch) return `Game ${gameMatch[1]}`;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function getOrderedServers(statusData) {
  const seen = new Set(DEFAULT_SERVERS.map((s) => s.id));
  const list = [...DEFAULT_SERVERS];

  if (statusData && typeof statusData === 'object' && !Array.isArray(statusData)) {
    for (const id of Object.keys(statusData)) {
      if (!seen.has(id)) {
        seen.add(id);
        list.push({ id, name: formatServerName(id) });
      }
    }
  }

  return list;
}

function isHubServer(serverId, entry) {
  return serverId === 'hub' || entry?.role === 'hub';
}

function buildHubConnectUrl() {
  const url = new URL(JOIN_URL);
  url.searchParams.set('to', 'hub');
  return url.toString();
}

function buildStatusPayload(statusData, fetchError) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const servers = getOrderedServers(statusData);

  if (fetchError) {
    return {
      embeds: [
        {
          title: EMBED_TITLE,
          description: `Unable to fetch live server status right now.\nLast checked: <t:${nowUnix}:R>`,
          color: 0xe74c3c,
          footer: { text: `Updates every ${Math.round(POLL_INTERVAL_MS / 1000)} seconds` },
        },
      ],
      components: [
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.BUTTON,
              style: ButtonStyleTypes.LINK,
              label: 'Connect to Hub',
              url: buildHubConnectUrl(),
            },
          ],
        },
      ],
    };
  }

  let onlinePlayers = 0;
  let onlineServers = 0;
  let hubOnline = false;

  const fields = servers.map((server) => {
    const entry = statusData?.[server.id];
    const isHub = isHubServer(server.id, entry);
    const hasValidCounts =
      entry?.online &&
      Number.isInteger(entry.players) &&
      Number.isInteger(entry.max) &&
      entry.players >= 0 &&
      entry.max >= 0;

    if (!hasValidCounts) {
      return {
        name: `🔴 ${server.name}`,
        value: 'Offline',
        inline: !isHub,
      };
    }

    onlinePlayers += entry.players;
    onlineServers += 1;
    if (isHub) hubOnline = true;

    const lines = [`**${entry.players} / ${entry.max}** online`];

    if (!isHub) {
      lines.push(entry.ingame ? 'Match in progress' : 'Waiting');
    }

    if (entry.map) {
      lines.push(`Map: \`${entry.map}\``);
    }

    // Only expose direct connect info for the Hub
    if (isHub) {
      lines.push(`Console: \`connect ${HUB_ADDRESS}\``);
    }

    return {
      name: `🟢 ${server.name}`,
      value: lines.join('\n'),
      inline: !isHub,
    };
  });

  const color = hubOnline ? 0x2ecc71 : onlineServers > 0 ? 0xf39c12 : 0xe74c3c;
  const playerWord = onlinePlayers === 1 ? 'player' : 'players';
  const serverWord = onlineServers === 1 ? 'server' : 'servers';

  // Connect button is shown ONLY for the Hub
  const components = [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: MessageComponentTypes.BUTTON,
          style: ButtonStyleTypes.LINK,
          label: hubOnline ? 'Connect to Hub' : 'Hub Offline',
          url: buildHubConnectUrl(),
          disabled: !hubOnline,
        },
      ],
    },
  ];

  return {
    embeds: [
      {
        title: EMBED_TITLE,
        description: `**${onlinePlayers} ${playerWord}** online across **${onlineServers}/${servers.length} ${serverWord}**\nLast updated: <t:${nowUnix}:R>`,
        color,
        fields,
        footer: {
          text: `Updates every ${Math.round(POLL_INTERVAL_MS / 1000)} seconds • Quick games start from the Hub`,
        },
      },
    ],
    components,
  };
}

async function fetchServerStatus() {
  const res = await fetch(STATUS_URL, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Status request failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Status response has an invalid format');
  }

  return data;
}

async function findExistingStatusMessage(channelId, botUserId) {
  try {
    const res = await DiscordRequest(`channels/${channelId}/messages?limit=20`, {
      method: 'GET',
    });
    const messages = await res.json();
    const existing = messages.find(
      (msg) =>
        msg.author?.id === botUserId &&
        msg.embeds?.some((embed) => embed.title === EMBED_TITLE)
    );
    return existing?.id || null;
  } catch (err) {
    console.warn('Could not look up existing status message:', err.message);
    return null;
  }
}

export function startServerTracker() {
  const channelId = process.env.STATUS_CHANNEL_ID;
  if (!channelId) {
    console.warn('STATUS_CHANNEL_ID is not set; server status tracker disabled.');
    return null;
  }

  let botUserId = process.env.APP_ID || null;
  let statusMessageId = null;
  let initialized = false;
  let isUpdating = false;

  async function init() {
    try {
      const meRes = await DiscordRequest('users/@me', { method: 'GET' });
      const me = await meRes.json();
      if (me?.id) botUserId = me.id;
    } catch (err) {
      console.warn('Could not fetch bot user info:', err.message);
    }

    if (botUserId) {
      statusMessageId = await findExistingStatusMessage(channelId, botUserId);
      if (statusMessageId) {
        console.log(`Reusing existing status message ${statusMessageId} in channel ${channelId}`);
      }
    }

    initialized = true;
  }

  async function updateStatusMessage() {
    if (isUpdating) return;
    isUpdating = true;

    try {
      if (!initialized) {
        await init();
      }

      let statusData = null;
      let fetchError = null;
      try {
        statusData = await fetchServerStatus();
      } catch (err) {
        fetchError = err;
        console.error('Failed to fetch server status:', err.message);
      }

      const payload = buildStatusPayload(statusData, fetchError);

      if (statusMessageId) {
        try {
          await DiscordRequest(`channels/${channelId}/messages/${statusMessageId}`, {
            method: 'PATCH',
            body: payload,
          });
          return;
        } catch (err) {
          // If the message was deleted, fall through and post a new one
          if (err.status === 404 || err.message.includes('10008')) {
            console.warn('Previous status message was deleted; posting a new one.');
            statusMessageId = null;
          } else {
            throw err;
          }
        }
      }

      const createdRes = await DiscordRequest(`channels/${channelId}/messages`, {
        method: 'POST',
        body: payload,
      });
      const created = await createdRes.json();
      statusMessageId = created.id;
      console.log(`Posted server status message ${statusMessageId} in channel ${channelId}`);
    } catch (err) {
      console.error('Failed to update Discord status message:', err.message);
    } finally {
      isUpdating = false;
    }
  }

  // Run immediately, then every POLL_INTERVAL_MS (default 60s)
  updateStatusMessage();
  const intervalId = setInterval(updateStatusMessage, POLL_INTERVAL_MS);
  console.log(
    `Server tracker started: polling ${STATUS_URL} every ${Math.round(POLL_INTERVAL_MS / 1000)}s -> channel ${channelId}`
  );

  return intervalId;
}
