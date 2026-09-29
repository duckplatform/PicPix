'use strict';

/**
 * Temps reel de bout en bout en polling HTTP : un invite envoie une photo,
 * le diaporama de l'organisateur la recoit via Socket.IO.
 *
 * Le client est simule au niveau du protocole Engine.IO v4 (polling), comme
 * le fait le navigateur quand le WebSocket est indisponible.
 */

const fs = require('fs/promises');
const http = require('http');
const request = require('supertest');
const { expect } = require('chai');

const app = require('../app');
const { createRealtimeServer, resolveSocketTransports } = require('../config/realtime');
const eventFileStore = require('../services/eventFileStore');
const eventStore = require('../services/eventStore');
const userStore = require('../services/userStore');

const EVENT_STORAGE_ROOT = eventStore.getEventStorageRoot();
const PACKET_SEPARATOR = '\x1e';

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error('Token CSRF introuvable dans la page');
  }

  return match[1];
}

/** Middleware de session reellement monte par app.js. */
function getSessionMiddleware() {
  const layer = app.router.stack.find((item) => item.name === 'session');
  return layer.handle;
}

/** Client Socket.IO minimal en polling HTTP. */
async function connectPollingClient(baseUrl, cookie = '') {
  const endpoint = `${baseUrl}/socket.io/?EIO=4&transport=polling`;
  const headers = cookie ? { Cookie: cookie } : {};

  const openResponse = await fetch(endpoint, { headers });
  const openPacket = await openResponse.text();
  expect(openPacket.startsWith('0')).to.equal(true);
  const handshake = JSON.parse(openPacket.slice(1));
  const sessionUrl = `${endpoint}&sid=${handshake.sid}`;

  async function send(packet) {
    const response = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: packet,
    });
    expect(response.status).to.equal(200);
  }

  /** Recupere les paquets en attente (requete longue, rendue des qu'il y en a). */
  async function poll() {
    const response = await fetch(sessionUrl, { headers });
    expect(response.status).to.equal(200);
    return (await response.text()).split(PACKET_SEPARATOR);
  }

  await send('40');
  const connectPackets = await poll();
  expect(connectPackets.some((packet) => packet.startsWith('40'))).to.equal(true);

  return {
    handshake,
    emit: (eventName, payload) => send(`42${JSON.stringify([eventName, payload])}`),
    /** Evenements Socket.IO recus, sous la forme [nom, payload]. */
    async receiveEvents() {
      const packets = await poll();
      return packets
        .filter((packet) => packet.startsWith('42'))
        .map((packet) => JSON.parse(packet.slice(2)));
    },
  };
}

describe('Temps reel en polling (upload -> diaporama)', () => {
  let server;
  let baseUrl;
  let owner;

  async function startRealtimeServer(transports) {
    server = http.createServer(app);
    app.locals.io = createRealtimeServer(server, { sessionMiddleware: getSessionMiddleware(), transports });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  beforeEach(async () => {
    userStore.resetTestState();
    eventFileStore.resetTestState();
    eventStore.resetTestState();

    await fs.rm(EVENT_STORAGE_ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    await fs.mkdir(EVENT_STORAGE_ROOT, { recursive: true });

    owner = await userStore.findByEmail('admin@example.com');
  });

  afterEach(async () => {
    if (app.locals.io) {
      await new Promise((resolve) => { app.locals.io.close(() => resolve()); });
    }
    app.locals.io = undefined;
    server = null;
  });

  async function loginOwnerCookie() {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login');
    const loginResponse = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: extractCsrfToken(loginPage.text), email: 'admin@example.com', password: 'Admin1234' });

    expect(loginResponse.status).to.equal(302);
    return loginResponse.headers['set-cookie'].map((entry) => entry.split(';')[0]).join('; ');
  }

  async function uploadAsGuest(eventItem, filename) {
    const guest = request.agent(app);
    const registerPage = await guest.get(`/event/${eventItem.token}/register`);
    await guest
      .post(`/event/${eventItem.token}/register`)
      .type('form')
      .send({ _csrf: extractCsrfToken(registerPage.text), guestName: 'Invite Direct' });

    const uploadPage = await guest.get(`/event/${eventItem.token}/upload`);
    const uploadResponse = await guest
      .post(`/event/${eventItem.token}/upload`)
      .set('x-csrf-token', extractCsrfToken(uploadPage.text))
      .attach('photos', Buffer.from(`contenu de ${filename}`), { filename, contentType: 'image/jpeg' });

    expect(uploadResponse.status).to.equal(201);
    return uploadResponse.body.files[0];
  }

  function createActiveEvent() {
    return eventStore.createEvent({
      ownerUserId: owner.id,
      name: 'Soiree en direct',
      description: 'Projection temps reel.',
      startsAt: '2099-06-01T19:00:00',
      status: 'active',
    });
  }

  it('choisit le polling par defaut et n\'active le WebSocket que sur demande', () => {
    expect(resolveSocketTransports(undefined)).to.deep.equal(['polling']);
    expect(resolveSocketTransports('')).to.deep.equal(['polling']);
    expect(resolveSocketTransports('n-importe-quoi')).to.deep.equal(['polling']);
    expect(resolveSocketTransports('polling,websocket')).to.deep.equal(['polling', 'websocket']);
    // Le polling reste indispensable : c'est par lui que le client se connecte.
    expect(resolveSocketTransports(' WebSocket ')).to.deep.equal(['polling', 'websocket']);
  });

  it('n\'annonce aucun upgrade WebSocket au client en mode polling', async () => {
    await startRealtimeServer(['polling']);

    const client = await connectPollingClient(baseUrl);
    expect(client.handshake.upgrades).to.deep.equal([]);
  });

  it('annonce l\'upgrade WebSocket quand il est explicitement active', async () => {
    await startRealtimeServer(['polling', 'websocket']);

    const client = await connectPollingClient(baseUrl);
    expect(client.handshake.upgrades).to.deep.equal(['websocket']);
  });

  it('pousse la photo d\'un invite vers le diaporama de l\'organisateur', async () => {
    await startRealtimeServer(['polling']);
    const eventItem = await createActiveEvent();

    const slideshow = await connectPollingClient(baseUrl, await loginOwnerCookie());
    await slideshow.emit('slideshow:join', { eventId: eventItem.id });
    // Le join verifie les droits de facon asynchrone.
    await new Promise((resolve) => { setTimeout(resolve, 100); });

    const uploadedFile = await uploadAsGuest(eventItem, 'direct.jpg');

    const events = await slideshow.receiveEvents();
    const newPhoto = events.find(([eventName]) => eventName === 'slideshow:new-photo');
    expect(newPhoto, 'slideshow:new-photo attendu').to.exist;
    expect(newPhoto[1]).to.include({ eventId: eventItem.id, storedName: uploadedFile.storedName });
  });

  it('ne pousse rien a une connexion sans droit sur l\'evenement', async () => {
    await startRealtimeServer(['polling']);
    const eventItem = await createActiveEvent();

    const anonymous = await connectPollingClient(baseUrl);
    await anonymous.emit('slideshow:join', { eventId: eventItem.id });
    await new Promise((resolve) => { setTimeout(resolve, 100); });

    await uploadAsGuest(eventItem, 'prive.jpg');

    // Attendre "aucun evenement" en polling bloquerait jusqu'au ping serveur :
    // on verifie donc que la socket n'a pas ete admise dans la salle.
    const room = app.locals.io.sockets.adapter.rooms.get(`event:${eventItem.id}:slideshow`);
    expect(room).to.equal(undefined);
  });
});
