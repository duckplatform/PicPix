'use strict';

const fs = require('fs/promises');
const request = require('supertest');
const { expect } = require('chai');

const app = require('../app');
const eventArchiveService = require('../services/eventArchiveService');
const eventFileStore = require('../services/eventFileStore');
const userStore = require('../services/userStore');
const eventStore = require('../services/eventStore');

const EVENT_STORAGE_ROOT = eventStore.getEventStorageRoot();

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error('Token CSRF introuvable dans la page');
  }

  return match[1];
}

/** Connecte l'agent avec le compte admin par defaut, qui possede aussi les evenements de test. */
async function loginAsDefaultAdmin(agent) {
  const loginPage = await agent.get('/login');

  const loginResponse = await agent
    .post('/login')
    .type('form')
    .send({
      _csrf: extractCsrfToken(loginPage.text),
      email: 'admin@example.com',
      password: 'Admin1234',
    });

  expect(loginResponse.status).to.equal(302);
}

async function registerGuestForEvent(agent, token, guestName) {
  const registerPage = await agent.get(`/event/${token}/register`);

  const registerResponse = await agent
    .post(`/event/${token}/register`)
    .type('form')
    .send({
      _csrf: extractCsrfToken(registerPage.text),
      guestName,
    });

  expect(registerResponse.status).to.equal(302);
}

/**
 * Attend que la generation asynchrone du ZIP se termine.
 * La file d'attente est en memoire : on sonde l'etat persiste.
 */
async function waitForArchive(eventId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const eventItem = await eventStore.findById(eventId);
    if (eventItem && eventItem.archiveStatus !== 'pending') {
      return eventItem;
    }

    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }

  throw new Error('Timeout: archive toujours en attente');
}

describe('Cloture definitive d\'un evenement', () => {
  let owner;

  beforeEach(async () => {
    userStore.resetTestState();
    eventFileStore.resetTestState();
    eventStore.resetTestState();

    await fs.rm(EVENT_STORAGE_ROOT, { recursive: true, force: true });
    await fs.mkdir(EVENT_STORAGE_ROOT, { recursive: true });

    owner = await userStore.findByEmail('admin@example.com');
  });

  async function createActiveEvent(name = 'Soiree a cloturer') {
    return eventStore.createEvent({
      ownerUserId: owner.id,
      name,
      description: 'Un evenement destine a etre cloture dans les tests.',
      startsAt: '2099-06-01T19:00:00',
      status: 'active',
    });
  }

  /** Depose une photo via le parcours visiteur, comme en production. */
  async function uploadPhoto(createdEvent, filename) {
    const guestAgent = request.agent(app);
    await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Archive');

    const uploadPage = await guestAgent.get(`/event/${createdEvent.token}/upload`);
    const uploadResponse = await guestAgent
      .post(`/event/${createdEvent.token}/upload`)
      .set('x-csrf-token', extractCsrfToken(uploadPage.text))
      .attach('photos', Buffer.from(`contenu de ${filename}`), {
        filename,
        contentType: 'image/jpeg',
      });

    expect(uploadResponse.status).to.equal(201);
    return uploadResponse.body.files[0].storedName;
  }

  async function closeEventViaHttp(agent, createdEvent, confirmClose = 'CLOTURER') {
    const profilePage = await agent.get('/profile');

    return agent
      .post(`/profile/events/${createdEvent.id}/close`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(profilePage.text),
        confirmClose,
      });
  }

  it('genere une archive ZIP telechargeable apres la cloture', async () => {
    const createdEvent = await createActiveEvent();
    await uploadPhoto(createdEvent, 'photo-archive.jpg');

    const agent = request.agent(app);
    await loginAsDefaultAdmin(agent);

    const closeResponse = await closeEventViaHttp(agent, createdEvent);
    expect(closeResponse.status).to.equal(302);
    expect(closeResponse.headers.location).to.equal('/profile');

    const closedEvent = await waitForArchive(createdEvent.id);
    expect(closedEvent.status).to.equal('closed');
    expect(closedEvent.closedAt).to.not.equal(null);
    expect(closedEvent.archiveStatus).to.equal('ready');
    expect(closedEvent.archivePhotoCount).to.equal(1);
    expect(closedEvent.archiveSizeBytes).to.be.greaterThan(0);
    expect(await eventArchiveService.archiveExists(closedEvent.uuid)).to.equal(true);

    const downloadResponse = await agent
      .get(`/profile/events/${createdEvent.id}/archive`)
      .buffer()
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(downloadResponse.status).to.equal(200);
    expect(downloadResponse.headers['content-disposition']).to.include('.zip');
    // Signature d'en-tete d'un fichier ZIP ("PK\x03\x04")
    expect(downloadResponse.body.subarray(0, 2).toString()).to.equal('PK');
  });

  it('refuse la cloture sans la confirmation de la popup', async () => {
    const createdEvent = await createActiveEvent('Soiree sans confirmation');

    const agent = request.agent(app);
    await loginAsDefaultAdmin(agent);

    const closeResponse = await closeEventViaHttp(agent, createdEvent, 'oui');
    expect(closeResponse.status).to.equal(302);

    const stillOpen = await eventStore.findById(createdEvent.id);
    expect(stillOpen.status).to.equal('active');
    expect(stillOpen.archiveStatus).to.equal('none');
  });

  it('expose l\'etat de l\'archive en JSON pour le message d\'attente du dashboard', async () => {
    const createdEvent = await createActiveEvent('Soiree suivi archive');
    await uploadPhoto(createdEvent, 'photo-suivi.jpg');

    const agent = request.agent(app);
    await loginAsDefaultAdmin(agent);
    await closeEventViaHttp(agent, createdEvent);
    await waitForArchive(createdEvent.id);

    const statusResponse = await agent.get(`/profile/events/${createdEvent.id}/archive/status`);
    expect(statusResponse.status).to.equal(200);
    expect(statusResponse.body.status).to.equal('ready');
    expect(statusResponse.body.downloadUrl).to.equal(`/profile/events/${createdEvent.id}/archive`);
  });

  it('bloque tout retour arriere apres la cloture', async () => {
    const createdEvent = await createActiveEvent('Soiree irreversible');

    const agent = request.agent(app);
    await loginAsDefaultAdmin(agent);
    await closeEventViaHttp(agent, createdEvent);
    await waitForArchive(createdEvent.id);

    // Reactivation refusee
    const profilePage = await agent.get('/profile');
    const csrfToken = extractCsrfToken(profilePage.text);

    const activateResponse = await agent
      .post(`/profile/events/${createdEvent.id}/activate`)
      .type('form')
      .send({ _csrf: csrfToken });

    expect(activateResponse.status).to.equal(302);
    expect((await eventStore.findById(createdEvent.id)).status).to.equal('closed');

    // Seconde cloture refusee (pas de regeneration d'archive)
    const secondClose = await closeEventViaHttp(agent, createdEvent);
    expect(secondClose.status).to.equal(302);

    // Meme en forcant le store, le statut reste 'closed'
    const forced = await eventStore.updateEvent(createdEvent.id, { status: 'active' });
    expect(forced.status).to.equal('closed');
  });

  it('bloque la cloture tant que des photos attendent la moderation', async () => {
    const createdEvent = await eventStore.createEvent({
      ownerUserId: owner.id,
      name: 'Soiree avec moderation',
      description: 'Un evenement dont les photos passent par la moderation.',
      startsAt: '2099-06-01T19:00:00',
      status: 'active',
      moderationEnabled: true,
    });

    await uploadPhoto(createdEvent, 'photo-en-attente.jpg');
    expect(await eventFileStore.countByEventAndStatus(createdEvent.id, 'pending')).to.equal(1);

    const agent = request.agent(app);
    await loginAsDefaultAdmin(agent);

    const closeResponse = await closeEventViaHttp(agent, createdEvent);
    expect(closeResponse.status).to.equal(302);
    expect(closeResponse.headers.location).to.equal(`/profile/event/${createdEvent.id}/moderation`);

    const stillOpen = await eventStore.findById(createdEvent.id);
    expect(stillOpen.status).to.equal('active');
    expect(stillOpen.archiveStatus).to.equal('none');
  });

  it('autorise la cloture une fois la moderation terminee, et archive les photos approuvees', async () => {
    const createdEvent = await eventStore.createEvent({
      ownerUserId: owner.id,
      name: 'Soiree moderee',
      description: 'Un evenement dont les photos sont moderees avant cloture.',
      startsAt: '2099-06-01T19:00:00',
      status: 'active',
      moderationEnabled: true,
    });

    await uploadPhoto(createdEvent, 'photo-gardee.jpg');
    await uploadPhoto(createdEvent, 'photo-rejetee.jpg');

    const pendingFiles = await eventFileStore.listByEventAndStatus(createdEvent.id, 'pending');
    expect(pendingFiles).to.have.lengthOf(2);

    await eventFileStore.updateModerationStatus(pendingFiles[0].id, 'approved');
    await eventFileStore.updateModerationStatus(pendingFiles[1].id, 'rejected');

    const agent = request.agent(app);
    await loginAsDefaultAdmin(agent);

    const closeResponse = await closeEventViaHttp(agent, createdEvent);
    expect(closeResponse.headers.location).to.equal('/profile');

    const closedEvent = await waitForArchive(createdEvent.id);
    expect(closedEvent.archiveStatus).to.equal('ready');
    // Seule la photo approuvee entre dans l'archive ; la rejetee est ecartee.
    expect(closedEvent.archivePhotoCount).to.equal(1);
  });

  it('refuse les nouveaux uploads visiteurs sur un evenement cloture', async () => {
    const createdEvent = await createActiveEvent('Soiree fermee aux uploads');

    const guestAgent = request.agent(app);
    await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Tardif');
    const uploadPage = await guestAgent.get(`/event/${createdEvent.token}/upload`);
    const uploadCsrfToken = extractCsrfToken(uploadPage.text);

    const ownerAgent = request.agent(app);
    await loginAsDefaultAdmin(ownerAgent);
    await closeEventViaHttp(ownerAgent, createdEvent);
    await waitForArchive(createdEvent.id);

    const uploadResponse = await guestAgent
      .post(`/event/${createdEvent.token}/upload`)
      .set('x-csrf-token', uploadCsrfToken)
      .attach('photos', Buffer.from('photo trop tardive'), {
        filename: 'trop-tard.jpg',
        contentType: 'image/jpeg',
      });

    expect(uploadResponse.status).to.equal(403);
    expect(uploadResponse.body.message).to.include('cloture');

    // La page d'upload renvoie desormais vers la galerie
    const uploadPageAfter = await guestAgent.get(`/event/${createdEvent.token}/upload`);
    expect(uploadPageAfter.status).to.equal(302);
    expect(uploadPageAfter.headers.location).to.equal(`/event/${createdEvent.token}/gallery`);
  });
});
