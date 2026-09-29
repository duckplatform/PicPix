'use strict';

/**
 * Temps reel (Socket.IO) : diaporama et moderation.
 *
 * Transport : polling HTTP par defaut. Le frontal mutualise de l'hebergeur
 * (o2switch PowerBoost) accepte l'upgrade WebSocket mais applique ensuite un
 * encodage "chunked" au flux, ce qui corrompt les trames ("One or more
 * reserved bits are on" cote navigateur). Le WebSocket ne s'active que si
 * SOCKET_TRANSPORTS le demande explicitement (ex. "polling,websocket") : le
 * client ne tente l'upgrade que si le serveur l'annonce au handshake.
 *
 * Le polling exige que toutes les requetes d'une session atteignent le meme
 * processus Node : avec plusieurs processus Passenger, activer les sessions
 * collantes ou limiter l'application a un seul processus.
 */

const { Server } = require('socket.io');

const logger = require('./logger');
const eventStore = require('../services/eventStore');
const userStore = require('../services/userStore');

const DEFAULT_TRANSPORTS = ['polling'];

/**
 * Transports serveur a partir de SOCKET_TRANSPORTS (liste separee par des
 * virgules). Le polling est toujours inclus et place en tete : c'est par lui
 * que le client ouvre la connexion.
 */
function resolveSocketTransports(value) {
  const requested = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase());

  return requested.includes('websocket')
    ? ['polling', 'websocket']
    : [...DEFAULT_TRANSPORTS];
}

/**
 * Les salles temps reel (slideshow, moderation) sont reservees au
 * proprietaire de l'evenement ou a un administrateur.
 */
async function canAccessEventRealtime(sessionData, eventId) {
  const userId = sessionData && sessionData.userId;
  if (!userId) {
    return false;
  }

  const user = await userStore.findPublicById(userId);
  if (!user || user.status !== 'active') {
    return false;
  }

  if (user.role === 'admin') {
    return true;
  }

  const eventItem = await eventStore.findById(eventId);
  return Boolean(eventItem) && eventItem.ownerUserId === Number(user.id);
}

/**
 * Attache Socket.IO au serveur HTTP en partageant la session Express.
 * Les clients (re)joignent leur salle a chaque connexion : une reconnexion
 * ouvre une nouvelle socket, qui n'appartient plus a aucune salle.
 */
function createRealtimeServer(httpServer, { sessionMiddleware, transports = resolveSocketTransports(process.env.SOCKET_TRANSPORTS) }) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    transports,
    cors: {
      origin: false,
    },
  });

  io.engine.use(sessionMiddleware);

  io.on('connection', (socket) => {
    const joinOwnedEventRoom = (roomSuffix) => async (payload = {}) => {
      const eventId = Number.parseInt(payload.eventId, 10);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return;
      }

      try {
        if (await canAccessEventRealtime(socket.request.session, eventId)) {
          socket.join(`event:${eventId}:${roomSuffix}`);
          logger.debug(`[SOCKET] ${socket.id} a rejoint event:${eventId}:${roomSuffix}`);
          return;
        }

        logger.warn(`[SOCKET] Acces refuse a event:${eventId}:${roomSuffix} (session sans droit sur l'evenement)`);
      } catch (err) {
        logger.warn(`[SOCKET] Verification d'acces impossible (${roomSuffix}) : ${err.message}`);
      }
    };

    socket.on('slideshow:join', joinOwnedEventRoom('slideshow'));
    socket.on('moderation:join', joinOwnedEventRoom('moderation'));
  });

  logger.info(`[SOCKET] Transports temps reel : ${transports.join(', ')}`);
  return io;
}

module.exports = {
  canAccessEventRealtime,
  createRealtimeServer,
  resolveSocketTransports,
};
