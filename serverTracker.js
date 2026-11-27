import http from 'node:http';
import https from 'node:https';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  MessageComponentTypes,
  SeparatorSpacingTypes,
} from 'discord-interactions';
import { DiscordRequest } from './utils.js';

const STATUS_URL = process.env.STATUS_URL || 'http://57.128.191.109:8080/status.json';
const JOIN_URL = process.env.JOIN_URL || 'http://57.128.191.109:8080/join/';
const HUB_ADDRESS = process.env.HUB_ADDRESS || '57.128.191.109:27015';
const POLL_INTERVAL_MS = Number(process.env.STATUS_INTERVAL_MS) || 60_000;

const LEGACY_EMBED_TITLE = 'Distrust Online — Server Status';
const STATUS_HEADER_MARKER = 'DISTRUST ONLINE';

// Danganronpa Red & Yellow palette
const COLORS = {
  crimson: 0xe6192e, // Hub online
  cautionYellow: 0xffcc00, // Hub offline, game servers still running
  darkCrimson: 0x8b0000, // All offline or status unavailable
};

const DEFAULT_SERVERS = [
  { id: 'hub', name: 'Hub' },
  { id: 'game1', name: 'Game 1' },
  { id: 'game2', name: 'Game 2' },
  { id: 'game3', name: 'Game 3' },
  { id: 'game4', name: 'Game 4' },
  { id: 'game5', name: 'Game 5' },
];

const KNOWN_MAPS = {
  dro_lobby: 'Lobby',
  dro_hopespeak_v3: "Hope's Peak v3",
  dro_hopespeak_v3_mirror: "Hope's Peak v3 (Mirror)",
  dro_hopespeak_v3_g2311: "Hope's Peak v3 (g2311)",
};

function formatServerName(id) {
  const known = DEFAULT_SERVERS.find((s) => s.id === id);
  if (known) return known.name;
  const hubMatch = /^hub(\d+)$/i.exec(id);
  if (hubMatch) return `Hub ${hubMatch[1]}`;
  const gameMatch = /^game(\d+)$/i.exec(id);
  if (gameMatch) return `Game ${gameMatch[1]}`;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function serverSortKey(server) {
  if (server.id === 'hub') return [0, 0, server.id];
  const hubMatch = /^hub(\d+)$/i.exec(server.id);
  if (hubMatch) return [0, Number(hubMatch[1]), server.id];
  const gameMatch = /^game(\d+)$/i.exec(server.id);
  if (gameMatch) return [1, Number(gameMatch[1]), server.id];
  return [2, 0, server.id];
}

function formatMapName(rawMap) {
  if (!rawMap) return null;
  if (KNOWN_MAPS[rawMap]) return KNOWN_MAPS[rawMap];
  const stripped = rawMap.replace(/^dro_/i, '');
  return stripped
    .split('_')
    .filter(Boolean)
    .map((part) => (/^v\d+$/i.test(part) ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
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

  return list.sort((a, b) => {
    const ka = serverSortKey(a);
    const kb = serverSortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2].localeCompare(kb[2]);
  });
}

function isHubServer(serverId, entry) {
  return serverId === 'hub' || entry?.role === 'hub';
}

function hasValidEntry(entry) {
  return Boolean(
    entry?.online &&
      Number.isInteger(entry.players) &&
      Number.isInteger(entry.max) &&
      entry.players >= 0 &&
      entry.max >= 0
  );
}

export function buildHubConnectUrl() {
  return JOIN_URL;
}

function buildConnectButton(hubOnline) {
  return {
    type: MessageComponentTypes.BUTTON,
    style: ButtonStyleTypes.LINK,
    label: hubOnline ? 'Connect to Hub' : 'Hub Offline',
    url: buildHubConnectUrl(),
    disabled: !hubOnline,
  };
}

function buildSeparator(divider = true) {
  return {
    type: MessageComponentTypes.SEPARATOR,
    divider,
    spacing: SeparatorSpacingTypes.SMALL,
  };
}

export function buildStatusPayload(statusData, fetchError) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const refreshSeconds = Math.round(POLL_INTERVAL_MS / 1000);
  const servers = getOrderedServers(statusData);

  if (fetchError) {
    return {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.CONTAINER,
          accent_color: COLORS.darkCrimson,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: [
                `# ${STATUS_HEADER_MARKER}`,
                `Unable to fetch live server status • Last checked <t:${nowUnix}:R>`,
              ].join('\n'),
            },
            buildSeparator(),
            {
              type: MessageComponentTypes.SECTION,
              components: [
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content: [
                    '### HUB',
                    `-# Console: \`connect ${HUB_ADDRESS}\``,
                  ].join('\n'),
                },
              ],
              accessory: buildConnectButton(true),
            },
            buildSeparator(),
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: `-# Retrying every ${refreshSeconds}s`,
            },
          ],
        },
      ],
    };
  }

  let onlinePlayers = 0;
  let onlineServers = 0;
  let hubOnline = false;

  const hubServers = servers.filter((server) => isHubServer(server.id, statusData?.[server.id]));
  if (hubServers.length === 0) hubServers.push(DEFAULT_SERVERS[0]);
  const hubIds = new Set(hubServers.map((s) => s.id));
  const gameServers = servers.filter((server) => !hubIds.has(server.id));

  const hubLines = hubServers.map((server) => {
    const entry = statusData?.[server.id];
    if (!hasValidEntry(entry)) {
      return hubServers.length > 1 ? `**${server.name}** — Offline` : 'Offline';
    }
    hubOnline = true;
    onlinePlayers += entry.players;
    onlineServers += 1;
    const mapLabel = formatMapName(entry.map) || 'Lobby';
    return hubServers.length > 1
      ? `**${server.name}** — **${entry.players} / ${entry.max}** online • \`${mapLabel}\``
      : `**${entry.players} / ${entry.max}** online • \`${mapLabel}\``;
  });

  const gameLines = gameServers.map((server) => {
    const entry = statusData?.[server.id];
    if (!hasValidEntry(entry)) {
      return `**${server.name}** — Offline`;
    }

    onlinePlayers += entry.players;
    onlineServers += 1;

    const mapLabel = formatMapName(entry.map);
    const stateText = entry.ingame ? 'Match in progress' : 'Waiting';
    const mapPart = mapLabel ? ` • \`${mapLabel}\`` : '';

    return `**${server.name}** — **${entry.players} / ${entry.max}** • ${stateText}${mapPart}`;
  });

  const accentColor = hubOnline
    ? COLORS.crimson
    : onlineServers > 0
      ? COLORS.cautionYellow
      : COLORS.darkCrimson;

  const playerWord = onlinePlayers === 1 ? 'player' : 'players';
  const serverWord = onlineServers === 1 ? 'server' : 'servers';

  const hubHeading = hubServers.length > 1 ? '### HUBS' : `### ${hubServers[0].name.toUpperCase()}`;
  const hubDetails = [hubHeading, ...hubLines, `-# Console: \`connect ${HUB_ADDRESS}\``].join('\n');

  return {
    flags: InteractionResponseFlags.IS_COMPONENTS_V2,
    components: [
      {
        type: MessageComponentTypes.CONTAINER,
        accent_color: accentColor,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: [
              `# ${STATUS_HEADER_MARKER}`,
              `**${onlinePlayers} ${playerWord}** online across **${onlineServers}/${servers.length} ${serverWord}** • Updated <t:${nowUnix}:R>`,
            ].join('\n'),
          },
          buildSeparator(),
          {
            type: MessageComponentTypes.SECTION,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: hubDetails,
              },
            ],
            accessory: buildConnectButton(hubOnline),
          },
          buildSeparator(),
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: ['### GAME SERVERS', ...gameLines].join('\n'),
          },
          buildSeparator(),
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `-# Quick games start from the Hub • Updates every ${refreshSeconds}s`,
          },
        ],
      },
    ],
  };
}

function componentsContainMarker(components) {
  if (!Array.isArray(components)) return false;
  for (const comp of components) {
    if (typeof comp?.content === 'string' && comp.content.includes(STATUS_HEADER_MARKER)) {
      return true;
    }
    if (Array.isArray(comp?.components) && componentsContainMarker(comp.components)) {
      return true;
    }
  }
  return false;
}

function isComponentsV2Message(msg) {
  return Boolean((msg?.flags ?? 0) & InteractionResponseFlags.IS_COMPONENTS_V2);
}

function fetchServerStatus() {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(STATUS_URL);
    const client = targetUrl.protocol === 'https:' ? https : http;
    const req = client.get(
      targetUrl,
      {
        family: 4,
        headers: {
          'Cache-Control': 'no-cache',
          Connection: 'close',
          'User-Agent': 'DistrustOnlineBot/1.0',
        },
        timeout: 15_000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`Status request failed: HTTP ${res.statusCode}`));
          return;
        }

        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
              reject(new Error('Status response has an invalid format'));
              return;
            }
            resolve(data);
          } catch (err) {
            reject(new Error(`Invalid JSON in status response: ${err.message}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request to ${STATUS_URL} timed out after 15s`));
    });
    req.on('error', (err) => {
      const code = err.code ? ` (${err.code})` : '';
      reject(new Error(`${err.message}${code}`));
    });
  });
}

async function findExistingStatusMessage(channelId, botUserId) {
  try {
    const res = await DiscordRequest(`channels/${channelId}/messages?limit=20`, {
      method: 'GET',
    });
    const messages = await res.json();
    const existing = messages.find((msg) => {
      if (msg.author?.id !== botUserId) return false;
      const isV2Match = isComponentsV2Message(msg) && componentsContainMarker(msg.components);
      const isLegacyMatch = msg.embeds?.some((embed) => embed.title === LEGACY_EMBED_TITLE);
      return isV2Match || isLegacyMatch;
    });

    if (!existing) return null;
    return { id: existing.id, isV2: isComponentsV2Message(existing) };
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
      const existing = await findExistingStatusMessage(channelId, botUserId);
      if (existing) {
        if (existing.isV2) {
          statusMessageId = existing.id;
          console.log(`Reusing existing status message ${statusMessageId} in channel ${channelId}`);
        } else {
          // Discord rejects upgrading a legacy embed message to IS_COMPONENTS_V2 via PATCH,
          // so remove the old embed message and post a clean V2 card instead.
          try {
            await DiscordRequest(`channels/${channelId}/messages/${existing.id}`, {
              method: 'DELETE',
            });
            console.log(`Replaced legacy status message ${existing.id} with Components V2 card`);
          } catch (err) {
            console.warn('Could not delete legacy status message:', err.message);
          }
        }
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
          // If the message was deleted or incompatible with V2 flags, post a fresh one
          if (err.status === 404 || err.status === 400 || err.message.includes('10008')) {
            console.warn('Previous status message could not be patched; posting a new one.');
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
